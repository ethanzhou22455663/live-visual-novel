/**
 * 历史渲染(ai-calls §0.4)测试:三形态格式、行数上限、token 预算丢最旧。
 */
import { describe, expect, it } from "vitest";
import type { HistoryItem } from "@gal/shared";
import { renderHistory } from "../src/director/history.ts";

describe("renderHistory", () => {
  it("say=【表示名】(表情)「…」/ narrate=（…）/ choice=▶ label", () => {
    const items: HistoryItem[] = [
      { t: "narrate", text: "放課後。" },
      { t: "say", who: "enagi", emotion: "笑", text: "きみ、今の聞いた?" },
      { t: "say", who: "enagi", text: "ふふ。" },
      { t: "choice", label: "声をかける" },
    ];
    const out = renderHistory(items, 12, 2000, { enagi: "陽見恵凪" });
    const lines = out.split("\n");
    expect(lines[0]).toBe("（放課後。）");
    expect(lines[1]).toBe("【陽見恵凪】(笑)「きみ、今の聞いた?」");
    expect(lines[2]).toBe("【陽見恵凪】「ふふ。」");
    expect(lines[3]).toBe("▶ 声をかける");
  });

  it("未知角色回退 id 本身", () => {
    const out = renderHistory([{ t: "say", who: "miku", text: "あ。" }], 12, 2000, {});
    expect(out).toBe("【miku】「あ。」");
  });

  it("maxLines 超出丢最旧", () => {
    const items: HistoryItem[] = Array.from({ length: 15 }, (_, i) => ({ t: "narrate", text: `n${i}` }));
    const lines = renderHistory(items, 12).split("\n");
    expect(lines.length).toBe(12);
    expect(lines[0]).toBe("（n3）");
    expect(lines.at(-1)).toBe("（n14）");
  });

  it("token 预算(chars/2)从最新往回收,溢出丢最旧", () => {
    const items: HistoryItem[] = [
      { t: "narrate", text: "あ".repeat(100) }, // cost 50
      { t: "narrate", text: "い".repeat(4) }, // cost 2
    ];
    const out = renderHistory(items, 12, 10);
    expect(out).toBe(`（${"い".repeat(4)}）`); // 最古の 100 字行は予算超過で落ちる
  });
});
