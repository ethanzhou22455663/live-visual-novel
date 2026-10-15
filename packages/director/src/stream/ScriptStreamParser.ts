/**
 * NDJSON 流式解析器(plan §2.1)——容错规则:
 * 1. 跳过开场白/markdown 围栏:首个以 { 开头的行才开始;
 * 2. JSON string 内裸换行:parse 失败且括号未平衡 → 继续吞行到平衡再 parse;
 * 3. 连续 3 次错误中止本次生成(上层发续写纠正);
 * 4. 逐行 zod discriminatedUnion 校验(裸换行、未知 t、缺字段都是校验失败);
 * 5. abort():半行原子丢弃,已提交行保留已生效。
 *
 * Tier-2 窥视解析(peekPartialText):对未完整行做 "text":"..." 字段扫描,
 * 只喂打字机显示,绝不进状态/TTS(失败即丢弃无副作用)。
 */
import { ModelScriptEventSchema } from "@gal/shared";
import type { ModelScriptEvent } from "@gal/shared";

export class ParserAbortedError extends Error {
  constructor(reason: string) {
    super(`解析器中止(连续错误): ${reason}`);
    this.name = "ParserAbortedError";
  }
}

export interface ScriptStreamParserOptions {
  /** 错误回调(已跳过的坏行);连续 3 次后抛 ParserAbortedError */
  onError?: (error: unknown, rawLine: string) => void;
  maxConsecutiveErrors?: number;
}

function braceBalance(s: string): number {
  // 只数结构括号;JSON string 内的引号转义粗处理:奇数个连续反斜杠跳过下一字符。
  // 解析层是容错路径,不需要完备的 tokenizer。
  let depth = 0;
  let inString = false;
  let escape = false;
  for (const ch of s) {
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') inString = !inString;
    else if (!inString) {
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
    }
  }
  return depth;
}

export class ScriptStreamParser {
  private started = false;
  private repairing = false;
  private repairBuf = "";
  private consecutiveErrors = 0;
  private aborted = false;
  private tail = ""; // 未收到换行的半行(abort 时原子丢弃)

  readonly #opts: Required<ScriptStreamParserOptions>;

  constructor(opts: ScriptStreamParserOptions = {}) {
    this.#opts = {
      onError: opts.onError ?? (() => {}),
      maxConsecutiveErrors: opts.maxConsecutiveErrors ?? 3,
    };
  }

  get isAborted(): boolean {
    return this.aborted;
  }

  /** 喂入一段流式文本,返回本次新提交的事件 */
  push(chunk: string): ModelScriptEvent[] {
    if (this.aborted) return [];
    this.tail += chunk;
    const lines = this.tail.split("\n");
    this.tail = lines.pop() ?? ""; // 最后一段可能是半行,留待下次
    const events: ModelScriptEvent[] = [];
    for (const line of lines) {
      const ev = this.#feedLine(line.replace(/\r$/, ""));
      if (ev) events.push(ev);
      if (this.aborted) break;
    }
    return events;
  }

  /** 流正常结束:提交残余(仅当它是完整行) */
  end(): ModelScriptEvent[] {
    if (this.aborted || !this.tail.trim()) {
      this.tail = "";
      return [];
    }
    const line = this.tail;
    this.tail = "";
    const ev = this.#feedLine(line);
    return ev ? [ev] : [];
  }

  /** 打断:半行原子丢弃,已提交行不受影响 */
  abort(): void {
    this.aborted = true;
    this.tail = "";
    this.repairing = false;
    this.repairBuf = "";
  }

  #fail(line: string, reason: unknown): never {
    this.consecutiveErrors++;
    this.#opts.onError(reason, line);
    if (this.consecutiveErrors >= this.#opts.maxConsecutiveErrors) {
      this.abort();
      throw new ParserAbortedError(String(reason).slice(0, 200));
    }
    return undefined as never;
  }

  #feedLine(line: string): ModelScriptEvent | undefined {
    const trimmed = line.trim();
    if (!trimmed) return undefined;

    // 1) 未开始:跳过围栏与开场白,首个 { 行启动
    if (!this.started) {
      if (trimmed === "```" || trimmed.startsWith("```")) return undefined;
      if (trimmed.startsWith("{")) this.started = true;
      else return undefined; // 开场白散文
    }
    if (this.aborted) return undefined;

    // 2) 修复模式:吞行到括号平衡
    if (this.repairing) {
      this.repairBuf += "\n" + trimmed;
      if (braceBalance(this.repairBuf) > 0) return undefined;
      this.repairing = false;
      const whole = this.repairBuf;
      this.repairBuf = "";
      try {
        return this.#parseAndValidate(whole);
      } catch (e) {
        if (e instanceof ParserAbortedError) throw e;
        // 修复后仍 parse 失败(string 内真有控制字符):整个 blob 只计 1 次错误——损伤遏制
        this.#fail(whole, e);
        return undefined;
      }
    }

    // 3) 常规:整行 parse;失败且未平衡 → 进入修复(修复策略归这里管,#parseAndValidate 只抛不判)
    try {
      return this.#parseAndValidate(trimmed);
    } catch (e) {
      if (e instanceof ParserAbortedError) throw e; // 中止信号必须穿透到调用方
      if (this.aborted) return undefined;
      if (braceBalance(trimmed) > 0) {
        this.repairing = true;
        this.repairBuf = trimmed;
        return undefined; // 尚不算错误:换行在 string 内是可修复的
      }
      this.#fail(trimmed, e);
      return undefined;
    }
  }

  #parseAndValidate(line: string): ModelScriptEvent | undefined {
    // JSON 解析失败原样抛出:是否可修复(括号未平衡)由 #feedLine 裁决
    const obj: unknown = JSON.parse(line);
    const parsed = ModelScriptEventSchema.safeParse(obj);
    if (!parsed.success) {
      this.#fail(line, parsed.error.message);
      return undefined;
    }
    this.consecutiveErrors = 0; // 好行重置错误计数
    return parsed.data as ModelScriptEvent;
  }
}

/**
 * Tier-2 窥视:从未完整流里抽 "text":"..." 的当前内容喂打字机。
 * 只读、无副作用、失败返回空串——绝不进状态/TTS。
 */
export function peekPartialText(rawTail: string): string {
  // 找最后一个 "text" 键的开始
  const keyAt = rawTail.lastIndexOf('"text"');
  if (keyAt < 0) return "";
  const colon = rawTail.indexOf(":", keyAt + 6);
  if (colon < 0) return "";
  let i = colon + 1;
  while (i < rawTail.length && /\s/.test(rawTail[i] as string)) i++;
  if (rawTail[i] !== '"') return "";
  i++;
  let out = "";
  while (i < rawTail.length) {
    const ch = rawTail[i] as string;
    if (ch === "\\") {
      const next = rawTail[i + 1];
      if (next === undefined) break;
      const map: Record<string, string> = { n: "\n", t: "\t", '"': '"', "\\": "\\", "/": "/" };
      if (next === "u") {
        const hex = rawTail.slice(i + 2, i + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) break; // 不完整/非法:窥视到此为止,不产乱码
        out += String.fromCharCode(Number.parseInt(hex, 16));
        i += 6;
        continue;
      }
      out += map[next] ?? next;
      i += 2;
      continue;
    }
    if (ch === '"') break; // 字符串闭合(之后是行尾 JSON,窥视到此为止)
    out += ch;
    i++;
  }
  // 裸换行只可能出现在坏行里;窥视不修复,直接截断
  return out.split("\n")[0] ?? "";
}
