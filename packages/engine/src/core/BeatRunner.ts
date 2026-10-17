/**
 * BeatRunner(plan §1.4):beat 主循环,engine 侧唯一"驾驶者"。
 * nextBeat → beginTurn → generateBeat 逐块消费 → commit 事务点 → 选项停等 →
 * sceneEnd 摘要 → 循环。打断 = abort + 打字机取消,已提交行保留生效。
 * summary/outlineBeatIndex 由 runner 持有(M5 起入 SaveData)。
 */
import type {
  BeatDirective,
  ContentPort,
  HistoryItem,
  SaveCurrentBeat,
  StoryChunk,
  StoryService,
  Summary,
} from "@gal/shared";
import { EMPTY_SUMMARY, toHistoryItems } from "@gal/shared";
import type { EngineCore } from "./EngineCore.ts";
import type { EventBus } from "./EventBus.ts";
import type { VoicePipeline } from "../audio/VoicePipeline.ts";

const HISTORY_CAP = 30;

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface BeatRunnerDeps {
  engine: EngineCore;
  bus: EventBus;
  story: StoryService;
  voice: VoicePipeline | null;
  content: ContentPort;
  /** 大纲节拍数(app 从 pack.story.outlineMd 算;null=无结构,游标恒 null) */
  outlineBeatCount: number | null;
  onError?: (err: unknown) => void;
}

export class BeatRunner {
  #deps: BeatRunnerDeps;
  #running = false;
  #abort: AbortController | null = null;
  #outlineBeatIndex: number | null;
  #summary: Summary = EMPTY_SUMMARY;
  /** 摘要游标:上次 summarize 覆盖到的 lineId("" = 从未摘要) */
  #summarizedThrough: string = "";
  /** 选项停等句柄 */
  #choiceWaiter: (() => void) | null = null;
  /** 进行中的拍(writing 中点存档的 pendingContinuation 依据;拍边界为 null) */
  #currentBeat: SaveCurrentBeat | null = null;
  /** 读档续写:下一轮循环跳过导演,直接用存档里的拍指令(引擎已 resumeTurn) */
  #resumeBeat: SaveCurrentBeat | null = null;

  constructor(deps: BeatRunnerDeps) {
    this.#deps = deps;
    this.#outlineBeatIndex = deps.outlineBeatCount === null ? null : 0;
    deps.bus.on("choice:resolved", () => {
      const w = this.#choiceWaiter;
      this.#choiceWaiter = null;
      w?.();
    });
  }

  get running(): boolean {
    return this.#running;
  }

  get summary(): Summary {
    return this.#summary;
  }

  get outlineBeatIndex(): number | null {
    return this.#outlineBeatIndex;
  }

  /** 进行中的拍(存档 SaveSystem 用);拍边界/停止时 null */
  get currentBeat(): SaveCurrentBeat | null {
    return this.#currentBeat;
  }

  /** 打断当前生成(ESC/停止):abort + 打字机取消;已提交行保留。循环在行边界退出 */
  stopGeneration(): void {
    this.#abort?.abort();
    this.#deps.engine.cancelTypewriter();
    const w = this.#choiceWaiter;
    this.#choiceWaiter = null;
    w?.(); // 选项等待也放行;循环检查 aborted 后退出
  }

