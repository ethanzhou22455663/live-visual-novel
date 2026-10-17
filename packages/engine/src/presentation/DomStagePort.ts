/**
 * DOM/CSS 舞台实现(P1 裁决 §6;视觉语言移植自 mock/ui.html):
 * - 背景两层 A/B 交叉淡化 .9s(同层换 src 会闪白,故双层)
 * - 立绘 enter:opacity+translateY(36px→0) .65s;**位置由在场人数唯一决定**(2026-10-17 裁决:
 *   "一人/两人/三人分别设置固定位置"——编剧 slot/move 不再决定位置,人数变化是唯一平移来源)
 * - 说话人高亮(dim 非发言者)按 2026-10-17 裁决移除:「男主说话立绘变黑是多此一举」
 * - 台词表情驱动:say.emotion → diff(权威来源,见 EngineCore#showLine)
 * - 未知表情 → defaultExpr + warn(坑⑧);图片未载完 → 占位淡入(坑⑭)
 * - 1920×1080 逻辑坐标,外层负责 scale;机制性样式全部内联(engine 自足,类名仅作语义钩子)
 */
import type { PresentationSnapshot } from "@gal/shared";
import type { SpriteOp, StageDeps, StagePort } from "./ports.ts";

export type { SpriteOp, StagePort, StageDeps } from "./ports.ts";

export function createDomStagePort(deps: StageDeps): StagePort {
  return new DomStagePort(deps);
}

// 按在场人数固定排位(2026-10-17 裁决)。素材是 1920×1080 全画布 PNG,人物画在画布中心、
// 宽约 40% 舞台宽:两人槽距 48% 放得下;三人 1 倍缩放数学上放不下(40×3>100)→ 全体缩 .72
// (人物宽≈29%,槽距 32% 放得下)。出场序从左到右;有人进/出全体平滑重排,恒不重叠。
const LAYOUT: Record<number, { xs: number[]; scale: number }> = {
  1: { xs: [50], scale: 1 },
  2: { xs: [26, 74], scale: 1 },
  3: { xs: [18, 50, 82], scale: 0.72 },
};

// 立绘定位:left:% 锚定(% 相对包含块 = 1920 逻辑宽)+ translate(-50%) 水平居中;
// transform 同时承担入场 36px 落下与人数缩放(place 完整重写,不能只改 left)。

class SpriteHandle {
  readonly el: HTMLElement;
  readonly img: HTMLImageElement;
  emotion = "";

  readonly who: string;
  #x = 50; // 当前布局位置(place 写入;快照槽名按它反查)

  constructor(who: string, layer: HTMLElement) {
    this.who = who;
    this.el = document.createElement("div");
    this.el.className = "gal-spr";
    this.el.dataset.who = who;
    this.el.style.cssText = [
      "position:absolute",
      "bottom:0",
      "left:50%",
      "height:100%",
      "aspect-ratio:auto",
      "opacity:0",
      "transform-origin:50% 100%", // 缩放以脚底为锚:人数缩放不把人抬离地面
      "transform:translate(-50%, 36px)",
      "transition:opacity .65s cubic-bezier(.2,.7,.2,1), transform .65s cubic-bezier(.2,.7,.2,1), left .65s cubic-bezier(.2,.7,.2,1)",
    ].join(";");
    this.img = document.createElement("img");
    this.img.alt = who;
    this.img.style.cssText = "height:100%;width:auto;max-width:none;display:block;";
    this.el.append(this.img);
    layer.append(this.el);
  }

  /** 快照用布局槽名(按当前 x 反查;位置由引擎按人数管理,此名仅存展示) */
  get slot(): "left" | "center" | "right" {
    return this.#x <= 35 ? "left" : this.#x <= 65 ? "center" : "right";
  }

  /** 引擎按人数排位:写 left% + transform 终值(缩放随人数);首调后下一帧淡入落位 */
  place(x: number, scale: number): void {
    this.#x = x;
    this.el.style.left = `${x}%`;
    this.el.style.transform = `translate(-50%, 0) scale(${scale})`;
    requestAnimationFrame(() => {
      this.el.style.opacity = "1";
    });
  }

  apply(emotion: string): void {
    this.emotion = emotion;
  }

  exit(): void {
    this.el.style.opacity = "0";
    const el = this.el;
    setTimeout(() => el.remove(), 700); // ≥.65s 淡出,不再中途切断(旧 400ms)
  }
}

