import { afterEach, describe, expect, it, vi } from "vitest";
import { PresentationClock } from "../src/core/PresentationClock.ts";

/** 手控 rAF + performance,替代 fake timers(确定性) */
function installManualFrame() {
  let cb: FrameRequestCallback | null = null;
  let now = 0;
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
    cb = fn;
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {
    cb = null;
  });
  vi.stubGlobal("performance", { now: () => now });
  return {
    tick(dt: number) {
      now += dt;
      const fn = cb;
      cb = null;
      fn?.(now);
      return now;
    },
    restore() {
      vi.unstubAllGlobals();
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PresentationClock", () => {
  it("帧循环派发 FrameInfo,onFrame 退订生效", () => {
    const f = installManualFrame();
    const clock = new PresentationClock();
    const frames: number[] = [];
    const off = clock.onFrame((info) => frames.push(info.deltaMs));
    clock.start();
    f.tick(16);
    f.tick(32);
    off();
    f.tick(64);
    clock.stop();
    expect(frames).toEqual([16, 32]);
    f.restore();
  });

  it("delta 封顶 250ms(后台标签页巨帧,坑⑬)", () => {
    const f = installManualFrame();
    const clock = new PresentationClock();
    const frames: number[] = [];
    clock.onFrame((info) => frames.push(info.deltaMs));
    clock.start();
    f.tick(5000);
    clock.stop();
    expect(frames).toEqual([250]);
    f.restore();
  });

  it("setMode 变更才通知;mode 随帧下发", () => {
    const f = installManualFrame();
    const clock = new PresentationClock();
    const modes: string[] = [];
    const seen: string[] = [];
    clock.onModeChange((m) => modes.push(m));
    clock.onFrame((info) => seen.push(info.mode));
    clock.setMode("fast");
    clock.setMode("fast");
    clock.start();
    f.tick(16);
    clock.setMode("normal");
    clock.stop();
    expect(modes).toEqual(["fast", "normal"]);
    expect(seen).toEqual(["fast"]);
    f.restore();
  });

  it("stop 后可 restart,无重复循环", () => {
    const f = installManualFrame();
    const clock = new PresentationClock();
    const frames: number[] = [];
    clock.onFrame((info) => frames.push(info.deltaMs));
    clock.start();
    clock.start(); // 幂等
    f.tick(10);
    clock.stop();
    clock.start();
    f.tick(20);
    clock.stop();
    expect(frames).toEqual([10, 20]);
    f.restore();
  });
});
