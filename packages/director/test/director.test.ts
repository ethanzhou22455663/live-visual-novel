/**
 * DirectorService(ai-calls §1 调用①,2026-10-18 幕制总导演)合同测试:
 * - 输出 {direction, act};【需新走向】时 direction=null 拒绝并附错重试
 * - 幕设计结构校验(最后段 sceneEnd/choice ≤1)+ maxLines clamp [6,14]
 * - 429 退避(withRetries ×3,fake timers)后彻底失败 → fallbackActPlan(沿用当前舞台)
 * - 两次输出不合格 / 4xx → fallback(direction=null 沿用旧走向)
 */
import { describe, expect, it, vi } from "vitest";
import { EMPTY_SUMMARY, EMPTY_WORLD, fallbackActPlan } from "@gal/shared";
import type { ActPlan, PlanActRequest } from "@gal/shared";
import { LlmHttpError } from "../src/llm/deepseek.ts";
import { DirectorService } from "../src/director/director.ts";
import { fakeLlm, makePack } from "./helpers.ts";

const REQ: PlanActRequest = {
  world: EMPTY_WORLD,
  summary: EMPTY_SUMMARY,
  history: [],
  lastChoice: null,
  outlineBeatIndex: 0,
  direction: "",
  mustRefreshDirection: false,
};

function service(llm: ReturnType<typeof fakeLlm>, onError?: (e: unknown) => void) {
  return new DirectorService({ llm, apiKey: "", baseUrl: "/llm", pack: makePack(), onError });
}

const ACT: ActPlan = {
  scene: { bg: "教室", bgm: null, cast: ["enagi"] },
  actGoal: "再会の幕",
  beats: [{ goal: "再会まで", endsWith: "beatEnd", maxLines: 8 }, { goal: "締め", endsWith: "sceneEnd", maxLines: 8 }],
};

describe("DirectorService.planAct", () => {
  it("清单校验错误附进重试消息;二次成功且各段 maxLines clamp 进 [6,14]", async () => {
    const llm = fakeLlm({
      chatOnce: async (_o, call) =>
        call === 1
          ? JSON.stringify({
              direction: null,
              act: { ...ACT, scene: { bg: "屋上", bgm: null, cast: ["enagi"] }, beats: [{ goal: "g", endsWith: "sceneEnd", maxLines: 30 }] },
            })
          : JSON.stringify({ direction: null, act: { ...ACT, beats: [{ goal: "g", endsWith: "sceneEnd", maxLines: 3 }] } }),
    });
    const svc = service(llm);
    const { act } = await svc.planAct(REQ);
    expect(llm.onceCalls.length).toBe(2);
    expect(act.beats[0]!.maxLines).toBe(6); // clamp 下限
    const retryUser = llm.onceCalls[1]!.messages.at(-1)!.content;
    expect(retryUser).toContain("[PREVIOUS OUTPUT ERRORS]");
    expect(retryUser).toContain('scene.bg "屋上" is not in the scene list');
  });

  it("结构校验:最后段非 sceneEnd / choice 段 >1 / 【需新走向】时 direction=null → 全部附错重试", async () => {
    const bads: unknown[] = [
      { direction: null, act: { ...ACT, beats: [{ goal: "g", endsWith: "beatEnd", maxLines: 8 }] } },
      {
        direction: null,
        act: {
          ...ACT,
          beats: [
            { goal: "a", endsWith: "choice", maxLines: 8 },
            { goal: "b", endsWith: "choice", maxLines: 8 },
            { goal: "c", endsWith: "sceneEnd", maxLines: 8 },
          ],
        },
      },
    ];
    let call = 0;
    const llm = fakeLlm({
      chatOnce: async () => {
        call++;
        return call <= 2 ? JSON.stringify(bads[call - 1]) : JSON.stringify({ direction: null, act: ACT });
      },
    });
    const svc = service(llm);
    await svc.planAct(REQ);
    const user1 = llm.onceCalls[1]!.messages.at(-1)!.content;
    expect(user1).toContain('endsWith must be "sceneEnd"');

    let call2 = 0;
    const llm2 = fakeLlm({
      chatOnce: async () => {
        call2++;
        return call2 === 1 ? JSON.stringify({ direction: null, act: ACT }) : JSON.stringify({ direction: "新しい走向", act: ACT });
      },
    });
    const { direction } = await service(llm2).planAct({ ...REQ, mustRefreshDirection: true });
    expect(llm2.onceCalls.length).toBe(2);
    const user2 = llm2.onceCalls[1]!.messages.at(-1)!.content;
    expect(user2).toContain("[NEED NEW DIRECTION]");
    expect(user2).toContain("direction must not be null");
    expect(direction).toBe("新しい走向");
  });

  it("429 退避 3 次后仍失败 → fallback(direction=null 沿用 + 沿用当前舞台 bg/cast)", async () => {
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
      const req: PlanActRequest = { ...REQ, stage: { bg: "商店街", bgm: null, cast: ["enagi"] }, direction: "旧走向" };
      const p = svc.planAct(req);
      // 指数退避 800+1600+3200ms+jitter:分段推进直到 resolve
      let resolved: unknown = "pending";
      void p.then((v) => (resolved = v));
      for (let i = 0; i < 20 && resolved === "pending"; i++) {
        await vi.advanceTimersByTimeAsync(1000);
      }
      expect(calls).toBe(4); // 初回 + 退避 3
      expect(resolved).toEqual({ direction: null, act: fallbackActPlan("商店街", ["enagi"]) });
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
        return calls <= 2 ? "これは JSON ではない" : JSON.stringify({ direction: null, act: ACT });
      },
    });
    const svc = service(llm);
    const { direction, act } = await svc.planAct(REQ);
    expect(calls).toBe(2); // 坏 JSON 可 parse-fail 路径:重试一次后放弃(不触发 429 退避)
    expect(direction).toBeNull();
    expect(act.actGoal).toBe("Let the story proceed naturally; depict a calm everyday moment.");
    expect(act.beats[0]!.endsWith).toBe("sceneEnd");
  });

  it("4xx(非 429)不可重试:单次调用即 fallback;无舞台状态时取首个场景", async () => {
    let calls = 0;
    const llm = fakeLlm({
      chatOnce: async () => {
        calls++;
        throw new LlmHttpError(401, "unauthorized");
      },
    });
    const svc = service(llm);
    const { act } = await svc.planAct(REQ);
    expect(calls).toBe(1);
    expect(act.scene.bg).toBe("教室"); // makePack 唯一场景
    expect(act.beats[0]!.maxLines).toBe(8);
  });
});
