/**
 * SaveData v1(plan §1.6):槽位存档的唯一形态。
 * - ledger 按 summarizedThroughLineId 裁剪(摘要已覆盖的行不入档,localStorage 5MB 红线)
 * - cursor 独立于 ledger 存在(裁剪后 ledger 可为空,游标语义不丢)
 * - pendingContinuation=true ⇒ currentBeat 必在(writing 中点保存,读档续写同一拍)
 * - migrations 链:v<n> → v<n+1>,migrateSave 拒绝过新的版本
 */
import { z } from "zod";
import { BeatDirectiveSchema } from "../protocol/directive.ts";
import type { BeatDirective } from "../protocol/directive.ts";
import { ScriptEventSchema, WorldDeltaSchema } from "../protocol/schema.ts";
import { PresentationSnapshotSchema } from "../protocol/schema.ts";
import type { PresentationSnapshot } from "../ports/index.ts";
import type { LedgerEntry } from "../state/ledger.ts";
import { SummarySchema } from "../state/summary.ts";
import type { Summary } from "../state/summary.ts";
import { WorldStateSchema } from "../state/world.ts";
import type { WorldState } from "../state/world.ts";

// ---------- 槽位(用户裁决:自动 1 槽 + 手动 3 槽,无 quick) ----------

export const SAVE_SLOTS = ["auto", "manual-0", "manual-1", "manual-2"] as const;
export type SaveSlot = (typeof SAVE_SLOTS)[number];

export function isSaveSlot(s: string): s is SaveSlot {
  return (SAVE_SLOTS as readonly string[]).includes(s);
}

// ---------- ledger 的 zod 形态(仅存档校验用;运行时一律走 TS 类型) ----------

const LedgerEventEntrySchema = z.object({
  kind: z.literal("ev"),
  lineId: z.string(),
  turnNo: z.number().int(),
  seq: z.number().int(),
  ev: ScriptEventSchema,
});

const LedgerChoiceEntrySchema = z.object({
  kind: z.literal("choice"),
  lineId: z.string(),
  turnNo: z.number().int(),
  seq: z.number().int(),
  optionId: z.string(),
  label: z.string(),
  delta: WorldDeltaSchema.optional(),
});

export const LedgerEntrySchema = z.discriminatedUnion("kind", [LedgerEventEntrySchema, LedgerChoiceEntrySchema]);

// ---------- SaveData ----------

export const SaveDataSchema = z.object({
  version: z.literal(1),
  meta: z.object({
    savedAt: z.string(),
    playTimeSec: z.number(),
    chapterLabel: z.string(),
    slot: z.string().optional(),
  }),
  world: WorldStateSchema,
  summary: SummarySchema,
  ledger: z.array(LedgerEntrySchema),
  presentation: PresentationSnapshotSchema,
  cursor: z.object({ turnNo: z.number().int(), seq: z.number().int() }),
  outlineBeatIndex: z.number().int().nullable(),
  pendingContinuation: z.boolean(),
  currentBeat: z
    .object({
      turnNo: z.number().int(),
      directive: BeatDirectiveSchema,
    })
    .nullable(),
  readState: z.array(z.string()),
});

export interface SaveMeta {
  savedAt: string;
  playTimeSec: number;
  chapterLabel: string;
  slot?: string;
}

export interface SaveCurrentBeat {
  turnNo: number;
  directive: BeatDirective;
}

export interface SaveData {
  version: 1;
  meta: SaveMeta;
  world: WorldState;
  summary: Summary;
  ledger: LedgerEntry[];
  presentation: PresentationSnapshot;
  cursor: { turnNo: number; seq: number };
  outlineBeatIndex: number | null;
  pendingContinuation: boolean;
  currentBeat: SaveCurrentBeat | null;
  readState: string[];
}

// ---------- 裁剪与迁移 ----------

/** 摘要已覆盖的行(≤ summarizedThroughLineId)不入档;裁剪只砍头部,游标 = 尾条目 seq+1 不变 */
export function trimLedger(entries: readonly LedgerEntry[], summarizedThroughLineId: string): LedgerEntry[] {
  if (!summarizedThroughLineId) return [...entries];
  const idx = entries.findIndex((e) => e.lineId === summarizedThroughLineId);
  return idx < 0 ? [...entries] : entries.slice(idx + 1);
}

export const SAVE_VERSION = 1;

/** v<n> → v<n+1>;v1 为初始版本,链为空 */
const MIGRATIONS: Record<number, (d: Record<string, unknown>) => Record<string, unknown>> = {};

/**
 * 任意来源的档(JSON.parse 结果)→ 校验过的 SaveData。
 * 缺 version/未知 schema → SyntaxError 语义的失败(调用方当坏档丢弃);
 * 版本比当前新 → 拒载(旧程序读新档必然误判)。
 */
export function migrateSave(raw: unknown): SaveData {
  if (typeof raw === "string") raw = JSON.parse(raw) as unknown;
  const obj = (raw ?? {}) as Record<string, unknown>;
  const version = typeof obj.version === "number" ? Math.trunc(obj.version) : 0;
  if (version > SAVE_VERSION) {
    throw new Error(`存档版本过新(v${version} > v${SAVE_VERSION}),请更新程序`);
  }
  let d = obj;
  for (let v = version; v < SAVE_VERSION; v++) {
    const step = MIGRATIONS[v];
    if (!step) throw new Error(`缺少 v${v} → v${v + 1} 迁移步骤`);
    d = step(d);
  }
  return SaveDataSchema.parse(d) as SaveData;
}
