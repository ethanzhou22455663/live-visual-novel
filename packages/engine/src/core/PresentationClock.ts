/**
 * 演出时钟(plan §2.2):rAF 帧循环 + 模式状态。
 * - delta 封顶 250ms:后台标签页回来不产生巨帧(坑⑬)
 * - auto 推进的"墙钟"计时由消费方用 Date.now() 自理,本时钟只管模式与帧
 */
import type { ClockMode } from "@gal/shared";

export interface FrameInfo {
  /** 帧间隔 ms,已封顶 */
  deltaMs: number;
  mode: ClockMode;
}

export class PresentationClock {
  #mode: ClockMode = "normal";
  #subs = new Set<(f: FrameInfo) => void>();
  #modeSubs = new Set<(m: ClockMode) => void>();
  #raf = 0;
  #last = 0;

  get mode(): ClockMode {
    return this.#mode;
  }

  setMode(mode: ClockMode): void {
    if (this.#mode === mode) return;
    this.#mode = mode;
    for (const fn of [...this.#modeSubs]) fn(mode);
  }

  onFrame(fn: (f: FrameInfo) => void): () => void {
    this.#subs.add(fn);
    return () => this.#subs.delete(fn);
  }

  onModeChange(fn: (m: ClockMode) => void): () => void {
    this.#modeSubs.add(fn);
    return () => this.#modeSubs.delete(fn);
  }

  start(): void {
    if (this.#raf) return;
    this.#last = performance.now();
    const step = (now: number) => {
      const raw = now - this.#last;
      this.#last = now;
      const info: FrameInfo = { deltaMs: Math.min(raw, 250), mode: this.#mode };
      for (const fn of [...this.#subs]) fn(info);
      this.#raf = requestAnimationFrame(step);
    };
    this.#raf = requestAnimationFrame(step);
  }

  stop(): void {
    if (this.#raf) cancelAnimationFrame(this.#raf);
    this.#raf = 0;
  }
}
