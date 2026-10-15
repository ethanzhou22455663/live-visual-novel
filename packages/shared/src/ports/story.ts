/**
 * StoryService 端口(plan §1.4):engine(BeatRunner)与 director 互不依赖的唯一通道。
 * 实现在 director 包(app 装配注入);测试注 FakeStoryService。
 */
import type { BeatDirective } from "../protocol/directive.ts";
import type { ModelScriptEvent } from "../protocol/schema.model.ts";
import type { Summary } from "../state/summary.ts";
import type { WorldState } from "../state/world.ts";

/** 历史渲染条目(ai-calls §0.4):导演与编剧共用 */
export type HistoryItem =
  | { t: "say"; who: string; emotion?: string; text: string }
  | { t: "narrate"; text: string }
  | { t: "choice"; label: string };

export interface NextBeatRequest {
  world: WorldState;
  summary: Summary;
  history: readonly HistoryItem[];
  /** 玩家刚做的选择(resolveChoice 变体);null=通常的下一拍 */
  lastChoice?: { label: string } | null;
  /** 大纲 `- ` 行游标(0 起);无结构=null */
  outlineBeatIndex: number | null;
  signal?: AbortSignal;
}

export interface GenerateBeatRequest {
  directive: BeatDirective;
  turnNo: number;
  world: WorldState;
  summary: Summary;
  history: readonly HistoryItem[];
  /** 本拍已提交行的 NDJSON(续写用;通常空) */
  ledgerTail: string;
  /** 续写上下文(BeatRunner 重入时带;禁原样重试) */
  continuation?: { reason: string; count: number };
  signal?: AbortSignal;
}

export type StoryChunk =
  | { kind: "preview"; text: string }
  | { kind: "commit"; event: ModelScriptEvent }
  | { kind: "aborted"; reason: string; canContinue: boolean }
  | { kind: "done"; result: "choice" | "beatEnd" | "sceneEnd"; lineCount: number };

export interface SummarizeRequest {
  old: Summary;
  items: readonly HistoryItem[];
  /** 新摘要覆盖到的行(含) */
  throughLineId: string;
  /** charId → 表示名(历史渲染用) */
  names?: Record<string, string>;
  signal?: AbortSignal;
}

export interface StoryService {
  nextBeat(req: NextBeatRequest): Promise<BeatDirective>;
  generateBeat(req: GenerateBeatRequest): AsyncIterable<StoryChunk>;
  summarize(req: SummarizeRequest): Promise<Summary>;
}