export class DomStagePort implements StagePort {
  #deps: StageDeps;
  #bgLayer: HTMLElement;
  #sprLayer: HTMLElement;
  #bgImgs: [HTMLImageElement, HTMLImageElement];
  #bgFront = 0;
  #bgCurrent: string | null = null;
  #sprites = new Map<string, SpriteHandle>();
  #noSpriteLogged = new Set<string>(); // 无立绘角色只提示一次,不刷屏
  #imageCache = new Map<string, Promise<HTMLImageElement | null>>();
  #root: HTMLElement;

  constructor(deps: StageDeps) {
    this.#deps = deps;
    this.#root = deps.root;
    this.#root.classList.add("gal-stage");
    this.#bgLayer = document.createElement("div");
    this.#bgLayer.className = "gal-stage-bg";
    this.#bgLayer.style.cssText = "position:absolute;inset:0;background:var(--stage-empty,#0b0c10);";
    this.#sprLayer = document.createElement("div");
    this.#sprLayer.className = "gal-stage-sprites";
    this.#sprLayer.style.cssText = "position:absolute;inset:0;";
    this.#bgImgs = [this.#makeBg(), this.#makeBg()];
    this.#bgLayer.append(...this.#bgImgs);
    this.#root.append(this.#bgLayer, this.#sprLayer);
  }

