/**
 * 规则正则切句(plan §2.3):句末标点后切,闭引号跟随;
 * 引号深度>0 不切(台词内的句号不断行);单句超长在逗读处强制再切。
 * 零依赖,供 TTS 入队与测试使用。
 */

const TERMINATORS = new Set(["。", "!", "?", "…", "‼", "⁉", "！", "？"]);
const CLOSERS = new Set(["」", "』", "）", ")", "〕", "］", "」"]);
const OPENERS = new Set(["「", "『", "（", "(", "〔", "［"]);

/** 逗读(强制长句切分的优先落点) */
const COMMAS = new Set(["、", "，", ",", " "]);

/** 有声字符:纯标点片(如行首 "……")不含它,不成句(GPT-SoVITS 拒纯标点文本) */
const VOICED = /[\p{L}\p{N}]/u;

function isTerminator(ch: string): boolean {
  return TERMINATORS.has(ch);
}

/**
 * 把一段台词切成 TTS 可独立合成的句元。
 * - "今日は…天気ですね。一緒に…ますか。" → 2 句
 * - "「はい。」と彼女は言った。" → 「はい。」 / と彼女は言った。(引号不切断)
 * - 连续标点(!!?…)与随后的闭引号并入前句
 * - 纯标点片(行首 "……"、孤立 "…!?"…)不成句:并入下一句;末尾无人声残余丢弃
 * - 无标点长句:在 maxLen 附近的最后一个逗读处强制切
 */
export function splitSentences(text: string, maxLen = 100): string[] {
  const out: string[] = [];
  let start = 0;
  let depth = 0;
  let lastComma = -1; // 最近一个逗读的下标(含逗读本身,切点在其后)
  let pendingCut = -1; // 命中句末标点的下标(等待引号闭合)
  let carry = ""; // 上一片无人声时暂存,并入下一句

  const flush = (end: number) => {
    const piece = (carry + text.slice(start, end)).trim();
    carry = "";
    start = end;
    pendingCut = -1;
    lastComma = -1;
    if (!piece) return;
    if (!VOICED.test(piece)) {
      carry = piece; // 纯标点:留给出下一句
      return;
    }
    out.push(piece);
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (OPENERS.has(ch)) depth++;
    if (CLOSERS.has(ch)) depth = Math.max(0, depth - 1);

    if (isTerminator(ch)) {
      if (depth === 0) {
        // 句末在引号外:立即切,并入紧随的连续标点与闭引号(如 "!?"、"。」")
        let end = i + 1;
        while (end < text.length) {
          const c = text[end] as string;
          if (isTerminator(c) || CLOSERS.has(c)) end++;
          else break;
        }
        flush(end);
        continue;
      }
      pendingCut = i; // 引号内的句末:推迟到闭引号处裁决
    }
    if (COMMAS.has(ch) && depth === 0) lastComma = i;

    // 闭引号把深度带回 0 且引号内有句末标点:是引用句边界还是句中引用?
    // 「…。」|「…。」(下一字符是开引号/文末)→ 切;「…。」と頷いた(普通续文)→ 不切
    if (pendingCut >= 0 && depth === 0 && CLOSERS.has(ch)) {
      const next = text[i + 1];
      if (next === undefined || OPENERS.has(next)) flush(i + 1);
      else pendingCut = -1;
    }

    // 超长兜底:距上次切点超过 maxLen,在最近逗读处强切
    if (i - start + 1 > maxLen && depth === 0) {
      if (lastComma > start) flush(lastComma + 1);
      else flush(i + 1); // 连逗读都没有:硬切
    }
  }
  if (start < text.length) flush(text.length);
  return out;
}
