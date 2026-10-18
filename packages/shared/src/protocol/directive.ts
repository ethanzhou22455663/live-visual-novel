/**
 * 幕设计 ActPlan + 拍级指令 BeatDirective(2026-10-18 幕制重构):
 * - 总导演每幕一次输出 ActPlan:一幕 = 一个场景(bg+bgm)内连续 1〜6 个分段
 * - beats 降级为编剧的创作指引(分段 goal),不再是调用/存档边界
 * - BeatDirective 是幕内派生的编剧调用指令(scene + 单段字段 + actGoal)
 * - maxLines schema 界 1..30,DirectorService 收到后 clamp 进 [6,14](节奏硬预算)
 */
import { z } from "zod";

const SceneSchema = z.object({
  bg: z.string().min(1),
  bgm: z.string().nullable(),
  cast: z.array(z.string().min(1)).min(1).max(3),
});

export const ActBeatSchema = z.object({
  goal: z.string().min(1),
  endsWith: z.enum(["choice", "beatEnd", "sceneEnd"]),
  maxLines: z.number().int().min(1).max(30),
});

export const ActPlanSchema = z.object({
  scene: SceneSchema,
  actGoal: z.string().min(1),
  toneHint: z.string().optional(),
  beats: z.array(ActBeatSchema).min(1).max(6),
});

export type ActPlan = z.infer<typeof ActPlanSchema>;
export type ActBeat = z.infer<typeof ActBeatSchema>;

export const BeatDirectiveSchema = z.object({
  scene: SceneSchema,
  /** 本段目标(幕设计派生) */
  goal: z.string().min(1),
  endsWith: z.enum(["choice", "beatEnd", "sceneEnd"]),
  maxLines: z.number().int().min(1).max(30),
  /** 幕目标(编剧看到幕上下文) */
  actGoal: z.string().optional(),
  toneHint: z.string().optional(),
});

export type BeatDirective = z.infer<typeof BeatDirectiveSchema>;

/** 总导演彻底失败时的兜底(§1):同场景、泛化目标、1 段 sceneEnd 收束;bg/cast 由调用方决定 */
export function fallbackActPlan(bg: string, cast: readonly string[]): ActPlan {
  return {
    scene: { bg, bgm: null, cast: cast.slice(0, 3) },
    actGoal: "物語を自然に進める。落ち着いた日常のワンシーンを描く。",
    beats: [{ goal: "この一幕を穏やかに締めくくる。", endsWith: "sceneEnd", maxLines: 8 }],
  };
}
