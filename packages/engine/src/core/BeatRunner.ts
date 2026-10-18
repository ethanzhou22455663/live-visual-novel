/**
 * BeatRunner(plan §1.4,2026-10-18 幕制):beat 主循环,engine 侧唯一"驾驶者"。
 * 以「幕」为单位:planAct(总导演:全局走向+幕设计)→ 幕首系统落实场景(bg/bgm)
 * → generateBeat 整幕流式 → choice 行停等玩家 → 续写至 sceneEnd → 幕尾摘要
 * → 大纲游标推进 → 循环。大纲只是起点骨架,走完后总导演按全局走向接管(不终局)。
 * 演出(打字/立绘/语音)全部归引擎显示泵;runner 只 commit 状态,选项等 engine.whenIdle。
 * 打断 = 只 abort 生成;已提交行保留,继续按玩家节奏显示。
 * 全局走向/已完成幕数/写作中的幕由 runner 持有(入 SaveData)。
 */
import type {
  ActPlan,
  ContentPort,
  HistoryItem,
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
  /** 大纲节点数(app 从 pack.story.outlineMd 算;null=无结构,游标恒 null) */
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
  /** 全局走向(总导演输出;"" = 尚未生成) */
  #direction = "";
  /** 已完成幕数(走向刷新节拍 %5 用) */
  #actsDone = 0;
  /** 上一幕是否发生过玩家选择(下一幕强制刷新走向) */
  #lastActHadChoice = false;
  /** 本幕是否发生过玩家选择(consumeAct 中记账) */
  #actHadChoice = false;
  /** 写作中的幕(存档 pendingContinuation 依据;幕边界为 null) */
  #actState: ActPlan | null = null;
  /** 读档续写:下一轮 run() 跳过总导演,直接续写存档里的幕(引擎已 resumeTurn) */
  #resumeAct: ActPlan | null = null;
  /** runner 记忆的当前 BGM(DomStagePort 不管音频;相同即跳过不重复 commit) */
  #lastBgm: string | null = null;

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

  /** 全局走向(存档用) */
  get storyDirection(): string {
    return this.#direction;
  }

  /** 已完成幕数(存档用) */
  get actsDone(): number {
    return this.#actsDone;
  }

  /** 写作中的幕(存档 SaveSystem 用;幕边界/停止时 null) */
  get currentAct(): ActPlan | null {
    return this.#actState;
  }

  /** 打断当前生成(ESC/停止):只 abort LLM;不动显示泵——已提交行保留,按玩家节奏继续显示 */
  stopGeneration(): void {
    this.#abort?.abort();
  }

  /** 新游戏:清空 ledger/走向/游标,回 title 相位等待 start */
  newGame(): void {
    if (this.#running) this.stopGeneration();
    this.#summary = EMPTY_SUMMARY;
    this.#summarizedThrough = "";
    this.#direction = "";
    this.#actsDone = 0;
    this.#lastActHadChoice = false;
    this.#actHadChoice = false;
    this.#outlineBeatIndex = this.#deps.outlineBeatCount === null ? null : 0;
    this.#actState = null;
    this.#resumeAct = null;
    this.#lastBgm = null;
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
        // ---- ① 总导演(读档续写时跳过:幕/游标已由 restore 恢复) ----
        let plan: ActPlan;
        if (this.#resumeAct) {
          plan = this.#resumeAct;
          this.#resumeAct = null;
          bus.emit("generation:status", { phase: "writing", turnNo: engine.turnNo });
        } else {
          bus.emit("generation:status", { phase: "directing", turnNo: engine.turnNo });
          const { direction, act } = await story.planAct({
            world: engine.world,
            summary: this.#summary,
            history: this.#history(),
            lastChoice: this.#lastChoiceLabel() ? { label: this.#lastChoiceLabel()! } : null,
            outlineBeatIndex: this.#outlineBeatIndex,
            direction: this.#direction,
            stage: this.#stageState(),
            mustRefreshDirection: this.#mustRefreshDirection(),
            signal: abort.signal,
          });
          if (abort.signal.aborted) break;
          if (direction) this.#direction = direction;
          plan = act;
          engine.beginTurn();
        }

        // ---- ② 幕首:系统落实场景(bg/bgm 相同即跳过;commit 进 ledger,存档/回放全对) ----
        this.#applyScene(plan);

        // ---- ③ 编剧:整幕流式(choice 停等 → 续写 → sceneEnd 幕终) ----
        const turnNo = engine.turnNo;
        this.#actState = plan;
        this.#actHadChoice = false;
        bus.emit("generation:status", { phase: "writing", turnNo });
        const end = await this.#consumeAct(plan, turnNo, abort);
        this.#actState = null;
        if (abort.signal.aborted) break;
        if (end === "fatal") {
          bus.emit("generation:status", { phase: "error", turnNo, error: "生成失败" });
          break;
        }

        // ---- ④ 幕尾:sceneEnd 摘要(失败沿用旧摘要,绝不阻塞)+ 游标推进 ----
        if (end === "sceneEnd") {
          await this.#summarize(abort.signal);
          if (abort.signal.aborted) break;
        }
        if (this.#outlineBeatIndex !== null && this.#deps.outlineBeatCount) {
          this.#outlineBeatIndex = Math.min(this.#outlineBeatIndex + 1, this.#deps.outlineBeatCount);
        }
        this.#actsDone++;
        this.#lastActHadChoice = this.#actHadChoice;
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

  /** 走向强制刷新节点:走向尚未生成 / 大纲骨架走完 / 每完成 5 幕 / 上一幕有玩家选择 */
  #mustRefreshDirection(): boolean {
    if (!this.#direction) return true;
    const count = this.#deps.outlineBeatCount;
    if (count !== null && this.#outlineBeatIndex !== null && this.#outlineBeatIndex >= count) return true;
    if (this.#actsDone > 0 && this.#actsDone % 5 === 0) return true;
    if (this.#lastActHadChoice) return true;
    return false;
  }

  /** 幕首落实场景:bg/bgm 与当前状态相同即跳过;commit 进 ledger → 存档/回放/读档全对 */
  #applyScene(plan: ActPlan): void {
    const { engine } = this.#deps;
    const cur = engine.stage.snapshot();
    if (plan.scene.bg !== cur.bg) {
      engine.commitModel({ t: "stage", op: { kind: "bg", asset: plan.scene.bg } });
    }
    const bgm = plan.scene.bgm ?? null;
    if (bgm && bgm !== this.#lastBgm) {
      engine.commitModel({ t: "stage", op: { kind: "bgm", asset: bgm, action: "play" } });
    }
    this.#lastBgm = bgm;
  }

  /** 当前舞台状态(总导演换场/选 cast 的决策依据) */
  #stageState(): { bg: string | null; bgm: string | null; cast: string[] } {
    const snap = this.#deps.engine.stage.snapshot();
    return { bg: snap.bg, bgm: this.#lastBgm, cast: Object.keys(snap.sprites) };
  }

  /** 消费一幕(可多段):choice 停等玩家后续写,直到 sceneEnd;"fatal" = 不可续的失败 */
  async #consumeAct(plan: ActPlan, turnNo: number, abort: AbortController): Promise<"choice" | "beatEnd" | "sceneEnd" | "fatal"> {
    const { engine, bus, story } = this.#deps;
    let continuation: { reason: string; count: number } | undefined;
    let disruptions = 0; // watchdog/parse 中断恢复(BeatRunner 再入,上限 2)
    let choiceContinues = 0; // choice 后的续写(幕设计 choice ≤1 段 → 正常 1 次,保险上限 2)

    for (;;) {
      const ledgerTail = this.#actTail(turnNo);
      let done: Extract<StoryChunk, { kind: "done" }> | null = null;
      let sawFatalAbort = false;
      let sawChoice = false;

      const stream = story.generateBeat({
        act: plan,
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
            if (ev.t === "choice") {
              sawChoice = true;
              this.#actHadChoice = true;
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
      // 中断恢复(禁原样重试:ledgerTail 让模型看到已确定行)
      if (!done && disruptions < 2) {
        disruptions++;
        continuation = { reason: "generation interrupted, continue the act", count: disruptions };
        bus.emit("generation:status", { phase: "writing", turnNo });
        continue;
      }

      // choice 段收束:等泵到达选项并等玩家选择 → **续写本幕剩余小节**(不结束幕)
      if (done?.result === "choice" && sawChoice) {
        if (choiceContinues >= 2) return "beatEnd"; // 保险:幕设计异常时按幕尾处理,剧情不断
        choiceContinues++;
        bus.emit("generation:status", { phase: "choicing", turnNo });
        await engine.whenIdle(abort.signal);
        if (abort.signal.aborted) return "beatEnd";
        const label = this.#lastChoiceLabel() ?? "?";
        continuation = {
          reason: `The player chose "${label}". Continue after the choice and finish the remaining beats of this act up to the sceneEnd closing`,
          count: disruptions + choiceContinues,
        };
        bus.emit("generation:status", { phase: "writing", turnNo });
        continue;
      }
      if (done) return done.result;
      return "beatEnd"; // 两次恢复仍未收束:按幕尾处理,剧情不断
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

  /** 本幕已提交事件(同幕续写的 ledgerTail) */
  #actTail(turnNo: number): string {
    const { engine } = this.#deps;
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

  /** M5 存档读恢复(runner 侧:摘要/走向/游标/幕进行中;引擎侧走 EngineCore.restoreFromSave) */
  restore(state: {
    summary: Summary;
    summarizedThrough: string;
    outlineBeatIndex: number | null;
    currentAct?: ActPlan | null;
    storyDirection?: string;
    actsDone?: number;
  }): void {
    this.#summary = state.summary;
    this.#summarizedThrough = state.summarizedThrough;
    this.#outlineBeatIndex = state.outlineBeatIndex;
    this.#direction = state.storyDirection ?? "";
    this.#actsDone = state.actsDone ?? 0;
    this.#resumeAct = state.currentAct ?? null;
    this.#actState = null;
    this.#lastActHadChoice = false;
    this.#actHadChoice = false;
    this.#lastBgm = null; // 音频状态不持久化;下个非 null 幕设计自然重切
  }
}
