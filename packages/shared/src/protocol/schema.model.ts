/**
 * 模型面协议 schema(P1 裁决 §1.1):ai-calls.md 规定模型不产出 id/turnNo,
 * 拍号由引擎在 commit 事务点分配。这里每个变体 = 现行 schema 去掉 turnNo;
 * zod 默认 strip 未知键,模型违规输出 turnNo 会被静默剥离(容错而非报错)。
 * 带 turnNo 的 ScriptEventSchema(../schema.ts)继续用于存档/ledger/fixture 校验。
 */
import { z } from "zod";
import { noRawNewline, StageOpSchema } from "./schema.ts";
import { ChoiceOptionSchema } from "./schema.ts";

export const ModelSayEventSchema = z.object({
  t: z.literal("say"),
  who: z.string().min(1),
  emotion: z.string(),
  text: z.string().min(1).refine(noRawNewline, "text 含裸换行"),
  zh: z.string().optional(),
});

export const ModelNarrateEventSchema = z.object({
  t: z.literal("narrate"),
  text: z.string().min(1).refine(noRawNewline, "text 含裸换行"),
  zh: z.string().optional(),
});

export const ModelStageEventSchema = z.object({
  t: z.literal("stage"),
  op: StageOpSchema,
});

export const ModelChoiceOfferEventSchema = z.object({
  t: z.literal("choice"),
  prompt: z.string().optional(),
  options: z.array(ChoiceOptionSchema).min(2).max(6),
  defaultOptionId: z.string().min(1),
});

export const ModelScriptEventSchema = z.discriminatedUnion("t", [
  ModelSayEventSchema,
  ModelNarrateEventSchema,
  ModelStageEventSchema,
  ModelChoiceOfferEventSchema,
]);

export type ModelSayEvent = z.infer<typeof ModelSayEventSchema>;
export type ModelNarrateEvent = z.infer<typeof ModelNarrateEventSchema>;
export type ModelStageEvent = z.infer<typeof ModelStageEventSchema>;
export type ModelChoiceOfferEvent = z.infer<typeof ModelChoiceOfferEventSchema>;
export type ModelScriptEvent = z.infer<typeof ModelScriptEventSchema>;
