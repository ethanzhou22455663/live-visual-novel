/**
 * Summarizer(ai-calls §3 调用③)测试:json_object/低温度、schema 校验、
 * facts 截断、threads 上限、throughLineId 回填、非 JSON/schema 不合 → 抛出。
 */
import { describe, expect, it, vi } from "vitest";
import { EMPTY_SUMMARY } from "@gal/shared";
import type { HistoryItem } from "@gal/shared";
import { LlmHttpError } from "../src/llm/deepseek.ts";
import { Summarizer } from "../src/director/summarize.ts";
import { fakeLlm } from "./helpers.ts";

const ITEMS: HistoryItem[] = [
  { t: "narrate", text: "放課後の教室。" },
  { t: "say", who: "enagi", emotion: "笑", text: "きみ、今の聞いた?" },
];

const MODEL_OUT = {
  facts: "恒凪が一人で歌っていた。主人公がそれに気づいた。",
  charUpdates: { enagi: "人前で歌うことに少し心を開いた" },
  threads: [{ id: "t1", title: "歌の正体", status: "open" }],
};

function summarizer(llm: ReturnType<typeof fakeLlm>, maxFactsChars?: number) {
  return new Summarizer({ llm, apiKey: "", baseUrl: "/llm", maxFactsChars });
}

describe("Summarizer.summarize", () => {
  it("合并输出 → Summary;throughLineId 由调用方回填;调用参数 json_object/temp0.3/超时30s", async () => {
    const llm = fakeLlm({ chatOnce: async () => JSON.stringify(MODEL_OUT) });
    const s = await summarizer(llm).summarize({
      old: EMPTY_SUMMARY,
      items: ITEMS,
      throughLineId: "2.5",
      names: { enagi: "陽見恵凪" },
    });
    expect(s).toEqual({ ...MODEL_OUT, summarizedThroughLineId: "2.5" });
    const o = llm.onceCalls[0]!;
    expect(o.responseFormat).toEqual({ type: "json_object" });
    expect(o.temperature).toBe(0.3);
    expect(o.timeoutMs).toBe(30_000);
    expect(o.messages.at(-1)!.content).toContain("[NEW EVENTS]");
    expect(o.messages.at(-1)!.content).toContain("陽見恵凪 (笑): \"きみ、今の聞いた?\""); // 历史渲染带表示名
  });

  it("facts 截到 maxFactsChars;threads ≤12;旧摘要点在 user 里", async () => {
    const llm = fakeLlm({
      chatOnce: async () =>
        JSON.stringify({
          facts: "あ".repeat(1000),
          charUpdates: {},
          threads: Array.from({ length: 15 }, (_, i) => ({ id: `t${i}`, title: `伏線${i}`, status: "open" })),
        }),
    });
    const s = await summarizer(llm, 100).summarize({
      old: { ...EMPTY_SUMMARY, facts: "旧い事実", threads: [{ id: "old", title: "旧伏線", status: "open" }] },
      items: ITEMS,
      throughLineId: "1.0",
    });
    expect(s.facts.length).toBe(100);
    expect(s.threads.length).toBe(12);
    const user = llm.onceCalls[0]!.messages.at(-1)!.content;
    expect(user).toContain("旧い事実");
    expect(user).toContain("旧伏線");
  });

  it("非 JSON → 抛出;畸形输出(threads 字符串化/charUpdates 值对象化)→ 归一化后成功", async () => {
    const llm = fakeLlm({ chatOnce: async () => "申し訳ありません、JSON ではありません" });
    await expect(
      summarizer(llm).summarize({ old: EMPTY_SUMMARY, items: ITEMS, throughLineId: "1.0" }),
    ).rejects.toBeInstanceOf(LlmHttpError);

    // 2026-10-18 手验:DeepSeek 实际输出过的两种畸形 → 宽松归一化兜住(摘要不再永败)
    const malformed = fakeLlm({
      chatOnce: async () =>
        JSON.stringify({
          facts: "まとめ",
          charUpdates: { enagi: { change: "心を開いた" } },
          threads: ["歌の正体", { id: "t2", title: "屋上の鍵", status: "open" }],
        }),
    });
    const s = await summarizer(malformed).summarize({ old: EMPTY_SUMMARY, items: ITEMS, throughLineId: "1.0" });
    expect(s.charUpdates.enagi).toBe(JSON.stringify({ change: "心を開いた" }));
    expect(s.threads[0]).toEqual({ id: "t1", title: "歌の正体", status: "open" });
    expect(s.threads[1]).toEqual({ id: "t2", title: "屋上の鍵", status: "open" });

    // 不可归一(threads 元素是数字)→ 仍 schema 不合抛出
    const bad = fakeLlm({ chatOnce: async () => JSON.stringify({ facts: "x", threads: [123] }) });
    await expect(
      summarizer(bad).summarize({ old: EMPTY_SUMMARY, items: ITEMS, throughLineId: "1.0" }),
    ).rejects.toThrow(/schema 不合/);
  });

  it("429 退避 1 次后成功(withRetries retries=1;fake timers)", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const llm = fakeLlm({
        chatOnce: async () => {
          calls++;
          if (calls === 1) throw new LlmHttpError(429, "busy");
          return JSON.stringify(MODEL_OUT);
        },
      });
      const p = summarizer(llm).summarize({ old: EMPTY_SUMMARY, items: ITEMS, throughLineId: "1.0" });
      let resolved: unknown = "pending";
      void p.then((v) => (resolved = v));
      for (let i = 0; i < 10 && resolved === "pending"; i++) await vi.advanceTimersByTimeAsync(500);
      expect(calls).toBe(2);
      expect(resolved).toMatchObject({ summarizedThroughLineId: "1.0" });
    } finally {
      vi.useRealTimers();
    }
  });
});
