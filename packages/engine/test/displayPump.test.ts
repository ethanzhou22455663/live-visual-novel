/**
 * 显示泵测试(2026-10-17 重写核心):commit/显示分离后的合同。
 * - 显示序=入队序;stage 条目按队列位置生效(屏幕所见=正在读的行)
 * - 两段式 advance(打字中一击=瞬完且停留;再一击=放行);#armedClicks 连点吸收
 * - 模式表:normal 硬点击门(不点不走)/ auto 800ms+点击截断 / fast 瞬完+120ms / skip 有界排空
 * - choice 到达才 offer;skip 到达即自选
 * - displayedThrough 游标推进进 toSaveData;whenIdle(+signal abort)
 * - replay 打断:epoch 换代,旧泵退出、旧队列丢弃、新泵接管(死锁回归)
 * - restoreFromSave 队列重建:只重读未读尾部;未决 choice 重新 offer;旧档全量已看
 */
import { describe, expect, it, vi } from "vitest";
import type { ContentPort, ModelScriptEvent } from "@gal/shared";
import { EngineCore } from "../src/core/EngineCore.ts";
import { EventBus } from "../src/core/EventBus.ts";
import { PresentationClock } from "../src/core/PresentationClock.ts";
import type { SpriteOp, StageDeps, StagePort } from "../src/presentation/ports.ts";

type StageCall = { op: string; args: unknown[] };

const content: ContentPort = {
  characterIds: new Set(["enagi"]),
  sceneIds: new Set(["classroom"]),
  bgmIds: new Set<string>(),
  defaultExprOf: () => "平常",
  emotionsOf: () => new Set(["平常", "笑"]),
  displayNameOf: (who) => (who === "enagi" ? "陽見恵凪" : who),
};

function fakeStage(): StagePort & { calls: StageCall[]; snaps: unknown[] } {
  const calls: StageCall[] = [];
  const snaps: unknown[] = [];
  const snapshot = () => ({ bg: null, bgm: null, sprites: {} });
  return {
    calls,
    snaps,
    bg: (a, t) => calls.push({ op: "bg", args: [a, t] }),
    sprite: (o: SpriteOp) => calls.push({ op: "sprite", args: [o] }),
    shake: () => calls.push({ op: "shake", args: [] }),
    flash: () => calls.push({ op: "flash", args: [] }),
    reset: () => calls.push({ op: "reset", args: [] }),
    snapshot,
    restore: (s) => {
      snaps.push(s);
      calls.push({ op: "restore", args: [s] });
    },
  };
}

function makeEngine(opts: { cps?: number; skipAutoPick?: boolean } = {}) {
  const bus = new EventBus();
  const clock = new PresentationClock();
  const stage = fakeStage();
  const engine = new EngineCore({
    bus,
    clock,
    stage,
    content,
    textEl: document.createElement("p"),
    cps: opts.cps ?? 2000, // 默认高字速:一帧打完,把时序焦点留给门控
    skipAutoPick: opts.skipAutoPick,
  });
  engine.setPhase("play"); // 泵只在 play 相位显示(生产里由 BeatRunner.run 设置)
  const shows: string[] = [];
  bus.on("line:show", ({ lineId }) => shows.push(lineId));
  return { bus, clock, stage, engine, shows };
}

/** happy-dom 的 rAF 由内部定时器驱动(~16ms/帧);一个 tick ≈ 一帧 */
const tick = (ms = 40) => new Promise<void>((r) => setTimeout(r, ms));

const CHOICE: ModelScriptEvent = {
  t: "choice",
  options: [{ id: "a", label: "A", delta: { affection: { enagi: 5 } } }, { id: "b", label: "B" }],
  defaultOptionId: "a",
};

describe("显示泵:队列与顺序", () => {
  it("显示序=入队序:stage 条目按位置生效,屏幕所见=正在读的行", async () => {
    const { engine, shows, stage } = makeEngine();
    engine.setClockMode("skip");
    engine.beginTurn();
    const FIX: ModelScriptEvent[] = [
      { t: "stage", op: { kind: "bg", asset: "classroom" } },
      { t: "say", who: "enagi", emotion: "平常", text: "セリフ1" },
      { t: "narrate", text: "地の文" },
      { t: "stage", op: { kind: "sprite", who: "enagi", action: "enter", slot: "center", emotion: "笑" } },
      { t: "say", who: "enagi", emotion: "笑", text: "セリフ2" },
    ];
    const ids = FIX.map((m) => engine.commitModel(m).lineId);
    expect(ids).toEqual(["1.0", "1.1", "1.2", "1.3", "1.4"]);
    await vi.waitFor(() => expect(engine.displayedThrough).toBe("1.4"), { timeout: 4000 });
    expect(shows).toEqual(["1.1", "1.2", "1.4"]); // stage 指令不占 line:show
    expect(stage.calls.map((c) => c.op)).toEqual(["bg", "sprite", "sprite", "sprite"]);
    expect(stage.calls[0]!.args[0]).toBe("classroom");
    expect(stage.calls[1]!.args[0]).toMatchObject({ who: "enagi", action: "diff", emotion: "平常" }); // say 表情驱动(权威来源)
    expect(stage.calls[2]!.args[0]).toMatchObject({ who: "enagi", slot: "center", action: "enter" }); // 显式 sprite op
    expect(stage.calls[3]!.args[0]).toMatchObject({ who: "enagi", action: "diff", emotion: "笑" });
  });
});

