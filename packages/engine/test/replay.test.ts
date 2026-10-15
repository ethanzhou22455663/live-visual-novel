import { describe, expect, it } from "vitest";
import type { ContentPort } from "@gal/shared";
import type { ModelScriptEvent } from "@gal/shared";
import { EngineCore } from "../src/core/EngineCore.ts";
import { EventBus } from "../src/core/EventBus.ts";
import { PresentationClock } from "../src/core/PresentationClock.ts";
import { backlogOf } from "../src/game/Backlog.ts";
import type { SpriteOp, StageDeps, StagePort } from "../src/presentation/ports.ts";

const content: ContentPort = {
  characterIds: new Set(["enagi", "yukitaka"]),
  sceneIds: new Set(["classroom"]),
  bgmIds: new Set<string>(),
  defaultExprOf: (who) => (who === "enagi" ? "平常" : ""),
  emotionsOf: (who) => (who === "enagi" ? new Set(["平常", "笑"]) : new Set<string>()),
  displayNameOf: (who) => (who === "enagi" ? "陽見恵凪" : who),
};

type StageCall = { op: string; args: unknown[] };

function fakeStage(): StagePort & { calls: StageCall[] } {
  const calls: StageCall[] = [];
  return {
    calls,
    bg: (a, t) => calls.push({ op: "bg", args: [a, t] }),
    sprite: (o: SpriteOp) => calls.push({ op: "sprite", args: [o] }),
    speak: (w) => calls.push({ op: "speak", args: [w] }),
    shake: () => calls.push({ op: "shake", args: [] }),
    flash: () => calls.push({ op: "flash", args: [] }),
    reset: () => calls.push({ op: "reset", args: [] }),
    snapshot: () => ({ bg: null, bgm: null, sprites: {} }),
    restore: () => calls.push({ op: "restore", args: [] }),
  };
}

function makeEngine(stage = fakeStage()) {
  const bus = new EventBus();
  const root = document.createElement("div");
  const textEl = document.createElement("p");
  const deps: StageDeps = { root, resolve: () => null, content, warn: () => {} };
  const engine = new EngineCore({ bus, clock: new PresentationClock(), stage, content, textEl });
  // 拦截 warn 走 StageDeps.warn 的场景已由 stage 测试覆盖;这里只测 engine 自己的告警
  return { engine, bus, stage };
}

const FIXTURE: ModelScriptEvent[] = [
  { t: "stage", op: { kind: "bg", asset: "classroom" } },
  { t: "say", who: "enagi", emotion: "平常", text: "ですふぁっきゅー!" },
  { t: "narrate", text: "放課後の教室に、誰かの歌声が響いていた。" },
  { t: "stage", op: { kind: "sprite", who: "enagi", action: "enter", slot: "center", emotion: "笑" } },
  { t: "say", who: "enagi", emotion: "笑", text: "きみ、今の聞いた?" },
];

describe("EngineCore commit 事务点", () => {
  it("lineId 单调分配 1.0→1.1→…→2.0;ledger 忠实追加", () => {
    const { engine } = makeEngine();
    engine.beginTurn();
    const ids = FIXTURE.map((m) => engine.commitModel(m).lineId);
    engine.beginTurn();
    ids.push(engine.commitModel({ t: "narrate", text: "二拍目。" }).lineId);
    expect(ids).toEqual(["1.0", "1.1", "1.2", "1.3", "1.4", "2.0"]);
    expect(engine.cursor).toEqual({ turnNo: 2, seq: 1 });
    expect(engine.ledger.length).toBe(6);
  });

  it("bus 序列:每条 commit 发 line:commit;say/narrate 驱动 speak 与打字机", () => {
    const { engine, bus, stage } = makeEngine();
    const commits: string[] = [];
    bus.on("line:commit", (p) => commits.push(p.lineId));
    engine.beginTurn();
    for (const m of FIXTURE) engine.commitModel(m);
    expect(commits).toEqual(["1.0", "1.1", "1.2", "1.3", "1.4"]);
    const speakCalls = stage.calls.filter((c) => c.op === "speak").map((c) => c.args[0]);
    expect(speakCalls).toEqual(["enagi", null, "enagi"]); // bg/sprite 指令不触发 speak
  });

  it("未知表情净化为 defaultExpr 并发 engine:warning;ledger 存净化后事件", () => {
    const { engine, bus } = makeEngine();
    const warns: string[] = [];
    bus.on("engine:warning", (w) => warns.push(w.message));
    engine.beginTurn();
    const { ev } = engine.commitModel({ t: "say", who: "enagi", emotion: "照れ", text: "えっと……" });
    expect(ev.t === "say" && ev.emotion).toBe("平常");
    expect(warns.some((w) => w.includes("未知表情「照れ」"))).toBe(true);
    const stored = engine.ledger[0]!;
    expect(stored.kind === "ev" && stored.ev.t === "say" && stored.ev.emotion).toBe("平常");
  });

  it("选项提交:phase→choicing、choice:offered 只带公开视图、世界状态按 delta 折叠", () => {
    const { engine, bus } = makeEngine();
    let offered: unknown = null;
    bus.on("choice:offered", (p) => (offered = p.choice));
    engine.beginTurn();
    const { ev } = engine.commitModel({
      t: "choice",
      prompt: "どうする?",
      options: [
        { id: "a", label: "声をかける", delta: { affection: { enagi: 5 } }, hidden: { delta: { affection: { enagi: 99 } } } },
        { id: "b", label: "見守る" },
      ],
      defaultOptionId: "a",
    });
    expect(engine.phase).toBe("choicing");
    expect(engine.pendingChoice).not.toBeNull();
    expect(offered).not.toBeNull();
    expect(JSON.stringify(offered)).not.toContain("hidden"); // 公开视图不含 hidden
    expect(ev.t === "choice" && ev.options[0]?.hidden?.beatHint).toBeUndefined();
    // delta 在 M4 resolveChoice 时才入账;offer 时刻 world 不动
    expect(engine.world.affection.enagi).toBeUndefined();
  });

  it("defaultOptionId 无效时回退首个选项并 warn", () => {
    const { engine, bus } = makeEngine();
    const warns: string[] = [];
    bus.on("engine:warning", (w) => warns.push(w.message));
    engine.beginTurn();
    const { ev } = engine.commitModel({
      t: "choice",
      options: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
      defaultOptionId: "zzz",
    });
    expect(ev.t === "choice" && ev.defaultOptionId).toBe("a");
    expect(warns.some((w) => w.includes("defaultOptionId 无效"))).toBe(true);
  });
});

