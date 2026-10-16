/**
 * EngineCore(plan §2.2 / M2):游戏状态唯一持有者——ledger、游标、phase 状态机、
 * 模型事件提交事务点。副作用只经 EventBus 与端口;DOM 仅打字机目标元素。
 * BeatRunner(M3)是唯一"驾驶者";React 经 snapshot/subscribe 只读。
 *
 * 拍号语义(§1.1):turnNo=拍号(1 起),seq=拍内序号(0 起);
 * beginTurn 分配新拍号,同拍续写用 resumeTurn 续 seq,行号单调不重复。
 */
import {
  EMPTY_SUMMARY,
  EMPTY_WORLD,
  WorldDeltaSchema,
  combineDeltas,
  commitModelEvent,
  cursorAfter,
  foldWorld,
  makeLineId,
  mergeDelta,
  trimLedger,
} from "@gal/shared";
import type {
  ClockMode,
  ContentPort,
  EmotionTag,
  GameEventMap,
  LineId,
  LedgerEntry,
  ModelScriptEvent,
  PresentationSnapshot,
  PublicChoiceOffer,
  SaveCurrentBeat,
  SaveData,
  ScriptEvent,
  SpeakerId,
  Summary,
  WorldState,
} from "@gal/shared";
import type { EventBus } from "./EventBus.ts";
import type { PresentationClock } from "./PresentationClock.ts";
import type { StagePort } from "../presentation/ports.ts";
import { ChoiceOverlay } from "../game/ChoiceOverlay.ts";
import { Typewriter } from "../Typewriter.ts";

export type EnginePhase = GameEventMap["engine:phase"]["phase"];

/** React useSyncExternalStore 的只读视图(hidden 永不出现在此) */
export interface EngineSnapshot {
  phase: EnginePhase;
  clockMode: ClockMode;
  turnNo: number;
  /** 下一个待分配游标(= SaveData.cursor,M5) */
  cursor: { turnNo: number; seq: number };
  world: WorldState;
  pendingChoice: PublicChoiceOffer | null;
  lineCount: number;
  /** 当前发言者(名牌;null=旁白/尚无行) */
  currentLine: { who: string; emotion: string } | null;
}

export interface EngineCoreDeps {
  bus: EventBus;
  clock: PresentationClock;
  stage: StagePort;
  content: ContentPort;
  /** 打字机上屏目标(台词窗正文元素,样式归 chrome) */
  textEl: HTMLElement;
  /** 选项浮层挂载点(舞台根);缺省 = 无浮层(headless 测试/纯引擎用法) */
  choiceRoot?: HTMLElement;
  /** skip 模式下自动选 defaultOptionId(M4);默认开 */
  skipAutoPick?: boolean;
  /** 每秒字数(设置面板 M6 可调;默认同 P0) */
  cps?: number;
  /** BGM 指令出口(bootstrap 接 AudioBus;null=stop);不设 = 无声玩法(headless) */
  onBgm?: (assetId: string | null, fadeMs?: number) => void;
  onSe?: (assetId: string) => void;
}

export class EngineCore {
  readonly bus: EventBus;
  readonly clock: PresentationClock;
  readonly stage: StagePort;
  readonly content: ContentPort;

  #ledger: LedgerEntry[] = [];
  #turnNo = 1; // 当前(或最后已开始的)拍号
  #seq = 0; // 拍内下一个待分配序号
  /** false ⇒ #turnNo 尚未开始(新游戏/空档),beginTurn 分配 #turnNo 本身;true ⇒ 分配 #turnNo+1 */
  #turnStarted = false;
  #phase: EnginePhase = "title";
  #world: WorldState = EMPTY_WORLD;
  #pendingChoice: PublicChoiceOffer | null = null;
  #listeners = new Set<() => void>();
  #tw: Typewriter;
  #currentLineId: LineId | null = null;
  #twWaiters = new Map<LineId, Set<() => void>>();
  #currentLine: { who: string; emotion: string } | null = null;
  #skipAutoPick: boolean;
  #choiceOverlay: ChoiceOverlay | null = null;
  #onBgm: ((assetId: string | null, fadeMs?: number) => void) | null;
  #onSe: ((assetId: string) => void) | null;

