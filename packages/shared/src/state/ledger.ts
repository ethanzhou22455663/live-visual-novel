/**
 * ScriptLedger(plan §2.1):已提交事件序列 = 唯一事实源。
 * Say/Narrate/Stage/Choice 四种已提交形态 + 玩家选择条目;
 * foldWorld 从零重放(存档恢复/无头回放)。
 */
import type { LineId } from "../ports/index.ts";
import type { ScriptEvent, WorldDelta } from "../protocol/script.ts";
import { EMPTY_WORLD, mergeDelta } from "./world.ts";
import type { WorldState } from "./world.ts";

export interface LedgerEventEntry {
  readonly kind: "ev";
  readonly lineId: LineId;
  readonly turnNo: number;
  readonly seq: number;
  readonly ev: ScriptEvent;
}

export interface LedgerChoiceEntry {
  readonly kind: "choice";
  readonly lineId: LineId;
  readonly turnNo: number;
  readonly seq: number;
  readonly optionId: string;
  readonly label: string;
  readonly delta?: WorldDelta;
}

export type LedgerEntry = LedgerEventEntry | LedgerChoiceEntry;

/** 纯 fold:重放全部条目得到世界状态(幂等) */
export function foldWorld(entries: readonly LedgerEntry[]): WorldState {
  let world = EMPTY_WORLD;
  for (const e of entries) {
    if (e.kind === "choice" && e.delta) world = mergeDelta(world, e.delta);
  }
  return world;
}

/** ledger 末尾游标(下一个待分配 lineId 的 turnNo/seq);空 ledger 从第 1 拍开始 */
export function cursorAfter(entries: readonly LedgerEntry[]): { turnNo: number; seq: number } {
  const last = entries[entries.length - 1];
  if (!last) return { turnNo: 1, seq: 0 };
  return { turnNo: last.turnNo, seq: last.seq + 1 };
}
