/**
 * M4 选项系统测试:
 * - ChoiceOverlay(DOM):choice:offered 渲染选项;点击 → resolveChoice 生效;resolved → 收起
 * - hidden 后果隔离:不进 DOM、不进 snapshot;resolve 时与自身 delta 合一折叠(clamp)
 * - skip auto-pick:offer 时刻已是 skip / choicing 中切 skip,两条路径都按 defaultOptionId 收束
 * - skipAutoPick:false 时不自动选
 */
import { describe, expect, it } from "vitest";
import type { ContentPort, ModelScriptEvent } from "@gal/shared";
import { EngineCore } from "../src/core/EngineCore.ts";
import { EventBus } from "../src/core/EventBus.ts";
import { PresentationClock } from "../src/core/PresentationClock.ts";
import type { StagePort } from "../src/presentation/ports.ts";

const content: ContentPort = {
  characterIds: new Set(["enagi"]),
  sceneIds: new Set(["classroom"]),
  bgmIds: new Set<string>(),
  defaultExprOf: (who) => (who === "enagi" ? "平常" : ""),
  emotionsOf: () => new Set(["平常"]),
  displayNameOf: (who) => (who === "enagi" ? "陽見恵凪" : who),
};

const stage: StagePort = {
  bg: () => {},
  sprite: () => {},
  speak: () => {},
  shake: () => {},
  flash: () => {},
  reset: () => {},
  snapshot: () => ({ bg: null, bgm: null, sprites: {} }),
  restore: () => {},
};

const CHOICE: ModelScriptEvent = {
  t: "choice",
  options: [
    { id: "a", label: "声をかける", delta: { affection: { enagi: 5 } }, hidden: { delta: { affection: { enagi: 99 } } } },
    { id: "b", label: "見守る" },
  ],
  defaultOptionId: "a",
};

function makeEngine(opts: { skipAutoPick?: boolean } = {}) {
  const bus = new EventBus();
  const clock = new PresentationClock();
  const root = document.createElement("div");
  document.body.append(root);
  const engine = new EngineCore({
    bus,
    clock,
    stage,
    content,
    textEl: document.createElement("p"),
    choiceRoot: root,
    skipAutoPick: opts.skipAutoPick,
  });
  engine.setPhase("play"); // 泵只在 play 相位显示(生产里由 BeatRunner.run 设置)
  engine.beginTurn();
  return { bus, clock, root, engine };
}

describe("ChoiceOverlay", () => {
  it("choice:offered → 渲染 prompt+选项按钮;点击 → resolveChoice 生效 → 收起", () => {
    const { root, engine } = makeEngine();

    engine.commitModel(CHOICE);
    expect(engine.phase).toBe("choicing");
    expect(root.querySelector(".gal-choice")).not.toBeNull();
    const btns = [...root.querySelectorAll<HTMLButtonElement>("button[data-option-id]")];
    expect(btns.map((b) => b.dataset.optionId)).toEqual(["a", "b"]);
    expect(btns.map((b) => b.textContent)).toEqual(["声をかける", "見守る"]);

    btns.find((b) => b.dataset.optionId === "a")!.click();

    // resolve 副作用全到位:world 折叠(5+99 → clamp 100)、ledger 追加、相位回 play、浮层收起
    expect(engine.world.affection.enagi).toBe(100);
    expect(engine.phase).toBe("play");
    expect(engine.pendingChoice).toBeNull();
    expect(root.querySelector(".gal-choice")!.getAttribute("style")).toContain("display: none");
  });

  it("选无 delta 的选项 → world 不动,ledger 仍落 choice 条目", () => {
    const { root, engine } = makeEngine();
    engine.commitModel(CHOICE);
    root.querySelector<HTMLButtonElement>('button[data-option-id="b"]')!.click();
    expect(engine.world.affection.enagi).toBeUndefined();
    const entry = engine.ledger.find((e) => e.kind === "choice");
    expect(entry).toMatchObject({ kind: "choice", optionId: "b", lineId: "1.1", turnNo: 1, seq: 1 });
  });

  it("hidden 不进 DOM、不进 snapshot;offer 时刻 world 不动", () => {
    const { root, engine } = makeEngine();
    engine.commitModel(CHOICE);
    expect(root.innerHTML).not.toContain("hidden");
    expect(engine.world.affection.enagi).toBeUndefined(); // offer 不改世界
    const pub = engine.snapshot().pendingChoice!;
    expect(JSON.stringify(pub)).not.toContain("hidden");
    expect(pub.options[0]).toEqual({ id: "a", label: "声をかける", delta: { affection: { enagi: 5 } } });
  });
});

describe("skip auto-pick", () => {
  it("offer 时刻已是 skip → 立即按 defaultOptionId 收束(choice ev 先入账,再落 choice 条目)", () => {
    const { clock, engine } = makeEngine();
    clock.setMode("skip");

    engine.commitModel(CHOICE);

    expect(engine.pendingChoice).toBeNull();
    expect(engine.phase).toBe("play");
    expect(engine.world.affection.enagi).toBe(100);
    // 行号:choice 事件 1.0 → 玩家选择条目 1.1(hidden 合一折叠)
    expect(engine.ledger.map((e) => e.lineId)).toEqual(["1.0", "1.1"]);
    expect(engine.ledger[1]).toMatchObject({ kind: "choice", optionId: "a" });
  });

  it("choicing 中切 skip → onModeChange 触发自动选", () => {
    const { clock, engine } = makeEngine();
    engine.commitModel(CHOICE);
    expect(engine.pendingChoice).not.toBeNull();

    clock.setMode("skip");

    expect(engine.pendingChoice).toBeNull();
    expect(engine.world.affection.enagi).toBe(100);
  });

  it("skipAutoPick:false → skip 中不自动选,停等玩家", () => {
    const { clock, engine } = makeEngine({ skipAutoPick: false });
    clock.setMode("skip");

    engine.commitModel(CHOICE);
    expect(engine.pendingChoice).not.toBeNull();
    expect(engine.world.affection.enagi).toBeUndefined();

    engine.resolveChoice("a"); // 玩家手动仍有效
    expect(engine.world.affection.enagi).toBe(100);
  });
});
