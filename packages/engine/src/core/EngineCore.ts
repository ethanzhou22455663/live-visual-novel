/**
 * EngineCore(2026-10-17 显示泵重写):游戏状态唯一持有者——ledger、游标、phase 状态机、
 * 模型事件提交事务点、显示队列泵。副作用只经 EventBus 与端口;DOM 仅打字机目标元素。
 * BeatRunner 是唯一"驾驶者";React 经 snapshot/subscribe 只读。
 *
 * 显示泵(commit/显示彻底分离,核心裁决"写剧本然后一句一句对话"):
 * - commitModel 只做状态入账(行号/ledger/line:commit/notify),演出一律入 #queue
 * - 泵逐条消费:line = 打字 + 定步(normal 打完停住**等点击**;auto/fast 停留),
 *   stage = 到达时应用(屏幕所见恒等于正在读的行),choice = 到达时 offer 等玩家
 * - advance 两段式(mock 同款手感):打字中 = 补完文本(停留本行);等待中 = 放行下一行;
 *   打字中双击 = 补完即放行(连点不被吞)
 * - 取消用 epoch 代际:replay/newGame 令旧泵退出;泵的一切等待过 #cancellable 壳,
 *   绝不挂在被 cancel 的 Typewriter(其 start promise 永不 resolve)上
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
  ActPlan,
  ClockMode,
  ContentPort,
  EmotionTag,
  GameEventMap,
  LineId,
  LedgerEntry,
  ModelScriptEvent,
  PresentationSnapshot,
  PublicChoiceOffer,
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

/** 显示队列条目:commit 入队,泵按序消费(演出与生成的解耦边界) */
export type DisplayEntry =
  | { kind: "line"; lineId: LineId; ev: Extract<ScriptEvent, { t: "say" | "narrate" }> }
  | { kind: "stage"; lineId: LineId; op: Extract<ScriptEvent, { t: "stage" }>["op"] }
  | { kind: "choice"; lineId: LineId; offer: PublicChoiceOffer };

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
  /** 每秒字数(设置面板 M6 可调;默认同 P0) */
  cps?: number;
  /** BGM 指令出口(bootstrap 接 AudioBus;null=stop);不设 = 无声玩法(headless) */
  onBgm?: (assetId: string | null, fadeMs?: number) => void;
  onSe?: (assetId: string) => void;
  /** 上屏文本源(app 层注入:UI 语言=中文且已有译文时显示 zh;缺省 = ev.text 日文原文)。
   *  可返回 Promise:译文未就位时 app 等预取翻译(自带超时回退),泵在此挂起等文本。
   *  lineId 供 app 精确对应等待中的译文(2026-10-28 裁决:中文显示不许忽明忽暗) */
  textOf?: (ev: Extract<ScriptEvent, { t: "say" | "narrate" }>, lineId: LineId) => string | Promise<string>;
  /** 译文显示开关(app 层注入:() => uiLang === "zh";缺省 = 有译文就显示)。
   *  日文模式下选项浮层不许显示中文(2026-10-28 用户反馈):开关关时 zh 一律不呈现 */
  zhOn?: () => boolean;
}

