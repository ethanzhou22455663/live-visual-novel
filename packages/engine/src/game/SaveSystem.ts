/**
 * SaveSystem(plan §1.6/M5):槽位管理 + auto 存档 + 读档续写的协调者。
 * - 槽位:自动 1 槽 + 手动 3 槽(用户裁决,无 quick);存储经 StoragePort(app 注入
 *   LocalStorageAdapter,测试注入 MemoryStorage)
 * - 写入时机:显示边界。幕写作中手动存档 → 挂起到下一个 display:drained(泵排空,
 *   commit 现遥遥领先于显示,必须在显示边界兑现)快照,此时 runner.currentAct 在场
 *   ⇒ pendingContinuation=true
 * - auto 触发:beat:end(beatEnd/sceneEnd)与 choice:resolved(choice 收束瞬间)
 * - 读档:EngineCore.restoreFromSave(引擎侧)+ BeatRunner.restore(摘要/拍进行中),
 *   pendingContinuation ⇒ 下一轮 run() 跳过导演续写同一拍
 */
import {
  SAVE_SLOTS,
  StorageQuotaError,
  isSaveSlot,
  migrateSave,
} from "@gal/shared";
import type { SaveData, SaveSlot, StoragePort } from "@gal/shared";
import type { EngineCore } from "../core/EngineCore.ts";
import type { EventBus } from "../core/EventBus.ts";
import type { BeatRunner } from "../core/BeatRunner.ts";

export interface SaveSystemDeps {
  engine: EngineCore;
  bus: EventBus;
  storage: StoragePort;
  /** runner 在 bootstrap 中惰性创建(start 手势里),经 getter 注入 */
  getRunner?: () => BeatRunner | null;
}

export interface SaveResult {
  ok: boolean;
  /** writing 中点:已受理,等下一个行边界落盘 */
  deferred?: boolean;
  reason?: "quota" | "bad-data";
}

export interface SlotSummary {
  slot: SaveSlot;
  data: SaveData | null;
  error: string | null;
}

export class SaveSystem {
  #engine: EngineCore;
  #bus: EventBus;
  #storage: StoragePort;
  #getRunner: () => BeatRunner | null;
  /** writing 中点受理的存档(per-slot:反复手动存不同槽互不覆盖;审计 M3) */
  #deferredSlots = new Map<SaveSlot, string | undefined>();
  #offs: Array<() => void> = [];

  constructor(deps: SaveSystemDeps) {
    this.#engine = deps.engine;
    this.#bus = deps.bus;
    this.#storage = deps.storage;
    this.#getRunner = deps.getRunner ?? (() => null);

    this.#offs.push(
      deps.bus.on("display:drained", () => {
        if (this.#deferredSlots.size === 0) return;
        const pending = [...this.#deferredSlots];
        this.#deferredSlots.clear();
        for (const [slot, label] of pending) this.#writeNow(slot, label); // 此刻 currentAct 在场 ⇒ pendingContinuation
      }),
      // choice:resolved 已在 choice 事务点发出 → world 已折叠,快照即所选结果
      deps.bus.on("choice:resolved", () => this.save("auto")),
      deps.bus.on("beat:end", ({ result }) => {
        if (result !== "choice") this.save("auto");
      }),
    );
  }

  dispose(): void {
    for (const off of this.#offs) off();
    this.#offs = [];
  }

  get slots(): readonly SaveSlot[] {
    return SAVE_SLOTS;
  }

  /**
   * 存档。显示边界(泵排空/拍间/停止中)即时落盘;writing 中点挂起到下一个 display:drained。
   */
  save(slot: SaveSlot, label?: string): SaveResult {
    if (!isSaveSlot(slot)) return { ok: false, reason: "bad-data" };
    const runner = this.#getRunner();
    if (runner?.running && runner.currentAct) {
      this.#deferredSlots.set(slot, label);
      return { ok: true, deferred: true };
    }
    return this.#writeNow(slot, label);
  }

  #writeNow(slot: SaveSlot, label?: string): SaveResult {
    const runner = this.#getRunner();
    const data = this.#engine.toSaveData({
      summary: runner?.summary,
      outlineBeatIndex: runner?.outlineBeatIndex ?? null,
      currentAct: runner?.currentAct ?? null,
      storyDirection: runner?.storyDirection ?? "",
      actsDone: runner?.actsDone ?? 0,
      route: runner?.route ?? null,
      routeSince: runner?.routeSince ?? 0,
    });
    data.meta.slot = slot;
    if (label) data.meta.chapterLabel = label;
    return this.#store(slot, data);
  }

  #store(slot: SaveSlot, data: SaveData): SaveResult {
    try {
      this.#storage.setRaw("saves", slot, JSON.stringify(data));
    } catch (e) {
      if (e instanceof StorageQuotaError) {
        this.#engine.warn("存档失败:浏览器存储配额已满(清旧存档或换槽)");
        return { ok: false, reason: "quota" };
      }
      this.#engine.warn(`存档失败:${e instanceof Error ? e.message : String(e)}`);
      return { ok: false };
    }
    return { ok: true };
  }

  /** 读档(migrate 链应用后返回;坏档/过新版本 → error 带原因) */
  load(slot: SaveSlot): { data: SaveData | null; error: string | null } {
    const raw = this.#storage.getRaw("saves", slot);
    if (raw === null) return { data: null, error: null };
    try {
      return { data: migrateSave(raw), error: null };
    } catch (e) {
      return { data: null, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** 存读面板数据源:4 槽全量;空槽 data=null */
  list(): SlotSummary[] {
    return SAVE_SLOTS.map((slot) => {
      const { data, error } = this.#safeLoad(slot);
      return { slot, data, error };
    });
  }

  /** 最新 auto 档(标题「つづきから」);无/坏档 → null */
  latestAuto(): SaveData | null {
    return this.#safeLoad("auto").data;
  }

  remove(slot: SaveSlot): void {
    this.#storage.removeRaw("saves", slot);
  }

  /**
   * 读档续写:引擎侧恢复(ledger/world/舞台/时间)+ runner 侧恢复(摘要/拍进行中)。
   * pendingContinuation ⇒ BeatRunner 下一轮 run() 跳过导演,直接续写存档拍。
   */
  continueFrom(save: SaveData): void {
    // deferred 快照语义已失效(ledger 即将回滚):丢弃并明示,不静默
    if (this.#deferredSlots.size > 0) {
      this.#engine.warn(`放弃 ${this.#deferredSlots.size} 个未落盘的挂起存档(读档回滚)`);
      this.#deferredSlots.clear();
    }
    const runner = this.#getRunner();
    if (runner?.running) runner.stopGeneration();
    this.#engine.restoreFromSave(save);
    runner?.restore({
      summary: save.summary,
      outlineBeatIndex: save.outlineBeatIndex,
      currentAct: save.pendingContinuation ? (save.currentAct?.plan ?? null) : null,
      storyDirection: save.storyDirection ?? "",
      actsDone: save.actsDone ?? 0,
      route: save.route ?? null,
      routeSince: save.routeSince ?? 0,
    });
  }

  #safeLoad(slot: SaveSlot): { data: SaveData | null; error: string | null } {
    try {
      return this.load(slot);
    } catch (e) {
      return { data: null, error: e instanceof Error ? e.message : String(e) };
    }
  }
}
