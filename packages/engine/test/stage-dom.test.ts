import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContentPort } from "@gal/shared";
import { createDomStagePort } from "../src/presentation/DomStagePort.ts";
import type { StageDeps } from "../src/presentation/ports.ts";

const content: ContentPort = {
  characterIds: new Set(["enagi", "yukitaka", "mitsuki", "rin"]),
  sceneIds: new Set(["classroom", "street"]),
  bgmIds: new Set<string>(),
  defaultExprOf: (who) => (who === "enagi" ? "平常" : ""),
  // yukitaka = 无立绘主角(pack 无 sprites 目录);mitsuki/rin 有立绘表(resolve 返回 null → 占位,不影响几何)
  emotionsOf: (who) =>
    who === "enagi" ? new Set(["平常", "笑", "惊"]) : who === "yukitaka" ? new Set<string>() : new Set(["平常"]),
  displayNameOf: (who) => (who === "enagi" ? "陽見恵凪" : who),
};

function makeDeps(root: HTMLElement, warns: string[] = [], logs: string[] = []): StageDeps {
  return {
    root,
    resolve: (kind, who, id) => {
      if (kind === "scene") return content.sceneIds.has(id) ? `http://t/scene/${id}.jpg` : null;
      return who === "enagi" ? `http://t/spr/${who}/${id}.png` : null;
    },
    content,
    warn: (m) => warns.push(m),
    log: (m) => logs.push(m),
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
  const logs: string[] = [];
  const port = createDomStagePort(makeDeps(root, warns, logs));
  return { root, warns, logs, port };
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

  it("未知角色忽略并 warn;无立绘角色(主角)enter/diff 都不建句柄", () => {
    const { root, warns, port } = makePort();
    port.sprite({ who: "ghost", action: "enter", emotion: "平常" });
    expect(root.querySelector('[data-who="ghost"]')).toBeNull();
    expect(warns.some((w) => w.includes("未知角色「ghost」"))).toBe(true);
    port.sprite({ who: "yukitaka", action: "enter" }); // 主角:pack 无 sprites 目录
    port.sprite({ who: "yukitaka", action: "diff", emotion: "平常" });
    expect(root.querySelector('[data-who="yukitaka"]')).toBeNull();
  });

  it("主角不占人数位:对主角发过 enter 后,唯一可见立绘仍按 1 人表居中;忽略提示只打一次", () => {
    const { root, logs, port } = makePort();
    for (let i = 0; i < 3; i++) port.sprite({ who: "yukitaka", action: i === 1 ? "diff" : "enter" }); // 编剧反复发也只提示一次
    expect(logs.filter((m) => m.includes("无立绘资产"))).toHaveLength(1);
    port.sprite({ who: "enagi", action: "enter", emotion: "平常" });
    const el = root.querySelector<HTMLElement>('[data-who="enagi"]')!;
    expect(el.style.left).toBe("50%"); // 若主角占位,这里会是 2 人表的 26%(截图 3 的 bug)
  });

  it("说话人高亮已按 2026-10-17 裁决移除:diff/speak 不再暗化任何立绘", async () => {
    const { root, port } = makePort();
    port.sprite({ who: "enagi", action: "enter", emotion: "笑" });
    await flushImages();
    port.sprite({ who: "mitsuki", action: "enter", slot: "left" });
    await flushImages();
    // 模拟泵显示 say:引擎只发 diff 表情指令,不存在「非发言者变暗」
    port.sprite({ who: "mitsuki", action: "diff", emotion: "平常" });
    for (const who of ["enagi", "mitsuki"]) {
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

  it("snapshot/restore 往返:背景与立绘表情还原(slot 名仅存展示,布局按人数重排)", async () => {
    const { port } = makePort();
    port.bg("classroom", "cut");
    await flushImages();
    port.sprite({ who: "enagi", action: "enter", emotion: "笑" }); // 1 人 → 居中
    await flushImages();
    const snap = port.snapshot();
    expect(snap.bg).toBe("classroom");
    expect(snap.sprites.enagi).toEqual({ slot: "center", emotion: "笑" });

    port.reset();
    expect(port.snapshot().bg).toBeNull();
    expect(Object.keys(port.snapshot().sprites)).toEqual([]);

    port.restore(snap);
    await new Promise((r) => setTimeout(r, 0)); // bg 走异步 load 缓存
    expect(port.snapshot().bg).toBe("classroom");
    expect(port.snapshot().sprites.enagi).toEqual({ slot: "center", emotion: "笑" });

    // 两人档:slot 名按当前 x 反查(left/right);restore 不回喂 slot,重排即正确布局
    port.sprite({ who: "mitsuki", action: "enter" });
    expect(port.snapshot().sprites.enagi).toEqual({ slot: "left", emotion: "笑" });
    expect(port.snapshot().sprites.mitsuki).toEqual({ slot: "right", emotion: "" });
  });

  it("人数固定布局(2026-10-17 裁决):排位由在场人数唯一决定,编剧 slot 被忽略", () => {
    const { root, port } = makePort();
    // 1 人:居中(slot:"right" 是编剧乱发的,必须被忽略;scale=1)
    port.sprite({ who: "enagi", action: "enter", slot: "right", emotion: "平常" });
    const el1 = root.querySelector<HTMLElement>('[data-who="enagi"]')!;
    expect(el1.style.left).toBe("50%");
    expect(el1.style.transform).toContain("translate(-50%, 0) scale(1)");
    // 2 人:26/74(全体重排:出场序从左到右)
    port.sprite({ who: "mitsuki", action: "enter", slot: "center" });
    const el2 = root.querySelector<HTMLElement>('[data-who="mitsuki"]')!;
    expect(el1.style.left).toBe("26%");
    expect(el2.style.left).toBe("74%");
    expect(el2.style.transform).toContain("scale(1)");
    // 3 人:18/50/82 + 全体缩 .72(素材全画布,1 倍放不下;origin 脚底,不悬空)
    port.sprite({ who: "rin", action: "enter" });
    const el3 = root.querySelector<HTMLElement>('[data-who="rin"]')!;
    expect(el1.style.left).toBe("18%");
    expect(el2.style.left).toBe("50%");
    expect(el3.style.left).toBe("82%");
    for (const el of [el1, el2, el3]) {
      expect(el.style.transform).toContain("scale(0.72)");
      expect(el.style.transformOrigin).toBe("50% 100%"); // 缩放锚脚底:不出现「半个人在空中」
    }
    expect(el1.style.transition).toContain("left .65s"); // 重排平移走过渡
  });

  it("exit → 剩余立绘按人数重排(人数变化是唯一平移来源)", () => {
    const { root, port } = makePort();
    port.sprite({ who: "enagi", action: "enter" });
    port.sprite({ who: "mitsuki", action: "enter" });
    port.sprite({ who: "rin", action: "enter" });
    const el1 = root.querySelector<HTMLElement>('[data-who="enagi"]')!;
    const el2 = root.querySelector<HTMLElement>('[data-who="mitsuki"]')!;
    port.sprite({ who: "rin", action: "exit" });
    expect(el1.style.left).toBe("26%"); // 3 人表 → 2 人表
    expect(el2.style.left).toBe("74%");
    expect(el1.style.transform).toContain("scale(1)"); // 缩放复原
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
