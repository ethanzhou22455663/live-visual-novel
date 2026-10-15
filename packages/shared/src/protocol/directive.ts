/**
 * BeatDirective(ai-calls §1 调用①):导演为下一拍定调。
 * 无 beatId——拍号即引擎 turnNo(§1.1);maxLines schema 界 1..30,
 * DirectorService 收到后 clamp 进 [6,14](行数硬预算控 token 与节奏)。
 */
import { z } from "zod";

export const BeatDirectiveSchema = z.object({
  scene: z.object({
    bg: z.string().min(1),
    bgm: z.string().nullable(),
    cast: z.array(z.string().min(1)).min(1).max(3),
  }),
  goal: z.string().min(1),
  endsWith: z.enum(["choice", "beatEnd", "sceneEnd"]),
  maxLines: z.number().int().min(1).max(30),
  toneHint: z.string().optional(),
});

export type BeatDirective = z.infer<typeof BeatDirectiveSchema>;

/** 导演彻底失败时的兜底(§1):同场景、泛化 goal、beatEnd 收束;cast 由调用方从内容包取 */
export function fallbackDirective(bg: string, cast: readonly string[]): BeatDirective {
  return {
    scene: { bg, bgm: null, cast: cast.slice(0, 3) },
    goal: "物語を自然に進める。落ち着いた日常のワンシーンを描く。",
    endsWith: "beatEnd",
    maxLines: 10,
  };
}
