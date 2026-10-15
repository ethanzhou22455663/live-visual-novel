import { describe, expect, it } from "vitest";
import { parseWorldbookMd, validateContent } from "../src/content/validate.ts";
import type { ScannedFile } from "../src/content/validate.ts";

const card = (dir: string, text: string, data: Record<string, unknown>): ScannedFile => ({
  path: `characters/${dir}/card.md`,
  kind: "card",
  text,
  data,
});
const sprite = (dir: string, name: string): ScannedFile => ({ path: `characters/${dir}/${name}.png`, kind: "sprite" });

const GOOD_CARD = card("enagi", "陽見恵凪の設定。", { name: "陽見恵凪", color: "#f2a7c3", defaultExpr: "平常" });

describe("validateContent 内容包校验器", () => {
  it("完整通过样例:卡+立绘+场景+bgm+outline+worldbook", () => {
    const files: ScannedFile[] = [
      GOOD_CARD,
      sprite("enagi", "平常"),
      sprite("enagi", "微笑"),
      { path: "scenes/教室.jpg", kind: "scene" },
      { path: "bgm/p07.m4a", kind: "bgm" },
      { path: "story/outline.md", kind: "md", text: "- 序章:路上ライブ\n" },
      { path: "story/worldbook.md", kind: "md", text: "## 神仙学園\nkeys: 神仙学園, 学校\n---\n雪鷹と恵凪の通う学校。\n" },
    ];
    expect(validateContent(files)).toEqual([]);
  });

  it("缺 card.md → MISSING_CARD", () => {
    const issues = validateContent([sprite("miku", "平常")]);
    expect(issues).toContainEqual(expect.objectContaining({ code: "MISSING_CARD", severity: "error" }));
  });

  it("frontmatter 缺 name/color → BAD_FRONTMATTER", () => {
    const issues = validateContent([card("enagi", "x", { name: "陽見恵凪" })]);
    expect(issues.some((i) => i.code === "BAD_FRONTMATTER")).toBe(true);
    const issues2 = validateContent([card("enagi", "x", { name: "陽見恵凪", color: "red" })]);
    expect(issues2.some((i) => i.code === "BAD_FRONTMATTER")).toBe(true);
  });

  it("defaultExpr 不在 sprites 集 → DANGLING_DEFAULT_EXPR", () => {
    const issues = validateContent([card("enagi", "x", { name: "n", color: "#ffffff", defaultExpr: "脸红" }), sprite("enagi", "平常")]);
    expect(issues).toContainEqual(expect.objectContaining({ code: "DANGLING_DEFAULT_EXPR" }));
  });

  it("charId 非法字符集 → BAD_ID_CHARSET", () => {
    const issues = validateContent([card("Enagi!", "x", { name: "n", color: "#ffffff" })]);
    expect(issues).toContainEqual(expect.objectContaining({ code: "BAD_ID_CHARSET" }));
  });

  it("场景重名(不同子目录)→ DUP_ID", () => {
    const issues = validateContent([
      GOOD_CARD,
      { path: "scenes/教室.jpg", kind: "scene" },
      { path: "scenes/sub/教室.png", kind: "scene" },
    ]);
    expect(issues).toContainEqual(expect.objectContaining({ code: "DUP_ID", detail: expect.stringContaining("教室") }));
  });

  it("立绘扩展名非法 → BAD_ASSET_EXT;全部非法 → MISSING_SPRITE_FILE", () => {
    const files: ScannedFile[] = [GOOD_CARD, { path: "characters/enagi/平常.bmp", kind: "sprite" }];
    const issues = validateContent(files);
    expect(issues).toContainEqual(expect.objectContaining({ code: "BAD_ASSET_EXT" }));
    expect(issues).toContainEqual(expect.objectContaining({ code: "MISSING_SPRITE_FILE" }));
  });

  it("无立绘角色(主人公)合法,不报错", () => {
    const files = [card("yukitaka", "主人公。", { name: "沖浪雪鷹", color: "#8899aa", defaultExpr: "平常" })];
    const issues = validateContent(files).filter((i) => i.severity === "error");
    expect(issues).toEqual([]);
  });

  it("缺 outline.md → warn(非 error)", () => {
    const issues = validateContent([GOOD_CARD]);
    expect(issues).toContainEqual(expect.objectContaining({ code: "MISSING_OUTLINE", severity: "warn" }));
  });
});

describe("parseWorldbookMd 世界书解析", () => {
  it("标准条目:keys 多分隔符/priority 缺省 5", () => {
    const md = [
      "## レモネードファクトリー",
      "keys: レモネードファクトリー, バンド、ララジャム",
      "priority: 10",
      "---",
      "雪鷹が結成したバンド。",
    ].join("\n");
    const { entries, issues } = parseWorldbookMd(md);
    expect(issues).toEqual([]);
    expect(entries).toEqual([
      { id: "1-レモネードファクトリー", keys: ["レモネードファクトリー", "バンド", "ララジャム"], content: "雪鷹が結成したバンド。", priority: 10, enabled: true },
    ]);
  });

  it("缺 keys 或正文 → BAD_WORLDBOOK 且不进 entries", () => {
    const md = ["## 坏条目", "---", "没写 keys。", "", "## 坏条目2", "keys: ある", "---", ""].join("\n");
    const { entries, issues } = parseWorldbookMd(md);
    expect(entries).toEqual([]);
    expect(issues.filter((i) => i.code === "BAD_WORLDBOOK")).toHaveLength(2);
  });

  it("CRLF 归一", () => {
    const md = "## 学校\r\nkeys: 学校\r\n---\r\n説明。\r\n";
    const { entries, issues } = parseWorldbookMd(md);
    expect(issues).toEqual([]);
    expect(entries[0]?.keys).toEqual(["学校"]);
  });
});
