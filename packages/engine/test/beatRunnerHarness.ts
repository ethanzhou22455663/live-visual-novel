/**
 * BeatRunner 测试共享假件(beatRunner.test.ts 与 m6.test.ts 共用):
 * FakeStoryService 脚本化(nextBeat/generateBeat/summarize)+ 内容端口/舞台假件。
 * 终止姿势:脚本尾部放一个"挂到 signal abort"的 pad 拍,stopGeneration 确定性停循环。
 */
import type {
  BeatDirective,
  ContentPort,
  GenerateBeatRequest,
  NextBeatRequest,
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

export function fakeStage(): StagePort {
  return {
    bg: () => {},
    sprite: (_o: SpriteOp) => {},
    shake: () => {},
    flash: () => {},
    reset: () => {},
    snapshot: () => ({ bg: null, bgm: null, sprites: {} }),
    restore: () => {},
  };
}

export const DIRECTIVE: BeatDirective = {
  scene: { bg: "classroom", bgm: null, cast: ["enagi"] },
  goal: "再会",
  endsWith: "beatEnd",
  maxLines: 6,
};

export type Chunks = StoryChunk[] | ((req: GenerateBeatRequest) => AsyncGenerator<StoryChunk, void, unknown> | StoryChunk[]);

export interface ScriptEntry {
  directive?: BeatDirective;
  chunks?: Chunks;
  /** 垫拍:nextBeat 挂到 signal abort(此时 directing/writing 还没发,status 序列确定) */
  hang?: boolean;
}

/** 挂到 abort 的垫拍:让循环停在 nextBeat 里,stopGeneration 确定性收尾 */
export const pad = (): ScriptEntry => ({ hang: true });

export function fakeStory(script: ScriptEntry[], cannedSummary?: Summary) {
  const nextCalls: NextBeatRequest[] = [];
  const genReqs: GenerateBeatRequest[] = [];
  const summarizeCalls: SummarizeRequest[] = [];
  let i = 0;
  return {
    nextCalls,
    genReqs,
    summarizeCalls,
    async nextBeat(req: NextBeatRequest): Promise<BeatDirective> {
      nextCalls.push(req);
      const entry = script[i];
      if (entry?.hang) {
        const sig = req.signal;
        if (sig && !sig.aborted) {
          await new Promise<void>((resolve) => sig.addEventListener("abort", () => resolve(), { once: true }));
        }
      }
      return entry?.directive ?? DIRECTIVE;
    },
    async *generateBeat(req: GenerateBeatRequest): AsyncGenerator<StoryChunk, void, unknown> {
      genReqs.push(req);
      const entry = script[i];
      i++;
      if (!entry) {
        yield { kind: "aborted", reason: "script exhausted", canContinue: false };
        return;
      }
      const chunks = typeof entry.chunks === "function" ? entry.chunks(req) : entry.chunks;
      yield* chunks;
    },
    async summarize(req: SummarizeRequest): Promise<Summary> {
      summarizeCalls.push(req);
      return cannedSummary ?? { facts: "要約済み", charUpdates: {}, threads: [], summarizedThroughLineId: req.throughLineId };
    },
  };
}
