/**
 * 世界书(plan §1.3):SillyTavern 概念模型,零 AGPL 代码。
 * 扫描窗 = 最近 12 条已提交文本 + directive.goal(不扫摘要);
 * 命中按 (priority desc, 最长 key 优先) 排序;budgetTokens=600 按 chars/2 累加满即止;
 * 递归激活 v1 关闭。
 */
import type { WorldBookEntry } from "@gal/shared";

export interface WorldbookHit {
  entry: WorldBookEntry;
  /** 命中的 key(取最长者参与排序) */
  matchedKey: string;
}

export function matchWorldbook(
  entries: readonly WorldBookEntry[],
  scanTexts: readonly string[],
  budgetTokens = 600,
): WorldbookHit[] {
  const haystack = scanTexts.join("\n");
  if (!haystack) return [];
  const hits: WorldbookHit[] = [];
  for (const entry of entries) {
    if (!entry.enabled) continue;
    let matchedKey = "";
    for (const key of entry.keys) {
      if (key && haystack.includes(key) && key.length > matchedKey.length) matchedKey = key;
    }
    if (matchedKey) hits.push({ entry, matchedKey });
  }
  hits.sort((a, b) => {
    if (b.entry.priority !== a.entry.priority) return b.entry.priority - a.entry.priority;
    return b.matchedKey.length - a.matchedKey.length;
  });
  // 预算:tokens ≈ chars/2
  const out: WorldbookHit[] = [];
  let budget = budgetTokens;
  for (const h of hits) {
    const cost = Math.ceil(h.entry.content.length / 2);
    if (cost > budget) continue;
    budget -= cost;
    out.push(h);
  }
  return out;
}

export function renderWorldbookBlock(hits: readonly WorldbookHit[]): string {
  if (hits.length === 0) return "【世界書命中】(なし)";
  return `【世界書命中】\n${hits.map((h) => h.entry.content).join("\n\n")}`;
}
