/**
 * 协议 zod schema(plan §2.1):逐行 discriminatedUnion 校验,
 * 校验失败的行按解析器错误策略处理(连续 3 次中止本次生成)。
 */
import { z } from "zod";

/** 事件文本禁止裸换行(NDJSON 行完整性;换行会破坏行分隔) */
export const noRawNewline = (s: string) => !s.includes("\n") && !s.includes("\r");

export const SayEventSchema = z.object({
  t: z.literal("say"),
  turnNo: z.number().int().nonnegative(),
  who: z.string().min(1),
  emotion: z.string(),
  text: z.string().min(1).refine(noRawNewline, "text 含裸换行"),
});

export const NarrateEventSchema = z.object({
  t: z.literal("narrate"),
  turnNo: z.number().int().nonnegative(),
  text: z.string().min(1).refine(noRawNewline, "text 含裸换行"),
});

const TransitionSchema = z.enum(["fade", "cut", "slide"]);
const SlotSchema = z.enum(["left", "center", "right"]);

export const StageOpSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("bg"), asset: z.string().min(1), transition: TransitionSchema.optional() }),
  z.object({
    kind: z.literal("sprite"),
    who: z.string().min(1),
    slot: SlotSchema.optional(),
    action: z.enum(["enter", "exit", "diff"]),
    emotion: z.string().optional(),
  }),
  z.object({
    kind: z.literal("bgm"),
    asset: z.string().optional(),
    action: z.enum(["play", "stop", "fade"]),
    fadeMs: z.number().nonnegative().optional(),
  }),
  z.object({ kind: z.literal("se"), asset: z.string().min(1) }),
  z.object({ kind: z.literal("shake") }),
  z.object({ kind: z.literal("flash") }),
]);

export const StageEventSchema = z.object({
  t: z.literal("stage"),
  turnNo: z.number().int().nonnegative(),
  op: StageOpSchema,
});

export const WorldDeltaSchema = z.object({
  affection: z.record(z.string(), z.number()).optional(),
  flags: z.record(z.string(), z.union([z.boolean(), z.number(), z.string()])).optional(),
});

export const ChoiceOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  delta: WorldDeltaSchema.optional(),
  hidden: z
    .object({
      delta: WorldDeltaSchema.optional(),
      beatHint: z.string().optional(),
    })
    .optional(),
});

export const ChoiceOfferEventSchema = z.object({
  t: z.literal("choice"),
  turnNo: z.number().int().nonnegative(),
  prompt: z.string().optional(),
  options: z.array(ChoiceOptionSchema).min(2).max(6),
  defaultOptionId: z.string().min(1),
});

export const ScriptEventSchema = z.discriminatedUnion("t", [
  SayEventSchema,
  NarrateEventSchema,
  StageEventSchema,
  ChoiceOfferEventSchema,
]);

/** 舞台呈现快照(存档用;bgm 不持久化) */
export const PresentationSnapshotSchema = z.object({
  bg: z.string().nullable(),
  sprites: z.record(z.string(), z.object({ slot: SlotSchema, emotion: z.string() })),
});
