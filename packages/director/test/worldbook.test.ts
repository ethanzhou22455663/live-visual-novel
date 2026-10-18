/**
 * 世界书(plan §1.3)测试:精确 key 匹配、priority desc、最长 key、预算丢弃、enabled。
 */
import { describe, expect, it } from "vitest";
import type { WorldBookEntry } from "@gal/shared";
import { matchWorldbook, renderWorldbookBlock } from "../src/director/worldbook.ts";

function entry(over: Partial<WorldBookEntry> & { id: string }): WorldBookEntry {
  return { keys: [over.id], content: `${over.id} の内容。`, priority: 1, enabled: true, ...over };
}

describe("matchWorldbook", () => {
  it("扫描文本命中 key;disabled 跳过;未命中不出现", () => {
    const hits = matchWorldbook(
      [entry({ id: "a", keys: ["レモネード"] }), entry({ id: "b", keys: ["屋上"], enabled: false }), entry({ id: "c", keys: ["存在しない"] })],
      ["今日はレモネードの話をした。"],
    );
    expect(hits.map((h) => h.entry.id)).toEqual(["a"]);
    expect(matchWorldbook([entry({ id: "a" })], [])).toEqual([]);
  });

  it("priority desc 优先;同 priority 时最长 key 优先", () => {
    const hits = matchWorldbook(
      [entry({ id: "low", keys: ["レモネード"], priority: 1 }), entry({ id: "high", keys: ["歌"], priority: 10 })],
      ["レモネードの歌"],
    );
    expect(hits.map((h) => h.entry.id)).toEqual(["high", "low"]);

    const [tie] = matchWorldbook(
      [entry({ id: "short", keys: ["歌"] }), entry({ id: "long", keys: ["レモネードの歌"] })],
      ["レモネードの歌"],
    );
    expect(tie!.matchedKey).toBe("レモネードの歌");
  });

  it("预算(cost=chars/2)满即止:放得下的先来,放不下的跳过", () => {
    const hits = matchWorldbook(
      [
        entry({ id: "small", keys: ["小"], content: "短い。", priority: 1 }), // cost 3
        entry({ id: "huge", keys: ["大"], content: "あ".repeat(5000), priority: 10 }), // cost 2500 > budget 600
      ],
      ["小 大"],
      600,
    );
    expect(hits.map((h) => h.entry.id)).toEqual(["small"]); // huge はコスト超過で落ちる
  });
});

describe("renderWorldbookBlock", () => {
  it("无命中 → (none);有命中 → 内容连缀", () => {
    expect(renderWorldbookBlock([])).toContain("(none)");
    const hits = matchWorldbook([entry({ id: "a", keys: ["歌"], content: "A の設定。" })], ["歌"]);
    const block = renderWorldbookBlock(hits);
    expect(block).toContain("[WORLDBOOK]");
    expect(block).toContain("A の設定。");
  });
});
