#!/usr/bin/env node
/**
 * 试听样本生成器(零依赖):每套参考音频合成一条样句,存 wav 供人工听音色质量。
 * 数字测量用 probe.mjs;这里只服务"只有人耳能判断"的维度(音色相似度/自然度)。
 *
 * 用法:
 *   node samples.mjs --out <输出目录> --ref "<名称=参考音频绝对路径>" [--ref ...] [--text "<日文样句>"]
 * 示例:
 *   node samples.mjs --out assets/voice-samples --ref "a=D:/x/ref1.wav" --ref "b=D:/x/ref2.wav"
 */

import { parseArgs } from "node:util";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const { values: o } = parseArgs({
  options: {
    url:  { type: "string", default: "http://127.0.0.1:9880" },
    out:  { type: "string", default: "voice-samples" },
    ref:  { type: "string", multiple: true },          // "名称=参考音频绝对路径"(服务端本机可读)
    text: { type: "string", default: "おかえりなさい。今日はずっと待っていたんですよ。……ふふ、そんなに急がなくても、逃げませんから。" },
  },
  strict: true,
});

if (!o.ref?.length) fail("需要至少一个 --ref \"名称=参考音频绝对路径\"");

const outDir = resolve(o.out);
mkdirSync(outDir, { recursive: true });

for (const item of o.ref) {
  const eq = item.indexOf("=");
  if (eq <= 0) fail(`--ref 格式应为 "名称=路径": ${item}`);
  const name = item.slice(0, eq);
  const refPath = item.slice(eq + 1);
  const t0 = Date.now();
  const res = await fetch(`${o.url}/tts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      text: o.text,
      text_lang: "ja",
      ref_audio_path: refPath,
      prompt_text: "",
      prompt_lang: "ja",
      text_split_method: "cut0",
      media_type: "wav",
      streaming_mode: 0,
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    console.log(`${name}: FAIL HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    continue;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const file = resolve(outDir, `${name}.wav`);
  writeFileSync(file, buf);
  console.log(`${name}: ${(buf.length / 1024).toFixed(0)}KiB  ${Date.now() - t0}ms  -> ${file}`);
}

function fail(msg) { console.error(`错误: ${msg}`); process.exit(2); }