  constructor(deps: EngineCoreDeps) {
    this.bus = deps.bus;
    this.clock = deps.clock;
    this.stage = deps.stage;
    this.content = deps.content;
    this.#onBgm = deps.onBgm ?? null;
    this.#onSe = deps.onSe ?? null;
    this.#skipAutoPick = deps.skipAutoPick ?? true;
    this.#tw = new Typewriter(deps.textEl, { cps: deps.cps ?? 30 });
    this.#tw.onProgress = (ratio) => {
      if (this.#currentLineId) {
        this.bus.emit("typewriter:progress", { lineId: this.#currentLineId, ratio });
      }
    };
    if (deps.choiceRoot) {
      this.#choiceOverlay = new ChoiceOverlay({
        bus: this.bus,
        root: deps.choiceRoot,
        onPick: (id) => this.resolveChoice(id),
      });
    }
    // 选项停等中切到 skip → 立即按默认项收束(offer 时刻已是 skip 的路径在 commitModel)
    this.clock.onModeChange((mode) => {
      if (mode === "skip" && this.#skipAutoPick && this.#pendingChoice) {
        this.resolveChoice(this.#pendingChoice.defaultOptionId);
      }
    });
  }

  // ---- 只读视图 ----

  get phase(): EnginePhase {
    return this.#phase;
  }

  get turnNo(): number {
    return this.#turnNo;
  }

