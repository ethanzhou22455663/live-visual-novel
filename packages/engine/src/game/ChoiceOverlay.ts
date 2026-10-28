/**
 * 选项浮层(M4):DOM 实现,engine 持有——React 只做 chrome(标题/HUD)。
 * choice:offered 渲染选项;choice:resolved 或相位离开 choicing 时收起。
 * 选项永远停等玩家(2026-10-17 裁决 skip 已移除,不存在自动选)。
 * 机制样式内联(engine 自足,类名仅作语义钩子,视觉微调走 app CSS 覆盖)。
 */
import type { PublicChoiceOffer } from "@gal/shared";
import type { EventBus } from "../core/EventBus.ts";

export interface ChoiceOverlayDeps {
  bus: EventBus;
  /** 挂载点(舞台根元素) */
  root: HTMLElement;
  /** 玩家点选(唯一入口:EngineCore.resolveChoice) */
  onPick(optionId: string): void;
  /** 译文显示开关(app 注入 uiLang==="zh";缺省 = 有译文就显示)。
   *  日文模式下不许呈现中文按钮/prompt(2026-10-28 用户反馈),渲染时实时读 */
  zhOn?: () => boolean;
}

export class ChoiceOverlay {
  #bus: EventBus;
  #root: HTMLElement;
  #onPick: (optionId: string) => void;
  #zhOn: () => boolean;
  #el: HTMLElement;
  #offs: Array<() => void> = [];

  constructor(deps: ChoiceOverlayDeps) {
    this.#bus = deps.bus;
    this.#root = deps.root;
    this.#onPick = deps.onPick;
    this.#zhOn = deps.zhOn ?? (() => true);

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
      // 译文回写(2026-10-28 裁决:选项不许只有日文):开着就把按钮原地说成中文
      this.#bus.on("choice:labels", ({ choice }) => {
        if (this.isOpen) this.#show(choice);
      }),
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
    const zh = this.#zhOn(); // 渲染时实时读:语言切到日文,已带译文的组也要显示日文
    const prompt = zh ? (choice.promptZh ?? choice.prompt) : choice.prompt;
    if (prompt) {
      const p = document.createElement("p");
      p.className = "gal-choice-prompt"; // 视觉归 app CSS(mock .choice 语言)
      p.textContent = prompt;
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
      btn.textContent = zh ? (opt.zh ?? opt.label) : opt.label; // 译文开关决定呈现语言,否则日文原文
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
