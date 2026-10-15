/**
 * 上下文装配器(plan §1.3)测试:三张表、大纲游标、块序冻结、续写指示、导演 user 块。
 */
import { describe, expect, it } from "vitest";
import { EMPTY_SUMMARY, EMPTY_WORLD } from "@gal/shared";
import { buildDirectorMessages, buildWriterMessages, outlineBeatCount, outlineWithCursor, renderPackTables } from "../src/director/context.ts";
import { DIRECTIVE, makePack } from "./helpers.ts";

describe("renderPackTables", () => {
  it("三张表全部来自 manifest,零硬编码", () => {
    const t = renderPackTables(makePack());
    expect(t).toContain("- enagi / 陽見恵凪 / 主题色 #ff8fb4 / 可用表情: 平常|笑");
    expect(t).toContain("yukitaka");
    expect(t).toContain("(立繪なし)");
    expect(t).toContain("【可用场景】教室");
    expect(t).toContain("p07");
  });
});

describe("大纲游标", () => {
  const md = makePack().story.outlineMd;
  it("outlineBeatCount:`- ` 行数;无结构 → null", () => {
    expect(outlineBeatCount(md)).toBe(2);
    expect(outlineBeatCount("# 見出しのみ\n本文。")).toBeNull();
  });
  it("outlineWithCursor:▶ 插在 index 行前;null 保留原文", () => {
    const withCursor = outlineWithCursor(md, 1);
    expect(withCursor).toContain("▶ レモネードファクトリー結成へ");
    expect(withCursor).not.toContain("▶ 放課後の教室");
    expect(outlineWithCursor(md, null)).toBe(md);
  });
});

describe("buildWriterMessages 块序(§0.2 冻结)", () => {
  it("system=格式合同+三张表;user 依 序=世界書→摘要→世界→指令→歴史;续写块加在尾部", () => {
    const [sys, user] = buildWriterMessages({
      tables: renderPackTables(makePack()),
      worldbookEntries: makePack().story.worldBook,
      world: EMPTY_WORLD,
      summary: EMPTY_SUMMARY,
      directive: DIRECTIVE,
      history: [{ t: "narrate", text: "レモネードの話をした。" }],
      names: { enagi: "陽見恵凪" },
      ledgerTail: '{"t":"narrate","text":"確定行"}',
      continuationReason: "前次生成中断",
    });
    expect(sys!.content).toContain("全年齢対象");
    const order = ["【世界書命中】", "【滚动摘要】", "【世界状态】", "【本拍指令】", "【近期历史】", "【续写指示】"].map(
      (m) => user!.content.indexOf(m),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(user!.content).toContain("確定行");
  });
});

describe("buildDirectorMessages", () => {
  it("system 带大纲 ▶ 游标;user 带 摘要/世界/歴史/刚选择/前次错误", () => {
    const [sys, user] = buildDirectorMessages({
      outlineMd: makePack().story.outlineMd,
      outlineBeatIndex: 0,
      tables: "T",
      world: EMPTY_WORLD,
      summary: EMPTY_SUMMARY,
      history: [],
      names: {},
      lastChoice: { label: "声をかけた" },
      validationErrors: ['scene.bg "屋上" 不在场景清单'],
    });
    expect(sys!.content).toContain("▶ 放課後の教室");
    expect(user!.content).toContain("【滚动摘要】");
    expect(user!.content).toContain("【世界状态】");
    expect(user!.content).toContain("【近期历史】");
    expect(user!.content).toContain("【玩家刚选择】▶ 声をかけた");
    expect(user!.content).toContain("【前次输出错误】");
    expect(user!.content).toContain("不在场景清单");
    expect(user!.content.indexOf("【玩家刚选择】")).toBeLessThan(user!.content.indexOf("【前次输出错误】"));
  });

  it("无 lastChoice / 无 validationErrors:对应块不出现", () => {
    const [, user] = buildDirectorMessages({
      outlineMd: makePack().story.outlineMd,
      outlineBeatIndex: null,
      tables: "T",
      world: EMPTY_WORLD,
      summary: EMPTY_SUMMARY,
      history: [],
      names: {},
    });
    expect(user!.content).not.toContain("【玩家刚选择】");
    expect(user!.content).not.toContain("【前次输出错误】");
  });
});