describe("EngineCore replay", () => {
  it("重放恢复游标/世界/舞台终态,不发 line:commit、不恢复待选状态", () => {
    const { engine, bus, stage } = makeEngine();
    const commits: string[] = [];
    bus.on("line:commit", (p) => commits.push(p.lineId));
    engine.beginTurn();
    for (const m of FIXTURE) engine.commitModel(m);
    engine.commitModel({
      t: "choice",
      options: [{ id: "a", label: "A", delta: { affection: { enagi: 3 } } }],
      defaultOptionId: "a",
    });
    expect(commits.length).toBe(6);
    // 玩家选择落地(M4 前手动补 ledger):重放经 foldWorld 恢复世界状态
    engine.ledger.push({ kind: "choice", lineId: "1.6", turnNo: 1, seq: 6, optionId: "a", label: "A", delta: { affection: { enagi: 3 } } });
    stage.calls.length = 0;

    engine.replay(engine.ledger);
    expect(commits.length).toBe(6); // 重放不再发 line:commit
    expect(stage.calls[0]?.op).toBe("reset");
    expect(engine.cursor).toEqual({ turnNo: 1, seq: 7 });
    expect(engine.world.affection.enagi).toBe(3);
    expect(engine.pendingChoice).toBeNull();
    expect(engine.phase).toBe("play");
    // 舞台终态:最后一次 speak 来自 choice 前的 say
    const speaks = stage.calls.filter((c) => c.op === "speak").map((c) => c.args[0]);
    expect(speaks.at(-1)).toBe("enagi");
  });

  it("resumeTurn 延续拍号:重放后续写行号不重复", () => {
    const { engine } = makeEngine();
    engine.beginTurn();
    engine.commitModel(FIXTURE[0]!);
    engine.replay(engine.ledger);
    expect(engine.cursor).toEqual({ turnNo: 1, seq: 1 });
    // 模拟同拍续写:resume 到 cursor,提交不产生重复行号
    engine.resumeTurn(engine.cursor.turnNo, engine.cursor.seq);
    const { lineId } = engine.commitModel({ t: "narrate", text: "続き。", });
    expect(lineId).toBe("1.1");
  });
});

describe("Backlog(ledger 派生,坑①)", () => {
  it("say/narrate/choice 派生条目;cap 200", () => {
    const { engine } = makeEngine();
    engine.beginTurn();
    engine.commitModel({ t: "say", who: "enagi", emotion: "平常", text: "一行目" });
    engine.commitModel({ t: "narrate", text: "地の文" });
    engine.commitModel({
      t: "choice",
      options: [{ id: "a", label: "選んだ!", delta: { affection: { enagi: 1 } } }],
      defaultOptionId: "a",
    });
    // 手动落一条 choice 结果(BeatRunner/M4 的职责,这里直接补 ledger)
    engine.ledger.push({ kind: "choice", lineId: "1.3", turnNo: 1, seq: 3, optionId: "a", label: "選んだ!" });
    const items = backlogOf(engine.ledger);
    expect(items.map((i) => i.kind)).toEqual(["say", "narrate", "choice"]);
    expect(items[2]!.text).toBe("選んだ!");

    for (let i = 0; i < 250; i++) engine.commitModel({ t: "narrate", text: `n${i}` });
    expect(backlogOf(engine.ledger).length).toBe(200);
  });
});