describe("显示泵:两段式 advance 与点击门", () => {
  it("两段式:打字中一击=瞬完且停留本行;再一击=放行下一行", async () => {
    const { engine, shows } = makeEngine({ cps: 2 }); // 低字速:打字横跨多个 tick
    engine.beginTurn();
    engine.commitModel({ t: "say", who: "enagi", emotion: "平常", text: "一段目" });
    engine.commitModel({ t: "narrate", text: "二段目" });
    expect(engine.typewriter.typing).toBe(true);
    engine.advance(); // 一击:补完
    await tick();
    expect(engine.typewriter.typing).toBe(false);
    expect(engine.displayedThrough).toBeNull(); // 仍停留本行(硬门未放行)
    expect(shows).toEqual(["1.0"]);
    engine.advance(); // 二击:放行
    await tick();
    expect(shows).toEqual(["1.0", "1.1"]); // 下一行开始显示
  });

  it("连点吸收:打字中双击=补完即自动放行,第二击不被吞", async () => {
    const { engine, shows } = makeEngine({ cps: 2 });
    engine.beginTurn();
    engine.commitModel({ t: "narrate", text: "長い行" });
    engine.commitModel({ t: "narrate", text: "次の行" });
    engine.advance();
    engine.advance(); // 同一帧内第二击(仍在打字)
    expect(engine.typewriter.typing).toBe(true); // 补完发生在下一帧
    await tick(80);
    expect(shows).toEqual(["1.0", "1.1"]); // 双击生效:无人再点也翻页了
    expect(engine.displayedThrough).toBe("1.0");
  });

  it("normal:不点击永不动——打完停留,无 dwell 无自动翻页", async () => {
    const { engine, shows } = makeEngine();
    engine.beginTurn();
    engine.commitModel({ t: "narrate", text: "あ" });
    engine.commitModel({ t: "narrate", text: "い" });
    await vi.waitFor(() => expect(engine.typewriter.typing).toBe(false)); // 一行目打完
    await new Promise((r) => setTimeout(r, 150)); // 远超任何 dwell
    expect(shows).toEqual(["1.0"]); // 二行目从未开始
    expect(engine.displayedThrough).toBeNull();
  });
});

describe("显示泵:模式表", () => {
  it("auto:打完 800ms 停留自动前进;点击可截断停留", async () => {
    const { engine } = makeEngine();
    engine.setClockMode("auto");
    engine.beginTurn();
    engine.commitModel({ t: "narrate", text: "あ" });
    engine.commitModel({ t: "narrate", text: "い" });
    await vi.waitFor(() => expect(engine.typewriter.typing).toBe(false)); // 一行目打完,进入 dwell
    const t0 = Date.now();
    engine.advance(); // 截断
    await tick();
    expect(engine.displayedThrough).toBe("1.0"); // 未等满 800ms
    expect(Date.now() - t0).toBeLessThan(400);
    await new Promise((r) => setTimeout(r, 900)); // 二行目 dwell 自然到点
    expect(engine.displayedThrough).toBe("1.1");
  });

  it("fast:入队即瞬完 + 120ms 短停留,无点击连续推进", async () => {
    const { engine, shows } = makeEngine();
    engine.setClockMode("fast");
    engine.beginTurn();
    engine.commitModel({ t: "narrate", text: "あ" });
    engine.commitModel({ t: "narrate", text: "い" });
    await new Promise((r) => setTimeout(r, 450)); // 2 行 ×(一帧瞬完+120ms)
    expect(engine.displayedThrough).toBe("1.1");
    expect(shows).toEqual(["1.0", "1.1"]);
    expect(engine.typewriter.typing).toBe(false);
  });

  it("skip:零点击有界排空 20 行,显示序=入队序", async () => {
    const { engine, shows } = makeEngine();
    engine.setClockMode("skip");
    engine.beginTurn();
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) ids.push(engine.commitModel({ t: "narrate", text: `n${i}` }).lineId);
    await vi.waitFor(() => expect(engine.displayedThrough).toBe(ids[19]!), { timeout: 4000 });
    expect(shows).toEqual(ids);
  });
});

