/**
 * 上下文装配器(plan §1.3 / ai-calls §0.2):块序冻结——
 * system(格式合同+三张表) → 世界书命中 → 滚动摘要 → 世界状态 → 本拍指令 → 近期历史。
 * 全部纯函数,快照测试断言块序。
 */
import type { ActPlan, ContentPack, Summary, WorldState, WorldBookEntry } from "@gal/shared";
import type { HistoryItem, StageState } from "@gal/shared";
import type { ChatMessage } from "../llm/deepseek.ts";
import { directorSystem, WRITER_SYSTEM, continuationBlock } from "./prompts.ts";
import { renderHistory } from "./history.ts";
import { matchWorldbook, renderWorldbookBlock } from "./worldbook.ts";

/** 三张表(§0.3):代码零硬编码,一切来自 manifest */
export function renderPackTables(pack: ContentPack): string {
  const chars = Object.values(pack.characters)
    .map((c) => {
      const emotions = Object.keys(c.sprites);
      const emo = emotions.length ? emotions.join("|") : "(no sprite)";
      return `- ${c.id} / ${c.displayName} / 主题色 ${c.color} / 可用表情: ${emo}`;
    })
    .join("\n");
  const scenes = Object.keys(pack.scenes).join("|");
  const bgm = Object.values(pack.bgm)
    .map((b) => `${b.id}${b.title ? ` ${b.title}` : ""}`)
    .join(" | ");
  return `[AVAILABLE CHARACTERS]\n${chars}\n[AVAILABLE SCENES] ${scenes}\n[AVAILABLE BGM] ${bgm || "(none)"}`;
}

function renderWorld(world: WorldState): string {
  const aff = Object.entries(world.affection)
    .map(([id, v]) => `${id}=${v >= 0 ? "+" : ""}${v}`)
    .join(", ");
  const flags = Object.entries(world.flags)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(", ");
  return `好感度: ${aff || "(なし)"} ｜ flags: ${flags || "(なし)"}`;
}

function renderSummary(summary: Summary): string {
  const threads = summary.threads.length
    ? `\n【未决伏笔】${summary.threads.map((t) => `・${t.title}(${t.status})`).join("\n")}`
    : "";
  const updates = Object.entries(summary.charUpdates)
    .map(([id, u]) => `・${id}: ${u}`)
    .join("\n");
  return `${summary.facts || "(まだ要約なし)"}${updates ? `\n【角色动态】\n${updates}` : ""}${threads}`;
}

/** 大纲 `- ` 行 = 一拍;在 index 行前插 ▶;无结构返回原文 */
export function outlineWithCursor(outlineMd: string, beatIndex: number | null): string {
  if (beatIndex === null) return outlineMd;
  let seen = -1;
  return outlineMd
    .split("\n")
    .map((line) => {
      if (!line.startsWith("- ")) return line;
      seen++;
      return seen === beatIndex ? `▶ ${line.slice(2)}` : line;
    })
    .join("\n");
}

/** 大纲节拍数(app 启动时算一次;无结构 = null) */
export function outlineBeatCount(outlineMd: string): number | null {
  const n = outlineMd.split("\n").filter((l) => l.startsWith("- ")).length;
  return n > 0 ? n : null;
}

export interface DirectorContextInput {
  outlineMd: string;
  outlineBeatIndex: number | null;
  tables: string;
  world: WorldState;
  summary: Summary;
  history: readonly HistoryItem[];
  names: Record<string, string>;
  lastChoice?: { label: string } | null;
  /** 当前全局走向(总导演上次输出;""=尚未生成) */
  direction?: string;
  /** 当前舞台状态(引擎真实呈现) */
  stage?: StageState;
  /** 强制刷新走向标记(大纲走完/每 5 幕/上一幕有选择)→ user 附【需新走向】 */
  mustRefreshDirection?: boolean;
  /** 清单校验错误附进 user 重试一次(§1 失败策略) */
  validationErrors?: string[];
}

function renderStage(stage: StageState | undefined): string {
  if (!stage) return "(no info)";
  const on = stage.cast.length ? stage.cast.join(",") : "none";
  return `bg=${stage.bg ?? "none"} / bgm=${stage.bgm ?? "none"} / on-stage=${on}`;
}

export function buildDirectorMessages(input: DirectorContextInput): ChatMessage[] {
  const user = [
    `[GLOBAL DIRECTION] ${input.direction || "(none yet)"}`,
    input.mustRefreshDirection
      ? "[NEED NEW DIRECTION] You MUST output a new direction this time (null is forbidden). If the player just made a choice, the direction must reflect it."
      : null,
    `[CURRENT STAGE] ${renderStage(input.stage)}`,
    `[ROLLING SUMMARY] ${renderSummary(input.summary)}`,
    `[WORLD STATE] ${renderWorld(input.world)}`,
    `[RECENT HISTORY] ${renderHistory(input.history, 10, 2000, input.names) || "(none)"}`,
    input.lastChoice ? `[PLAYER JUST CHOSE] > ${input.lastChoice.label}` : null,
    input.validationErrors?.length
      ? `[PREVIOUS OUTPUT ERRORS]\n${input.validationErrors.join("\n")}\nFix all of the above and output ONLY the JSON again.`
      : null,
    `[TASK] Design the next act (direction+act JSON). Scene changes happen only at act boundaries.`,
  ]
    .filter((x): x is string => x !== null)
    .join("\n\n");
  return [
    { role: "system", content: directorSystem(outlineWithCursor(input.outlineMd, input.outlineBeatIndex), input.tables) },
    { role: "user", content: user },
  ];
}

export interface WriterContextInput {
  tables: string;
  worldbookEntries: readonly WorldBookEntry[];
  world: WorldState;
  summary: Summary;
  /** 本幕设计(总导演输出) */
  act: ActPlan;
  history: readonly HistoryItem[];
  names: Record<string, string>;
  ledgerTail?: string;
  continuationReason?: string;
}

export function buildWriterMessages(input: WriterContextInput): ChatMessage[] {
  const scanTexts = [
    ...input.history.slice(-12).map((h) => (h.t === "choice" ? h.label : h.text)),
    input.act.actGoal,
  ];
  const wbBlock = renderWorldbookBlock(matchWorldbook(input.worldbookEntries, scanTexts));
  const parts = [
    wbBlock,
    `[ROLLING SUMMARY] ${renderSummary(input.summary)}`,
    `[WORLD STATE] ${renderWorld(input.world)}`,
    `[ACT DESIGN] ${JSON.stringify(input.act)}`,
    `[RECENT HISTORY] ${renderHistory(input.history, 12, 2000, input.names) || "(none)"}`,
  ];
  if (input.continuationReason !== undefined) {
    parts.push(continuationBlock(input.continuationReason, input.ledgerTail ?? "(なし)"));
  }
  return [
    { role: "system", content: `${WRITER_SYSTEM}\n\n${input.tables}` },
    { role: "user", content: parts.join("\n\n") },
  ];
}