  #makeBg(): HTMLImageElement {
    const img = document.createElement("img");
    img.className = "gal-stage-bg-img";
    img.alt = "";
    img.style.cssText =
      "position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:0;transition:opacity .9s ease, transform .9s ease;";
    return img;
  }

  // ---- 背景:双层交叉淡化 ----
  bg(assetId: string | null, transition: "fade" | "cut" | "slide" = "fade"): void {
    if (this.#bgCurrent === assetId) return;
    if (assetId === null) {
      this.#bgCurrent = null;
      this.#bgImgs[this.#bgFront]!.style.opacity = "0";
      return;
    }
    const url = this.#deps.resolve("scene", undefined, assetId);
    if (!url) {
      this.#deps.warn(`未知场景「${assetId}」,背景保持不变`);
      return;
    }
    const nextLayer = 1 - this.#bgFront;
    void this.#load(url).then((img) => {
      // 期间又切了别的背景 → 丢弃过期结果
      if (this.#bgCurrent === assetId) return;
      this.#bgCurrent = assetId;
      const next = this.#bgImgs[nextLayer]!;
      const front = this.#bgImgs[this.#bgFront]!;
      if (!img) {
        this.#placeholder(next, assetId);
        next.style.transform = "none";
        next.style.opacity = "1";
        front.style.opacity = "0";
        this.#bgFront = nextLayer;
        return;
      }
      next.src = img.src;
      if (transition === "cut") {
        next.style.transition = "none";
        next.style.opacity = "1";
        front.style.opacity = "0";
        this.#bgFront = nextLayer;
        return;
      }
      next.style.transition = "none";
      next.style.transform = transition === "slide" ? "translateX(60px)" : "none";
      next.style.opacity = "0";
      requestAnimationFrame(() => {
        next.style.transition = "";
        next.style.opacity = "1";
        next.style.transform = "none";
        front.style.opacity = "0";
      });
      this.#bgFront = nextLayer;
    });
  }

  // ---- 立绘(位置由在场人数唯一决定;编剧 slot/move 被忽略) ----
  sprite(op: SpriteOp): void {
    if (!this.#deps.content.characterIds.has(op.who)) {
      this.#deps.warn(`未知角色「${op.who}」,立绘指令忽略`);
      return;
    }
    // 无立绘角色(=主人公类,pack 无 sprites 目录;2026-10-17 裁决「主角不显示立绘」):
    // 不建句柄不占人数位——否则隐形占位块会把 1 人挤到 2 人表左槽。
    // 编剧(LLM)仍会给主角发 enter,这里持续兜底;提示每角色一次,不刷屏
    if (this.#deps.content.emotionsOf(op.who).size === 0) {
      if (!this.#noSpriteLogged.has(op.who)) {
        this.#noSpriteLogged.add(op.who);
        this.#deps.log?.(`「${op.who}」无立绘资产 → sprite 指令一律忽略(此后不再提示)`);
      }
      return;
    }
    let h = this.#sprites.get(op.who);
    if (op.action === "exit") {
      h?.exit();
      this.#sprites.delete(op.who);
      this.#relayout(); // 剩下的人平滑重排(人数变化是唯一平移来源)
      return;
    }
    if (!h) {
      if (op.action === "diff") return; // 未出场谈 diff = 编剧越权,忽略
      h = new SpriteHandle(op.who, this.#sprLayer);
      this.#sprites.set(op.who, h);
      this.#relayout(); // 出场即按在场人数排位
    }
    const wanted = op.emotion ?? h.emotion;
    const valid = this.#deps.content.emotionsOf(op.who);
    const emotion = wanted && valid.has(wanted) ? wanted : this.#deps.content.defaultExprOf(op.who);
    if (wanted && wanted !== emotion) {
      this.#deps.warn(`未知表情「${wanted}」@${op.who} → 回退「${emotion}」`);
    }
    if (emotion !== h.emotion) this.#deps.log?.(`表情 ${op.who}: ${h.emotion || "(无)"}→${emotion} @${op.action}`);
    h.apply(emotion);
    if (emotion) {
      const url = this.#deps.resolve("sprite", op.who, emotion);
      if (!url) {
        h.img.removeAttribute("src");
        h.img.style.background = "rgba(255,255,255,.06)";
      } else {
        void this.#load(url).then((img) => {
          if (h.emotion !== emotion) return; // 已换表情,丢弃
          if (img) {
            h.img.src = img.src;
            h.img.style.background = "";
          } else {
            h.img.removeAttribute("src");
            h.img.style.background = "rgba(255,255,255,.06)"; // 占位淡入
          }
        });
      }
    }
  }

  shake(): void {
    const el = this.#root;
    el.classList.remove("gal-shake");
    void el.offsetWidth; // 强制 reflow 以重启动画
    el.classList.add("gal-shake");
    setTimeout(() => el.classList.remove("gal-shake"), 500);
  }

  flash(): void {
    const el = document.createElement("div");
    el.className = "gal-flash";
    el.style.cssText =
      "position:absolute;inset:0;background:#fff;opacity:.85;pointer-events:none;transition:opacity .45s ease;";
    this.#root.append(el);
    requestAnimationFrame(() => (el.style.opacity = "0"));
    setTimeout(() => el.remove(), 500);
  }

  reset(): void {
    for (const h of this.#sprites.values()) h.exit();
    this.#sprites.clear();
    this.#bgCurrent = null;
    for (const img of this.#bgImgs) img.style.opacity = "0";
  }

  snapshot(): PresentationSnapshot {
    const sprites: PresentationSnapshot["sprites"] = {};
    for (const [who, h] of this.#sprites) sprites[who] = { slot: h.slot, emotion: h.emotion };
    return { bg: this.#bgCurrent, bgm: null, sprites };
  }

  restore(p: PresentationSnapshot): void {
    this.reset();
    if (p.bg) this.bg(p.bg, "cut");
    // slot 不回喂:位置由在场人数重排决定(旧档布局同样按人数走,行为更正确)
    for (const [who, s] of Object.entries(p.sprites)) {
      this.sprite({ who, action: "enter", emotion: s.emotion });
    }
  }

  /** 按在场人数排位(出场序从左到右);有人进/出即调,全体平滑重排,恒不重叠 */
  #relayout(): void {
    const n = this.#sprites.size;
    const lay = LAYOUT[n];
    let i = 0;
    const placed: string[] = [];
    for (const h of this.#sprites.values()) {
      const x = lay ? lay.xs[i]! : ((i + 1) / (n + 1)) * 100; // >3 人兜底均分(罕见,仅防炸)
      h.place(x, lay ? lay.scale : 0.6);
      placed.push(`${h.who}@${x}%`);
      i++;
    }
    this.#deps.log?.(`立绘重排 ${n}人: ${placed.join(" ")}`);
  }

  #load(url: string): Promise<HTMLImageElement | null> {
    let p = this.#imageCache.get(url);
    if (!p) {
      p = new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = url;
      });
      this.#imageCache.set(url, p);
    }
    return p;
  }

  #placeholder(el: HTMLImageElement, assetId: string): void {
    el.removeAttribute("src");
    el.style.background = "linear-gradient(160deg,#1a1d26,#0b0c10)";
    el.alt = assetId;
  }
}
