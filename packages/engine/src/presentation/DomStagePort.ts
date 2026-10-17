/**
 * DOM/CSS 舞台实现(P1 裁决 §6;视觉语言移植自 mock/ui.html):
 * - 背景两层 A/B 交叉淡化 .9s(同层换 src 会闪白,故双层)
 * - 立绘 enter:opacity+translateY(36px→0) .65s;槽位 left/center/right = 26%/50%/74% left 锚定
 *   (2026-10-17 手验:素材是 1920×1080 全画布 PNG、人物画在画布中心宽约 40%,
 *    旧 34/66 槽距 32% 盖不住人物宽 → 两人同屏重叠;26/74 槽距 48% 才放得下)
 * - 说话人高亮(dim 非发言者)按 2026-10-17 裁决移除:「男主说话立绘变黑是多此一举」
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
const SLOT_X: Record<"left" | "center" | "right", number> = { left: 26, center: 50, right: 74 };

// 立绘定位(2026-10-17 修复):left:% 锚定槽位(% 相对包含块 = 1920 逻辑宽,语义正确),
// transform 只做 translate(-50%) 水平居中 + 入场的 36px 落下。
// 旧实现把槽位写进 translateX(±16%)——CSS 百分比按元素自身宽度解析,收缩包图的元素
// 上等于把中心钉在舞台 x=0(左半被 overflow:hidden 裁掉),三槽位全部塌在左缘。

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
      `left:${SLOT_X[this.slot]}%`,
      "height:100%",
      "aspect-ratio:auto",
      "transition:opacity .65s cubic-bezier(.2,.7,.2,1), transform .65s cubic-bezier(.2,.7,.2,1), left .65s cubic-bezier(.2,.7,.2,1)",
    ].join(";");
    this.img = document.createElement("img");
    this.img.alt = who;
    this.img.style.cssText = "height:100%;width:auto;max-width:none;display:block;";
    this.el.append(this.img);
    layer.append(this.el);
    // enter 动画:下一帧落位(仅 opacity + 36px 落下;水平居中交给 translate(-50%))
    this.el.style.opacity = "0";
    this.el.style.transform = "translate(-50%, 36px)";
    requestAnimationFrame(() => {
      this.el.style.opacity = "1";
      this.el.style.transform = "translate(-50%, 0)";
    });
  }

  apply(emotion: string): void {
    this.emotion = emotion;
  }

  moveTo(slot: "left" | "center" | "right"): void {
    if (this.slot === slot) return;
    this.slot = slot;
    this.el.style.left = `${SLOT_X[slot]}%`; // left 过渡平滑移位
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
