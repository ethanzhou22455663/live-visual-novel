#!/usr/bin/env node
/**
 * 立绘/场景批量生图(火山方舟 · Seedream)——一次性批处理工具,不进运行时、不加 vite proxy。
 *
 * 前置:.env 提供 ARK_KEY;方舟控制台已开通「图像创作模型」。
 * 用法:
 *   node --env-file=.env tools/asset-gen/gen.mjs sprites --char shiori --expr 平常 [--ref <参考图>] [--n 1]
 *   node --env-file=.env tools/asset-gen/gen.mjs scene   --name 店内 [--n 1]
 *   通用旗标: --model <id>  --size 1920x1080  --out <dir>  --dry-run(只打印 prompt,不花钱)
 * 产物:assets/_gen/*.jpg(gitignored)。立绘为绿幕底 JPG,挑图后交 tools/asset-derive/derive.mjs 的
 * cutout() 抠成 1920×1080 透明 PNG(自动识别绿幕/黑底),再按 docs/pack-switch.md 流程入包。
 * 请求参数名以方舟 images/generations 文档为准;不匹配时只改本文件顶部常量与 body 组装处。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";

const ARK_URL = "https://ark.cn-beijing.volces.com/api/v3/images/generations";
const DEFAULT_MODEL = "doubao-seedream-4-5-251128"; // 以控制台「图像创作模型」页为准,--model 覆盖
const DEFAULT_SIZE = "1920x1080";
const DEFAULT_OUT = "assets/_gen";

/** 三位女主外貌规格(与 docs/dawn/characters.md 同源;改动须两边同步) */
const APPEARANCE = {
  shiori: {
    zh: "及腰黑长直发,额发上别一枚月白色月牙发卡,深蓝色旧式便利店店员制服配深蓝围裙,袖口卷起,身形娇小约155cm,年龄不详看似高中生,神情平静",
    en: "long straight black hair waist-length, a single pale-moon crescent hairpin in her bangs, deep navy vintage convenience-store staff uniform with navy apron, rolled-up sleeves, petite 155cm, ageless girl looking like a high schooler, calm composed face",
  },
  akari: {
    zh: "浅棕色微卷长发,旧式圆顶学生帽配缎带,米白色连衣裙配奶油色针织开衫,约158cm,礼貌温柔,像从旧时代走来的少女",
    en: "light brown loosely-waved long hair, vintage round school hat with ribbon, plain beige one-piece dress with cream knit cardigan, 158cm, polite gentle ladylike, a girl seemingly from another era",
  },
  yoi: {
    zh: "深紫色齐肩乱发,过大的深灰色连帽卫衣,眼下淡淡阴影,腋下夹着写满字的笔记本,约170cm高挑,慵懒的作家气质",
    en: "messy dark-purple shoulder-length hair, oversized dark-grey hoodie, faint dark circles under tired sharp eyes, a handwriting-crammed notebook under her arm, tall 170cm, lazy novelist vibe",
  },
};

/** 表情键 = 引擎 sprites 文件名(5 个固定中文词) */
const EXPR_EN = {
  平常: "calm neutral expression, standing straight, hands naturally at sides",
  微笑: "soft gentle closed-mouth smile, lips together, no teeth showing, kind warm eyes, relaxed shoulders",
  笑: "bright cheerful laugh, eyes narrowed with joy",
  害羞: "blushing, shy, glancing slightly away, hands fidgeting",
  震惊: "shocked, eyes wide, frozen in place",
};

/** 立绘构图硬约束:引擎吃 1920×1080 全画布,人物居中脚贴底(DomStagePort LAYOUT)。
 *  背景用绿幕:黑发/黑鞋等近黑前景在黑底下会被抠图误吃,绿幕键色距离法全免疫 */
const COMPOSITION =
  "single character, full body, standing, feet touching the bottom edge of the frame, " +
  "character fills about 90% of the canvas height, centered, " +
  "solid flat pure chroma green background (#00ff00), evenly lit, no shadow, no gradient, no vignette on the background, " +
  "anime style, clean lineart, soft cel shading, visual novel character sprite, " +
  "high quality, no text, no watermark, no logo";