  /** 新游戏:清空 ledger/摘要/游标,回 title 相位等待 start */
  newGame(): void {
    if (this.#running) this.stopGeneration();
    this.#summary = EMPTY_SUMMARY;
    this.#summarizedThrough = "";
    this.#outlineBeatIndex = this.#deps.outlineBeatCount === null ? null : 0;
    this.#currentBeat = null;
    this.#resumeBeat = null;
    this.#deps.engine.replay([]);
    this.#deps.engine.setPhase("title");
  }

  /** 主循环:从 title 进入,直到 stopGeneration 或致命错误。同一时刻仅一个 */
  async run(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    const { engine, bus, story } = this.#deps;
    const abort = (this.#abort = new AbortController());
    bus.emit("generation:status", { phase: "idle", turnNo: engine.turnNo });

    try {
      engine.setPhase("play");
      while (!abort.signal.aborted) {
        // ---- ① 导演(读档续写时跳过:拍号/游标已由 restore 恢复) ----
        let directive: BeatDirective;
        if (this.#resumeBeat) {
          directive = this.#resumeBeat.directive;
          this.#resumeBeat = null;
          bus.emit("generation:status", { phase: "directing", turnNo: engine.turnNo });
        } else {
          bus.emit("generation:status", { phase: "directing", turnNo: engine.turnNo });
          directive = await story.nextBeat({
            world: engine.world,
            summary: this.#summary,
            history: this.#history(),
            lastChoice: this.#lastChoiceLabel() ? { label: this.#lastChoiceLabel()! } : null,
            outlineBeatIndex: this.#outlineBeatIndex,
            signal: abort.signal,
          });
          if (abort.signal.aborted) break;
          engine.beginTurn();
        }

        // ---- ② 编剧 ----
        const turnNo = engine.turnNo;
        this.#currentBeat = { turnNo, directive };
        bus.emit("generation:status", { phase: "writing", turnNo });
        const end = await this.#consumeBeat(directive, turnNo, abort);
        this.#currentBeat = null;
        if (abort.signal.aborted) break;
        if (end === "fatal") {
          bus.emit("generation:status", { phase: "error", turnNo, error: "生成失败" });
          break;
        }

        // ---- ③ sceneEnd 摘要(失败沿用旧摘要,绝不阻塞) ----
        if (end === "sceneEnd") {
          await this.#summarize(abort.signal);
          if (abort.signal.aborted) break;
        }

        // 大纲游标推进(有结构才推进)
        if (this.#outlineBeatIndex !== null && this.#deps.outlineBeatCount) {
          this.#outlineBeatIndex = Math.min(this.#outlineBeatIndex + 1, this.#deps.outlineBeatCount);
        }
        // M5:auto 存档由 SaveSystem 挂 beat:end(choice 的收束走 choice:resolved)
        bus.emit("beat:end", { result: end, turnNo });
      }
      if (!abort.signal.aborted || engine.phase !== "choicing") {
        bus.emit("generation:status", { phase: "idle", turnNo: engine.turnNo });
      }
    } catch (err) {
      if (!abort.signal.aborted) {
        this.#deps.onError?.(err);
        bus.emit("generation:status", {
          phase: "error",
          turnNo: engine.turnNo,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      this.#running = false;
      this.#abort = null;
    }
  }

  /** 消费一拍;返回收束方式,"fatal" = 不可续的失败 */
  async #consumeBeat(directive: BeatDirective, turnNo: number, abort: AbortController): Promise<"choice" | "beatEnd" | "sceneEnd" | "fatal"> {
    const { engine, bus, story, voice, content } = this.#deps;
    let continuation: { reason: string; count: number } | undefined;
    let reentries = 0;

    for (;;) {
      const ledgerTail = this.#beatTail();
      let done: Extract<StoryChunk, { kind: "done" }> | null = null;
      let sawFatalAbort = false;

      const stream = story.generateBeat({
        directive,
        turnNo,
        world: engine.world,
        summary: this.#summary,
        history: this.#history(),
        ledgerTail,
        continuation,
        signal: abort.signal,
      });

      for await (const chunk of stream) {
        if (abort.signal.aborted) break;
        switch (chunk.kind) {
          case "preview":
            bus.emit("generation:preview", { text: chunk.text });
            break;
          case "commit": {
            const { ev, lineId } = engine.commitModel(chunk.event);
            if (ev.t === "say" && voice && content.characterIds.has(ev.who)) {
              const entries = voice.enqueue(ev, lineId, abort.signal);
              this.#chain(() => this.#presentSay(lineId, entries, abort.signal));
            } else if (ev.t === "narrate") {
              this.#chain(() => this.#presentNarrate(lineId, abort.signal));
            }
            break;
          }
          case "aborted":
            if (!chunk.canContinue) {
              sawFatalAbort = true;
              bus.emit("generation:status", { phase: "aborted", turnNo, error: chunk.reason });
            }
            break;
          case "done":
            done = chunk;
            break;
        }
      }

      if (abort.signal.aborted) return "beatEnd";
      if (sawFatalAbort) return "fatal";
      // 续写再入(禁原样重试:ledgerTail 让模型看到已确定行)
      if (!done && reentries < 2) {
        reentries++;
        continuation = { reason: "前次生成中断,继续本拍", count: reentries };
        bus.emit("generation:status", { phase: "writing", turnNo });
        continue;
      }

      // 演出链收尾:最后一行打完/播完才进选项或下一拍
      await this.#drainPresentation();

      if (done?.result === "choice" && engine.pendingChoice) {
        bus.emit("generation:status", { phase: "choicing", turnNo });
        await this.#waitChoice(abort.signal);
        return abort.signal.aborted ? "beatEnd" : "choice";
      }
      if (done) return done.result;
      return "beatEnd"; // 两次续写仍未收束:按拍尾处理,剧情不断
    }
  }

  /** 行级流水线:打字机完 → 语音逐句 → 停留(不阻塞流消费;点击可快进) */
  async #presentSay(lineId: string, entries: ReturnType<VoicePipeline["enqueue"]>, signal: AbortSignal): Promise<void> {
    const { engine, voice } = this.#deps;
    if (!voice) return;
    const mode = engine.clock.mode;
    // 坑③:skip/fast 演出直通——瞬间补完打字机、不等语音;commit/fold 已照常入账
    if (mode === "skip" || mode === "fast") {
      engine.advance();
      return;
    }
    try {
      await engine.waitForTypewriter(lineId);
      if (signal.aborted) return;
      // 玩家第二击(等待中点击)= 快进:停当前句、放弃余句、跳过停留
      const v0 = engine.presentationVersion;
      const interrupt = engine.waitPresentationSkip(v0);
      const skipped = await Promise.race([
        voice.playOut(entries, signal, interrupt).then(() => false),
        interrupt.then(() => true),
      ]);
      if (skipped) voice.stopCurrent();
      await Promise.race([interrupt, delay(mode === "auto" ? 800 : 400)]);
    } catch (e) {
      this.#deps.onError?.(e);
    }
  }

  async #presentNarrate(lineId: string, signal: AbortSignal): Promise<void> {
    const { engine, voice } = this.#deps;
    const mode = engine.clock.mode;
    if (mode === "skip" || mode === "fast") {
      engine.advance();
      return;
    }
    if (!voice || signal.aborted) return;
    try {
      await engine.waitForTypewriter(lineId);
      if (signal.aborted) return;
      const v0 = engine.presentationVersion;
      await Promise.race([engine.waitPresentationSkip(v0), delay(mode === "auto" ? 800 : 400)]);
    } catch (e) {
      this.#deps.onError?.(e);
    }
  }

  #presentation: Promise<void> = Promise.resolve();

  /** 演出链顺序化;drain = 等全部排队的行演出完 */
  async #drainPresentation(): Promise<void> {
    await this.#presentation.catch(() => {});
  }

  #chain(step: () => Promise<void>): void {
    this.#presentation = this.#presentation.then(step).catch((e) => this.#deps.onError?.(e));
  }

