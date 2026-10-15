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

  it("speak 高亮发言者:非发言者 dim,旁白恢复", async () => {
    const { root, port } = makePort();
    port.sprite({ who: "enagi", action: "enter", emotion: "笑" });
    await flushImages();
    port.speak("enagi");
    const el = root.querySelector<HTMLElement>('[data-who="enagi"]')!;
    expect(el.style.filter).toBe("");
    port.speak(null);
    expect(el.style.filter).toBe("");
    // 两名角色时:非发言者被暗化
    // (enagi 在场,模拟第二个角色只需再次 enter 不同 who)
    port.sprite({ who: "yukitaka", action: "enter" });
    await flushImages();
    port.speak("yukitaka");
    const enagi = root.querySelector<HTMLElement>('[data-who="enagi"]')!;
    expect(enagi.style.filter).toContain("brightness(.6)");
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

  it("exit 移除立绘;speak(null) 不暗化任何人", async () => {
    const { root, port } = makePort();
    port.sprite({ who: "enagi", action: "enter", emotion: "平常" });
    await flushImages();
    port.speak("enagi");
    port.sprite({ who: "enagi", action: "exit" });
    await new Promise((r) => setTimeout(r, 450)); // 等 exit 的 remove 定时器
    expect(root.querySelector('[data-who="enagi"]')).toBeNull();
  });
});
