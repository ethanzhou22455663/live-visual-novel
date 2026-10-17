/**
 * BeatRunner(plan §1.4):beat 主循环,engine 侧唯一"驾驶者"。
 * nextBeat → beginTurn → generateBeat 逐块消费 → commit 事务点 → 选项停等 →
 * sceneEnd 摘要 → 循环。演出(打字/立绘/语音)全部归引擎显示泵(2026-10-17 重写):
 * runner 只 commit 状态,选项拍等 engine.whenIdle(泵到达→offer→玩家选)。
 * 打断 = 只 abort 生成;已提交行保留,继续按玩家节奏显示。
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

const HISTORY_CAP = 30;

export interface BeatRunnerDeps {
  engine: EngineCore;
  bus: EventBus;
  story: StoryService;
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
  /** 进行中的拍(writing 中点存档的 pendingContinuation 依据;拍边界为 null) */
  #currentBeat: SaveCurrentBeat | null = null;
  /** 读档续写:下一轮循环跳过导演,直接用存档里的拍指令(引擎已 resumeTurn) */
  #resumeBeat: SaveCurrentBeat | null = null;

  constructor(deps: BeatRunnerDeps) {
    this.#deps = deps;
    this.#outlineBeatIndex = deps.outlineBeatCount === null ? null : 0;
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

  /** 打断当前生成(ESC/停止):只 abort LLM;不动显示泵——已提交行保留,按玩家节奏继续显示 */
  stopGeneration(): void {
    this.#abort?.abort();
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
    const { engine, bus, story } = this.#deps;
    let continuation: { reason: string; count: number } | undefined;
    let reentries = 0;

    for (;;) {
      const ledgerTail = this.#beatTail();
      let done: Extract<StoryChunk, { kind: "done" }> | null = null;
      let sawFatalAbort = false;
      let sawChoice = false; // 本拍 commit 过 choice 事件(到达时由泵 offer,whenIdle 等玩家)

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
            // 状态入账即返回;演出(打字/立绘/语音)归引擎显示泵,这里不等任何演出
            const { ev } = engine.commitModel(chunk.event);
            if (ev.t === "choice") sawChoice = true;
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

      // choice 拍:等泵到达选项条目并收束玩家选择(硬逻辑门;abort 由 signal 提前放行)。
      // beatEnd/sceneEnd 不等显示——下一拍 LLM 生成与玩家阅读流水并行,显示队列吸收延迟。
      if (done?.result === "choice" && sawChoice) {
        bus.emit("generation:status", { phase: "choicing", turnNo });
        await engine.whenIdle(abort.signal);
        return abort.signal.aborted ? "beatEnd" : "choice";
      }
      if (done) return done.result;
      return "beatEnd"; // 两次续写仍未收束:按拍尾处理,剧情不断
    }
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
