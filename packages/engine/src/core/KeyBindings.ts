/**
 * KeyBindings(M2 骨架,M6 定稿):keydown → 引擎动作。
 * 计划键位:Enter/Space=advance、Ctrl 按住 fast、滚轮/↑=backlog、Esc=暂停/关面板。
 * 面板打开时(见 #panelOpen)除 Esc 外全部吞掉,防止打字误触。
 */

export interface KeyActions {
  advance(): void;
  setFast(on: boolean): void;
  toggleBacklog(): void;
  togglePause(): void;
  closePanel(): void;
}

export class KeyBindings {
  #actions: KeyActions;
  #panelOpen = false;
  #detach: (() => void) | null = null;

  constructor(actions: KeyActions) {
    this.#actions = actions;
  }

  /** 面板(存读档/设置/backlog)打开时键位进入"仅 Esc"模式 */
  setPanelOpen(open: boolean): void {
    this.#panelOpen = open;
  }

  attach(target: HTMLElement | Window = window): void {
    if (this.#detach) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat && e.key !== "Enter" && e.key !== " ") return;
      if (this.#panelOpen) {
        if (e.key === "Escape") {
          e.preventDefault();
          this.#actions.closePanel();
        }
        return;
      }
      switch (e.key) {
        case "Enter":
        case " ":
          e.preventDefault();
          this.#actions.advance();
          break;
        case "Control":
          this.#actions.setFast(true);
          break;
        case "Escape":
          e.preventDefault();
          this.#actions.togglePause();
          break;
        case "ArrowUp":
          e.preventDefault();
          this.#actions.toggleBacklog();
          break;
        default:
          return;
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Control") this.#actions.setFast(false);
    };
    const host = target as EventTarget;
    host.addEventListener("keydown", onKey as EventListener);
    host.addEventListener("keyup", onKeyUp as EventListener);
    this.#detach = () => {
      host.removeEventListener("keydown", onKey as EventListener);
      host.removeEventListener("keyup", onKeyUp as EventListener);
    };
  }

  detach(): void {
    this.#detach?.();
    this.#detach = null;
  }
}