const AUTO_DWELL_MS = 800; // auto 模式行间停留(沿旧值)
const FAST_DWELL_MS = 120; // fast(Ctrl)行间停留:防止百行同帧刷完导致事件风暴

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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
  #choiceOverlay: ChoiceOverlay | null = null;
  #pendingChoiceLineId: LineId | null = null; // 停等中选项的 lineId(attachChoiceLabels 原地换中文用)
  #onBgm: ((assetId: string | null, fadeMs?: number) => void) | null;
  #onSe: ((assetId: string) => void) | null;
  #textOf:
    | ((ev: Extract<ScriptEvent, { t: "say" | "narrate" }>, lineId: LineId) => string | Promise<string>)
    | null;
  #zhOn: (() => boolean) | null;

  // ---- 显示泵状态 ----
  #queue: DisplayEntry[] = [];
  #pumping = false;
  #pumpEpoch = -1; // 在跑的泵属于哪个代际(cancel 后旧泵让位,新泵接管 #pumping)
  #epoch = 0; // 取消代际:replay/newGame 令旧泵退出
  #gate: Promise<void> | null = null; // normal 模式的点击门(每行一个)
  #openGate: (() => void) | null = null;
  /** 打字中点击过的行(连点手感:第二击 = 补完即放行) */
  #armedFor: LineId | null = null;
  #armedClicks = 0;
  #cancelWaiters = new Set<() => void>(); // epoch 取散播点(#cancellable 壳)
  #idleWaiters = new Set<{ res: () => void }>();
  #choiceWaiters = new Set<() => void>(); // 选项停等(resolveChoice 成功后放行)
  #displayedThrough: LineId | null = null;

  constructor(deps: EngineCoreDeps) {
    this.bus = deps.bus;
    this.clock = deps.clock;
    this.stage = deps.stage;
    this.content = deps.content;
    this.#onBgm = deps.onBgm ?? null;
    this.#onSe = deps.onSe ?? null;
    this.#textOf = deps.textOf ?? null;
    this.#zhOn = deps.zhOn ?? null;
    this.#tw = new Typewriter(deps.textEl, { cps: deps.cps ?? 30 });
    if (deps.choiceRoot) {
      this.#choiceOverlay = new ChoiceOverlay({
        bus: this.bus,
        root: deps.choiceRoot,
        onPick: (id) => this.resolveChoice(id),
        zhOn: () => this.#zhOn?.() ?? true,
      });
    }
    // 门等待中被切 fast/auto → 立即放行当前行(2026-10-17 裁决:skip 模式已移除,
    // 选项永远停等玩家,不再有任何自动选)
    this.clock.onModeChange((mode) => {
      if (mode !== "normal") this.#releaseGate();
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

  /** 最后已看行(显示泵游标;存档 displayedThrough / 读档名牌同步用) */
  get displayedThrough(): LineId | null {
    return this.#displayedThrough;
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
   * 提交事务点(§1.4):成员校验/净化 → 补拍号 → ledger → bus line:commit。
   * 演出全部入显示队列(泵逐条消费,见 #drain)——流式生成再快也不扰动画面,
   * 对话节奏只由玩家点击(或 auto/fast 模式)驱动。不抛错——编剧输出是随机的,
   * 违规一律净化+告警,剧情不断。
   */
  commitModel(m: ModelScriptEvent): { ev: ScriptEvent; lineId: LineId } {
    const turnNo = this.#turnNo;
    const seq = this.#seq;
    const lineId = makeLineId(turnNo, seq);
    let ev = commitModelEvent(m, turnNo);

    switch (ev.t) {
      case "say": {
        ev = { ...ev, emotion: this.#sanitizeEmotion(ev.who, ev.emotion) };
        this.#queue.push({ kind: "line", lineId, ev });
        break;
      }
      case "narrate": {
        this.#queue.push({ kind: "line", lineId, ev });
        break;
      }
      case "stage": {
        this.#queue.push({ kind: "stage", lineId, op: ev.op });
        break;
      }
      case "choice": {
        ev = this.#sanitizeChoice(ev);
        this.#queue.push({ kind: "choice", lineId, offer: this.#publicOfferOf(ev) });
        break;
      }
    }

    this.#ledger.push({ kind: "ev", lineId, turnNo, seq, ev });
    this.#seq = seq + 1;
    this.bus.emit("line:commit", { event: ev, lineId });
    this.#notify();
    this.#kickPump();
    return { ev, lineId };
  }

  /**
   * 玩家选择(M3 起由 BeatRunner/UI 调):校验属组 → 自身+hidden delta 合并过 schema
   * → world 入账 → ledger 追加 choice 条目 → bus choice:resolved → 回 play → 放行泵的选项停等。
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
    this.#pendingChoiceLineId = null;
    this.setPhase("play");
    this.bus.emit("choice:resolved", { optionId: opt.id, label: opt.label });
    for (const w of [...this.#choiceWaiters]) w(); // 放行泵的选项停等
    this.#choiceWaiters.clear();
    this.#notify();
    return { optionId: opt.id, label: opt.label };
  }

  // ---- 重放(读档/回溯;不发 line:commit/line:show,backlog/语音订阅者不受扰动) ----

  /**
   * 字幕翻译回写(app 层非核心,2026-10-18):更新 ledger ev 的 zh 并通知
   * (SaveData 随档持久化,回看/读档自然带中文)。已提交行不重打——显示中的行
   * 保持原文,译文下一行生效;仍在显示队列里的行同步补上(泵到达时已可显示中文)。
   */
  attachTranslations(entries: readonly { lineId: LineId; zh: string }[]): void {
    if (entries.length === 0) return;
    const byId = new Map(entries.map((e) => [e.lineId, e.zh]));
    let changed = false;
    this.#ledger = this.#ledger.map((e) => {
      if (e.kind !== "ev") return e;
      const ev = e.ev;
      const zh = byId.get(e.lineId);
      if ((ev.t !== "say" && ev.t !== "narrate") || zh === undefined) return e;
      changed = true;
      return { ...e, ev: { ...ev, zh } };
    });
    if (changed) {
      this.#queue = this.#queue.map((q) =>
        q.kind === "line" && byId.has(q.lineId) ? { ...q, ev: { ...q.ev, zh: byId.get(q.lineId)! } } : q,
      );
      this.#notify();
    }
  }

  /**
   * 选项中文回写(app 翻译层,非核心;2026-10-28 用户裁决:选项不许只有日文):
   * 更新 ledger choice 事件的 prompt/options[].zh、显示队列里的 offer;
   * 若该组正停等玩家,#pendingChoice 原地更新并广播 choice:labels——浮层把按钮换成中文。
   * 存档往返:zh 在 ledger ev 上,随 SaveData 持久化(schema 已收编)。
   */
  attachChoiceLabels(
    entries: readonly { lineId: LineId; prompt?: string; labels: readonly { optionId: string; zh: string }[] }[],
  ): void {
    if (entries.length === 0) return;
    const byLine = new Map(entries.map((e) => [e.lineId, e]));
    let changed = false;
    this.#ledger = this.#ledger.map((e) => {
      if (e.kind !== "ev" || e.ev.t !== "choice") return e;
      const upd = byLine.get(e.lineId);
      if (!upd) return e;
      changed = true;
      return { ...e, ev: this.#choiceEvWithZh(e.ev, upd) };
    });
    this.#queue = this.#queue.map((q) => {
      if (q.kind !== "choice") return q;
      const upd = byLine.get(q.lineId);
      if (!upd) return q;
      changed = true;
      return { ...q, offer: this.#offerWithZh(q.offer, upd) };
    });
    if (this.#pendingChoice && this.#pendingChoiceLineId && byLine.has(this.#pendingChoiceLineId)) {
      this.#pendingChoice = this.#offerWithZh(this.#pendingChoice, byLine.get(this.#pendingChoiceLineId)!);
      this.bus.emit("choice:labels", { choice: this.#pendingChoice });
      changed = true;
    }
    if (changed) this.#notify();
  }

  /** 语言切换后重画开着的选项浮层(浮层渲染时实时读 zhOn,重发一次即可) */
  refreshChoice(): void {
    if (this.#pendingChoice) this.bus.emit("choice:labels", { choice: this.#pendingChoice });
  }

  /** choice 事件套上中文(promptZh/options[].zh;原文不动,不覆盖已有译文) */
  #choiceEvWithZh(
    ev: Extract<ScriptEvent, { t: "choice" }>,
    upd: { prompt?: string; labels: readonly { optionId: string; zh: string }[] },
  ): Extract<ScriptEvent, { t: "choice" }> {
    const zhOf = new Map(upd.labels.map((l) => [l.optionId, l.zh]));
    return {
      ...ev,
      promptZh: ev.prompt !== undefined ? (upd.prompt ?? ev.promptZh) : ev.promptZh,
      options: ev.options.map((o) => (zhOf.has(o.id) && !o.zh ? { ...o, zh: zhOf.get(o.id) } : o)),
    };
  }

  /** 公开 offer 套上中文(promptZh/options[].zh) */
  #offerWithZh(
    offer: PublicChoiceOffer,
    upd: { prompt?: string; labels: readonly { optionId: string; zh: string }[] },
  ): PublicChoiceOffer {
    const zhOf = new Map(upd.labels.map((l) => [l.optionId, l.zh]));
    return {
      ...offer,
      promptZh: upd.prompt ?? offer.promptZh,
      options: offer.options.map((o) => (zhOf.has(o.id) && !o.zh ? { ...o, zh: zhOf.get(o.id) } : o)),
    };
  }

  /**
   * 状态按 entries 全量恢复;舞台视觉只按 visuals(=已看前缀)重放。
   * restoreFromSave 用两段式:未读尾部经队列重建(#enqueueFromLedger)让玩家重读。
   */
  replay(entries: readonly LedgerEntry[], visuals: readonly LedgerEntry[] = entries): void {
    this.#cancelDisplay();
    this.stage.reset();
    this.#ledger = [...entries];
    this.#world = foldWorld(entries);
    this.#pendingChoice = null; // 选项即时性:重放不恢复"等玩家"状态(未读尾部的 choice 由队列重新 offer)
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
    // 视觉终态:按序应用 bg/sprite + 台词表情(与泵显示语义一致);shake/flash 是瞬态特效,重放跳过
    for (const e of visuals) {
      if (e.kind !== "ev") continue;
      const ev = e.ev;
      if (ev.t === "stage") {
        this.#applyStageOp(ev.op, /* replay */ true);
      } else if (ev.t === "say" && ev.emotion) {
        this.#applyStageOp({ kind: "sprite", who: ev.who, action: "diff", emotion: ev.emotion }, /* replay */ true);
      }
    }
    this.#notify();
  }

  /** 推进(点击/Enter,两段式,mock 同款手感):打字中 = 瞬间补完;等待中 = 放行下一行 */
  advance(): void {
    if (this.#tw.typing) {
      this.#tw.skip(); // 第一击:补完当前行文本,停留本行
      if (this.#armedFor === this.#currentLineId) {
        this.#armedClicks += 1; // 打字中的第二击 = 放行意图:补完即自动前进
      } else {
        this.#armedFor = this.#currentLineId;
        this.#armedClicks = 1;
      }
      return;
    }
    this.#releaseGate(); // 第二击:放行点击门 / 截断 dwell(无门在等 = 无操作,不缓存点击)
  }

  // ---- 显示泵(commit/显示分离的核心) ----

  #kickPump(): void {
    if (this.#pumping && this.#pumpEpoch === this.#epoch) return;
    this.#pumping = true;
    this.#pumpEpoch = this.#epoch;
    void this.#drain(this.#epoch);
  }

  async #drain(epoch: number): Promise<void> {
    try {
      while (this.#queue.length > 0 && this.#epoch === epoch && this.#phase !== "title") {
        const entry = this.#queue.shift()!;
        const ok = await this.#showEntry(entry, epoch);
        if (!ok || this.#epoch !== epoch) break;
        this.#displayedThrough = entry.lineId;
        this.#notify();
      }
    } finally {
      if (this.#epoch === epoch) {
        // 代际已换(replay/newGame):#pumping 归新泵管,这里什么都不动
        this.#pumping = false;
        if (this.#queue.length === 0) {
          this.bus.emit("display:drained", { displayedThrough: this.#displayedThrough });
          this.#resolveIdle();
        }
      }
    }
  }

  async #showEntry(entry: DisplayEntry, epoch: number): Promise<boolean> {
    switch (entry.kind) {
      case "stage":
        // 到达即应用:bg/立绘/音频指令在玩家读到这一刻才生效
        this.#applyStageOp(entry.op);
        return true;
      case "choice":
        return this.#showChoice(entry, epoch);
      case "line":
        return this.#showLine(entry, epoch);
    }
  }

  /** 一行 = 打字 + 定步。normal:硬点击门(打完停住等点击——"一句一句对话"的核心);fast/auto:停留 */
  async #showLine(entry: Extract<DisplayEntry, { kind: "line" }>, epoch: number): Promise<boolean> {
    const ev = entry.ev;
    // ① 显示语义:台词表情驱动立绘 + line:show(名牌与语音的入口)。
    //    say.emotion 是表情的权威来源(2026-10-17 手验:表情只靠编剧显式 sprite op 会被
    //    下一拍的 enter(平常) 重置——台词到哪句,表情跟到哪句);空表情=保持现状不动。
    //    diff 对未出场角色被舞台忽略,不会凭空冒立绘。
    this.#armedFor = null;
    this.#armedClicks = 0;
    this.#closeGate();
    this.#currentLineId = entry.lineId;
    if (ev.t === "say" && ev.emotion) {
      this.#applyStageOp({ kind: "sprite", who: ev.who, action: "diff", emotion: ev.emotion });
    }
    this.bus.emit("line:show", { lineId: entry.lineId, ev });
    this.#notify();
    // ② 打字(fast 入队即瞬完;打字中点击 → 补完 + 连点计数)。
    //    textOf 只换上屏文本:语音/日志/切句仍用原始 ev.text(日语),配音节奏不变。
    //    textOf 可异步(等译文):过 #cancellable 壳,epoch 取消时随之退出;
    //    同步返回(含未注入)保持旧语义——commit 即开打,不引入微任务空窗
    const src = this.#textOf ? this.#textOf(ev, entry.lineId) : ev.text;
    const text = typeof src === "string" ? src : await this.#cancellable(epoch, src);
    if (text === null) return false;
    const typing = this.#tw.start(text);
    if (this.clock.mode === "fast") this.#tw.skip();
    if ((await this.#cancellable(epoch, typing)) === null) return false;
    this.bus.emit("typewriter:done", { lineId: entry.lineId });
    this.#notify();
    // ③ 定步:读**当下**模式(不是入队时)
    const mode = this.clock.mode;
    if (this.#armedFor === entry.lineId && this.#armedClicks >= 2) {
      this.#armedFor = null; // 打字中双击:补完即放行
      return true;
    }
    if (mode === "normal") {
      // 硬点击门:玩家不点,画面永不动(单击补完的行也停在这里等第二击)
      return (await this.#cancellable(epoch, this.#waitGate())) !== null;
    }
    // fast/auto:停留,可被点击(或模式切换)截断
    const dwell = delay(mode === "auto" ? AUTO_DWELL_MS : FAST_DWELL_MS);
    const r = await this.#cancellable(epoch, Promise.race([dwell, this.#waitGate()]));
    this.#closeGate(); // 截断/到点都收门,防误放下一条
    return r !== null;
  }

  async #showChoice(entry: Extract<DisplayEntry, { kind: "choice" }>, epoch: number): Promise<boolean> {
    this.#pendingChoice = entry.offer;
    this.#pendingChoiceLineId = entry.lineId;
    this.setPhase("choicing");
    this.bus.emit("choice:offered", { choice: entry.offer });
    this.#notify();
    // 停等玩家(2026-10-17 裁决:skip 已移除,选项永远手动);resolveChoice 成功后放行
    // (cancel/读档走 #cancellable 退出)
    const r = await this.#cancellable(epoch, new Promise<void>((res) => this.#choiceWaiters.add(res)));
    return r !== null;
  }

  /**
   * 泵统一等待壳:epoch 取消(replay/newGame)先到 → null。
   * 必须用它包一切泵内等待——Typewriter.cancel 后 start promise 永不 resolve,
   * 裸 await 会让旧泵挂在 #pumping=true 上永久堵死后续 kick(本设计唯一的"必错"点)。
   */
  #cancellable<T>(epoch: number, p: Promise<T>): Promise<T | null> {
    if (this.#epoch !== epoch) return Promise.resolve(null);
    let off: () => void = () => {};
    const cancelled = new Promise<null>((res) => {
      const w = () => res(null);
      this.#cancelWaiters.add(w);
      off = () => {
        this.#cancelWaiters.delete(w);
      };
    });
    return Promise.race([
      p.then(
        (v) => {
          off();
          return this.#epoch === epoch ? v : null;
        },
        () => {
          off();
          return null;
        },
      ),
      cancelled,
    ]);
  }

  #waitGate(): Promise<void> {
    this.#gate ??= new Promise<void>((res) => {
      this.#openGate = res;
    });
    return this.#gate;
  }

  #releaseGate(): void {
    this.#openGate?.();
    this.#openGate = null;
  }

  #closeGate(): void {
    this.#gate = null;
    this.#openGate = null;
  }

  /** 取消当前显示(读档/新游戏):换代际 + 清队 + 放行一切等待;旧泵在下个 await 处退出 */
  #cancelDisplay(): void {
    this.#epoch += 1;
    this.#queue = [];
    this.#armedFor = null;
    this.#armedClicks = 0;
    this.#closeGate();
    this.#tw.cancel();
    this.#currentLineId = null;
    this.#pendingChoiceLineId = null;
    this.#displayedThrough = null;
    for (const w of [...this.#cancelWaiters]) w();
    this.#cancelWaiters.clear();
    for (const w of [...this.#choiceWaiters]) w();
    this.#choiceWaiters.clear();
    this.#resolveIdle();
  }

  /** 显示队列排空(含选项已决)时 resolve;signal abort 亦 resolve(BeatRunner 的 choice 拍等待用) */
  whenIdle(signal?: AbortSignal): Promise<void> {
    if (!this.#pumping && this.#queue.length === 0) return Promise.resolve();
    if (signal?.aborted) return Promise.resolve(); // 先于注册已 aborted:监听器永不触发会悬挂(审计 B4)
    return new Promise<void>((res) => {
      const w = { res };
      this.#idleWaiters.add(w);
      signal?.addEventListener(
        "abort",
        () => {
          this.#idleWaiters.delete(w);
          res();
        },
        { once: true },
      );
    });
  }

  #resolveIdle(): void {
    for (const w of [...this.#idleWaiters]) w.res();
    this.#idleWaiters.clear();
  }

  /** 舞台呈现快照(M5 存档用) */
  presentationSnapshot(): PresentationSnapshot {
    return this.stage.snapshot();
  }

  // ---- 游玩时间与存档(M5) ----

  #playTimeSec = 0;
  #playClockAt: number | null = null; // Date.now() 锚点;null = 未开始计时

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
   * currentAct 在场 = 幕写作中保存(pendingContinuation)。
   * displayedThrough = 泵游标(读档按它切"已看/未读",未读尾部重读)。
   * summary/outlineBeatIndex/currentAct 由 BeatRunner 持有,经 parts 注入。
   */
  toSaveData(
    parts: {
      summary?: Summary;
      outlineBeatIndex?: number | null;
      /** 写作中的幕(幕制 2026-10-18);在场 = pendingContinuation */
      currentAct?: ActPlan | null;
      /** 全局走向(runner 持有;空 = 未生成) */
      storyDirection?: string;
      /** 已完成幕数 */
      actsDone?: number;
      /** 当前个人线女主(三段式 2026-10-18;null/缺省 = 共通线) */
      route?: string | null;
      /** 进入个人线时的 actsDone(线内幕数 = actsDone - routeSince) */
      routeSince?: number;
    } = {},
  ): SaveData {
    const summary = parts.summary ?? EMPTY_SUMMARY;
    this.#checkpointPlayTime();
    const label = parts.currentAct ? `${this.#turnNo}幕:${parts.currentAct.actGoal}` : `${this.#turnNo}幕`;
    return {
      version: 1,
      meta: { savedAt: new Date().toISOString(), playTimeSec: this.#playTimeSec, chapterLabel: label },
      world: this.#world,
      summary,
      ledger: trimLedger(this.#ledger, summary.summarizedThroughLineId),
      presentation: this.presentationSnapshot(),
      cursor: this.cursor,
      outlineBeatIndex: parts.outlineBeatIndex ?? null,
      pendingContinuation: parts.currentAct != null,
      currentAct: parts.currentAct ? { plan: parts.currentAct } : null,
      storyDirection: parts.storyDirection || undefined,
      actsDone: parts.actsDone,
      route: parts.route ?? null,
      routeSince: parts.routeSince ?? 0,
      displayedThrough: this.#displayedThrough ?? undefined,
    };
  }

  /**
   * 从存档恢复引擎侧状态:ledger/world/cursor/舞台/游玩时间 + 未读尾部队列重建。
   * displayedThrough 命中 → 已看前缀同步 replay(视觉),未读尾部入显示队列让玩家重读
   * (未决 choice 重新 offer);命中不了(旧档/被摘要裁剪)→ 全部视为已看,旧行为。
   * 摘要与幕进行中信息(summary/currentAct)归 BeatRunner.restore,由 SaveSystem 协调。
   * 拍状态以 save.cursor 为准——摘要裁剪可能清空 ledger,replay 的空档分支(新游戏语义)
   * 会把拍号回退到 1;仅「cursor={1,0} 且零提交」视作真新档。
   */
  restoreFromSave(save: SaveData): void {
    const idx = save.displayedThrough ? save.ledger.findIndex((e) => e.lineId === save.displayedThrough) : -1;
    const shown = idx >= 0 ? save.ledger.slice(0, idx + 1) : save.ledger;
    const unseen = idx >= 0 ? save.ledger.slice(idx + 1) : [];
    this.replay(save.ledger, shown);
    const fresh = save.ledger.length === 0 && save.cursor.turnNo === 1 && save.cursor.seq === 0;
    if (!fresh) this.resumeTurn(save.cursor.turnNo, save.cursor.seq);
    if (unseen.length === 0) {
      this.stage.restore(save.presentation); // bg 权威值(replay 不覆盖;全看过才叠终态)
    }
    // unseen 非空:replay(shown) 的视觉重放已重建"存档时所见"的 bg/立绘,不叠加终态
    // (终态由未读尾部的 stage 条目在显示时逐步重建)。拍中切 bg 罕见(通常拍首),接受。
    this.#playTimeSec = save.meta.playTimeSec;
    this.#playClockAt = Date.now();
    this.#displayedThrough = shown.length > 0 ? shown[shown.length - 1]!.lineId : null;
    this.setPhase("play");
    for (const e of unseen) this.#enqueueFromLedger(e);
    this.#kickPump();
  }

  // ---- 内部 ----

  /** 未读尾部按 ledger 形态还原为显示条目(kind:"choice" 是已决的历史记录,不可显示) */
  #enqueueFromLedger(e: LedgerEntry): void {
    if (e.kind === "choice") return;
    switch (e.ev.t) {
      case "say":
      case "narrate":
        this.#queue.push({ kind: "line", lineId: e.lineId, ev: e.ev });
        break;
      case "stage":
        this.#queue.push({ kind: "stage", lineId: e.lineId, op: e.ev.op });
        break;
      case "choice":
        // 未决选项(存档时停等中)→ 泵到达时重新 offer
        this.#queue.push({ kind: "choice", lineId: e.lineId, offer: this.#publicOfferOf(e.ev) });
        break;
    }
  }

  #publicOfferOf(ev: Extract<ScriptEvent, { t: "choice" }>): PublicChoiceOffer {
    return {
      prompt: ev.prompt,
      promptZh: ev.promptZh, // 读档重建队列也带上译文(ledger 已持久化的 zh 不丢)
      options: ev.options.map((o) => {
        const base: PublicChoiceOffer["options"][number] = { id: o.id, label: o.label };
        return {
          ...base,
          ...(o.zh !== undefined ? { zh: o.zh } : {}),
          ...(o.delta !== undefined ? { delta: o.delta } : {}),
        };
      }),
      defaultOptionId: ev.defaultOptionId,
    };
  }

  #sanitizeEmotion(who: SpeakerId, emotion: EmotionTag): EmotionTag {
    if (!this.content.characterIds.has(who)) {
      this.#warnOnce(`unknown-char:${who}`, `未知角色「${who}」的台词照常上屏(立绘/语音跳过;此后不再提示)`);
      return "";
    }
    // 无立绘角色(主人公类,emotionsOf 空):表情无视觉意义,原样保留不校验不告警
    // (2026-10-18 裁决:男主无立绘,他的"表情回退"提示全是噪音)
    const emotions = this.content.emotionsOf(who);
    if (emotions.size === 0) return emotion;
    if (emotion && emotions.has(emotion)) return emotion;
    const fallback = this.content.defaultExprOf(who);
    if (emotion) {
      this.#warnOnce(`bad-emotion:${who}`, `未知表情「${emotion}」@${who} → 回退「${fallback || "(无)"}」(此后不再提示)`);
    }
    return fallback;
  }

  /** 同类告警每 key 只打一次(97bdf30 同款去刷屏;表情/未知角色逐行触发会淹掉控制台) */
  #warned = new Set<string>();
  #warnOnce(key: string, msg: string): void {
    if (this.#warned.has(key)) return;
    this.#warned.add(key);
    this.warn(msg);
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
