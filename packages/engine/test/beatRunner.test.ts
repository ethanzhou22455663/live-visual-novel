/**
 * BeatRunner(2026-10-18 幕制主循环)合同测试:
 * - 一幕流:planAct → 幕首场景落实(bg 相同跳过)→ 整幕流式 → 幕尾游标推进/beat:end
 * - choice:停等 offer → resolveChoice(world 折叠 clamp)→ **续写本幕**(不结束幕),
 *   续写指示带玩家选择 + ledgerTail;choice 幕 → 下一幕强制刷新走向
 * - sceneEnd → summarize;aborted(canContinue) → 同幕再入;aborted(false) → fatal
 * - 走向:首次强制刷新;planAct 喂回 direction/stage
 * 终止姿势:plans 尾部放 hang 垫幕,stopGeneration 确定性地停下循环。
 */
import { describe, expect, it, vi } from "vitest";
import type { ActPlan, StoryChunk, Summary } from "@gal/shared";
import { EMPTY_SUMMARY } from "@gal/shared";
import { BeatRunner } from "../src/core/BeatRunner.ts";
import { EngineCore } from "../src/core/EngineCore.ts";
import { EventBus } from "../src/core/EventBus.ts";
import { PresentationClock } from "../src/core/PresentationClock.ts";
import { ACT, content, fakeStage, fakeStory, pad, type Chunks, type PlanEntry } from "./beatRunnerHarness.ts";

function makeRunner(
  plans: PlanEntry[],
  segments?: Chunks[],
  opts: { outlineBeatCount?: number; stageBg?: string | null; cannedSummary?: Summary } = {},
) {
  const bus = new EventBus();
  // 显式 null=未开场舞台;undefined=缺省 classroom(不能 ?? 合并,null 会被吞)
  const stage = fakeStage(opts.stageBg !== undefined ? opts.stageBg : "classroom");
  const engine = new EngineCore({
    bus,
    clock: new PresentationClock(),
    stage,
    content,
    textEl: document.createElement("p"),
  });
  const story = fakeStory(plans, segments, opts.cannedSummary);
  const runner = new BeatRunner({ engine, bus, story, content, outlineBeatCount: opts.outlineBeatCount ?? 3 });
  return { engine, bus, story, runner };
}

const commit = (ev: Extract<StoryChunk, { kind: "commit" }>["event"]): StoryChunk => ({ kind: "commit", event: ev });
const done = (result: "choice" | "beatEnd" | "sceneEnd", lineCount = 1): StoryChunk => ({ kind: "done", result, lineCount });

