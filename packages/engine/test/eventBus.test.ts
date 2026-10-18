import { describe, expect, it, vi } from "vitest";
import { EventBus } from "../src/core/EventBus.ts";

describe("EventBus", () => {
  it("同类型多监听器按订阅顺序同步派发", () => {
    const bus = new EventBus();
    const calls: string[] = [];
    bus.on("line:commit", () => calls.push("a"));
    bus.on("line:commit", () => calls.push("b"));
    bus.emit("line:commit", { event: { t: "narrate", turnNo: 1, text: "x" }, lineId: "1.0" });
    expect(calls).toEqual(["a", "b"]);
  });

  it("退订后不再收到", () => {
    const bus = new EventBus();
    const calls: number[] = [];
    const off = bus.on("typewriter:done", () => calls.push(1));
    off();
    bus.emit("typewriter:done", { lineId: "1.0" });
    expect(calls).toEqual([]);
  });

  it("单监听器抛错不影响其余监听器", () => {
    const bus = new EventBus();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const calls: string[] = [];
    bus.on("engine:warning", () => {
      throw new Error("boom");
    });
    bus.on("engine:warning", () => calls.push("survivor"));
    bus.emit("engine:warning", { message: "m" });
    expect(calls).toEqual(["survivor"]);
    expect(errSpy).toHaveBeenCalledOnce();
    errSpy.mockRestore();
  });

  it("无监听器 emit 不抛错", () => {
    const bus = new EventBus();
    expect(() => bus.emit("voice:state", { lineId: "1.0", state: "muted" })).not.toThrow();
  });
});
