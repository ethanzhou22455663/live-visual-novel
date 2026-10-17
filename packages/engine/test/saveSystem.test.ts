/**
 * SaveSystem(M5)合同测试:
 * - MemoryStorage 往返:ledger/world/cursor 一致;continueFrom 后状态回滚到存档点
 * - writing 中点:挂起到下一个 line:commit 快照,pendingContinuation=true 且 currentBeat 在
 * - quota → SaveResult{reason:"quota"} + engine:warning
 * - auto 触发:beat:end(beatEnd/sceneEnd)与 choice:resolved 写 auto;choice 收束的 beat:end 不写
 * - 摘要裁剪:summarizedThroughLineId 之后的行才入档;裁剪清空 ledger 时读档后 beginTurn 仍前进
 * - 读档续写:pendingContinuation ⇒ 下一轮 run() 跳过导演,同拍续号(1.0 → 1.1),ledgerTail 可见
 */
import { describe, expect, it, vi } from "vitest";
import { EMPTY_SUMMARY, StorageQuotaError } from "@gal/shared";
import type {
  BeatDirective,
  ContentPort,
  GenerateBeatRequest,
  SaveData,
  StoragePort,
  StoryChunk,
} from "@gal/shared";
import { BeatRunner } from "../src/core/BeatRunner.ts";
import { EngineCore } from "../src/core/EngineCore.ts";
import { EventBus } from "../src/core/EventBus.ts";
import { PresentationClock } from "../src/core/PresentationClock.ts";
import { SaveSystem } from "../src/game/SaveSystem.ts";
import type { SpriteOp, StagePort } from "../src/presentation/ports.ts";

const content: ContentPort = {
  characterIds: new Set(["enagi"]),
  sceneIds: new Set(["classroom"]),
  bgmIds: new Set<string>(),
  defaultExprOf: () => "平常",
  emotionsOf: () => new Set(["平常"]),
  displayNameOf: (who) => (who === "enagi" ? "陽見恵凪" : who),
};

const DIRECTIVE: BeatDirective = {
  scene: { bg: "classroom", bgm: null, cast: ["enagi"] },
  goal: "再会",
  endsWith: "beatEnd",
  maxLines: 6,
};

function fakeStage(): StagePort {
  const snapshot = { bg: null, bgm: null, sprites: {} };
  return {
    bg: () => {},
    sprite: (_o: SpriteOp) => {},
    shake: () => {},
    flash: () => {},
    reset: () => {},
    snapshot: () => snapshot,
    restore: (s: typeof snapshot) => Object.assign(snapshot, s),
  };
}

