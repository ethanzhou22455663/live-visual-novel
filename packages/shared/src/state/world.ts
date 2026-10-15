/**
 * 世界状态(plan §2.1 不变量):ledger 是唯一事实源,
 * 任何状态都是对 ledger 的纯 fold——applyEvent 永远返回新对象。
 */
import { WorldDeltaSchema } from "../protocol/schema.ts";
import type { WorldDelta } from "../protocol/script.ts";

export const AFFECTION_MIN = -100;
export const AFFECTION_MAX = 100;

export interface WorldState {
  /** 角色好感度,clamp 到 [-100, 100];未知角色首次出现自动建条目 */
  affection: Record<string, number>;
  flags: Record<string, boolean | number | string>;
}

export const EMPTY_WORLD: WorldState = { affection: {}, flags: {} };

const clamp = (n: number): number => Math.min(AFFECTION_MAX, Math.max(AFFECTION_MIN, n));

/**
 * 纯函数:把一个 WorldDelta 合并进世界状态。
 * 模型增量永不直接信任——调用方必须先过 WorldDeltaSchema(坑⑮)。
 */
export function mergeDelta(world: WorldState, delta: WorldDelta): WorldState {
  let affection = world.affection;
  let flags = world.flags;
  if (delta.affection) {
    affection = { ...affection };
    for (const [who, d] of Object.entries(delta.affection)) {
      affection[who] = clamp((affection[who] ?? 0) + d);
    }
  }
  if (delta.flags) {
    flags = { ...flags, ...delta.flags }; // last-wins 整值覆盖
  }
  return { affection, flags };
}
