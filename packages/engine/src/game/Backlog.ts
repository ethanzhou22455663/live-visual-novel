/**
 * Backlog(坑①):不独立维护状态,从 ledger 派生的只读视图,cap 200。
 * say/narrate → 文本;choice 条目 → 玩家选了什么。React 面板直接渲染。
 */
import type { LedgerEntry, LineId, SpeakerId } from "@gal/shared";

export interface BacklogItem {
  lineId: LineId;
  turnNo: number;
  kind: "say" | "narrate" | "choice";
  who?: SpeakerId;
  text: string;
}

const CAP = 200;

export function backlogOf(entries: readonly LedgerEntry[]): BacklogItem[] {
  const items: BacklogItem[] = [];
  for (const e of entries) {
    if (e.kind === "ev") {
      if (e.ev.t === "say") {
        items.push({ lineId: e.lineId, turnNo: e.turnNo, kind: "say", who: e.ev.who, text: e.ev.text });
      } else if (e.ev.t === "narrate") {
        items.push({ lineId: e.lineId, turnNo: e.turnNo, kind: "narrate", text: e.ev.text });
      }
    } else {
      items.push({ lineId: e.lineId, turnNo: e.turnNo, kind: "choice", text: e.label });
    }
  }
  return items.length > CAP ? items.slice(items.length - CAP) : items;
}
