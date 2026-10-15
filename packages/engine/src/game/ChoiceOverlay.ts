/**
 * 选项浮层(M4):DOM 实现,engine 持有——React 只做 chrome(标题/HUD)。
 * choice:offered 渲染选项;choice:resolved 或相位离开 choicing 时收起。
 * skip 模式的自动选择归 EngineCore(单一入口 resolveChoice,overlay 只管呈现)。
 * 机制样式内联(engine 自足,类名仅作语义钩子,视觉微调走 app CSS 覆盖)。
 */
import type { PublicChoiceOffer } from "@gal/shared";
import type { EventBus } from "../core/EventBus.ts";

export interface ChoiceOverlayDeps {
  bus: EventBus;
  /** 挂载点(舞台根元素) */
  root: HTMLElement;
  /** 玩家点选(与 skip 自动选同一入口:EngineCore.resolveChoice) */
  onPick(optionId: string): void;
}

export class ChoiceOverlay {
  #bus: EventBus;
  #root: HTMLElement;
  #onPick: (optionId: string) => void;
  #el: HTMLElement;
  #offs: Array<() => void> = [];

  constructor(deps: ChoiceOverlayDeps) {
    this.#bus = deps.bus;
    this.#root = deps.root;
    this.#onPick = deps.onPick;

    this.#el = document.createElement("div");
    this.#el.className = "gal-choice";
    this.#el.style.cssText = [
      "position:absolute",
      "inset:0",
      "display:none",
      "flex-direction:column",
      "align-items:center",
      "justify-content:center",
      "gap:26px",
      "background:rgba(8,9,14,.35)",
      "z-index:20",
    ].join(";");
    this.#root.append(this.#el);

    this.#offs.push(
      this.#bus.on("choice:offered", ({ choice }) => this.#show(choice)),
      this.#bus.on("choice:resolved", () => this.#hide()),
      this.#bus.on("engine:phase", ({ phase }) => {
        if (phase !== "choicing") this.#hide(); // replay/读档把相位带走时收起残留浮层
      }),
    );
  }

  /** 测试与 M5 存档恢复用 */
  get isOpen(): boolean {
    return this.#el.style.display !== "none";
  }

  /** 已渲染的选项 id(测试断言 DOM 不含 hidden 途径) */
  get optionIds(): string[] {
    return [...this.#el.querySelectorAll<HTMLButtonElement>("button[data-option-id]")].map((b) => b.dataset.optionId!);
  }

  dispose(): void {
    for (const off of this.#offs) off();
    this.#offs = [];
    this.#el.remove();
  }

  #show(choice: PublicChoiceOffer): void {
    this.#el.textContent = "";
    if (choice.prompt) {
      const p = document.createElement("p");
      p.className = "gal-choice-prompt";
      p.style.cssText =
        "margin:0;padding:12px 34px;border:1px solid rgba(255,255,255,.14);border-radius:999px;" +
        "background:rgba(12,13,20,.85);color:#f0eef8;font-size:24px;";
      p.textContent = choice.prompt;
      this.#el.append(p);
    }
    const list = document.createElement("div");
    list.className = "gal-choice-list";
    list.style.cssText = "display:flex;flex-direction:column;gap:18px;min-width:560px;";
    for (const opt of choice.options) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "gal-choice-btn";
      btn.dataset.optionId = opt.id;
      btn.style.cssText = [
        "padding:20px 40px",
        "font-size:26px",
        "text-align:left",
        "color:#f0eef8",
        "background:rgba(16,17,26,.88)",
        "border:1px solid rgba(255,255,255,.18)",
        "border-radius:14px",
        "cursor:pointer",
        "transition:border-color .15s ease, transform .15s ease",
      ].join(";");
      btn.addEventListener("mouseenter", () => {
        btn.style.borderColor = "#7aa2ff";
        btn.style.transform = "translateX(6px)";
      });
      btn.addEventListener("mouseleave", () => {
        btn.style.borderColor = "rgba(255,255,255,.18)";
        btn.style.transform = "";
      });
      btn.addEventListener("click", () => this.#onPick(opt.id));
      btn.textContent = opt.label;
      list.append(btn);
    }
    this.#el.append(list);
    this.#el.style.display = "flex";
  }

  #hide(): void {
    this.#el.style.display = "none";
    this.#el.textContent = "";
  }
}
