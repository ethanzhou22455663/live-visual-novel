/**
 * BeatRunner 测试共享假件(beatRunner.test.ts / m6.test.ts / saveSystem.test.ts 共用):
 * FakeStoryService 脚本化(planAct/generateBeat/summarize,幕制 2026-10-18)+ 内容端口/舞台假件。
 * - plans:总导演脚本(每幕一项;direction/hang 可选;hang=挂到 signal abort,确定性停循环)
 * - segments:编剧脚本(按调用序;choice 续写/中断再入都是新的一段)
 */
import type {
  ActPlan,
  ContentPort,
  GenerateBeatRequest,
  PlanActRequest,
  StoryChunk,
  SummarizeRequest,
  Summary,
} from "@gal/shared";
import type { SpriteOp, StagePort } from "../src/presentation/ports.ts";

export const content: ContentPort = {
  characterIds: new Set(["enagi", "yukitaka"]),
  sceneIds: new Set(["classroom"]),
  bgmIds: new Set<string>(),
  defaultExprOf: (who) => (who === "enagi" ? "平常" : ""),
  emotionsOf: (who) => (who === "enagi" ? new Set(["平常", "笑"]) : new Set<string>()),
  displayNameOf: (who) => (who === "enagi" ? "陽見恵凪" : who),
};

/** 舞台假件:有状态 snapshot(bg 默认 classroom,与 ACT 对齐 → 幕首 bg 相同跳过) */
export function fakeStage(bg: string | null = "classroom"): StagePort {
  let current = bg;
  return {
    bg: (a) => {
      current = a;
    },
    sprite: (_o: SpriteOp) => {},
    shake: () => {},
    flash: () => {},
    reset: () => {
      current = null;
    },
    snapshot: () => ({ bg: current, bgm: null, sprites: {} }),
    restore: () => {},
  };
}

export const ACT: ActPlan = {
  scene: { bg: "classroom", bgm: null, cast: ["enagi"] },
  actGoal: "再会の幕",
  beats: [{ goal: "教室の探索と再会", endsWith: "sceneEnd", maxLines: 6 }],
};

export type Chunks = StoryChunk[] | ((req: GenerateBeatRequest) => AsyncGenerator<StoryChunk, void, unknown> | StoryChunk[]);

export interface PlanEntry {
  /** planAct 返回的幕设计(缺省 ACT) */
  plan?: ActPlan;
  /** 新走向(缺省 null=沿用) */
  direction?: string | null;
  /** 垫幕:planAct 挂到 signal abort(此时 directing 还没发,status 序列确定) */
  hang?: boolean;
}

/** 挂到 abort 的垫幕:让循环停在 planAct 里,stopGeneration 确定性收尾 */
export const pad = (): PlanEntry => ({ hang: true });

export function fakeStory(plans: PlanEntry[], segments?: Chunks[], cannedSummary?: Summary) {
  const planCalls: PlanActRequest[] = [];
  const genReqs: GenerateBeatRequest[] = [];
  const summarizeCalls: SummarizeRequest[] = [];
  let pi = 0;
  let si = 0;
  return {
    planCalls,
    genReqs,
    summarizeCalls,
    async planAct(req: PlanActRequest): Promise<{ direction: string | null; act: ActPlan }> {
      planCalls.push(req);
      const entry = plans[pi++];
      if (entry?.hang) {
        const sig = req.signal;
        if (sig && !sig.aborted) {
          await new Promise<void>((resolve) => sig.addEventListener("abort", () => resolve(), { once: true }));
        }
      }
      return { direction: entry?.direction ?? null, act: entry?.plan ?? ACT };
    },
    async *generateBeat(req: GenerateBeatRequest): AsyncGenerator<StoryChunk, void, unknown> {
      genReqs.push(req);
      const seg = segments?.[si++];
      if (!seg) {
        yield { kind: "aborted", reason: "script exhausted", canContinue: false };
        return;
      }
      const chunks = typeof seg === "function" ? seg(req) : seg;
      yield* chunks;
    },
    async summarize(req: SummarizeRequest): Promise<Summary> {
      summarizeCalls.push(req);
      return cannedSummary ?? { facts: "要約済み", charUpdates: {}, threads: [], summarizedThroughLineId: req.throughLineId };
    },
  };
}
