#!/usr/bin/env node
/**
 * P0-③ 无头端到端验收(plan §三-3 / §四-2):
 * DeepSeek 流式 → ScriptStreamParser 逐行提交 → 切句 → GPT-SoVITS 逐句合成,
 * 按行级流水线(合成链 FIFO,演出零宽最坏情形)模拟播放时间轴,统计断档。
 *
 * 验收口径(docs/p0-tts-findings.md §五):
 *   首字 <2s、连续 10 句无断档(断档 = 下一句合成完成晚于上一句播放结束 >50ms)、RTF<1。
 *
 * 用法:node tools/p0-e2e.mjs [--key sk-..] [--ref D:/path/ref.wav] [--prompt 参考转写]
 * 默认从仓库根 .env 读 DEEPSEEK_KEY / VITE_TTS_REF_PATH / VITE_TTS_PROMPT_TEXT。
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// ---- 参数与 .env ----
const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const env = existsSync(join(root, ".env"))
  ? Object.fromEntries(
      readFileSync(join(root, ".env"), "utf8")
        .split(/\r?\n/)
        .filter((l) => l.trim() && !l.trim().startsWith("#"))
        .map((l) => {
          const i = l.indexOf("=");
          return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
        }),
    )
  : {};
const KEY = argOf("--key") ?? env.DEEPSEEK_KEY;
const REF = argOf("--ref") ?? env.VITE_TTS_REF_PATH;
const PROMPT_TEXT = argOf("--prompt") ?? env.VITE_TTS_PROMPT_TEXT ?? "";
const TTS_BASE = "http://127.0.0.1:9880";
if (!KEY) fail("缺 DEEPSEEK_KEY(.env 或 --key)");
if (!REF) fail("缺 VITE_TTS_REF_PATH(.env 或 --ref)");

// ---- 复用 packages 的 TS 源(Node 26 原生 type stripping) ----
const { streamChat } = await import("../packages/director/src/llm/deepseek.ts");
const { ScriptStreamParser } = await import("../packages/director/src/stream/ScriptStreamParser.ts");
const { splitSentences } = await import("../packages/shared/src/text/split.ts");

const SCENE =
  "夕暮れの商店街。主人公の前に、同級生のユキが待っていた。久しぶりの再会を喜ぶ、穏やかで温かい日常シーン。";

async function synth(text, signal) {
  const t0 = performance.now();
  const res = await fetch(`${TTS_BASE}/tts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      text,
      text_lang: "ja",
      ref_audio_path: REF,
      prompt_text: PROMPT_TEXT,
      prompt_lang: "ja",
      text_split_method: "cut0",
      media_type: "wav",
      streaming_mode: 0,
      batch_size: 1,
    }),
    signal,
  });
  if (!res.ok) throw new Error(`TTS HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`);
  const buf = await res.arrayBuffer();
  const ms = performance.now() - t0;
  // WAV 时长(与 packages/tts-bridge wavInfo 同逻辑的极简版:32kHz 单声道 suffice)
  const view = new DataView(buf);
  const sampleRate = view.getUint32(24, true);
  const channels = view.getUint16(22, true);
  const bits = view.getUint16(34, true);
  const byteRate = view.getUint32(28, true) || (sampleRate * channels * bits) / 8;
  let off = 12;
  let dataLen = buf.byteLength - 44;
  while (off + 8 <= buf.byteLength) {
    const id = String.fromCharCode(view.getUint8(off), view.getUint8(off + 1), view.getUint8(off + 2), view.getUint8(off + 3));
    const size = view.getUint32(off + 4, true);
    if (id === "data") {
      dataLen = size === 0 || size === 0xffffffff ? buf.byteLength - off - 8 : size;
      break;
    }
    off += 8 + size + (size % 2);
  }
  return { ms, audioSec: dataLen / byteRate, bytes: buf.byteLength };
}

function fail(msg) {
  console.error(`错误: ${msg}`);
  process.exit(2);
}

// ---- 主流程 ----
console.log(`── DeepSeek 流式生成(场景:${SCENE})`);
const t0 = performance.now();
const parser = new ScriptStreamParser({
  onError: (e) => console.log(`   [解析器跳过] ${String(e).slice(0, 100)}`),
});
let firstTokenMs = null;
let seq = 0;
const sentences = []; // {lineId, text, doneAt, synthMs, audioSec}
let synthChain = Promise.resolve();

const SYSTEM = `あなたは日本語のビジュアルノベル脚本家です。全年齢対象。
出力は markdown も説明文も禁止。NDJSON として、1行 = 1 JSON オブジェクトのみ:
{"t":"narrate","turnNo":N,"text":"地の文"}
{"t":"say","turnNo":N,"who":"ユキ","emotion":"平常|微笑|悲しい|驚き","text":"セリフ"}
turnNo は 1 から。text に生の改行禁止。12〜16 行書いたら黙って終了。`;

try {
  for await (const delta of streamChat({
    apiKey: KEY,
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: `シーン:\n${SCENE}\n\nNDJSON で書いてください。` },
    ],
    temperature: 0.9,
    signal: AbortSignal.timeout(180_000),
  })) {
    if (firstTokenMs === null) {
      firstTokenMs = performance.now() - t0;
      console.log(`   首 token: ${firstTokenMs.toFixed(0)}ms`);
    }
    for (const ev of parser.push(delta)) {
      if (ev.t === "say" || ev.t === "narrate") {
        const lineId = `${ev.turnNo}.${seq++}`;
        const who = ev.t === "say" ? ev.who : "―";
        console.log(`   [${lineId}] ${who}${ev.t === "say" ? `(${ev.emotion})` : ""} ${ev.text}`);
        const clips =
          ev.t === "say"
            ? splitSentences(ev.text)
            : [];
        for (const s of clips) {
          const idx = sentences.length;
          sentences.push({ lineId: `${lineId}#${idx}`, text: s, doneAt: NaN, synthMs: NaN, audioSec: NaN, failed: false });
          // 合成链 FIFO(commit 即入队,不阻塞 LLM 消费——与 app 行为一致)
          const entry = sentences[idx];
          synthChain = synthChain
            .then(async () => {
              const r = await synth(s);
              entry.doneAt = performance.now() - t0;
              entry.synthMs = r.ms;
              entry.audioSec = r.audioSec;
            })
            .catch((e) => {
              // 降级链语义:单句失败→静音,不炸整场;验收单独计数
              entry.failed = true;
              console.log(`   [合成失败→静音] ${s.slice(0, 20)}: ${String(e.message).slice(0, 90)}`);
            });
        }
      } else {
        console.log(`   [${ev.t}] (P0 记录不演出)`);
      }
    }
  }
  await synthChain;
} catch (e) {
  fail(`LLM 流失败: ${e.message}`);
}

// ---- 时间轴:行级流水线,演出零宽最坏情形 ----
let playbackEnd = -1;
let gaps = 0;
let maxGap = 0;
let rtfSum = 0;
let ttsFailed = 0;
console.log("\n── 流水线时间轴(演出零宽最坏情形;真实 app 另有打字机时间做缓冲)");
console.log("   句 | 合成耗时 | 音频时长 | RTF  | 断档");
for (const [i, s] of sentences.entries()) {
  if (s.failed) {
    ttsFailed++;
    console.log(`   ${String(i + 1).padStart(2)} | (静音降级)`);
    continue; // 零时长零断档:muted 时文本即时推进
  }
  const gap = i === 0 ? 0 : Math.max(0, s.doneAt - playbackEnd);
  if (gap > 50) gaps++;
  maxGap = Math.max(maxGap, gap);
  const start = Math.max(playbackEnd, s.doneAt);
  playbackEnd = start + s.audioSec * 1000;
  const rtf = s.synthMs / 1000 / s.audioSec;
  rtfSum += rtf;
  console.log(
    `   ${String(i + 1).padStart(2)} | ${s.synthMs.toFixed(0).padStart(6)}ms | ${s.audioSec.toFixed(2).padStart(5)}s | ${rtf.toFixed(2)} | ${gap > 50 ? `+${gap.toFixed(0)}ms ⚠` : "-"}`,
  );
}

const totalLines = sentences.length; // 近似:每行至少 1 句
const firstAudioReady = sentences[0] ? sentences[0].doneAt : NaN;
const avgRtf = sentences.length ? rtfSum / sentences.length : NaN;
console.log("\n── 验收(plan §四,P0-① 修正口径)");
console.log(`   首 token:        ${firstTokenMs?.toFixed(0) ?? "?"}ms  ${firstTokenMs < 2000 ? "✅" : "❌"}(线 <2000ms)`);
console.log(`   首句音频 ready:  ${firstAudioReady.toFixed(0)}ms`);
console.log(`   行/句数:         ${seq} 行 / ${sentences.length} 句  ${sentences.length >= 10 ? "✅" : "⚠ <10 句"}`);
console.log(`   断档(>50ms):    ${gaps} 处(最大 ${maxGap.toFixed(0)}ms)  ${gaps === 0 ? "✅ 连续无断档" : "❌"}`);
console.log(`   平均 RTF:        ${avgRtf.toFixed(3)}  ${avgRtf < 1 ? "✅" : "❌"}`);
console.log(`   合成失败(静音):  ${ttsFailed}  ${ttsFailed === 0 ? "✅" : "❌ 降级不得成为常态"}`);
const pass = firstTokenMs < 2000 && gaps === 0 && sentences.length >= 10 && avgRtf < 1 && ttsFailed === 0;
console.log(`\n${pass ? "P0-③ 端到端验收 PASS ✅" : "P0-③ 端到端验收 FAIL ❌"}`);
process.exit(pass ? 0 : 1);
