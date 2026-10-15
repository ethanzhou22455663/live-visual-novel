/**
 * WriterService(ai-calls §2 调用②)合同测试:
 * - NDJSON 流 → commit/done;system=格式合同+三张表;user 块序冻结(§0.2)
 * - 连续坏行 → ParserAbortedError → aborted(canContinue)
 * - watchdog 停滞 → aborted(canContinue)(fake timers)
 * - overrun / missing-choice 内部续写一次,续写消息带【续写指示】+ ledgerTail
 * - BeatRunner 再入:req.ledgerTail 必须进入续写消息
 */
import { describe, expect, it, vi } from "vitest";
import { EMPTY_SUMMARY, EMPTY_WORLD } from "@gal/shared";
import type { GenerateBeatRequest, StoryChunk } from "@gal/shared";
import { WriterService } from "../src/director/writer.ts";
import { DIRECTIVE, fakeLlm, makePack, ndStream } from "./helpers.ts";

function makeReq(over: Partial<GenerateBeatRequest> = {}): GenerateBeatRequest {
  return {
    directive: DIRECTIVE,
    turnNo: 3,
    world: EMPTY_WORLD,
    summary: EMPTY_SUMMARY,
    history: [],
    ledgerTail: "",
    ...over,
  };
}

function makeWriter(llm: ReturnType<typeof fakeLlm>, watchdogMs?: number, onError?: (e: unknown) => void) {
  return new WriterService({ llm, apiKey: "", baseUrl: "/llm", pack: makePack(), watchdogMs, onError });
}

async function collect(gen: AsyncGenerator<StoryChunk, void, unknown>): Promise<StoryChunk[]> {
  const out: StoryChunk[] = [];
  for await (const c of gen) out.push(c);
  return out;
}

const SCRIPT = [
  { t: "stage", op: { kind: "bg", asset: "教室" } },
  { t: "say", who: "enagi", emotion: "平常", text: "……誰もいないはずなのに。" },
  { t: "narrate", text: "放課後の教室に、歌う声が響いていた。" },
] as const;

