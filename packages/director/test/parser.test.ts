import { describe, expect, it } from "vitest";
import { ParserAbortedError, ScriptStreamParser, peekPartialText } from "../src/stream/ScriptStreamParser.ts";

const SAY1 = '{"t":"say","turnNo":1,"who":"ユキ","emotion":"微笑","text":"きょうはいい天気だね。"}';
const NAR1 = '{"t":"narrate","turnNo":2,"text":"陽射しが差し込む。"}';

function feedAll(p: ScriptStreamParser, text: string) {
  const out = p.push(text);
  return [...out, ...p.end()];
}

describe("ScriptStreamParser", () => {
  it("正常流:多事件逐行提交", () => {
    const p = new ScriptStreamParser();
    const evs = feedAll(p, `${SAY1}\n${NAR1}\n`);
    expect(evs).toHaveLength(2);
    expect(evs[0]).toMatchObject({ t: "say", who: "ユキ" });
    expect(evs[1]).toMatchObject({ t: "narrate" });
  });

  it("跳过 markdown 围栏与开场白散文", () => {
    const p = new ScriptStreamParser();
    const evs = feedAll(p, `はい、脚本です。\n\`\`\`\n${SAY1}\n\`\`\`\n`);
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ t: "say" });
  });

  it("分块喂入(逐字粒度)与整喂等价", () => {
    const whole = feedAll(new ScriptStreamParser(), `${SAY1}\n${NAR1}\n`);
    const p = new ScriptStreamParser();
    const got: unknown[] = [];
    for (const ch of `${SAY1}\n${NAR1}\n`) got.push(...p.push(ch));
    got.push(...p.end());
    expect(got).toEqual(whole);
  });

  it("JSON string 内裸换行:吞行到括号平衡,整个 blob 只计 1 次错误(损伤遏制)", () => {
    const badLines: string[] = [];
    const p = new ScriptStreamParser({ onError: (_e, line) => badLines.push(line) });
    // 物理行 1:string 未闭合(真换行在 JSON string 里,行分隔符把它切开)
    expect(p.push('{"t":"say","turnNo":1,"who":"ユキ","emotion":"平常","text":"また会えたね。\n')).toHaveLength(0);
    // 物理行 2:闭合并平衡 → 修复后 parse(裸控制字符)失败 → 整个 blob 只计 1 错,不中止
    expect(p.push('心配させたんだよ。"}\n')).toHaveLength(0);
    expect(badLines).toHaveLength(1);
    expect(p.isAborted).toBe(false);
    // 后续好行正常提交(错误计数被重置)
    expect(p.push(`${SAY1}\n`)).toHaveLength(1);
  });

  it("坏行(已平衡但非法)×3 → 中止并抛错", () => {
    const errors: unknown[] = [];
    const p = new ScriptStreamParser({ onError: (e) => errors.push(e) });
    expect(feedAll(p, `${SAY1}\n`)).toHaveLength(1); // 先用好行启动解析器(此前坏行会被当开场白跳过)
    const bad = "これは JSON ではない\n";
    expect(() => feedAll(p, bad + bad + bad)).toThrow(ParserAbortedError);
    expect(errors).toHaveLength(3);
    expect(p.isAborted).toBe(true);
  });

  it("zod 校验失败连续 3 次 → 中止;好行重置计数", () => {
    const p = new ScriptStreamParser();
    // 错1+错2:不中止
    expect(() =>
      feedAll(p, ['{"t":"unknown","turnNo":1}', '{"t":"say","turnNo":2,"text":"who がない"}'].join("\n") + "\n"),
    ).not.toThrow();
    // 好(重置)+错1+错2
    expect(() =>
      feedAll(p, [SAY1, '{"t":"narrate","turnNo":3}', '{"t":"say","turnNo":4}'].join("\n") + "\n"),
    ).not.toThrow();
    // 错3 → 中止
    expect(() => feedAll(p, '{"t":"narrate"}\n')).toThrow(ParserAbortedError);
  });

  it("abort():半行原子丢弃,之后 push 无效果", () => {
    const p = new ScriptStreamParser();
    expect(p.push(`${SAY1}\n`)).toHaveLength(1);
    p.push('{"t":"say","turnNo":3,"who":"x","emotion":"平常","text":"半');
    p.abort();
    expect(p.push(`行"}\n${SAY1}\n`)).toHaveLength(0);
  });

  it("turnNo=0 合法(nonnegative);负数按错误计(不越过 3 次不中止)", () => {
    const p = new ScriptStreamParser();
    expect(feedAll(p, '{"t":"narrate","turnNo":0,"text":"零号もOK"}\n')).toHaveLength(1);
    const strict = new ScriptStreamParser({ maxConsecutiveErrors: 1 });
    expect(() => feedAll(strict, '{"t":"narrate","turnNo":-1,"text":"x"}\n')).toThrow(ParserAbortedError);
  });
});

describe("peekPartialText(Tier-2 窥视)", () => {
  it("从半行里抽出 text 当前内容", () => {
    const tail = '{"t":"say","turnNo":1,"who":"ユキ","emotion":"平常","text":"こん';
    expect(peekPartialText(tail)).toBe("こん");
  });

  it("字符串闭合后返回已完整内容(整行提交在即,窥视自然交接)", () => {
    expect(peekPartialText('{"text":" complet"}')).toBe(" complet");
  });

  it("转义处理:\\n 截断、非法 \\u 不产乱码", () => {
    expect(peekPartialText('{"text":"あ\\nい"}')).toBe("あ");
    expect(peekPartialText('{"text":"あ\\u305\\n')).toBe("あ");
    expect(peekPartialText('{"text":"あ\\u3053"}')).toBe("あこ");
  });

  it("无 text 键与空输入安全", () => {
    expect(peekPartialText('{"who":"x"}')).toBe("");
    expect(peekPartialText("")).toBe("");
  });
});