  /** 下一个待分配游标;ledger 空时从 1.0 开始 */
  get cursor(): { turnNo: number; seq: number } {
    if (this.#ledger.length === 0) return { turnNo: 1, seq: 0 };
    const last = this.#ledger[this.#ledger.length - 1]!;
    return { turnNo: last.turnNo, seq: last.seq + 1 };
  }

  get world(): WorldState {
    return this.#world;
  }

  get ledger(): readonly LedgerEntry[] {
    return this.#ledger;
  }

  get pendingChoice(): PublicChoiceOffer | null {
    return this.#pendingChoice;
  }

  get typewriter(): Typewriter {
    return this.#tw;
  }

  // ---- React 外部 store 契约 ----

  snapshot(): EngineSnapshot {
    return {
      phase: this.#phase,
      clockMode: this.clock.mode,
      turnNo: this.#turnNo,
      cursor: this.cursor,
      world: this.#world,
      pendingChoice: this.#pendingChoice,
      lineCount: this.#ledger.length,
      currentLine: this.#currentLine,
    };
  }

  subscribe = (fn: () => void): (() => void) => {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  };

  #notify(): void {
    for (const fn of [...this.#listeners]) fn();
  }

  // ---- phase 状态机 ----

  setPhase(phase: EnginePhase): void {
    if (this.#phase === phase) return;
    this.#phase = phase;
    this.bus.emit("engine:phase", { phase });
    this.#notify();
  }

  setClockMode(mode: ClockMode): void {
    this.clock.setMode(mode);
  }

  warn(message: string): void {
    this.bus.emit("engine:warning", { message });
  }

  // ---- 拍事务(plan §1.1/§1.4) ----

  /**
   * 新拍:分配严格递增的新拍号,seq 归零。
   * 拍号基准是 #turnNo 状态而非 ledger 尾条目——存档 ledger 被摘要裁剪后,
   * 尾条目拍号可能远小于真实进度(M5),从 ledger 推导会回退重号。
   */
  beginTurn(): number {
    this.#turnNo = this.#turnStarted ? this.#turnNo + 1 : this.#turnNo;
    this.#turnStarted = true;
    this.#seq = 0;
    return this.#turnNo;
  }

  /** 读档续写/同拍续写:沿用指定拍号,seq = 拍内下一个待分配序号;拍视为已开始 */
  resumeTurn(turnNo: number, seq: number): void {
    this.#turnNo = turnNo;
    this.#seq = seq;
    this.#turnStarted = true;
  }

  /**
   * 提交事务点(§1.4):成员校验/净化 → 补拍号 → ledger → bus line:commit →
   * 舞台应用 → choice 时挂起等玩家。返回引擎视角的已提交事件与行号。
   * 不抛错——编剧输出是随机的,违规一律净化+告警,剧情不断。
   */
  commitModel(m: ModelScriptEvent): { ev: ScriptEvent; lineId: LineId } {
    const turnNo = this.#turnNo;
    const seq = this.#seq;
    const lineId = makeLineId(turnNo, seq);
    let ev = commitModelEvent(m, turnNo);

    switch (ev.t) {
      case "say": {
        ev = { ...ev, emotion: this.#sanitizeEmotion(ev.who, ev.emotion) };
        this.#currentLine = { who: ev.who, emotion: ev.emotion };
        this.stage.speak(ev.who);
        this.#present(lineId, ev.text);
        break;
      }
      case "narrate": {
        this.#currentLine = null;
        this.stage.speak(null);
        this.#present(lineId, ev.text);
        break;
      }
      case "stage": {
        this.#applyStageOp(ev.op);
        break;
      }
      case "choice": {
        ev = this.#sanitizeChoice(ev);
        const offer: PublicChoiceOffer = {
          prompt: ev.prompt,
          options: ev.options.map((o) =>
            o.delta !== undefined ? { id: o.id, label: o.label, delta: o.delta } : { id: o.id, label: o.label },
          ),
          defaultOptionId: ev.defaultOptionId,
        };
        this.#pendingChoice = offer;
        this.setPhase("choicing");
        this.bus.emit("choice:offered", { choice: offer });
        break;
      }
    }

    this.#ledger.push({ kind: "ev", lineId, turnNo, seq, ev });
    this.#seq = seq + 1;
    this.bus.emit("line:commit", { event: ev, lineId });
    this.#notify();

    // skip 模式(offer 时刻已是 skip 的路径):选项按默认项立即收束。
    // 必须在本事件入账后执行——resolveChoice 回扫 ledger 取 hidden delta
    if (ev.t === "choice" && this.clock.mode === "skip" && this.#skipAutoPick) {
      this.resolveChoice(ev.defaultOptionId);
    }
    return { ev, lineId };
  }

  /** M4:校验属组 → 应用 delta → ledger → bus → 放行 BeatRunner。M2 仅占位断言不误用 */
  get hasPendingChoice(): boolean {
    return this.#pendingChoice !== null;
  }

  /**
   * 玩家选择(M3 起由 BeatRunner/UI 调):校验属组 → 自身+hidden delta 合并过 schema
   * → world 入账 → ledger 追加 choice 条目 → bus choice:resolved → 回 play。
   * 返回 null = 无待选或 id 不属本组(不产生任何副作用)。
   */
  resolveChoice(optionId: string): { optionId: string; label: string } | null {
    const pending = this.#pendingChoice;
    if (!pending) return null;
    const opt = pending.options.find((o) => o.id === optionId);
    if (!opt) {
      this.warn(`选项「${optionId}」不属当前选项组,忽略`);
      return null;
    }
    // 已提交 choice 事件(ledger 尾部)持有 hidden 后果;公开视图只有自身 delta
    let ev: Extract<ScriptEvent, { t: "choice" }> | null = null;
    for (let i = this.#ledger.length - 1; i >= 0; i--) {
      const e = this.#ledger[i]!;
      if (e.kind === "ev" && e.ev.t === "choice") {
        ev = e.ev;
        break;
      }
    }
    const full = ev?.options.find((o) => o.id === optionId);
    const delta = combineDeltas(
      parseChoiceDelta(opt.delta, (m) => this.warn(m)),
      parseChoiceDelta(full?.hidden?.delta, (m) => this.warn(m)),
    );
    if (delta) this.#world = mergeDelta(this.#world, delta);

    const lineId = makeLineId(this.#turnNo, this.#seq);
    this.#ledger.push({
      kind: "choice",
      lineId,
      turnNo: this.#turnNo,
      seq: this.#seq,
      optionId: opt.id,
      label: opt.label,
      delta,
    });
    this.#seq += 1;
    this.#pendingChoice = null;
    this.setPhase("play");
    this.bus.emit("choice:resolved", { optionId: opt.id, label: opt.label });
    this.#notify();
    return { optionId: opt.id, label: opt.label };
  }

  // ---- 重放(读档/回溯;不发 line:commit,语音/backlog 订阅者不受扰动) ----

  replay(entries: readonly LedgerEntry[]): void {
    this.cancelTypewriter();
    this.#currentLine = null;
    this.stage.reset();
    this.#readState = [];
    this.#ledger = [...entries];
    this.#world = foldWorld(entries);
    this.#pendingChoice = null; // 选项即时性:重放不恢复"等玩家"状态
    if (entries.length === 0) {
      // 空档 = 新游戏语义:第 1 拍尚未开始(beginTurn 将分配 1)
      this.#turnNo = 1;
      this.#seq = 0;
      this.#turnStarted = false;
    } else {
      const c = cursorAfter(entries);
      this.resumeTurn(c.turnNo, c.seq);
    }
    this.setPhase("play"); // 读档落地不回"choicing"(选项即时性:重放不恢复等玩家状态)
    // 视觉终态:按序应用 bg/sprite/speak;shake/flash 是瞬态特效,重放跳过
    for (const e of entries) {
      if (e.kind !== "ev") continue;
      const ev = e.ev;
      if (ev.t === "say") {
        this.stage.speak(ev.who);
      } else if (ev.t === "narrate") {
        this.stage.speak(null);
      } else if (ev.t === "stage") {
        this.#applyStageOp(ev.op, /* replay */ true);
      }
    }
    this.#notify();
  }

  /** 打断当前打字机(Ctrl 快进/Esc):瞬间补完 */
  advance(): void {
    this.#tw.skip();
  }

  /** 演出链等待打字机完(行被顶替/已取消 → 立即放行,绝不挂死) */
  waitForTypewriter(lineId: LineId): Promise<void> {
    if (this.#currentLineId !== lineId) return Promise.resolve();
    return new Promise((res) => {
      let set = this.#twWaiters.get(lineId);
      if (!set) {
        set = new Set();
        this.#twWaiters.set(lineId, set);
      }
      set.add(res);
    });
  }

  #resolveTw(lineId: LineId): void {
    const set = this.#twWaiters.get(lineId);
    if (!set) return;
    this.#twWaiters.delete(lineId);
    for (const fn of set) fn();
  }

  /** 取消当前行打字机并放行全部等待者(打断/重放/停生成) */
  cancelTypewriter(): void {
    this.#tw.cancel();
    const cur = this.#currentLineId;
    this.#currentLineId = null;
    if (cur) this.#resolveTw(cur);
  }

  /** 舞台呈现快照(M5 存档用) */
  presentationSnapshot(): PresentationSnapshot {
    return this.stage.snapshot();
  }

  // ---- 游玩时间与存档(M5) ----

  #playTimeSec = 0;
  #playClockAt: number | null = null; // Date.now() 锚点;null = 未开始计时
  #readState: string[] = [];

  /** 累计游玩秒数(检查点制:toSaveData/restoreFromSave 落账,无定时器) */
  get playTimeSec(): number {
    return this.#playClockAt === null ? this.#playTimeSec : this.#playTimeSec + (Date.now() - this.#playClockAt) / 1000;
  }

  /** 开始计时(标题点スタート时调;重复调用无害) */
  startPlayClock(): void {
    if (this.#playClockAt === null) this.#playClockAt = Date.now();
  }

  #checkpointPlayTime(): void {
    this.#playTimeSec = this.playTimeSec;
    this.#playClockAt = Date.now();
  }

  /**
   * 存档快照(plan §1.6):ledger 按摘要游标裁剪、cursor 独立存、
   * currentBeat 在场 = writing 中点保存(pendingContinuation)。
   * summary/outlineBeatIndex/currentBeat 由 BeatRunner 持有,经 parts 注入。
   */
  toSaveData(
    parts: { summary?: Summary; outlineBeatIndex?: number | null; currentBeat?: SaveCurrentBeat | null } = {},
  ): SaveData {
    const summary = parts.summary ?? EMPTY_SUMMARY;
    this.#checkpointPlayTime();
    const label = parts.currentBeat
      ? `${parts.currentBeat.turnNo}拍目:${parts.currentBeat.directive.goal}`
      : `${this.#turnNo}拍目`;
    return {
      version: 1,
      meta: { savedAt: new Date().toISOString(), playTimeSec: this.#playTimeSec, chapterLabel: label },
      world: this.#world,
      summary,
      ledger: trimLedger(this.#ledger, summary.summarizedThroughLineId),
      presentation: this.presentationSnapshot(),
      cursor: this.cursor,
      outlineBeatIndex: parts.outlineBeatIndex ?? null,
      pendingContinuation: parts.currentBeat != null,
      currentBeat: parts.currentBeat ?? null,
      readState: [...this.#readState],
    };
  }

  /**
   * 从存档恢复引擎侧状态:ledger/world/cursor/舞台终态/游玩时间。
   * 摘要与拍进行中信息(summary/currentBeat)归 BeatRunner.restore,由 SaveSystem 协调。
   * 拍状态以 save.cursor 为准——摘要裁剪可能清空 ledger,replay 的空档分支(新游戏语义)
   * 会把拍号回退到 1;仅「cursor={1,0} 且零提交」视作真新档。
   */
  restoreFromSave(save: SaveData): void {
    this.#readState = [];
    this.replay(save.ledger);
    const fresh = save.ledger.length === 0 && save.cursor.turnNo === 1 && save.cursor.seq === 0;
    if (!fresh) this.resumeTurn(save.cursor.turnNo, save.cursor.seq);
    this.stage.restore(save.presentation); // bg/bgm 权威值(replay 不覆盖 bgm)
    this.#playTimeSec = save.meta.playTimeSec;
    this.#playClockAt = Date.now();
    this.setPhase("play");
  }

  // ---- 内部 ----

  #present(lineId: LineId, text: string): void {
    // 新行顶替旧行:旧行的等待者立即放行(演出链快速跟进)
    if (this.#currentLineId && this.#currentLineId !== lineId) this.#resolveTw(this.#currentLineId);
    this.#currentLineId = lineId;
    void this.#tw.start(text).then(() => {
      this.#resolveTw(lineId);
      if (this.#currentLineId === lineId) {
        this.bus.emit("typewriter:done", { lineId });
      }
    });
  }

  #sanitizeEmotion(who: SpeakerId, emotion: EmotionTag): EmotionTag {
    if (!this.content.characterIds.has(who)) {
      this.warn(`未知角色「${who}」的台词照常上屏(立绘/语音跳过)`);
      return "";
    }
    if (emotion && this.content.emotionsOf(who).has(emotion)) return emotion;
    const fallback = this.content.defaultExprOf(who);
    if (emotion) this.warn(`未知表情「${emotion}」@${who} → 回退「${fallback || "(无立绘)"}」`);
    return fallback;
  }

  #sanitizeChoice(ev: Extract<ScriptEvent, { t: "choice" }>): Extract<ScriptEvent, { t: "choice" }> {
    const options = ev.options.filter((o) => o && typeof o.id === "string" && o.id.length > 0);
    if (options.length !== ev.options.length) {
      this.warn("选项含空 id,已剔除");
    }
    if (options.length === 0) {
      this.warn("选项为空,插入占位「……」");
      options.push({ id: "fallback", label: "……" });
    }
    let defaultId = ev.defaultOptionId;
    if (!options.some((o) => o.id === defaultId)) {
      defaultId = options[0]!.id;
      this.warn(`defaultOptionId 无效 → 回退「${defaultId}」`);
    }
    return { ...ev, options, defaultOptionId: defaultId };
  }

  #applyStageOp(op: Extract<ScriptEvent, { t: "stage" }>["op"], replay = false): void {
    switch (op.kind) {
      case "bg":
        this.stage.bg(op.asset, op.transition ?? "fade");
        break;
      case "sprite":
        this.stage.sprite({ who: op.who, slot: op.slot, action: op.action, emotion: op.emotion });
        break;
      case "shake":
        if (!replay) this.stage.shake();
        break;
      case "flash":
        if (!replay) this.stage.flash();
        break;
      case "bgm":
        // replay 跳过:读档走 presentation.bgm 权威恢复(bootstrap),避免重触发淡入
        if (replay) break;
        if (op.action === "stop") this.#onBgm?.(null);
        else this.#onBgm?.(op.asset ?? null, op.fadeMs);
        break;
      case "se":
        if (!replay) this.#onSe?.(op.asset);
        break;
    }
  }
}

/** 选项 delta 过 schema(坑⑮):合法返回 delta,非法返回 undefined 并触发 onBad */
export function parseChoiceDelta(
  raw: unknown,
  onBad: (msg: string) => void,
): ReturnType<typeof WorldDeltaSchema.parse> | undefined {
  if (raw === undefined) return undefined;
  const r = WorldDeltaSchema.safeParse(raw);
  if (!r.success) {
    onBad(`WorldDelta 不合法,已丢弃:${JSON.stringify(r.error.issues)}`);
    return undefined;
  }
  return r.data;
}
