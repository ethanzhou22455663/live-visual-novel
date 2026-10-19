/**
 * StoryService 端口(plan §1.4 / 2026-10-18 幕制重构):engine(BeatRunner)与 director
 * 互不依赖的唯一通道。实现在 director 包(app 装配注入);测试注 FakeStoryService。
 * - planAct:总导演每幕一次(合并层:全局走向 + 幕设计)
 * - generateBeat:编剧按幕设计流式写台词(choice 行硬切分段,选择后续写)
 */
import type { ActPlan } from "../protocol/directive.ts";
import type { ModelScriptEvent } from "../protocol/schema.model.ts";
import type { Summary } from "../state/summary.ts";
import type { WorldState } from "../state/world.ts";

/** 历史渲染条目(ai-calls §0.4):导演与编剧共用 */
export type HistoryItem =
  | { t: "say"; who: string; emotion?: string; text: string; zh?: string }
  | { t: "narrate"; text: string; zh?: string }
  | { t: "choice"; label: string };

/** 当前舞台状态(引擎侧真实呈现;导演换场/cast 连续性决策依据) */
export interface StageState {
  /** 当前 bg(null=未开场) */
  bg: string | null;
  /** runner 记忆的当前 BGM(null=なし) */
  bgm: string | null;
  /** 在场角色(立绘 handle 的 keys) */
  cast: readonly string[];
}

export interface PlanActRequest {
  world: WorldState;
  summary: Summary;
  history: readonly HistoryItem[];
  /** 玩家刚做的选择(resolveChoice 后的下一幕必带);null=通常 */
  lastChoice?: { label: string } | null;
  /** 大纲 `- ` 行游标(0 起;≥行数=骨架走完,总导演按 direction 接管);无结构=null */
  outlineBeatIndex: number | null;
  /** 当前全局走向(总导演上次输出;""=尚未生成) */
  direction: string;
  /** 当前舞台状态 */
  stage?: StageState;
  /** 系统判定的强制刷新走向(大纲走完/每 5 幕/上一幕有玩家选择) */
  mustRefreshDirection: boolean;
  /** 当前个人线女主(null=共通线) */
  route?: string | null;
  /** 终幕标记(非 null = 本幕是终幕,heroine=个人线女主) */
  finale?: { heroine: string } | null;
  signal?: AbortSignal;
}

export interface PlanActResult {
  /** 新走向(null=沿用现有走向不刷新) */
  direction: string | null;
  act: ActPlan;
}

export interface GenerateBeatRequest {
  /** 本幕设计(总导演输出;编剧按 beats 顺序写整幕,choice 行停等后续写) */
  act: ActPlan;
  turnNo: number;
  world: WorldState;
  summary: Summary;
  history: readonly HistoryItem[];
  /** 本幕已提交行的 NDJSON(续写用;通常空) */
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
  planAct(req: PlanActRequest): Promise<PlanActResult>;
  generateBeat(req: GenerateBeatRequest): AsyncIterable<StoryChunk>;
  summarize(req: SummarizeRequest): Promise<Summary>;
}