describe("WriterService.generateBeat", () => {
  it("NDJSON 流 → commit ×3 + done(beatEnd, lineCount=2);stage 不计行数", async () => {
    const llm = fakeLlm({ chatStream: () => ndStream(...SCRIPT) });
    const chunks = await collect(makeWriter(llm).generateBeat(makeReq()));
    const commits = chunks.filter((c) => c.kind === "commit");
    expect(commits.map((c) => (c as { event: { t: string } }).event.t)).toEqual(["stage", "say", "narrate"]);
    const done = chunks.find((c) => c.kind === "done");
    expect(done).toEqual({ kind: "done", result: "beatEnd", lineCount: 2 });
  });

  it("块序冻结:system=合同+三张表;user=世界書→摘要→世界→指令→歴史;命中条目进入上下文", async () => {
    const llm = fakeLlm({ chatStream: () => ndStream(...SCRIPT) });
    await collect(
      makeWriter(llm).generateBeat(
        makeReq({ history: [{ t: "narrate", text: "レモネードの話をした。" }] }),
      ),
    );
    const [sys, user] = llm.streamCalls[0]!.messages;
    expect(sys!.role).toBe("system");
    expect(sys!.content).toContain("NDJSON");
    expect(sys!.content).toContain("【可用角色】");
    expect(user!.role).toBe("user");
    const order = ["【世界書命中】", "【滚动摘要】", "【世界状态】", "【本拍指令】", "【近期历史】"].map((m) =>
      user!.content.indexOf(m),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order); // 块序单调
    expect(user!.content).toContain("バンド「レモネードファクトリー」の設定。"); // 世界书命中
  });

  it("连续 3 坏行 → aborted(canContinue=true),无 done", async () => {
    const llm = fakeLlm({
      chatStream: () =>
        (async function* () {
          yield '{"t":"bogus"}\n{"t":"bogus"}\n{"t":"bogus"}\n';
        })(),
    });
    const errors: unknown[] = [];
    const chunks = await collect(makeWriter(llm, undefined, (e) => errors.push(e)).generateBeat(makeReq()));
    expect(chunks.some((c) => c.kind === "done")).toBe(false);
    const aborted = chunks.find((c) => c.kind === "aborted");
    expect(aborted).toMatchObject({ kind: "aborted", canContinue: true, reason: "连续坏行" });
    expect(errors.length).toBeGreaterThanOrEqual(3);
  });

  it("watchdog 停滞 → aborted(canContinue)(fake timers)", async () => {
    vi.useFakeTimers();
    try {
      const llm = fakeLlm({
        chatStream: () =>
          (async function* () {
            yield '{"t":"narrate","text":"一行目。"}\n';
            await new Promise<void>(() => {}); // 永久停滞
          })(),
      });
      const chunks: StoryChunk[] = [];
      let finished = false;
      const consume = (async () => {
        for await (const c of makeWriter(llm, 30).generateBeat(makeReq())) chunks.push(c);
        finished = true;
      })();
      for (let i = 0; i < 10 && !finished; i++) await vi.advanceTimersByTimeAsync(50);
      expect(finished).toBe(true);
      expect(chunks.filter((c) => c.kind === "commit").length).toBe(1); // 已提交行保留
      expect(chunks.find((c) => c.kind === "aborted")).toMatchObject({ canContinue: true, reason: "生成停滞" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("overrun(> maxLines+4)→ 内部续写一次,消息带 overrun 理由与 ledgerTail", async () => {
    const lines = Array.from({ length: 8 }, (_, i) => ({ t: "say", who: "enagi", emotion: "平常", text: `せりふ${i}` }));
    const llm = fakeLlm({
      chatStream: (_o, call) => (call === 1 ? ndStream(...lines) : ndStream({ t: "narrate", text: "しめくくり。" })),
    });
    const chunks = await collect(
      makeWriter(llm).generateBeat(makeReq({ directive: { ...DIRECTIVE, maxLines: 2 } })),
    );
    expect(llm.streamCalls.length).toBe(2);
    const done = chunks.find((c) => c.kind === "done");
    expect(done).toEqual({ kind: "done", result: "beatEnd", lineCount: 9 });
    const retryUser = llm.streamCalls[1]!.messages.at(-1)!.content;
    expect(retryUser).toContain("【续写指示】");
    expect(retryUser).toContain("overrun");
    expect(retryUser).toContain("せりふ0"); // 已确定行(ledgerTail)让模型看到
  });

  it("missing-choice(endsWith=choice 无 choice 行)→ 续写后 done(choice)", async () => {
    const llm = fakeLlm({
      chatStream: (_o, call) =>
        call === 1
          ? ndStream({ t: "say", who: "enagi", emotion: "平常", text: "えっと……。" })
          : ndStream({
              t: "choice",
              options: [
                { id: "a", label: "声をかける" },
                { id: "b", label: "見守る" },
              ],
              defaultOptionId: "a",
            }),
    });
    const chunks = await collect(
      makeWriter(llm).generateBeat(makeReq({ directive: { ...DIRECTIVE, endsWith: "choice" } })),
    );
    expect(llm.streamCalls.length).toBe(2);
    expect(llm.streamCalls[1]!.messages.at(-1)!.content).toContain("missing-choice");
    const done = chunks.find((c) => c.kind === "done");
    expect(done).toMatchObject({ kind: "done", result: "choice" });
  });

  it("BeatRunner 再入:req.ledgerTail + continuation 进续写消息(禁原样重试)", async () => {
    const llm = fakeLlm({ chatStream: () => ndStream({ t: "narrate", text: "つづき。" }) });
    await collect(
      makeWriter(llm).generateBeat(
        makeReq({
          ledgerTail: '{"t":"narrate","text":"前の確定行。"}',
          continuation: { reason: "前次生成中断,继续本拍", count: 1 },
        }),
      ),
    );
    const user = llm.streamCalls[0]!.messages.at(-1)!.content;
    expect(user).toContain("【续写指示】");
    expect(user).toContain("前次生成中断,继续本拍");
    expect(user).toContain("前の確定行。"); // 引擎侧已提交行必须可见
  });
});
