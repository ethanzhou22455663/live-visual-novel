/**
 * 打字机(plan §2.2):rAF 驱动逐字上屏,严格恒速(2026-10-28 用户裁决:不要标点停顿,
 * 每个字等间隔出,句子不蹦);skip 瞬间 drain;cancel 只停不打点(被新行顶替时不触发 done)。
 * auto 模式(打字机完 ∧ 语音完 ∧ 最小停留)在 P1 的 EngineCore 里组合。
 */

export interface TypewriterOptions {
  /** 每秒字数 */
  cps?: number;
}

export class Typewriter {
  /** 正在逐字上屏中(advance 的两段语义:第一击补完文本,第二击快进语音/停留) */
  get typing(): boolean {
    return this.resolveDone !== null;
  }

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
    const interval = 1000 / cps;
    return new Promise<void>((resolve) => {
      this.resolveDone = resolve;
      let shown = 0;
      let acc = interval; // 时间预算:起步即一格,首字上帧就出
      let last = performance.now();
      const step = () => {
        if (this.skipping) {
          this.el.textContent = text;
          this.#finish();
          return;
        }
        const now = performance.now();
        // 严格恒速(2026-10-28 用户裁决:打字要平滑不许一卡一卡):预算按帧积累,
        // 但欠账封顶一格——主线程被生成流/渲染占住掉帧后,至多立刻补一字、绝不连喷,
        // 每字等间隔,总时长顺延(标点停顿已按用户裁决移除——那是「一句一句蹦」的元凶)
        acc = Math.min(acc + now - last, interval);
        last = now;
        const prev = shown;
        while (acc >= interval && shown < chars.length) {
          acc -= interval;
          shown++;
        }
        if (shown !== prev) this.el.textContent = chars.slice(0, shown).join("");
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

  /** 设置每秒字数(设置面板 M6:五档即时生效,当前行下一帧起按新速走) */
  setCps(cps: number): void {
    this.opts = { ...this.opts, cps };
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
