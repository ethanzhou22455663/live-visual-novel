/**
 * 上下文装配器(plan §1.3)测试:三张表、大纲游标、块序冻结、续写指示、导演 user 块。
 */
import { describe, expect, it } from "vitest";
import { EMPTY_SUMMARY, EMPTY_WORLD } from "@gal/shared";
import { buildDirectorMessages, buildWriterMessages, outlineBeatCount, outlineWithCursor, renderPackTables } from "../src/director/context.ts";
import { ACT, makePack } from "./helpers.ts";

describe("renderPackTables", () => {
  it("三张表全部来自 manifest,零硬编码", () => {
    const t = renderPackTables(makePack());
    expect(t).toContain("- enagi / 陽見恵凪 / accent #ff8fb4 / expressions: 平常|笑");
    expect(t).toContain("yukitaka");
    expect(t).toContain("(no sprite)");
    expect(t).toContain("[AVAILABLE SCENES] 教室");
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
  it("system=格式合同+三张表;user 依 序=世界書→摘要→世界→幕設計→歴史;续写块加在尾部", () => {
    const [sys, user] = buildWriterMessages({
      tables: renderPackTables(makePack()),
      worldbookEntries: makePack().story.worldBook,
      world: EMPTY_WORLD,
      summary: EMPTY_SUMMARY,
      act: ACT,
      history: [{ t: "narrate", text: "レモネードの話をした。" }],
      names: { enagi: "陽見恵凪" },
      ledgerTail: '{"t":"narrate","text":"確定行"}',
      continuationReason: "generation interrupted",
    });
    expect(sys!.content).toContain("All-ages content only");
    const order = ["[WORLDBOOK]", "[ROLLING SUMMARY]", "[WORLD STATE]", "[ACT DESIGN]", "[RECENT HISTORY]", "[CONTINUATION]"].map(
      (m) => user!.content.indexOf(m),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(user!.content).toContain("確定行");
  });
});

describe("buildDirectorMessages", () => {
  it("system 带大纲 ▶ 游标;user 带 走向/舞台/摘要/世界/歴史/刚选择/前次错误(块序冻结)", () => {
    const [sys, user] = buildDirectorMessages({
      outlineMd: makePack().story.outlineMd,
      outlineBeatIndex: 0,
      tables: "T",
      world: EMPTY_WORLD,
      summary: EMPTY_SUMMARY,
      history: [],
      names: {},
      lastChoice: { label: "声をかけた" },
      direction: "次は日常パート:練習と絆を深める",
      stage: { bg: "教室", bgm: "p07", cast: ["enagi"] },
      mustRefreshDirection: true,
      validationErrors: ['scene.bg "屋上" is not in the scene list'],
    });
    expect(sys!.content).toContain("▶ 放課後の教室");
    expect(user!.content).toContain("[GLOBAL DIRECTION] 次は日常パート:練習と絆を深める");
    expect(user!.content).toContain("[NEED NEW DIRECTION]");
    expect(user!.content).toContain("[CURRENT STAGE] bg=教室 / bgm=p07 / on-stage=enagi");
    expect(user!.content).toContain("[ROLLING SUMMARY]");
    expect(user!.content).toContain("[WORLD STATE]");
    expect(user!.content).toContain("[RECENT HISTORY]");
    expect(user!.content).toContain("[PLAYER JUST CHOSE] > 声をかけた");
    expect(user!.content).toContain("[PREVIOUS OUTPUT ERRORS]");
    expect(user!.content).toContain("is not in the scene list");
    const order = ["[GLOBAL DIRECTION]", "[NEED NEW DIRECTION]", "[CURRENT STAGE]", "[ROLLING SUMMARY]", "[WORLD STATE]", "[RECENT HISTORY]", "[PLAYER JUST CHOSE]", "[PREVIOUS OUTPUT ERRORS]"].map(
      (m) => user!.content.indexOf(m),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("无 lastChoice / 无 validationErrors / 非刷新:对应块不出现;走向未生成显示 (まだ方針なし)", () => {
    const [, user] = buildDirectorMessages({
      outlineMd: makePack().story.outlineMd,
      outlineBeatIndex: null,
      tables: "T",
      world: EMPTY_WORLD,
      summary: EMPTY_SUMMARY,
      history: [],
      names: {},
    });
    expect(user!.content).not.toContain("[PLAYER JUST CHOSE]");
    expect(user!.content).not.toContain("[PREVIOUS OUTPUT ERRORS]");
    expect(user!.content).not.toContain("[NEED NEW DIRECTION]");
    expect(user!.content).toContain("[GLOBAL DIRECTION] (none yet)");
    expect(user!.content).toContain("[CURRENT STAGE] (no info)");
  });

  it("[CURRENT ROUTE](三段式 2026-10-18):route 非空注入聚焦块(表示名);共通线无块", () => {
    const base = {
      outlineMd: makePack().story.outlineMd,
      outlineBeatIndex: null,
      tables: "T",
      world: EMPTY_WORLD,
      summary: EMPTY_SUMMARY,
      history: [],
      names: { enagi: "陽見恵凪" },
    };
    const [, routed] = buildDirectorMessages({ ...base, route: "enagi" });
    expect(routed!.content).toContain("[CURRENT ROUTE] The story has entered 陽見恵凪's personal route");
    const [, common] = buildDirectorMessages(base);
    expect(common!.content).not.toContain("[CURRENT ROUTE]");
  });

  it("[FINAL ACT]:finale 在场替代 CURRENT ROUTE 块,收束指示带女主表示名", () => {
    const [, user] = buildDirectorMessages({
      outlineMd: makePack().story.outlineMd,
      outlineBeatIndex: null,
      tables: "T",
      world: EMPTY_WORLD,
      summary: EMPTY_SUMMARY,
      history: [],
      names: { enagi: "陽見恵凪" },
      route: "enagi",
      finale: { heroine: "enagi" },
    });
    expect(user!.content).toContain("[FINAL ACT]");
    expect(user!.content).toContain("陽見恵凪");
    expect(user!.content).toContain("sceneEnd");
    expect(user!.content).not.toContain("[CURRENT ROUTE]");
  });
});