describe("BeatRunner 幕循环", () => {
  it("一幕流:整幕 commit、幕尾游标推进/actsDone/beat:end、beatEnd 不触发摘要、首幕强制刷新走向", async () => {
    const { engine, bus, story, runner } = makeRunner(
      [{ direction: "走向A" }, pad()],
      [[
        commit({ t: "narrate", text: "一" }),
        commit({ t: "say", who: "enagi", emotion: "平常", text: "に" }),
        commit({ t: "narrate", text: "三" }),
        done("beatEnd", 3),
      ]],
    );
    const statuses: string[] = [];
    const beatEnds: string[] = [];
    bus.on("generation:status", (s) => statuses.push(s.phase));
    bus.on("beat:end", (e) => beatEnds.push(e.result));

    const p = runner.run();
    await vi.waitFor(() => expect(runner.actsDone).toBe(1)); // 幕完才停
    runner.stopGeneration();
    await p;

    expect(engine.ledger.map((e) => e.lineId)).toEqual(["1.0", "1.1", "1.2"]);
    expect(engine.phase).toBe("play");
    expect(story.summarizeCalls.length).toBe(0); // beatEnd 不摘要
    expect(beatEnds).toEqual(["beatEnd"]);
    expect(runner.outlineBeatIndex).toBe(1);
    expect(runner.storyDirection).toBe("走向A");
    expect(statuses).toEqual(["idle", "directing", "writing", "directing", "idle"]); // 垫幕停在下一轮 directing
    // 首幕:走向未生成 → 强制刷新;幕设计(无 bgm)的 stage 喂回
    expect(story.planCalls[0]!.mustRefreshDirection).toBe(true);
    expect(story.planCalls[0]!.direction).toBe("");
    expect(story.planCalls[0]!.stage).toEqual({ bg: "classroom", bgm: null, cast: [] });
    // 第二轮(垫幕):走向已生成 + actsDone=1(%5≠0)→ 不强制
    expect(story.planCalls[1]!.mustRefreshDirection).toBe(false);
    expect(story.planCalls[1]!.direction).toBe("走向A");
  });

  it("幕首场景落实:stage bg=null → commit bg/bgm;同场景同 bgm 的下一幕不重复 commit", async () => {
    const planWithBgm: ActPlan = { ...ACT, scene: { bg: "classroom", bgm: "p07", cast: ["enagi"] } };
    const { engine, story, runner } = makeRunner(
      [{ plan: planWithBgm }, { plan: planWithBgm }, pad()],
      [[commit({ t: "narrate", text: "一" }), done("sceneEnd", 1)], [commit({ t: "narrate", text: "二" }), done("sceneEnd", 1)]],
      { stageBg: null },
    );

    const p = runner.run();
    await vi.waitFor(() => expect(runner.actsDone).toBe(2));
    runner.stopGeneration();
    await p;

    // 幕1:bg 1.0 + bgm 1.1 先于台词;幕2:bg/bgm 相同 → 零重复 commit(turn 前进)
    expect(story.planCalls[1]!.stage).toEqual({ bg: "classroom", bgm: "p07", cast: [] });
    const kinds = engine.ledger.map((e) => (e.kind === "ev" && e.ev.t === "stage" ? e.ev.op.kind : e.kind));
    expect(kinds).toEqual(["bg", "bgm", "ev", "ev"]);
    expect(engine.ledger.map((e) => e.lineId)).toEqual(["1.0", "1.1", "1.2", "2.0"]);
  });

  it("choice 停等 → resolve 折叠(clamp)→ 续写本幕(续写指示带玩家选择+ledgerTail)→ sceneEnd 幕终", async () => {
    const planWithChoice: ActPlan = { ...ACT, beats: [{ goal: "選択まで", endsWith: "choice", maxLines: 6 }] };
    const { engine, story, runner } = makeRunner(
      [{ plan: planWithChoice }, pad()],
      [
        [
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
        (req) => {
          // 续写段:指示带玩家选择,ledgerTail 含已提交的 choice 行
          expect(req.continuation?.reason).toContain('The player chose "声をかける"');
          expect(req.ledgerTail).toContain('"t":"choice"');
          return [commit({ t: "say", who: "enagi", emotion: "笑", text: "えへへ。" }), done("sceneEnd", 1)];
        },
      ],
    );

    const p = runner.run();
    await vi.waitFor(() => expect(engine.pendingChoice).not.toBeNull());
    expect(engine.phase).toBe("choicing");
    expect(engine.world.affection.enagi).toBeUndefined(); // offer 时刻 world 不动

    expect(engine.resolveChoice("a")).toEqual({ optionId: "a", label: "声をかける" });
    await vi.waitFor(() => expect(runner.actsDone).toBe(1));
    runner.stopGeneration();
    await p;

    // 5 + 99 = 104 → clamp 100;同一幕内 turn 不变(选择+续写同 turn)
    expect(engine.world.affection.enagi).toBe(100);
    expect(engine.ledger.find((e) => e.kind === "choice")).toMatchObject({ optionId: "a", label: "声をかける", lineId: "1.1" });
    expect(engine.ledger.map((e) => e.lineId)).toEqual(["1.0", "1.1", "1.2"]);
    // sceneEnd → 摘要;choice 幕 → 下幕强制刷新走向
    expect(story.summarizeCalls.length).toBe(1);
    expect(story.planCalls[1]!.mustRefreshDirection).toBe(true);
  });

  it("sceneEnd → summarize(names/throughLineId),runner.summary 更新", async () => {
    const { story, runner } = makeRunner(
      [{}, pad()],
      [[commit({ t: "narrate", text: "一" }), done("sceneEnd")]],
    );

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

  it("aborted(canContinue) → 同幕再入:continuation + ledgerTail(已提交行可见),行号延续", async () => {
    const { engine, story, runner } = makeRunner(
      [{}],
      [
        [commit({ t: "narrate", text: "一行目" }), { kind: "aborted", reason: "生成停滞", canContinue: true }],
        (req) => {
          expect(req.continuation).toEqual({ reason: "generation interrupted, continue the act", count: 1 });
          expect(req.ledgerTail).toContain("一行目");
          return [commit({ t: "narrate", text: "二行目" }), done("sceneEnd", 2)];
        },
      ],
    );

    const p = runner.run();
    await vi.waitFor(() => expect(engine.ledger.length).toBe(2));
    runner.stopGeneration();
    await p;

    expect(story.genReqs.length).toBeGreaterThanOrEqual(2);
    expect(engine.ledger.map((e) => e.lineId)).toEqual(["1.0", "1.1"]); // 同幕续写,turn 不变
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
    const story = fakeStory([{}], [[{ kind: "aborted", reason: "LLM 流失败", canContinue: false }]]);
    const runner = new BeatRunner({ engine, bus, story, content, outlineBeatCount: 3 });
    const statuses: string[] = [];
    bus.on("generation:status", (s) => statuses.push(s.phase));

    await runner.run();
    expect(runner.running).toBe(false);
    expect(statuses).toEqual(["idle", "directing", "writing", "aborted", "error", "idle"]);
  });

  it("走向刷新节拍:大纲走完(index≥count)/每 5 幕 → 强制;direction 幕间沿用", async () => {
    // outlineBeatCount=1:幕 1 完成后游标=1 ≥ 1 → 幕 2 强制;actsDone=1(非 5 倍数)
    const { runner, story } = makeRunner(
      [{ direction: "走向1" }, { direction: "走向2" }, pad()],
      [
        [commit({ t: "narrate", text: "一" }), done("sceneEnd")],
        [commit({ t: "narrate", text: "二" }), done("sceneEnd")],
      ],
      { outlineBeatCount: 1 },
    );

    const p = runner.run();
    await vi.waitFor(() => expect(runner.actsDone).toBe(2));
    runner.stopGeneration();
    await p;

    expect(story.planCalls[0]!.mustRefreshDirection).toBe(true); // 走向未生成
    expect(story.planCalls[1]!.mustRefreshDirection).toBe(true); // 大纲走完
    expect(story.planCalls[1]!.direction).toBe("走向1"); // 旧走向喂回
    expect(runner.storyDirection).toBe("走向2");
    expect(runner.outlineBeatIndex).toBe(1); // 钳在 count
  });
});

describe("BeatRunner 三段式阶段机(2026-10-18)", () => {
  /** 带好感 delta 的 choice 条目:replay 进 ledger,foldWorld 折出种子好感(读档同路径) */
  const seedChoice = (affection: Record<string, number>) =>
    ({
      kind: "choice",
      lineId: "0.0",
      turnNo: 0,
      seq: 0,
      optionId: "seed",
      label: "種",
      delta: { affection },
    }) as const;

  const SCENE: StoryChunk[] = [commit({ t: "narrate", text: "一" }), done("sceneEnd")];

  it("好感达标 → 进线:最高好感**可立绘**角色(无立绘主角不参与);planAct 喂回 route", async () => {
    const { engine, story, runner } = makeRunner([{ direction: "走向A" }, pad()], [SCENE]);
    engine.replay([seedChoice({ yukitaka: 50, enagi: 20 })]); // 主角 50 分无立绘 → 不参与分线

    const p = runner.run();
    await vi.waitFor(() => expect(runner.actsDone).toBe(1));
    runner.stopGeneration();
    await p;

    expect(runner.route).toBe("enagi");
    expect(runner.routeSince).toBe(0);
    expect(story.planCalls[0]!.route).toBe("enagi");
    expect(story.planCalls[0]!.finale).toBeNull(); // 线内第 1 幕(diff=0<4)
  });

  it("好感不足门槛 → 共通线延续(route=null)", async () => {
    const { engine, story, runner } = makeRunner([{ direction: "走向A" }, pad()], [SCENE]);
    engine.replay([seedChoice({ enagi: 10 })]); // < 15

    const p = runner.run();
    await vi.waitFor(() => expect(runner.actsDone).toBe(1));
    runner.stopGeneration();
    await p;

    expect(runner.route).toBeNull();
    expect(story.planCalls[0]!.route).toBeNull();
    expect(story.planCalls[1]!.route).toBeNull();
  });

  it("线内幕数达标(actsDone-routeSince≥4)→ 下一幕 planAct 带 finale{heroine}", async () => {
    const { story, runner } = makeRunner([{ plan: ACT }, pad()], [SCENE]);
    runner.restore({ summary: EMPTY_SUMMARY, outlineBeatIndex: 0, actsDone: 4, route: "enagi", routeSince: 0 });

    const p = runner.run();
    await vi.waitFor(() => expect(runner.actsDone).toBe(5));
    runner.stopGeneration();
    await p;

    expect(story.planCalls[0]!.route).toBe("enagi");
    expect(story.planCalls[0]!.finale).toEqual({ heroine: "enagi" });
  });

  it("终幕以 sceneEnd 收束 → phase=ending + 循环自退出(不再规划下一幕);beat:end 照发", async () => {
    const { engine, bus, story, runner } = makeRunner([{ plan: ACT }], [SCENE]);
    runner.restore({ summary: EMPTY_SUMMARY, outlineBeatIndex: 0, actsDone: 4, route: "enagi", routeSince: 0 });
    const beatEnds: string[] = [];
    bus.on("beat:end", (e) => beatEnds.push(e.result));

    await runner.run(); // 无 choice/无垫幕:循环自己收束

    expect(runner.running).toBe(false);
    expect(engine.phase).toBe("ending");
    expect(story.planCalls.length).toBe(1); // 不再有下一幕
    expect(beatEnds).toEqual(["sceneEnd"]);
  });

  it("终幕中断(beatEnd 收束)→ 不进 ending;下一幕重试 finale,sceneEnd 才收束", async () => {
    const { engine, bus, story, runner } = makeRunner([{ plan: ACT }, { plan: ACT }], [
      [commit({ t: "narrate", text: "一" }), done("beatEnd")], // 幕设计异常兜底:非 sceneEnd
      SCENE,
    ]);
    runner.restore({ summary: EMPTY_SUMMARY, outlineBeatIndex: 0, actsDone: 4, route: "enagi", routeSince: 0 });
    const beatEnds: string[] = [];
    bus.on("beat:end", (e) => beatEnds.push(e.result));

    const p = runner.run();
    await vi.waitFor(() => expect(runner.actsDone).toBe(6));
    await p;

    expect(story.planCalls.length).toBe(2);
    expect(story.planCalls[1]!.finale).toEqual({ heroine: "enagi" }); // diff=5 仍达标 → 重试
    expect(beatEnds).toEqual(["beatEnd", "sceneEnd"]);
    expect(engine.phase).toBe("ending"); // 第二幕 sceneEnd 收束 → ending
  });

  it("segment:done:choice 硬切段与续写段各 emit 一次(同 turn)", async () => {
    const planWithChoice: ActPlan = { ...ACT, beats: [{ goal: "選択まで", endsWith: "choice", maxLines: 6 }] };
    const { bus, engine, runner } = makeRunner(
      [{ plan: planWithChoice }, pad()],
      [
        [
          commit({
            t: "choice",
            options: [
              { id: "a", label: "あ" },
              { id: "b", label: "い" },
            ],
            defaultOptionId: "a",
          }),
          done("choice"),
        ],
        [commit({ t: "narrate", text: "のち" }), done("sceneEnd")],
      ],
    );
    const segs: number[] = [];
    bus.on("segment:done", (e) => segs.push(e.turnNo));

    const p = runner.run();
    await vi.waitFor(() => expect(engine.pendingChoice).not.toBeNull());
    engine.resolveChoice("a");
    await vi.waitFor(() => expect(runner.actsDone).toBe(1));
    runner.stopGeneration();
    await p;

    expect(segs).toEqual([1, 1]); // choice 段 + 续写段
  });
});