describe("显示泵:选项到达", () => {
  it("choice 到达才 offer:normal 下前置行读毕放行后才弹选项", async () => {
    const { engine } = makeEngine();
    let offered = 0;
    engine.bus.on("choice:offered", () => offered++);
    engine.beginTurn();
    engine.commitModel({ t: "narrate", text: "前置行" });
    engine.commitModel(CHOICE);
    expect(engine.pendingChoice).toBeNull(); // 还在打前置行,选项未到达
    expect(offered).toBe(0);
    engine.advance(); // 补完
    await tick();
    engine.advance(); // 放行 → 泵到达 choice 条目
    await vi.waitFor(() => expect(engine.pendingChoice).not.toBeNull());
    expect(engine.phase).toBe("choicing");
    expect(offered).toBe(1);
  });

  it("skip 到达即自选:resolveChoice 走常规事务(world 折叠/ledger 落条目)", async () => {
    const { engine } = makeEngine();
    engine.setClockMode("skip");
    engine.beginTurn();
    engine.commitModel({ t: "narrate", text: "前置行" });
    engine.commitModel(CHOICE);
    await vi.waitFor(() => expect(engine.world.affection.enagi).toBe(5));
    expect(engine.pendingChoice).toBeNull(); // 自动选完已收束
    expect(engine.phase).toBe("play");
    expect(engine.ledger.map((e) => e.lineId)).toEqual(["1.0", "1.1", "1.2"]); // 事件+选择条目
    expect(engine.ledger[2]).toMatchObject({ kind: "choice", optionId: "a" });
  });
});

describe("显示泵:游标与空闲", () => {
  it("displayedThrough 随显示推进,写入 toSaveData", async () => {
    const { engine } = makeEngine();
    engine.setClockMode("skip");
    engine.beginTurn();
    engine.commitModel({ t: "narrate", text: "一" });
    engine.commitModel({ t: "narrate", text: "二" });
    expect(engine.toSaveData().displayedThrough).toBeUndefined(); // 尚未显示完
    await vi.waitFor(() => expect(engine.displayedThrough).toBe("1.1"), { timeout: 4000 });
    expect(engine.toSaveData().displayedThrough).toBe("1.1");
  });

  it("whenIdle:门等待中不 resolve;abort signal 提前放行;排空后 resolve", async () => {
    const { engine } = makeEngine();
    engine.beginTurn();
    engine.commitModel({ t: "narrate", text: "止まる行" });
    let idle1 = false;
    const ac = new AbortController();
    void engine.whenIdle(ac.signal).then(() => (idle1 = true));
    await tick(); // 打完进门等待
    expect(idle1).toBe(false);
    ac.abort(); // signal 放行(BeatRunner stopGeneration 语义)
    await tick(10);
    expect(idle1).toBe(true);

    engine.setClockMode("skip");
    let idle2 = false;
    void engine.whenIdle().then(() => (idle2 = true));
    engine.advance();
    await tick();
    engine.advance(); // 过门 → 队列空 → 排空
    await vi.waitFor(() => expect(idle2).toBe(true));
  });

  it("replay 打断:旧泵退出、旧队列丢弃、新泵接管(epoch 重启,死锁回归)", async () => {
    const { engine, shows } = makeEngine({ cps: 2 });
    engine.beginTurn();
    engine.commitModel({ t: "narrate", text: "一行目..." });
    engine.commitModel({ t: "narrate", text: "二行目" });
    engine.commitModel({ t: "narrate", text: "三行目" });
    await tick();
    expect(engine.typewriter.typing).toBe(true); // 一行目打字中,二三行目在队列里
    engine.replay(engine.ledger); // 打断:清队+换代际
    expect(engine.typewriter.typing).toBe(false);
    expect(engine.displayedThrough).toBeNull();
    engine.commitModel({ t: "narrate", text: "再開" }); // 旧泵若不死锁,新泵接管这行
    await tick();
    expect(shows).toEqual(["1.0", "1.3"]); // 旧队列的 1.1/1.2 被丢弃,永不显示
    engine.advance();
    await tick();
    engine.advance();
    await vi.waitFor(() => expect(engine.displayedThrough).toBe("1.3"));
  });
});