  #history(): HistoryItem[] {
    return toHistoryItems(this.#deps.engine.ledger, HISTORY_CAP);
  }

  #lastChoiceLabel(): string | null {
    for (let i = this.#deps.engine.ledger.length - 1; i >= 0; i--) {
      const e = this.#deps.engine.ledger[i]!;
      if (e.kind === "choice") return e.label;
    }
    return null;
  }

  /** 本拍已提交事件(同拍续写的 ledgerTail) */
  #beatTail(): string {
    const { engine } = this.#deps;
    const turnNo = engine.turnNo;
    const lines: string[] = [];
    for (const e of engine.ledger) {
      if (e.kind === "ev" && e.turnNo === turnNo) {
        const { turnNo: _t, ...rest } = e.ev;
        lines.push(JSON.stringify(rest));
      }
    }
    return lines.join("\n");
  }

  async #waitChoice(signal: AbortSignal): Promise<void> {
    if (!signal.aborted && this.#deps.engine.pendingChoice) {
      await new Promise<void>((res) => {
        this.#choiceWaiter = res;
      });
    }
  }

  /** sceneEnd 摘要(§3):失败沿用旧摘要 */
  async #summarize(signal: AbortSignal): Promise<void> {
    const { engine, story, content } = this.#deps;
    try {
      const items = toHistoryItems(engine.ledger, 40);
      const names = Object.fromEntries([...content.characterIds].map((id) => [id, content.displayNameOf(id)]));
      const last = engine.ledger[engine.ledger.length - 1];
      const through = last?.lineId ?? "";
      this.#summary = await story.summarize({
        old: this.#summary,
        items,
        throughLineId: through,
        names,
        signal,
      });
      this.#summarizedThrough = through;
    } catch (e) {
      this.#deps.onError?.(`摘要失败,沿用旧摘要:${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** M5 存档读恢复(runner 侧:摘要/大纲游标/拍进行中;引擎侧走 EngineCore.restoreFromSave) */
  restore(state: {
    summary: Summary;
    summarizedThrough: string;
    outlineBeatIndex: number | null;
    currentBeat?: SaveCurrentBeat | null;
  }): void {
    this.#summary = state.summary;
    this.#summarizedThrough = state.summarizedThrough;
    this.#outlineBeatIndex = state.outlineBeatIndex;
    this.#resumeBeat = state.currentBeat ?? null;
    this.#currentBeat = null;
  }
}
