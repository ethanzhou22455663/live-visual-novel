/**
 * M4 选项系统测试:
 * - ChoiceOverlay(DOM):choice:offered 渲染选项;点击 → resolveChoice 生效;resolved → 收起
 * - hidden 后果隔离:不进 DOM、不进 snapshot;resolve 时与自身 delta 合一折叠(clamp)
 * - 选项永远停等玩家(2026-10-17 裁决 skip 已移除,不存在任何自动选)
 */
import { describe, expect, it, vi } from "vitest";
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
  shake: () => {},
  flash: () => {},
  reset: () => {},
  snapshot: () => ({ bg: null, sprites: {} }),
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

function makeEngine(opts: { zhOn?: () => boolean } = {}) {
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
    zhOn: opts.zhOn,
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

  it("attachChoiceLabels(2026-10-28 裁决:选项不许只有日文):停等中的按钮/prompt 原地换中文;ledger 随档", () => {
    const { root, engine, bus } = makeEngine();
    const labelEvs: unknown[] = [];
    bus.on("choice:labels", ({ choice }) => labelEvs.push(choice));
    const withPrompt = { ...CHOICE, prompt: "どうする?" };
    const { lineId } = engine.commitModel(withPrompt);
    expect([...root.querySelectorAll<HTMLButtonElement>("button[data-option-id]")].map((b) => b.textContent)).toEqual([
      "声をかける",
      "見守る",
    ]);

    engine.attachChoiceLabels([
      { lineId, prompt: "怎么办?", labels: [{ optionId: "a", zh: "打招呼" }, { optionId: "b", zh: "注视" }] },
    ]);
    // 浮层原地说中文(无需重新 offer):prompt 显示译文,原文 prompt 不被覆写
    expect(root.querySelector(".gal-choice-prompt")?.textContent).toBe("怎么办?");
    expect([...root.querySelectorAll<HTMLButtonElement>("button[data-option-id]")].map((b) => b.textContent)).toEqual([
      "打招呼",
      "注视",
    ]);
    expect(labelEvs).toHaveLength(1); // choice:labels 广播一次(浮层开着才消费)
    expect(engine.pendingChoice).toMatchObject({ prompt: "どうする?", promptZh: "怎么办?" });
    // ledger 原文+译文并存(写手历史不被中文污染),随档持久化
    const ledgerEv = engine.ledger.find((e) => e.kind === "ev" && e.ev.t === "choice");
    expect(ledgerEv).toMatchObject({ ev: { prompt: "どうする?", promptZh: "怎么办?" } });
    const savedEv = engine.toSaveData().ledger.find((e) => e.kind === "ev")?.ev as { promptZh?: string };
    expect(savedEv.promptZh).toBe("怎么办?");
    expect(() => engine.attachChoiceLabels([{ lineId: "9.9", labels: [] }])).not.toThrow(); // 未知行安全忽略
  });

  it("zhOn 译文开关(2026-10-28 用户反馈:日文模式不许出现中文):关=按钮/prompt 显示日文,缺省=有译文显示中文", () => {
    const attach = (engine: ReturnType<typeof makeEngine>["engine"], lineId: string): void => {
      engine.attachChoiceLabels([
        { lineId, prompt: "怎么办?", labels: [{ optionId: "a", zh: "打招呼" }, { optionId: "b", zh: "注视" }] },
      ]);
    };
    const btnText = (root: HTMLElement): (string | null)[] =>
      [...root.querySelectorAll<HTMLButtonElement>("button[data-option-id]")].map((b) => b.textContent);

    // 缺省(未注入 zhOn)= 有译文就显示(引擎自足用法不回归)
    const a = makeEngine();
    const withPrompt = { ...CHOICE, prompt: "どうする?" };
    const aId = a.engine.commitModel(withPrompt).lineId;
    attach(a.engine, aId);
    expect(a.root.querySelector(".gal-choice-prompt")?.textContent).toBe("怎么办?");
    expect(btnText(a.root)).toEqual(["打招呼", "注视"]);

    // 日文模式:译文仍在(存档往返保留),但不呈现
    const b = makeEngine({ zhOn: () => false });
    const bId = b.engine.commitModel(withPrompt).lineId;
    attach(b.engine, bId);
    expect(b.engine.pendingChoice?.options[0]?.zh).toBe("打招呼"); // 数据在
    expect(b.root.querySelector(".gal-choice-prompt")?.textContent).toBe("どうする?"); // 显示原文
    expect(btnText(b.root)).toEqual(["声をかける", "見守る"]);
  });

  it("refreshChoice:语言切换后重发 choice:labels 让浮层重画;无停等选项不发", () => {
    const { root, engine, bus } = makeEngine({ zhOn: () => false });
    let n = 0;
    bus.on("choice:labels", () => n++);
    engine.refreshChoice();
    expect(n).toBe(0); // 无停等选项:不发
    const { lineId } = engine.commitModel(CHOICE);
    expect(n).toBe(0); // offer 本身不带 labels 事件
    engine.attachChoiceLabels([{ lineId, labels: [{ optionId: "a", zh: "打招呼" }, { optionId: "b", zh: "注视" }] }]);
    expect(n).toBe(1); // 停等中回写原地换
    expect(root.querySelector(".gal-choice-prompt")).toBeNull(); // CHOICE 无 prompt
    engine.refreshChoice();
    expect(n).toBe(2); // 重画一次(渲染时读 zhOn,日文模式下重画即显示日文)
    expect([...root.querySelectorAll<HTMLButtonElement>("button[data-option-id]")].map((b) => b.textContent)).toEqual([
      "声をかける",
      "見守る",
    ]);
  });

  it("读档重建队列:已持久化的译文不丢(重开的 offer 直接带中文)", async () => {
    const a = makeEngine();
    const withPrompt = { ...CHOICE, prompt: "どうする?" };
    a.engine.commitModel({ t: "narrate", text: "前置行" });
    const committed = a.engine.commitModel(withPrompt);
    expect(committed.lineId).toBe("1.1");
    a.engine.attachChoiceLabels([
      {
        lineId: committed.lineId,
        prompt: "怎么办?",
        labels: [{ optionId: "a", zh: "打招呼" }, { optionId: "b", zh: "注视" }],
      },
    ]);
    await vi.waitFor(() => expect(a.engine.typewriter.typing).toBe(false)); // 1.0 打完,门停
    a.engine.advance(); // 放行 1.0 → 存档 displayedThrough 落在 1.0(choice 保持未读)
    await vi.waitFor(() => expect(a.engine.displayedThrough).toBe("1.0"));
    const save = a.engine.toSaveData();

    // 新引擎读档:choice 未读 → 队列重建 → 泵到达即 offer(直接中文,不需重新翻译)
    const b = makeEngine();
    b.engine.restoreFromSave(save);
    await vi.waitFor(() => expect(b.engine.pendingChoice).not.toBeNull());
    expect(b.engine.pendingChoice).toMatchObject({ prompt: "どうする?", promptZh: "怎么办?" });
    expect(b.engine.pendingChoice?.options.map((o) => o.zh)).toEqual(["打招呼", "注视"]);
    expect([...b.root.querySelectorAll<HTMLButtonElement>("button[data-option-id]")].map((btn) => btn.textContent)).toEqual([
      "打招呼",
      "注视",
    ]);
  });
});
