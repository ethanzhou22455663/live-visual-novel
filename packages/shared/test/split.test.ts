import { describe, expect, it } from "vitest";
import { splitSentences } from "../src/text/split.ts";

describe("splitSentences 切句", () => {
  it("普通双句", () => {
    expect(splitSentences("今日はとても良い天気ですね。一緒に商店街まで散歩しませんか。")).toEqual([
      "今日はとても良い天気ですね。",
      "一緒に商店街まで散歩しませんか。",
    ]);
  });

  it("引号内的句号不切,引号整体保留", () => {
    expect(splitSentences("彼女は「はい、大丈夫です。」と頷いた。")).toEqual([
      "彼女は「はい、大丈夫です。」と頷いた。",
    ]);
  });

  it("台词行:闭引号跟句末标点一起收口", () => {
    expect(splitSentences("「はい、大丈夫です。」「本当ですか?」")).toEqual([
      "「はい、大丈夫です。」",
      "「本当ですか?」",
    ]);
  });

  it("连续标点与感叹疑问合并", () => {
    expect(splitSentences("えっ!?うそでしょ!")).toEqual(["えっ!?", "うそでしょ!"]);
  });

  it("省略号切句", () => {
    expect(splitSentences("そんな……嘘だ。")).toEqual(["そんな……", "嘘だ。"]);
  });

  it("超长无标点句在逗读处强切", () => {
    const long = "あ".repeat(60) + "、" + "い".repeat(60);
    const pieces = splitSentences(long, 100);
    expect(pieces).toHaveLength(2);
    expect(pieces[0]).toContain("、");
  });

  it("超长且无逗读:硬切不超过上限太多", () => {
    const long = "あ".repeat(250);
    const pieces = splitSentences(long, 100);
    for (const p of pieces) expect(p.length).toBeLessThanOrEqual(101);
  });

  it("空白与空串", () => {
    expect(splitSentences("")).toEqual([]);
    expect(splitSentences("   ")).toEqual([]);
  });

  it("行首纯标点不成句:并入下一句(GPT-SoVITS 拒纯标点文本)", () => {
    expect(splitSentences("……ねえ、少しだけ、歩かない？")).toEqual(["……ねえ、少しだけ、歩かない？"]);
    expect(splitSentences("………")).toEqual([]); // 整句无有声字符:不产句
    expect(splitSentences("……！いいよ。")).toEqual(["……！いいよ。"]);
  });
});
