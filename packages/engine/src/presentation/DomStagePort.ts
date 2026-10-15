/**
 * DOM/CSS 舞台实现(P1 裁决 §6;视觉语言移植自 mock/ui.html):
 * - 背景两层 A/B 交叉淡化 .9s(同层换 src 会闪白,故双层)
 * - 立绘 enter:opacity+translateY(36px→0) .65s;槽位 left/center/right = 中央 ±16%
 * - 非发言者 brightness(.6) saturate(.85)
 * - 未知表情 → defaultExpr + warn(坑⑧);图片未载完 → 占位淡入(坑⑭)
 * - 1920×1080 逻辑坐标,外层负责 scale;机制性样式全部内联(engine 自足,类名仅作语义钩子)
 */
import type { PresentationSnapshot } from "@gal/shared";
import type { SpriteOp, StageDeps, StagePort } from "./ports.ts";

export type { SpriteOp, StagePort, StageDeps } from "./ports.ts";

export function createDomStagePort(deps: StageDeps): StagePort {
  return new DomStagePort(deps);
}

const STAGE_W = 1920;
const STAGE_H = 1080;
const SLOT_X: Record<"left" | "center" | "right", number> = { left: 34, center: 50, right: 66 };

/** 立绘定位:bottom 锚定,水平以槽位为中心 */
function sprTransform(slot: "left" | "center" | "right", enterOffset: boolean): string {
  return `translate(-50%, ${enterOffset ? "36px" : "0"}) translateX(${SLOT_X[slot] - 50}%)`;
}

class SpriteHandle {
  readonly el: HTMLElement;
  readonly img: HTMLImageElement;
  slot: "left" | "center" | "right";
  emotion = "";

  readonly who: string;

  constructor(who: string, layer: HTMLElement, initialSlot: "left" | "center" | "right" | undefined) {
    this.who = who;
    this.slot = initialSlot ?? "center";
    this.el = document.createElement("div");
    this.el.className = "gal-spr";
    this.el.dataset.who = who;
    this.el.style.cssText = [
      "position:absolute",
      "bottom:0",
      "left:0",
      "height:100%",
      "aspect-ratio:auto",
      "transition:opacity .65s cubic-bezier(.2,.7,.2,1), transform .65s cubic-bezier(.2,.7,.2,1), filter .35s ease",
    ].join(";");
    this.img = document.createElement("img");
    this.img.alt = who;
    this.img.style.cssText = "height:100%;width:auto;max-width:none;display:block;";
    this.el.append(this.img);
    layer.append(this.el);
    // enter 动画:下一帧落位
    this.el.style.opacity = "0";
    this.el.style.transform = sprTransform(this.slot, true);
    requestAnimationFrame(() => {
      this.el.style.opacity = "1";
      this.el.style.transform = sprTransform(this.slot, false);
    });
  }

  apply(emotion: string): void {
    this.emotion = emotion;
  }

  moveTo(slot: "left" | "center" | "right"): void {
    if (this.slot === slot) return;
    this.slot = slot;
    this.el.style.transform = sprTransform(slot, false);
  }

  setDim(dim: boolean): void {
    this.el.classList.toggle("gal-spr-dim", dim);
    this.el.style.filter = dim ? "brightness(.6) saturate(.85)" : "";
  }

  exit(): void {
    this.el.style.opacity = "0";
    const el = this.el;
    setTimeout(() => el.remove(), 400);
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
  #imageCache = new Map<string, Promise<HTMLImageElement | null>>();
  #speaking: string | null = null;
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

  // ---- 立绘 ----
  sprite(op: SpriteOp): void {
    if (!this.#deps.content.characterIds.has(op.who)) {
      this.#deps.warn(`未知角色「${op.who}」,立绘指令忽略`);
      return;
    }
    let h = this.#sprites.get(op.who);
    if (op.action === "exit") {
      h?.exit();
      this.#sprites.delete(op.who);
      this.#applyDim();
      return;
    }
    if (!h) {
      if (op.action === "diff") return; // 未出场谈 diff = 编剧越权,忽略
      h = new SpriteHandle(op.who, this.#sprLayer, op.slot);
      this.#sprites.set(op.who, h);
    }
    if (op.slot) h.moveTo(op.slot);
    const wanted = op.emotion ?? h.emotion;
    const valid = this.#deps.content.emotionsOf(op.who);
    const emotion = wanted && valid.has(wanted) ? wanted : this.#deps.content.defaultExprOf(op.who);
    if (wanted && wanted !== emotion) {
      this.#deps.warn(`未知表情「${wanted}」@${op.who} → 回退「${emotion}」`);
    }
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
    this.#applyDim();
  }

  speak(who: string | null): void {
    this.#speaking = who;
    this.#applyDim();
  }

  #applyDim(): void {
    for (const [who, h] of this.#sprites) h.setDim(this.#speaking !== null && this.#speaking !== who);
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
    this.#speaking = null;
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
    for (const [who, s] of Object.entries(p.sprites)) {
      this.sprite({ who, slot: s.slot, action: "enter", emotion: s.emotion });
    }
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
