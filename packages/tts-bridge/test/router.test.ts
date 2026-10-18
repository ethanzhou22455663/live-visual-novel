/**
 * TtsRouter(plan §1.7):按序降级合同——失败永久切下一家、链尾耗尽上抛、
 * abort 不是故障不降级(队列级 cancel API 已删,signal abort 覆盖)、healthCheck 委派当前。
 */
import { describe, expect, it, vi } from "vitest";
import type { ReadyClip, SynthRequest, TtsProvider } from "@gal/shared";
import { TtsRouter } from "../src/index.ts";

function req(over: Partial<SynthRequest> = {}): SynthRequest {
  return { lineId: "1.0", text: "テスト", ...over } as SynthRequest;
}

function fake(id: string, impl: (r: SynthRequest) => Promise<ReadyClip>): TtsProvider {
  return { id, synthesize: vi.fn(impl), healthCheck: async () => id === "a" };
}

const clip: ReadyClip = { lineId: "1.0", audio: new ArrayBuffer(4), durationSec: 0.2, sampleRate: 24000 };

describe("TtsRouter", () => {
  it("首 provider 成功:不降级、activeId 不变", async () => {
    const a = fake("a", async () => clip);
    const b = fake("b", async () => clip);
    const onDegraded = vi.fn();
    const r = new TtsRouter({ providers: [a, b], onDegraded });
    await expect(r.synthesize(req())).resolves.toBe(clip);
    expect(r.activeId).toBe("a");
    expect(onDegraded).not.toHaveBeenCalled();
    expect(b.synthesize).not.toHaveBeenCalled();
  });

  it("失败永久降级:onDegraded 通知,后续调用不再回头(演出中声线不变)", async () => {
    const a = fake("a", async () => {
      throw new Error("9880 拒绝连接");
    });
    const b = fake("b", async () => clip);
    const onDegraded = vi.fn();
    const r = new TtsRouter({ providers: [a, b], onDegraded });

    await expect(r.synthesize(req())).resolves.toBe(clip);
    expect(onDegraded).toHaveBeenCalledWith("a", "b");
    expect(r.activeId).toBe("b");

    await r.synthesize(req()); // 第二次:直达 b,不再触 a
    expect(a.synthesize).toHaveBeenCalledTimes(1);
    expect(b.synthesize).toHaveBeenCalledTimes(2);
  });

  it("链尾耗尽:原样上抛,onDegraded 收 (from, null)", async () => {
    const a = fake("a", async () => {
      throw new Error("fail-a");
    });
    const b = fake("b", async () => {
      throw new Error("fail-b");
    });
    const onDegraded = vi.fn();
    const r = new TtsRouter({ providers: [a, b], onDegraded });
    await expect(r.synthesize(req())).rejects.toThrow("fail-b");
    expect(onDegraded).toHaveBeenCalledTimes(2);
    expect(onDegraded).toHaveBeenNthCalledWith(1, "a", "b");
    expect(onDegraded).toHaveBeenNthCalledWith(2, "b", null);
    expect(r.activeId).toBeNull();
  });

  it("abort 原样上抛:不降级", async () => {
    const a = fake("a", async () => {
      throw new Error("The operation was aborted");
    });
    const onDegraded = vi.fn();
    const r = new TtsRouter({ providers: [a], onDegraded });
    const ac = new AbortController();
    ac.abort();
    await expect(r.synthesize(req({ signal: ac.signal }))).rejects.toThrow();
    expect(onDegraded).not.toHaveBeenCalled();
    expect(r.activeId).toBe("a");
  });

  it("healthCheck 委派当前 provider", async () => {
    const a = fake(
      "a",
      async () => {
        throw new Error("down"); // 首次合成失败 → 降级到 b
      },
    );
    const b = fake("b", async () => clip);
    const r = new TtsRouter({ providers: [a, b] });
    await expect(r.healthCheck()).resolves.toBe(true); // a
    await r.synthesize(req()); // 降级到 b
    expect(r.activeId).toBe("b");
    await expect(r.healthCheck()).resolves.toBe(false); // b 的 fake 返回 false
  });
});
