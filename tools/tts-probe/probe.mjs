#!/usr/bin/env node
/**
 * GPT-SoVITS api_v2 探测脚本（零依赖，Node >= 20）
 *
 * 面向 P0 实测与 tts-bridge 调参：延迟 / RTF / 真流式首包 / 权重热切成本 / CORS / 显存。
 * 所有参数显式传入，无本机硬编码；只做只读测量（swap 模式结束后恢复原权重）。
 *
 * 用法：
 *   node probe.mjs --ref "D:\path\ref.wav" --mode all
 *   node probe.mjs --ref "D:\path\ref.wav" --mode bench --runs 5
 *   node probe.mjs --ref "D:\path\ref.wav" --mode swap \
 *     --swapA "D:\path\s2Gv2Pro.pth" --swapB "D:\path\s2Gv2ProPlus.pth" \
 *     --gptWeights "D:\path\s1xxx.ckpt"
 *   node probe.mjs --mode cors
 *   node probe.mjs --mode vram
 *
 * 常用参数：--url http://127.0.0.1:9880  --lang ja  --text "<日文句子>"  --json
 * 输出：人类可读表格；--json 时末尾追加整体 JSON 报告（供 findings 文档粘贴）。
 */

import { parseArgs } from "node:util";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

// ---------- CLI ----------

const { values: o } = parseArgs({
  options: {
    url:        { type: "string", default: "http://127.0.0.1:9880" },
    ref:        { type: "string" },                    // 参考音频绝对路径（服务端本机可读）
    promptText: { type: "string", default: "" },       // 参考音频转写文本（可空）
    lang:       { type: "string", default: "ja" },     // text_lang 与 prompt_lang
    text:       { type: "string", default: "今日はとても良い天気ですね。一緒に商店街まで散歩しませんか。" },
    runs:       { type: "string", default: "3" },
    mode:       { type: "string", default: "all" },    // all|bench|stream|swap|cors|vram
    swapA:      { type: "string" },                    // 常驻 sovits 权重（测完恢复到它）
    swapB:      { type: "string" },                    // 另一套 sovits 权重
    gptWeights: { type: "string" },                    // GPT 权重（同路径重载成本）
    json:       { type: "boolean", default: false },
    help:       { type: "boolean", default: false },
  },
  strict: true,
});

if (o.help) {
  console.log("见文件头注释（用法示例与参数说明）");
  process.exit(0);
}

const MODES = new Set(["all", "bench", "stream", "swap", "cors", "vram"]);
if (!MODES.has(o.mode)) fail(`未知模式: ${o.mode}（可选 ${[...MODES].join("|")}）`);
const NEEDS_SYNTH = ["all", "bench", "stream", "swap"].includes(o.mode);
if (NEEDS_SYNTH && !o.ref) fail("该模式需要 --ref <参考音频绝对路径>");
if (o.mode === "swap" && !(o.swapA && o.swapB)) fail("swap 模式需要 --swapA 与 --swapB");

const report = { startedAt: new Date().toISOString(), url: o.url, mode: o.mode, node: process.version };

// ---------- WAV 解析（取时长算 RTF） ----------

function wavInfo(buf) {
  if (buf.length < 44 || buf.toString("latin1", 0, 4) !== "RIFF") return null;
  let off = 12, dataOff = -1, dataLen = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString("latin1", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "data") { dataOff = off + 8; dataLen = size; break; }
    off += 8 + size + (size % 2); // chunk 按 2 字节对齐
  }
  if (dataOff < 0) return null;
  const channels = buf.readUInt16LE(22);
  const sampleRate = buf.readUInt32LE(24);
  const bits = buf.readUInt16LE(34);
  const byteRate = buf.readUInt32LE(28) || (sampleRate * channels * bits) / 8;
  let bytes = dataLen;
  // 流式响应头里的 data 长度可能为 0 / 0xFFFFFFFF（边生成边发），以实际收到的为准
  if (bytes === 0 || bytes === 0xffffffff || dataOff + bytes > buf.length) bytes = buf.length - dataOff;
  if (byteRate <= 0) return null;
  return { channels, sampleRate, bits, seconds: bytes / byteRate, dataBytes: bytes };
}

// ---------- 调用 ----------