class MemoryStorage implements StoragePort {
  #m = new Map<string, string>();
  getRaw(scope: "saves" | "global", key: string): string | null {
    return this.#m.get(`${scope}.${key}`) ?? null;
  }
  setRaw(scope: "saves" | "global", key: string, value: string): void {
    this.#m.set(`${scope}.${key}`, value);
  }
  removeRaw(scope: "saves" | "global", key: string): void {
    this.#m.delete(`${scope}.${key}`);
  }
  listKeys(scope: "saves" | "global"): string[] {
    const p = `${scope}.`;
    return [...this.#m.keys()].filter((k) => k.startsWith(p)).map((k) => k.slice(p.length));
  }
}

class QuotaStorage extends MemoryStorage {
  override setRaw(): void {
    throw new StorageQuotaError();
  }
}

/** engine+bus+SaveSystem 一体;getRunner 注入模拟 runner(中点存档/摘要裁剪用) */
function makeEnv(storage: StoragePort = new MemoryStorage(), getRunner?: () => BeatRunner | null) {
  const bus = new EventBus();
  const clock = new PresentationClock();
  const engine = new EngineCore({
    bus,
    clock,
    stage: fakeStage(),
    content,
    textEl: document.createElement("p"),
  });
  const saves = new SaveSystem({ engine, bus, storage, getRunner });
  engine.setPhase("play"); // 泵只在 play 相位显示(生产里由 BeatRunner.run 设置)
  return { bus, clock, engine, saves, storage };
}

/** 中点/裁剪用的假 runner:只暴露 SaveSystem 读取的四个成员 */
function fakeRunnerState(opts: {
  running: boolean;
  currentBeat: { turnNo: number; directive: BeatDirective } | null;
  summarizedThroughLineId?: string;
  outlineBeatIndex?: number | null;
}): BeatRunner {
  return {
    running: opts.running,
    currentBeat: opts.currentBeat,
    summary: { ...EMPTY_SUMMARY, summarizedThroughLineId: opts.summarizedThroughLineId ?? "" },
    outlineBeatIndex: opts.outlineBeatIndex ?? null,
  } as unknown as BeatRunner;
}

function makeRunnerEnv(save: SaveData, chunks: (req: GenerateBeatRequest) => StoryChunk[]) {
  const bus = new EventBus();
  const engine = new EngineCore({
    bus,
    clock: new PresentationClock(),
    stage: fakeStage(),
    content,
    textEl: document.createElement("p"),
  });
  const nextCalls: unknown[] = [];
  const genReqs: GenerateBeatRequest[] = [];
  const story = {
    async nextBeat(): Promise<BeatDirective> {
      nextCalls.push(1);
      if (nextCalls.length >= 2) throw new Error("sentinel-stop"); // 无限循环的确定性出口
      return DIRECTIVE;
    },
    async *generateBeat(req: GenerateBeatRequest): AsyncGenerator<StoryChunk, void, unknown> {
      genReqs.push(req);
      yield* chunks(req);
    },
    summarize(): Promise<never> {
      return Promise.reject(new Error("summarize は本テストで呼ばれない"));
    },
  };
  const runner = new BeatRunner({ engine, bus, story, content, outlineBeatCount: null });
  const saves = new SaveSystem({ engine, bus, storage: new MemoryStorage(), getRunner: () => runner });
  saves.continueFrom(save);
  return { engine, runner, nextCalls, genReqs };
}

describe("SaveSystem 往返", () => {
  it("save→load→continueFrom:ledger/cursor 一致;继续生成后读档回滚到存档点", () => {
    const { engine, saves } = makeEnv();
    engine.beginTurn();
    engine.commitModel({ t: "narrate", text: "一行目" });
    engine.commitModel({ t: "say", who: "enagi", emotion: "平常", text: "せりふ" });

    expect(saves.save("manual-0")).toEqual({ ok: true });
    const { data } = saves.load("manual-0");
    expect(data).not.toBeNull();
    expect(data!.meta.slot).toBe("manual-0");
    expect(data!.ledger.map((e) => e.lineId)).toEqual(["1.0", "1.1"]);
    expect(data!.cursor).toEqual({ turnNo: 1, seq: 2 });
    expect(data!.pendingContinuation).toBe(false);
    expect(data!.currentBeat).toBeNull();

    engine.commitModel({ t: "narrate", text: "三行目" });
    expect(engine.ledger.length).toBe(3);
    saves.continueFrom(data!);
    expect(engine.ledger.map((e) => e.lineId)).toEqual(["1.0", "1.1"]);
    expect(engine.cursor).toEqual({ turnNo: 1, seq: 2 });
    expect(engine.phase).toBe("play");
  });

  it("writing 中点:save 受理为 deferred,下一个显示边界(display:drained)落盘且 pendingContinuation", async () => {
    const fake = fakeRunnerState({ running: true, currentBeat: { turnNo: 1, directive: DIRECTIVE }, outlineBeatIndex: 0 });
    const { clock, engine, saves } = makeEnv(new MemoryStorage(), () => fake);
    clock.setMode("skip"); // 泵直通:commit 后立刻到达显示边界(commit 已遥遥领先于显示)
    engine.beginTurn();

    expect(saves.save("manual-1")).toEqual({ ok: true, deferred: true });
    expect(saves.load("manual-1").data).toBeNull(); // 尚未落盘

    engine.commitModel({ t: "narrate", text: "行境界" }); // 泵排空 → 兑现
    await vi.waitFor(() => expect(saves.load("manual-1").data).not.toBeNull());

    const { data } = saves.load("manual-1");
    expect(data).not.toBeNull();
    expect(data!.pendingContinuation).toBe(true);
    expect(data!.currentBeat).toEqual({ turnNo: 1, directive: DIRECTIVE });
    expect(data!.meta.slot).toBe("manual-1");
  });

  it("quota → {ok:false, reason:'quota'} + engine:warning", () => {
    const { bus, engine, saves } = makeEnv(new QuotaStorage());
    const warnings: string[] = [];
    bus.on("engine:warning", ({ message }) => warnings.push(message));
    expect(saves.save("manual-0")).toEqual({ ok: false, reason: "quota" });
    expect(warnings.length).toBeGreaterThan(0);
    expect(engine.ledger).toEqual([]);
  });

  it("auto 触发:sceneEnd/beatEnd 与 choice:resolved 写 auto;choice 收束的 beat:end 不写", () => {
    const { bus, saves } = makeEnv();
    bus.emit("beat:end", { result: "sceneEnd", turnNo: 1 });
    expect(saves.load("auto").data).not.toBeNull();

    saves.remove("auto");
    bus.emit("beat:end", { result: "choice", turnNo: 2 }); // choice 的收束由 choice:resolved 管
    expect(saves.load("auto").data).toBeNull();

    bus.emit("choice:resolved", { optionId: "a", label: "ら" });
    expect(saves.load("auto").data).not.toBeNull();
  });
});

describe("摘要裁剪与读档后续号", () => {
  it("summary 覆盖到 1.1 → 1.2 以降のみ入档;读档后 beginTurn 前进到 2", () => {
    const { engine, saves } = makeEnv();
    engine.beginTurn();
    for (const t of ["あ", "い", "う", "え"]) engine.commitModel({ t: "narrate", text: t });

    const fake = fakeRunnerState({ running: false, currentBeat: null, summarizedThroughLineId: "1.1", outlineBeatIndex: 0 });
    const savesTrim = new SaveSystem({
      engine,
      bus: engine.bus,
      storage: new MemoryStorage(),
      getRunner: () => fake,
    });
    savesTrim.save("manual-2");
    const { data } = savesTrim.load("manual-2");
    expect(data!.ledger.map((e) => e.lineId)).toEqual(["1.2", "1.3"]);
    expect(data!.cursor).toEqual({ turnNo: 1, seq: 4 });

    // 读进新引擎:beginTurn 继续 2(拍号不回退)
    const env2 = makeEnv();
    env2.saves.continueFrom(data!);
    expect(env2.engine.beginTurn()).toBe(2);
  });

  it("裁剪清空 ledger(summary 覆盖全部)→ 读档后 beginTurn 仍前进(不回退到 1)", () => {
    const { engine } = makeEnv();
    engine.beginTurn();
    for (const t of ["あ", "い"]) engine.commitModel({ t: "narrate", text: t });

    const fake = fakeRunnerState({ running: false, currentBeat: null, summarizedThroughLineId: "1.1", outlineBeatIndex: 0 });
    const storage = new MemoryStorage();
    const savesA = new SaveSystem({ engine, bus: engine.bus, storage, getRunner: () => fake });
    savesA.save("manual-0");
    const { data } = savesA.load("manual-0");
    expect(data!.ledger).toEqual([]);
    expect(data!.cursor).toEqual({ turnNo: 1, seq: 2 });

    const env2 = makeEnv(storage); // 同一存储再读
    env2.saves.continueFrom(data!);
    expect(env2.engine.beginTurn()).toBe(2);
  });
});

describe("读档续写(pendingContinuation)", () => {
  it("下一轮 run() 跳过导演:同拍续号,ledgerTail 带已提交行,outlineBeatIndex 恢复", async () => {
    // 造一个 mid-beat 档:turn 1 已提交 1.0,再由行境界快照带上 1.1
    const fake = fakeRunnerState({
      running: true,
      currentBeat: { turnNo: 1, directive: DIRECTIVE },
      outlineBeatIndex: 2,
    });
    const { clock, engine, saves } = makeEnv(new MemoryStorage(), () => fake);
    clock.setMode("skip"); // 泵直通:显示边界即 commit 边界
    engine.beginTurn();
    engine.commitModel({ t: "narrate", text: "一行目" });
    expect(saves.save("manual-0")).toEqual({ ok: true, deferred: true });
    engine.commitModel({ t: "narrate", text: "行境界" }); // deferred 兑现(同时也提交了 1.1)
    await vi.waitFor(() => expect(saves.load("manual-0").data).not.toBeNull());
    const save = saves.load("manual-0").data!;
    expect(save.pendingContinuation).toBe(true);

    // 读进新引擎+真 runner:resume 路径。断言全部事后做——run() 会吞掉生成器内抛出的 expect
    const { engine: engine2, runner, nextCalls, genReqs } = makeRunnerEnv(save, (req) => {
      if (genReqs.length === 1) {
        return [
          { kind: "commit", event: { t: "narrate", text: "さん行目" } },
          { kind: "done", result: "beatEnd", lineCount: 3 },
        ];
      }
      return [
        { kind: "commit", event: { t: "narrate", text: "次の拍" } },
        { kind: "done", result: "beatEnd", lineCount: 1 },
      ];
    });
    expect(runner.outlineBeatIndex).toBe(2); // restore 恢复
    expect(engine2.turnNo).toBe(1); // resumeTurn 已就位
    await runner.run();

    // 迭代1(续写拍)没问导演;拍2 问了一次;拍3 的 nextBeat 即哨兵
    expect(nextCalls.length).toBe(2);
    expect(genReqs.length).toBe(2);
    const resumed = genReqs[0]!;
    expect(resumed.turnNo).toBe(1); // 同拍续写(若回退则会是 2)
    expect(resumed.continuation).toBeUndefined();
    expect(resumed.ledgerTail).toContain("一行目");
    expect(resumed.ledgerTail).toContain("行境界");
    expect(engine2.ledger.map((e) => e.lineId)).toEqual(["1.0", "1.1", "1.2", "2.0"]);
  });
});
