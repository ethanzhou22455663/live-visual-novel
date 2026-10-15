/**
 * DirectorService(ai-calls §1 调用①)合同测试:
 * - zod/清单校验错误附进 user 重试一次;二次成功 clamp [6,14]
 * - 429 退避(withRetries ×3,fake timers)后彻底失败 → fallbackDirective
 * - 两次输出不合格 → fallback
 */
import { describe, expect, it, vi } from "vitest";
import { EMPTY_SUMMARY, EMPTY_WORLD } from "@gal/shared";
import type { NextBeatRequest } from "@gal/shared";
import { fallbackDirective } from "@gal/shared";
import { LlmHttpError } from "../src/llm/deepseek.ts";
import { DirectorService } from "../src/director/director.ts";
import { fakeLlm, makePack } from "./helpers.ts";

const REQ: NextBeatRequest = {
  world: EMPTY_WORLD,
  summary: EMPTY_SUMMARY,
  history: [],
  lastChoice: null,
  outlineBeatIndex: 0,
};

function service(llm: ReturnType<typeof fakeLlm>, onError?: (e: unknown) => void) {
  return new DirectorService({ llm, apiKey: "", baseUrl: "/llm", pack: makePack(), onError });
}

const OK = {
  scene: { bg: "教室", bgm: null, cast: ["enagi"] },
  goal: "再会の拍",
  endsWith: "beatEnd",
  maxLines: 8,
};

describe("DirectorService.nextBeat", () => {
  it("清单校验错误附进重试消息;二次成功且 maxLines clamp 进 [6,14]", async () => {
    const llm = fakeLlm({
      chatOnce: async (_o, call) =>
        call === 1
          ? JSON.stringify({ ...OK, scene: { bg: "屋上", bgm: null, cast: ["enagi"] }, maxLines: 30 })
          : JSON.stringify({ ...OK, maxLines: 30 }),
    });
    const svc = service(llm);
    const d = await svc.nextBeat(REQ);
    expect(llm.onceCalls.length).toBe(2);
    expect(d.maxLines).toBe(14); // clamp 上限
    const retryUser = llm.onceCalls[1]!.messages.at(-1)!.content;
    expect(retryUser).toContain("【前次输出错误】");
    expect(retryUser).toContain('scene.bg "屋上" 不在场景清单');
  });

  it("429 退避 3 次后仍失败 → fallbackDirective(同场景泛化 goal)", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const llm = fakeLlm({
        chatOnce: async () => {
          calls++;
          throw new LlmHttpError(429, "rate limited");
        },
      });
      const errors: unknown[] = [];
      const svc = service(llm, (e) => errors.push(e));
      const p = svc.nextBeat(REQ);
      // 指数退避 800+1600+3200ms+jitter:分段推进直到 resolve
      let resolved: unknown = "pending";
      void p.then((v) => (resolved = v));
      for (let i = 0; i < 20 && resolved === "pending"; i++) {
        await vi.advanceTimersByTimeAsync(1000);
      }
      expect(calls).toBe(4); // 初回 + 退避 3
      const pack = makePack();
      expect(resolved).toEqual(fallbackDirective("教室", Object.keys(pack.characters)));
      expect(errors.length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("两次输出不合格 → fallback;400(不可重试)立即走 fallback 不退避", async () => {
    let calls = 0;
    const llm = fakeLlm({
      chatOnce: async () => {
        calls++;
        return calls <= 2 ? "これは JSON ではない" : JSON.stringify(OK);
      },
    });
    const svc = service(llm);
    const d = await svc.nextBeat(REQ);
    expect(calls).toBe(2); // 坏 JSON 可 parse-fail 路径:重试一次后放弃(不触发 429 退避)
    expect(d.goal).toBe("物語を自然に進める。落ち着いた日常のワンシーンを描く。");
    expect(d.endsWith).toBe("beatEnd");
  });

  it("4xx(非 429)不可重试:单次调用即 fallback", async () => {
    let calls = 0;
    const llm = fakeLlm({
      chatOnce: async () => {
        calls++;
        throw new LlmHttpError(401, "unauthorized");
      },
    });
    const svc = service(llm);
    const d = await svc.nextBeat(REQ);
    expect(calls).toBe(1);
    expect(d.maxLines).toBe(10);
  });
});
