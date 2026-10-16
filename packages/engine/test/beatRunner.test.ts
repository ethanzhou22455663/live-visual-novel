/**
 * BeatRunner(plan §1.4 主循环)合同测试:
 * - FakeStoryService 脚本化(beatRunnerHarness 共享):lineId 分配、status 序列、大纲游标推进
 * - choice 停等 → resolveChoice → world 折叠(自身+hidden 合一,clamp)→ 循环继续
 * - sceneEnd → summarize(names/throughLineId)
 * - aborted(canContinue) → 同拍再入:continuation + ledgerTail
 * - aborted(canContinue:false) → fatal,status error,循环退出
 * 终止姿势:脚本尾部放一个"挂到 signal abort"的 pad 拍,stopGeneration 确定性地停下循环。
 */
import { describe, expect, it, vi } from "vitest";
import type { StoryChunk } from "@gal/shared";
import { BeatRunner } from "../src/core/BeatRunner.ts";
import { EngineCore } from "../src/core/EngineCore.ts";
import { EventBus } from "../src/core/EventBus.ts";
import { PresentationClock } from "../src/core/PresentationClock.ts";
import { content, DIRECTIVE, fakeStage, fakeStory, pad, type ScriptEntry } from "./beatRunnerHarness.ts";

function makeRunner(script: ScriptEntry[], cannedSummary?: import("@gal/shared").Summary) {
  const bus = new EventBus();
  const engine = new EngineCore({
    bus,
    clock: new PresentationClock(),
    stage: fakeStage(),
    content,
    textEl: document.createElement("p"),
  });
  const story = fakeStory(script, cannedSummary);
  const runner = new BeatRunner({ engine, bus, story, voice: null, content, outlineBeatCount: 3 });
  return { engine, bus, story, runner };
}

const commit = (ev: Extract<StoryChunk, { kind: "commit" }>["event"]): StoryChunk => ({ kind: "commit", event: ev });
const done = (result: "choice" | "beatEnd" | "sceneEnd", lineCount = 1): StoryChunk => ({ kind: "done", result, lineCount });

describe("BeatRunner", () => {
  it("一拍流:lineId 1.0→…、status 序列、大纲游标推进、beatEnd 不触发摘要", async () => {
    const { engine, bus, story, runner } = makeRunner([
      {
        chunks: [
          commit({ t: "narrate", text: "一" }),
          commit({ t: "say", who: "enagi", emotion: "平常", text: "に" }),
          commit({ t: "narrate", text: "三" }),
          done("beatEnd", 3),
        ],
      },
      pad(),
    ]);
    const statuses: string[] = [];
    bus.on("generation:status", (s) => statuses.push(s.phase));

    const p = runner.run();
    await vi.waitFor(() => expect(runner.outlineBeatIndex).toBe(1)); // 拍完 + 游标推进后才停
    runner.stopGeneration();
    await p;

    expect(engine.ledger.map((e) => e.lineId)).toEqual(["1.0", "1.1", "1.2"]);
    expect(engine.phase).toBe("play");
    expect(story.summarizeCalls.length).toBe(0);
    expect(statuses).toEqual(["idle", "directing", "writing", "directing", "idle"]); // 垫拍停在下一轮 directing
  });

  it("choice 停等:offer 时 world 不动;resolve 后 自身+hidden 合一折叠(clamp),循环继续下一拍", async () => {
    const { engine, story, runner } = makeRunner([
      {
        directive: { ...DIRECTIVE, endsWith: "choice" },
        chunks: [
          commit({
            t: "choice",
            options: [
              { id: "a", label: "声をかける", delta: { affection: { enagi: 5 } }, hidden: { delta: { affection: { enagi: 99 } } } },
              { id: "b", label: "見守る" },
            ],
            defaultOptionId: "a",
          }),
          done("choice"),
        ],
      },
      { chunks: [commit({ t: "narrate", text: "つづき" }), done("beatEnd")] },
      pad(),
    ]);

    const p = runner.run();
    await vi.waitFor(() => expect(engine.pendingChoice).not.toBeNull());
    expect(engine.phase).toBe("choicing");
    expect(engine.world.affection.enagi).toBeUndefined(); // offer 时刻 world 不动

    expect(engine.resolveChoice("a")).toEqual({ optionId: "a", label: "声をかける" });
    await vi.waitFor(() => expect(engine.ledger.some((e) => e.turnNo === 2)).toBe(true));
    runner.stopGeneration();
    await p;

    // 5 + 99 = 104 → clamp 100;落一条 choice 条目
    expect(engine.world.affection.enagi).toBe(100);
    expect(engine.ledger.find((e) => e.kind === "choice")).toMatchObject({ optionId: "a", label: "声をかける", lineId: "1.1" });
    expect(engine.ledger.map((e) => e.lineId)).toEqual(["1.0", "1.1", "2.0"]);
    // 下一拍(导演/编剧)看到折叠后的世界
    expect(story.nextCalls[1]!.world.affection.enagi).toBe(100);
    expect(story.genReqs[1]!.world.affection.enagi).toBe(100);
  });

  it("sceneEnd → summarize(names/throughLineId),runner.summary 更新", async () => {
    const { story, runner } = makeRunner([{ chunks: [commit({ t: "narrate", text: "一" }), done("sceneEnd")] }, pad()]);

    const p = runner.run();
    await vi.waitFor(() => expect(runner.summary.summarizedThroughLineId).toBe("1.0"));
    runner.stopGeneration();
    await p;

    const call = story.summarizeCalls[0]!;
    expect(call.throughLineId).toBe("1.0");
    expect(call.items.length).toBe(1);
    expect(call.names!.enagi).toBe("陽見恵凪");
    expect(runner.outlineBeatIndex).toBe(1);
  });

  it("aborted(canContinue) → 同拍再入:continuation + ledgerTail(已提交行可见),行号延续", async () => {
    const { engine, story, runner } = makeRunner([
      { chunks: [commit({ t: "narrate", text: "一行目" }), { kind: "aborted", reason: "生成停滞", canContinue: true }] },
      {
        chunks: (req) => {
          expect(req.continuation).toEqual({ reason: "前次生成中断,继续本拍", count: 1 });
          expect(req.ledgerTail).toContain("一行目");
          return [commit({ t: "narrate", text: "二行目" }), done("beatEnd", 2)];
        },
      },
      pad(),
    ]);

    const p = runner.run();
    await vi.waitFor(() => expect(engine.ledger.length).toBe(2));
    runner.stopGeneration();
    await p;

    expect(story.genReqs.length).toBeGreaterThanOrEqual(2);
    expect(engine.ledger.map((e) => e.lineId)).toEqual(["1.0", "1.1"]); // 同拍续写,拍号不变
  });

  it("aborted(canContinue:false) → fatal:status error,循环自己退出", async () => {
    const bus = new EventBus();
    const engine = new EngineCore({
      bus,
      clock: new PresentationClock(),
      stage: fakeStage(),
      content,
      textEl: document.createElement("p"),
    });
    const story = fakeStory([{ chunks: [{ kind: "aborted", reason: "LLM 流失败", canContinue: false }] }]);
    const runner = new BeatRunner({ engine, bus, story, voice: null, content, outlineBeatCount: 3 });
    const statuses: string[] = [];
    bus.on("generation:status", (s) => statuses.push(s.phase));

    await runner.run();
    expect(runner.running).toBe(false);
    expect(statuses).toEqual(["idle", "directing", "writing", "aborted", "error", "idle"]);
  });
});
