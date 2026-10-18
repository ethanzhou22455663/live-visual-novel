/**
 * 历史渲染(ai-calls §0.4,导演与编剧共用)。提示词语言方针(2026-10-18):结构英语。
 * (text)旁白 / Name (emotion) "text" 台词 / > label 选择。
 * 12 行 / 2000 token(chars/2)预算,溢出丢最旧。
 */
import type { HistoryItem } from "@gal/shared";

export function renderHistory(
  items: readonly HistoryItem[],
  maxLines = 12,
  maxTokens = 2000,
  names: Record<string, string> = {},
): string {
  const lines = items.slice(-maxLines).map((h) => {
    switch (h.t) {
      case "narrate":
        return `(${h.text})`;
      case "say":
        return `${names[h.who] ?? h.who}${h.emotion ? ` (${h.emotion})` : ""}: "${h.text}"`;
      case "choice":
        return `> ${h.label}`;
    }
  });
  // 预算:从最新往回收,超出即止(丢最旧)
  let budget = maxTokens;
  let start = lines.length;
  while (start > 0) {
    const cost = Math.ceil((lines[start - 1] as string).length / 2);
    if (cost > budget && start < lines.length) break;
    budget -= cost;
    start--;
  }
  return lines.slice(start).join("\n");
}
