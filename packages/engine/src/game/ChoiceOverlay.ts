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
      "z-index:6", // 台词窗之上、面板之下(mock/ui.html 层序)
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
      p.className = "gal-choice-prompt"; // 视觉归 app CSS(mock .choice 语言)
      p.textContent = choice.prompt;
      this.#el.append(p);
    }
    const list = document.createElement("div");
    list.className = "gal-choice-list";
    list.style.cssText = "display:flex;flex-direction:column;gap:24px;width:700px;max-width:86%;";
    for (const opt of choice.options) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "gal-choice-btn";
      btn.dataset.optionId = opt.id;
      btn.style.cssText = ["position:relative", "padding:21px 20px 19px", "font-size:27px", "cursor:pointer"].join(";");
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
