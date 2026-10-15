/**
 * 滚动摘要(ai-calls §3):sceneEnd 同步触发 / 新增>1200tok 异步触发。
 * 失败一律沿用旧摘要,绝不阻塞游戏。
 */
import { z } from "zod";
import type { LineId } from "../ports/index.ts";

export interface SummaryThread {
  id: string;
  title: string;
  status: string;
}

export interface Summary {
  /** ≤400 字总述 */
  facts: string;
  /** 每角色变化记录 */
  charUpdates: Record<string, string>;
  /** 未决伏笔 */
  threads: SummaryThread[];
  /** 已摘要覆盖到的行(含),此前的 ledger 条目可裁剪(M5 存档瘦身) */
  summarizedThroughLineId: LineId;
}

export const EMPTY_SUMMARY: Summary = {
  facts: "",
  charUpdates: {},
  threads: [],
  summarizedThroughLineId: "",
};

export const SummarySchema = z.object({
  facts: z.string(),
  charUpdates: z.record(z.string(), z.string()),
  threads: z.array(z.object({ id: z.string(), title: z.string(), status: z.string() })),
  summarizedThroughLineId: z.string(),
});

/** 模型只产前三者;throughLineId 由调用方回填 */
export const ModelSummarySchema = SummarySchema.omit({ summarizedThroughLineId: true });
