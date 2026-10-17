import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContentPort } from "@gal/shared";
import { createDomStagePort } from "../src/presentation/DomStagePort.ts";
import type { StageDeps } from "../src/presentation/ports.ts";

const content: ContentPort = {
  characterIds: new Set(["enagi", "yukitaka"]),
  sceneIds: new Set(["classroom", "street"]),
  bgmIds: new Set<string>(),
  defaultExprOf: (who) => (who === "enagi" ? "平常" : ""),
  emotionsOf: (who) => (who === "enagi" ? new Set(["平常", "笑", "惊"]) : new Set<string>()),
  displayNameOf: (who) => (who === "enagi" ? "陽見恵凪" : who),
};

function makeDeps(root: HTMLElement, warns: string[] = []): StageDeps {
  return {
    root,
    resolve: (kind, who, id) => {
      if (kind === "scene") return content.sceneIds.has(id) ? `http://t/scene/${id}.jpg` : null;
      return who === "enagi" ? `http://t/spr/${who}/${id}.png` : null;
    },
    content,
    warn: (m) => warns.push(m),
  };
}

/** 捕获 #load 里的 new Image,测试中手动触发 onload(happy-dom 不真加载) */
const created: HTMLImageElement[] = [];
class FakeImage {
  constructor() {
    const el = document.createElement("img");
    created.push(el);
    return el;
  }
}

beforeEach(() => {
  vi.stubGlobal("Image", FakeImage);
});

async function flushImages(): Promise<void> {
  for (const el of created.splice(0)) el.onload?.(new Event("load"));
  await new Promise((r) => setTimeout(r, 0));
}

afterEach(() => {
  vi.unstubAllGlobals();
  created.length = 0;
});

function makePort() {
  const root = document.createElement("div");
  const warns: string[] = [];
  const port = createDomStagePort(makeDeps(root, warns));
  return { root, warns, port };
}

describe("DomStagePort", () => {
  it("立绘 enter:挂元素、未知表情回退 defaultExpr 并 warn", async () => {
    const { root, warns, port } = makePort();
    port.sprite({ who: "enagi", action: "enter", emotion: "害羞" });
    await flushImages();
    const el = root.querySelector<HTMLElement>('[data-who="enagi"]')!;
    expect(el).toBeTruthy();
    expect(warns.some((w) => w.includes("未知表情「害羞」"))).toBe(true);
    const img = el.querySelector("img")!;
    expect(decodeURIComponent(img.getAttribute("src") ?? "")).toBe("http://t/spr/enagi/平常.png");
  });

  it("未知角色立绘指令忽略并 warn;无立绘角色 diff 前不出现", () => {
    const { root, warns, port } = makePort();
    port.sprite({ who: "ghost", action: "enter", emotion: "平常" });
    expect(root.querySelector('[data-who="ghost"]')).toBeNull();
    expect(warns.some((w) => w.includes("未知角色「ghost」"))).toBe(true);
    port.sprite({ who: "yukitaka", action: "diff", emotion: "" });
    expect(root.querySelector('[data-who="yukitaka"]')).toBeNull();
  });

  it("说话人高亮已按 2026-10-17 裁决移除:diff/speak 不再暗化任何立绘", async () => {
    const { root, port } = makePort();
    port.sprite({ who: "enagi", action: "enter", emotion: "笑" });
    await flushImages();
    port.sprite({ who: "yukitaka", action: "enter", slot: "left" });
    await flushImages();
    // 模拟泵显示 say:引擎只发 diff 表情指令,不存在「非发言者变暗」
    port.sprite({ who: "yukitaka", action: "diff", emotion: "平常" });
    for (const who of ["enagi", "yukitaka"]) {
      const el = root.querySelector<HTMLElement>(`[data-who="${who}"]`)!;
      expect(el.style.filter).toBe("");
      expect(el.classList.contains("gal-spr-dim")).toBe(false);
    }
  });

  it("bg:已知场景解析 URL,未知场景 warn 且保持;重复切同图 no-op", () => {
    const { root, warns, port } = makePort();
    port.bg("classroom");
    expect(warns).toEqual([]);
    const layers = root.querySelectorAll<HTMLImageElement>(".gal-stage-bg-img");
    expect(layers.length).toBe(2);
    port.bg("classroom"); // no-op
    port.bg("nowhere");
    expect(warns.some((w) => w.includes("未知场景「nowhere」"))).toBe(true);
    port.bg(null);
  });

  it("snapshot/restore 往返:背景与立绘槽位表情还原", async () => {
    const { port } = makePort();
    port.bg("classroom", "cut");
    await flushImages();
    port.sprite({ who: "enagi", action: "enter", slot: "left", emotion: "笑" });
    await flushImages();
    const snap = port.snapshot();
    expect(snap.bg).toBe("classroom");
    expect(snap.sprites.enagi).toEqual({ slot: "left", emotion: "笑" });

    port.reset();
    expect(port.snapshot().bg).toBeNull();
    expect(Object.keys(port.snapshot().sprites)).toEqual([]);

    port.restore(snap);
    await new Promise((r) => setTimeout(r, 0)); // bg 走异步 load 缓存
    expect(port.snapshot().bg).toBe("classroom");
    expect(port.snapshot().sprites.enagi).toEqual({ slot: "left", emotion: "笑" });
  });

  it("槽位 left 锚定:26%/50%/74%(2026-10-17 二调:全画布素材人物宽~40%,槽距 48% 才不重叠),水平居中归 translate(-50%)", async () => {
    const { root, port } = makePort();
    port.sprite({ who: "enagi", action: "enter", slot: "center", emotion: "平常" });
    const el = root.querySelector<HTMLElement>('[data-who="enagi"]')!;
    expect(el.style.left).toBe("50%"); // % 相对包含块(1920 逻辑宽),不再按元素自身宽度解析
    expect(el.style.transform).toContain("translate(-50%");
    port.sprite({ who: "yukitaka", action: "enter", slot: "left" });
    const el2 = root.querySelector<HTMLElement>('[data-who="yukitaka"]')!;
    expect(el2.style.left).toBe("26%");
    port.sprite({ who: "enagi", action: "diff", slot: "right" });
    expect(el.style.left).toBe("74%"); // moveTo 走 left 过渡
    expect(el.style.transition).toContain("left .65s");
  });

  it("exit 移除立绘(≥.65s 淡出后移除 DOM)", async () => {
    const { root, port } = makePort();
    port.sprite({ who: "enagi", action: "enter", emotion: "平常" });
    await flushImages();
    port.sprite({ who: "enagi", action: "exit" });
    await new Promise((r) => setTimeout(r, 750)); // 等 exit 的 remove 定时器(≥.65s 淡出,2026-10-17 起 700ms)
    expect(root.querySelector('[data-who="enagi"]')).toBeNull();
  });
});