describe("restoreFromSave:显示队列重建", () => {
  /** 造一个「显示落后于 ledger」的存档:已看 1.0(displayedThrough),未读 1.1/1.2 留在 ledger */
  async function makeMidSave() {
    const { engine } = makeEngine(); // cps 2000:一帧打完
    engine.beginTurn();
    engine.commitModel({ t: "narrate", text: "既読行" });
    engine.commitModel({ t: "narrate", text: "未読行" });
    engine.commitModel({ t: "say", who: "enagi", emotion: "平常", text: "未読セリフ" });
    await vi.waitFor(() => expect(engine.typewriter.typing).toBe(false)); // 1.0 打完,硬门停住
    engine.advance(); // 放行 1.0 → 1.1 开始显示(1.2 仍在队列)
    await vi.waitFor(() => expect(engine.displayedThrough).toBe("1.0"));
    return engine; // 调用方直接取 toSaveData()
  }

  it("只重读未读尾部:已看前缀不重放 line:show,未读行由泵逐行显示", async () => {
    const a = await makeMidSave();
    const save = a.toSaveData();
    expect(save.displayedThrough).toBe("1.0");

    const b = makeEngine({ cps: 2000 });
    const bShows: string[] = [];
    b.engine.bus.on("line:show", ({ lineId }) => bShows.push(lineId));
    b.engine.restoreFromSave(save);

    // 状态全量恢复;视觉只按已看前缀重放(不调 stage.restore——未读尾部要靠显示重建)
    expect(b.engine.ledger.map((e) => e.lineId)).toEqual(["1.0", "1.1", "1.2"]);
    expect(b.engine.cursor).toEqual({ turnNo: 1, seq: 3 });
    expect(b.engine.displayedThrough).toBe("1.0");
    expect(b.stage.snaps.length).toBe(0);
    await vi.waitFor(() => expect(bShows).toEqual(["1.1"])); // 1.1 开显(1.0 不重放)
    await vi.waitFor(() => expect(b.engine.typewriter.typing).toBe(false)); // 1.1 打完(cps 2000),硬门停住
    expect(b.engine.displayedThrough).toBe("1.0"); // 1.1 尚未放行
    b.engine.advance(); // 放行 1.1 → 1.2 开显
    // 不能只等 typing=false:放行 1.1 与泵微任务开打 1.2 之间存在 typing==false 的
    // 微任务空窗,waitFor 可能落进去 → 这击被当成 1.2 的补完而非放行。先确认 1.2
    // 已开显,再等它打完,最后放行——三步全钉死。
    await vi.waitFor(() => expect(bShows).toEqual(["1.1", "1.2"]));
    await vi.waitFor(() => expect(b.engine.typewriter.typing).toBe(false));
    b.engine.advance(); // 放行 1.2 → 泵排空
    await vi.waitFor(() => expect(b.engine.displayedThrough).toBe("1.2"));
    expect(bShows).toEqual(["1.1", "1.2"]);
  });

  it("未决 choice 重新 offer:泵到达未读的 choice 条目时再次弹选项", async () => {
    const c = makeEngine({ cps: 2 });
    c.engine.beginTurn();
    c.engine.commitModel({ t: "narrate", text: "前置行" });
    c.engine.commitModel(CHOICE);
    c.engine.advance(); // 补完前置行
    await tick();
    c.engine.advance(); // 放行 → 选项到达(pendingChoice 停等)
    await vi.waitFor(() => expect(c.engine.pendingChoice).not.toBeNull());
    const save = c.engine.toSaveData();
    expect(save.displayedThrough).toBe("1.0");

    const d = makeEngine({ cps: 2000 });
    d.engine.restoreFromSave(save);
    // 泵对首条队列条目在 await 前的同步段完成到达与 offer——重 offer 即时成立
    expect(d.engine.pendingChoice).not.toBeNull();
    expect(d.engine.phase).toBe("choicing");
    expect(d.engine.resolveChoice("a")).toEqual({ optionId: "a", label: "A" });
    expect(d.engine.world.affection.enagi).toBe(5); // delta 折叠照常
  });

  it("旧档(无 displayedThrough)→ 全部视为已看:stage.restore 权威恢复,不重读", async () => {
    const { engine } = makeEngine({ cps: 2 });
    engine.beginTurn();
    engine.commitModel({ t: "narrate", text: "一" });
    engine.commitModel({ t: "narrate", text: "二" });
    await tick();
    const save = engine.toSaveData();
    delete save.displayedThrough; // 模拟旧档

    const e2 = makeEngine();
    const shows2: string[] = [];
    e2.engine.bus.on("line:show", ({ lineId }) => shows2.push(lineId));
    e2.engine.restoreFromSave(save);
    expect(e2.engine.displayedThrough).toBe("1.1"); // 全部已看
    expect(shows2).toEqual([]); // 零重读
    expect(e2.stage.snaps.length).toBe(1); // presentation 权威恢复
    expect(e2.engine.cursor).toEqual({ turnNo: 1, seq: 2 });
  });
});