async function synth(opts) {
  const { text, streaming = 0, timeoutMs = 300_000 } = opts;
  const body = {
    text,
    text_lang: o.lang,
    ref_audio_path: o.ref,
    prompt_text: o.promptText,
    prompt_lang: o.lang,
    text_split_method: "cut0", // 单句不切，精确测一句的成本
    media_type: "wav",
    streaming_mode: streaming,
    speed_factor: 1.0,
  };
  const t0 = performance.now();
  const res = await fetch(`${o.url}/tts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${errText.slice(0, 300)}`);
  }
  const chunks = [];
  let total = 0, firstChunkMs;
  for await (const c of res.body) {
    if (firstChunkMs === undefined) firstChunkMs = performance.now() - t0;
    chunks.push(c);
    total += c.length;
  }
  const totalMs = performance.now() - t0;
  const buf = Buffer.concat(chunks);
  const wav = wavInfo(buf);
  return {
    text,
    streaming,
    firstChunkMs: round(firstChunkMs),
    totalMs: round(totalMs),
    bytes: total,
    audioSeconds: wav ? round(wav.seconds, 2) : null,
    rtf: wav ? round(totalMs / 1000 / wav.seconds, 4) : null,
    sampleRate: wav?.sampleRate ?? null,
  };
}

async function setWeights(endpoint, weightsPath) {
  const t0 = performance.now();
  const res = await fetch(`${o.url}/${endpoint}?weights_path=${encodeURIComponent(weightsPath)}`, {
    signal: AbortSignal.timeout(300_000),
  });
  const bodyText = (await res.text().catch(() => "")).slice(0, 120);
  return { endpoint, weightsPath: short(weightsPath), status: res.status, httpMs: round(performance.now() - t0), body: bodyText };
}

// ---------- 各模式 ----------

async function bench() {
  console.log("── 冷启动（首个请求，含模型加载）");
  const cold = await synth({ text: "はい、大丈夫です。" });
  printRow("cold", cold);
  report.coldStart = cold;

  const n = Number(o.runs);
  console.log(`── 暖机 RTF ×${n}（整段 streaming_mode=0，"${cut(o.text)}"）`);
  const rows = [];
  for (let i = 1; i <= n; i++) {
    const r = await synth({ text: o.text });
    printRow(`warm#${i}`, r);
    rows.push(r);
  }
  const avgTotal = avg(rows.map((r) => r.totalMs));
  const avgRtf = avg(rows.map((r) => r.rtf));
  const pass = avgTotal <= 500;
  console.log(`   暖机均值: total=${round(avgTotal)}ms  rtf=${round(avgRtf, 4)}  ` +
    `验收(≤500ms): ${pass ? "PASS ✅" : "FAIL ❌"}`);
  report.bench = { runs: rows, avgTotalMs: round(avgTotal), avgRtf: round(avgRtf, 4), pass };
}

async function stream() {
  for (const sm of [2, 3]) {
    console.log(`── 真流式 streaming_mode=${sm}`);
    try {
      const r = await synth({ text: o.text, streaming: sm });
      printRow(`stream#${sm}`, r);
      report[`stream${sm}`] = r;
    } catch (e) {
      console.log(`   失败: ${e.message}`);
      report[`stream${sm}`] = { error: e.message };
    }
  }
}

async function swap() {
  console.log(`── sovits 热切 A→B→A（A=${short(o.swapA)}  B=${short(o.swapB)}）`);
  report.swap = {};
  for (const [label, target] of [["A→B", o.swapB], ["B→A(恢复)", o.swapA]]) {
    const sw = await setWeights("set_sovits_weights", target);
    // 切换后首请求：懒加载服务在这里补上模型加载时间
    const warm = await synth({ text: "はい、大丈夫です。" });
    const normal = await synth({ text: o.text });
    const entry = { switch: sw, firstSynth: warm, secondSynth: normal, totalCostMs: round(sw.httpMs + warm.totalMs) };
    report.swap[label] = entry;
    console.log(`   ${label}: http=${sw.httpMs}ms(body=${sw.body})  首请求=${warm.totalMs}ms  次请求=${normal.totalMs}ms  ⇒ 切换总成本≈${entry.totalCostMs}ms`);
  }
  if (o.gptWeights) {
    console.log(`── GPT 权重同路径重载（${short(o.gptWeights)}）`);
    const sw = await setWeights("set_gpt_weights", o.gptWeights);
    const warm = await synth({ text: "はい、大丈夫です。" });
    report.swap.gptReload = { switch: sw, firstSynth: warm, totalCostMs: round(sw.httpMs + warm.totalMs) };
    console.log(`   http=${sw.httpMs}ms  首请求=${warm.totalMs}ms  ⇒ 重载总成本≈${report.swap.gptReload.totalCostMs}ms`);
  }
  console.log("   （结论口径：切换总成本 = 权重 HTTP + 切后首请求；与 plan §2.3 多角色方案决策对照）");
}