/** 场景清单(9 张,16:9;与 content 包 scenes/ 中文文件名一一对应) */
const SCENES = {
  店内:
    "anime background art, no people, old Japanese convenience store interior at night, warm fluorescent lighting, three aisles of shelves with goods, vintage Showa-era cash register on the counter, window counter seats, oden pot steaming softly, cozy nostalgic mood, 16:9 wide shot, no text, no watermark, high quality",
  店门口:
    "anime background art, no people, exterior of a small old convenience store at night, glowing glass automatic doors, signboard with the number 24 crossed out and hand-written opening hours, quiet empty shopping street, warm light spilling onto pavement, 16:9 wide shot, no text, no watermark, high quality",
  商店街雨夜:
    "anime background art, no people, shopping street in heavy rain at night, wet asphalt reflecting neon and street lamps, closed shutters, a lone vending machine glowing, melancholic mood, 16:9 wide shot, no text, no watermark, high quality",
  车站前:
    "anime background art, no people, small suburban train station square late at night, empty rotary, dim station lights, vending machines, no crowds, still and quiet mood, 16:9 wide shot, no text, no watermark, high quality",
  里间:
    "anime background art, no people, small back storage room of an old convenience store, cardboard boxes, an old wooden abacus and paper ledgers on a desk, single warm bulb, cluttered but tidy, 16:9 wide shot, no text, no watermark, high quality",
  街心公园:
    "anime background art, no people, small neighborhood park before dawn, swing set and bench under a single lamp, dew on grass, deep blue night sky with fading stars, 16:9 wide shot, no text, no watermark, high quality",
  河堤:
    "anime background art, no people, grassy river embankment just before dawn, wide dark river reflecting the first pale light, distant city glow on the horizon, long empty path, serene wistful mood, 16:9 wide shot, no text, no watermark, high quality",
  主角房间:
    "anime background art, no people, small messy student apartment room late at night, unmade bed, desk with a glowing laptop showing a job listing page, instant noodle cup, curtains half open with street light leaking in, 16:9 wide shot, no text, no watermark, high quality",
  黎明的街:
    "anime background art, no people, quiet shopping street at first light of dawn, sky gradient from deep blue to pale orange, street lamps still on, store shutters closed, calm transitional mood, 16:9 wide shot, no text, no watermark, high quality",
};

function die(msg) {
  console.error(`[asset-gen] ${msg}`);
  process.exit(2);
}

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name) => argv.includes(`--${name}`);

const dry = has("dry-run");
const key = process.env.ARK_KEY;
if (!dry && !key) die("缺 ARK_KEY:请用 node --env-file=.env 运行,或在 .env 配置 ARK_KEY");

const model = flag("model") ?? DEFAULT_MODEL;
const size = flag("size") ?? DEFAULT_SIZE;
const out = flag("out") ?? DEFAULT_OUT;
const n = Math.max(1, Number.parseInt(flag("n") ?? "1", 10) || 1);
const refPath = flag("ref");

function spritePrompt(charId, expr) {
  const a = APPEARANCE[charId];
  if (!a) die(`未知角色「${charId}」,可选:${Object.keys(APPEARANCE).join(" / ")}`);
  const e = EXPR_EN[expr] ?? `${expr} expression`;
  return `anime visual novel character sprite. Appearance: ${a.en}. ${a.zh}. Expression and pose: ${e}. Composition: ${COMPOSITION}`;
}

/** 组装任务清单 */
let jobs;
if (cmd === "sprites") {
  const charId = flag("char");
  const expr = flag("expr");
  if (!charId || !expr) die("sprites 需要 --char <id> 与 --expr <表情>");
  jobs = Array.from({ length: n }, (_, i) => ({
    name: `${charId}-${expr}${i > 0 ? `-${i + 1}` : ""}.jpg`,
    prompt: spritePrompt(charId, expr),
  }));
} else if (cmd === "scene") {
  const name = flag("name");
  const desc = SCENES[name];
  if (!desc) die(`未知场景「${name}」,可选:${Object.keys(SCENES).join(" / ")}`);
  jobs = Array.from({ length: n }, (_, i) => ({
    name: `scene-${name}${i > 0 ? `-${i + 1}` : ""}.jpg`,
    prompt: desc,
  }));
} else {
  die(`用法见文件头注释;第一个参数应为 sprites 或 scene,收到:「${cmd ?? "(无)"}」`);
}

/** 参考图(i2i 差分一致性):本地文件读为 base64 数据 URI(方舟 images/generations 要求 url 格式) */
function refB64() {
  if (!refPath) return undefined;
  if (!existsSync(refPath)) die(`参考图不存在:${refPath}`);
  const mime = refPath.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
  return `data:${mime};base64,${readFileSync(refPath).toString("base64")}`;
}
const image = dry ? undefined : refB64();

async function callArk(body) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(ARK_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    });
    if (res.ok) return res.json();
    const text = await res.text();
    console.error(`[asset-gen] HTTP ${res.status}: ${text.slice(0, 400)}`);
    if ((res.status !== 429 && res.status < 500) || attempt >= 3) process.exit(2);
    await new Promise((r) => setTimeout(r, attempt * 2000));
  }
}

for (const job of jobs) {
  if (dry) {
    console.log(`[asset-gen:dry] ${job.name}\n  model=${model} size=${size} ref=${refPath ?? "无"}\n  prompt: ${job.prompt}\n`);
    continue;
  }
  const body = { model, prompt: job.prompt, size, watermark: false, response_format: "url" };
  if (image) body.image = [image];
  const data = await callArk(body);
  const url = data?.data?.[0]?.url;
  if (!url) {
    console.error(`[asset-gen] 响应中无 url:${JSON.stringify(data).slice(0, 400)}`);
    process.exit(2);
  }
  const bin = Buffer.from(await (await fetch(url)).arrayBuffer());
  mkdirSync(out, { recursive: true });
  const file = path.join(out, job.name);
  writeFileSync(file, bin);
  console.log(`[asset-gen] ${file}(${(bin.length / 1024).toFixed(0)} KB)`);
}
