/**
 * 打字机(plan §2.2):rAF 驱动逐字上屏,CJK 标点停顿权重;
 * skip 瞬间 drain;cancel 只停不打点(P0:被新行顶替时不触发 done)。
 * auto 模式(打字机完 ∧ 语音完 ∧ 最小停留)在 P1 的 EngineCore 里组合。
 */

const DEFAULT_PUNCT_PAUSE_MS: Record<string, number> = {
  "。": 320,
  "！": 320,
  "？": 320,
  "‼": 360,
  "⁉": 360,
  "…": 240,
  "、": 130,
  "，": 130,
  ",": 130,
};

export interface TypewriterOptions {
  /** 每秒字数 */
  cps?: number;
  /** 额外标点停顿(覆盖默认表) */
  punctPauseMs?: Record<string, number>;
}

export class Typewriter {
  /** 进度回调(打字机与语音节奏配合用) */
  onProgress: ((ratio: number) => void) | null = null;

  private raf = 0;
  private resolveDone: (() => void) | null = null;
  private skipping = false;

  private el: HTMLElement;
  private opts: TypewriterOptions;

  constructor(el: HTMLElement, opts: TypewriterOptions = {}) {
    this.el = el;
    this.opts = opts;
  }

  start(text: string): Promise<void> {
    this.cancel();
    this.skipping = false;
    const chars = [...text];
    const cps = this.opts.cps ?? 30;
    const pauseOf = (ch: string) => this.opts.punctPauseMs?.[ch] ?? DEFAULT_PUNCT_PAUSE_MS[ch] ?? 0;
    return new Promise<void>((resolve) => {
      this.resolveDone = resolve;
      const startAt = performance.now();
      let shown = 0;
      let pauseAcc = 0; // 已消耗的标点停顿总量(从时间轴上扣除)
      const step = () => {
        if (this.skipping) {
          this.el.textContent = text;
          this.onProgress?.(1);
          this.#finish();
          return;
        }
        const elapsed = performance.now() - startAt - pauseAcc;
        let target = Math.floor((elapsed * cps) / 1000);
        if (target > shown) {
          if (target > chars.length) target = chars.length;
          this.el.textContent = chars.slice(0, target).join("");
          for (let i = shown; i < target; i++) pauseAcc += pauseOf(chars[i] ?? "");
          shown = target;
          this.onProgress?.(chars.length ? shown / chars.length : 1);
        }
        if (shown >= chars.length) {
          this.#finish();
          return;
        }
        this.raf = requestAnimationFrame(step);
      };
      this.raf = requestAnimationFrame(step);
    });
  }

  /** 瞬间补完当前行 */
  skip(): void {
    this.skipping = true;
  }

  /** 停止当前行且不触发完成回调(换行/打断用) */
  cancel(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.resolveDone = null;
    this.skipping = false;
  }

  #finish(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    const done = this.resolveDone;
    this.resolveDone = null;
    done?.();
  }
}