async function cors() {
  const origin = "http://localhost:5173";
  console.log(`── CORS 预检 OPTIONS /tts（Origin: ${origin}）`);
  const headers = {};
  try {
    const pre = await fetch(`${o.url}/tts`, {
      method: "OPTIONS",
      headers: { Origin: origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" },
      signal: AbortSignal.timeout(15_000),
    });
    pre.headers.forEach((v, k) => (headers[k] = v));
    console.log(`   status=${pre.status}`);
  } catch (e) {
    console.log(`   预检失败: ${e.message}`);
  }
  console.log("── CORS 实际请求 POST /tts（空 body，预期 400，只为看响应头）");
  try {
    const post = await fetch(`${o.url}/tts`, {
      method: "POST",
      headers: { "content-type": "application/json", Origin: origin },
      body: "{}",
      signal: AbortSignal.timeout(15_000),
    });
    post.headers.forEach((v, k) => (headers[k] = v));
    console.log(`   status=${post.status}`);
  } catch (e) {
    console.log(`   实际请求失败: ${e.message}`);
  }
  const aca = Object.keys(headers).filter((k) => k.toLowerCase().startsWith("access-control"));
  const verdict = aca.length ? `存在 CORS 头: ${aca.join(", ")}` : "无任何 Access-Control-* 响应头";
  console.log(`   ⇒ ${verdict}`);
  report.cors = { headers, accessControlHeaders: aca, verdict };
}

async function vram() {
  console.log("── nvidia-smi");
  const { stdout } = await execFileP(
    "nvidia-smi",
    ["--query-gpu=name,memory.used,memory.total,utilization.gpu", "--format=csv,noheader,nounits"],
  );
  const [name, used, total, util] = stdout.trim().split(",").map((s) => s.trim());
  console.log(`   ${name}  显存 ${used}/${total} MiB  利用率 ${util}%`);
  report.vram = { name, usedMiB: Number(used), totalMiB: Number(total), gpuUtilPercent: Number(util) };
}

// ---------- 输出辅助 ----------

function printRow(label, r) {
  console.log(
    `   ${label.padEnd(10)} 首包 ${String(r.firstChunkMs ?? "-").padStart(6)}ms  ` +
    `总 ${String(r.totalMs).padStart(6)}ms  音频 ${String(r.audioSeconds ?? "-").padStart(5)}s  ` +
    `RTF ${String(r.rtf ?? "-").padStart(7)}  ${(r.bytes / 1024).toFixed(0)}KiB @${r.sampleRate ?? "?"}Hz`,
  );
}

function avg(a) { return a.reduce((s, v) => s + v, 0) / a.length; }
function round(v, d = 0) { return v == null ? null : Number(v.toFixed(d)); }
function cut(s, n = 18) { return s.length > n ? s.slice(0, n) + "…" : s; }
function short(p) { const parts = String(p).split(/[\\/]/); return parts.slice(-2).join("/"); }
function fail(msg) { console.error(`错误: ${msg}`); process.exit(2); }

// ---------- 主流程 ----------

try {
  const m = o.mode;
  if (m === "vram") await vram();
  else {
    if (m === "cors") await cors();
    else {
      await bench();
      if (m === "all" || m === "stream") await stream();
      if (m === "all" || m === "swap") await swap();
      if (m === "all") await cors();
      await vram();
    }
  }
  if (o.json) console.log("\n--- JSON REPORT ---\n" + JSON.stringify(report, null, 2));
} catch (e) {
  console.error(`\n探测中断: ${e.message}`);
  console.error(`(服务未启动？先运行 api_v2.py；冷启动超时可在 synth 调大 timeoutMs)`);
  process.exit(1);
}
