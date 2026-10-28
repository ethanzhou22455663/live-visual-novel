#!/usr/bin/env node
/**
 * 立绘/场景批量生图(火山方舟 · Seedream)——一次性批处理工具,不进运行时、不加 vite proxy。
 *
 * 前置:.env 提供 ARK_KEY;方舟控制台已开通「图像创作模型」。
 * 用法:
 *   node --env-file=.env tools/asset-gen/gen.mjs sprites --char shiori --expr 平常 [--ref <参考图>] [--n 1]
 *   node --env-file=.env tools/asset-gen/gen.mjs scene   --name 店内 [--n 1]
 *   通用旗标: --model <id>  --size 1920x1080  --out <dir>  --dry-run(只打印 prompt,不花钱)
 * 产物:assets/_gen/ 下按 --out 分目录的 jpg(gitignored)。立绘为绿幕底 JPG,挑图后交 tools/asset-derive/derive.mjs 的
 * cutout() 抠成 1920×1080 透明 PNG,再按 docs/pack-switch.md 流程入包。
 * 请求参数名以方舟 images/generations 文档为准;不匹配时只改本文件顶部常量与 body 组装处。
 *
 * 2026-10-27 画风重定(用户裁决,参考 limelight/YuzuSoft 供体图):
 * - 立绘改半身胸像(常规 galgame 立绘形态),引擎满高渲染底对齐=人物顶天立地占满画面;
 * - 画风统一「干净明亮的日系大厂 galgame 风」,明令禁脏禁旧禁噪点;
 * - 场景保留昭和怀旧内容,但必须整洁精致,不许破败感。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";

const ARK_URL = "https://ark.cn-beijing.volces.com/api/v3/images/generations";
const DEFAULT_MODEL = "doubao-seedream-5-0-flash-260915"; // 以控制台「图像创作模型」页为准,--model 覆盖
const DEFAULT_SIZE = "1920x1080";
const DEFAULT_OUT = "assets/_gen";

/** 画风总纲(立绘):逐条对齐 limelight 供体图(YuzuSoft 2025)的可观测特征(2026-10-28 三修) */
const STYLE_CHAR =
  "modern Japanese visual novel character sprite, official 2020s galgame art, " +
  "extremely clean delicate THIN lineart, soft round cute face, " +
  "very large soft vertical eyes with big sparkling highlights taking up much of the face, tiny simplified dot nose, small glossy lips, " +
  "hair drawn in big flat glossy locks with one smooth shiny highlight band across the bangs, " +
  "flat cel shading with a single soft shadow tone per surface, vivid clean bright colors, " +
  "youthful adorable girl, natural relaxed pose with a slight head tilt, polished commercial quality, " +
  "strictly NOT retro: no 2000s anime style, no old-fashioned galgame look, no stiff symmetric front-facing mannequin pose, " +
  "no realism, no realistic shading, no painterly brushwork, no grime, no noise";

/** 画风总纲(场景):内容可以怀旧,画面必须干净精致、扁平动画面风 */
const STYLE_SCENE =
  "beautiful Japanese visual novel background art, professional galgame background style, " +
  "flat clean anime rendering, bright appealing colors, soft warm light, tidy and polished, " +
  "no grime, no dirt, no stains, no decay, no noise, no people, no text, no watermark, 16:9 wide shot, high quality";

/** 三位女主外貌规格(与 docs/dawn/characters.md 同源;改动须两边同步)。
 *  2026-10-28 五修:用户裁决「形象太普通没特点」——每人一个强记忆点:
 *  栞=姬发式+泪痣,灯里=胸前细辫+缎带,宵=细框圆眼镜+帽子不许戴上 */
const APPEARANCE = {
  shiori: {
    zh: "及腰黑长直发姬发式平刘海,额发侧边别一枚月白色月牙发卡,左眼下一颗小泪痣,深紫色大眼睛,深蓝色旧式便利店店员制服配深蓝围裙,袖口卷起,身形娇小约155cm,年龄不详看似高中生,神情平静优雅",
    en: "extremely long straight glossy black hair in a hime cut with blunt straight-cut bangs, a tiny silver crescent-moon hair clip pinned at the SIDE of her bangs near her ear (small hair accessory, NOT a moon), a small beauty mark (tear mole) under her left eye, large soft dark-violet eyes, deep navy vintage convenience-store staff uniform with navy apron, rolled-up sleeves, petite 155cm, ageless beautiful girl looking like a high schooler, calm composed elegant face",
  },
  akari: {
    zh: "浅棕色微卷长发,一条细麻花辫从左侧垂在胸前、辫尾系奶白色缎带,旧式圆顶学生帽配缎带,蜜棕色圆大眼睛,米白色连衣裙配奶油色针织开衫,约158cm,礼貌温柔,像从旧时代走来的少女",
    en: "light brown loosely-waved long hair with one thin side braid hanging over her chest, the braid's end tied with a small cream ribbon, vintage round school hat with ribbon, large round warm honey-brown eyes, plain beige one-piece dress with cream knit cardigan, 158cm, polite gentle ladylike, an adorable beautiful girl seemingly from another era",
  },
  yoi: {
    zh: "深紫色齐肩乱发,细银框圆形薄边眼镜,半睁的水晶紫倦眼,眼下淡淡阴影,过大的深灰色连帽卫衣帽子垂在背后绝不戴头上,腋下夹着写满字的笔记本,约170cm高挑,慵懒的作家气质",
    en: "messy dark-purple shoulder-length hair, thin round silver-rimmed reading glasses, tired half-lidded amethyst eyes with faint dark circles, oversized dark-grey hoodie with the hood DOWN resting on her back (never worn up), a handwriting-crammed notebook under her arm, tall 170cm, lazy cool-beautiful novelist vibe",
  },
};

/** 表情键 = 引擎 sprites 文件名(5 个固定中文词) */
const EXPR_EN = {
  平常: "calm neutral expression, standing straight, hands naturally at sides",
  微笑: "soft gentle closed-mouth smile, lips together, no teeth showing, kind warm eyes, relaxed shoulders",
  笑: "delighted happy smile, eyes closed in cheerful upward arcs, mouth small and dainty slightly open in a soft laugh, no wide-open mouth, no teeth showing, gentle and adorable",
  害羞: "blushing, shy, glancing slightly away, hands fidgeting",
  震惊: "shocked, eyes wide, frozen in place",
};

/** 立绘构图硬约束(2026-10-27 用户裁决:常规 galgame 半身立绘):
 *  引擎吃 1920×1080 全画布、满高渲染、底边对齐——半身像腰腹部落在底边,
 *  渲染出来即「人物上半身占满画面」的标准视觉小说效果。
 *  FRAMING 数值锚点句让同一角色各表情差分头身大小/位置一致(derive --normalize 再兜底)。
 *  背景仍用绿幕:近黑前景(黑发/深色服装)在键色距离法下全免疫 */
const FRAMING =
  "fixed consistent framing across all expressions of the same character: " +
  "top of head at about 4% from the canvas top edge, eyes at about 30% canvas height, " +
  "chin at about 42% canvas height, shoulders and chest in the lower half, waist cut by the bottom edge, " +
  "face centered on the vertical centerline of the canvas, same head size in every variation";
const COMPOSITION =
  "single character, bust-up shot, upper body only from waist up, " +
  "standing naturally with a slight relaxed head tilt, body angled a few degrees, NOT a stiff front-facing mannequin pose, " +
  "character fills most of the canvas, " +
  "solid flat pure chroma green background (#00ff00), evenly lit, no shadow, no gradient, no vignette on the background, " +
  `anime style, clean lineart, high quality, no text, no watermark, no logo. Fixed framing: ${FRAMING}. Style: ${STYLE_CHAR}`;

/** 场景清单(9 张,16:9;与 content 包 scenes/ 中文文件名一一对应)。内容可怀旧,画面必须干净 */
const SCENES = {
  店内:
    "retro Showa-era Japanese convenience store interior at night, spotless and well-maintained, warm clean fluorescent lighting, three tidy aisles of neatly stocked shelves, vintage cream-colored cash register on a clean counter, window counter seats, oden pot steaming softly, cozy nostalgic inviting mood",
  店门口:
    "small retro Japanese convenience store exterior at night, glowing clean glass automatic doors, bright tidy signboard with the number 24 crossed out and hand-written opening hours, quiet neat shopping street, warm light spilling onto clean pavement, inviting cozy mood",
  商店街雨夜:
    "Japanese shopping street in gentle night rain, wet clean asphalt beautifully reflecting warm street lamps and soft neon, neat closed shutters, a lone glowing vending machine, atmospheric cinematic mood",
  车站前:
    "small suburban Japanese train station square late at night, clean empty rotary, dim warm station lights, tidy vending machines, no crowds, still and quiet peaceful mood",
  里间:
    "small tidy back storage room of a retro Japanese convenience store, neat stacks of cardboard boxes, a wooden abacus and paper ledgers on a clean desk, single warm bulb, cozy and organized",
  街心公园:
    "small neighborhood park just before dawn, swing set and bench under a single warm lamp, dew glistening on green grass, deep blue night sky with fading stars, serene beautiful mood",
  河堤:
    "grassy Japanese river embankment just before dawn, wide calm river reflecting the first pale golden light, distant city glow on the horizon, long clean walking path, serene wistful beautiful mood",
  主角房间:
    "small cozy Japanese student apartment room late at night, softly unmade bed, desk with a warm glowing laptop, instant noodle cup, warm desk lamp, curtains half open with soft street light leaking in, lived-in but clean and comfortable",
  黎明的街:
    "quiet Japanese shopping street at first light of dawn, beautiful sky gradient from deep blue to pale golden orange, warm street lamps still on, neat closed shutters, calm hopeful transitional mood",
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

/** 脸部质量硬约束(2026-10-28 用户裁决:差分脸崩=两眼不对称) */
const FACE =
  "perfectly symmetrical cute face, both eyes identical in size, shape and height, mouth centered, " +
  "clean undistorted facial features, correct anatomy";

function spritePrompt(charId, expr) {
  const a = APPEARANCE[charId];
  if (!a) die(`未知角色「${charId}」,可选:${Object.keys(APPEARANCE).join(" / ")}`);
  const e = EXPR_EN[expr] ?? `${expr} expression`;
  return `visual novel character sprite, bust-up. Appearance: ${a.en}. ${a.zh}. Expression: ${e}. ${FACE}. Composition: ${COMPOSITION}`;
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
    prompt: `${desc}. ${STYLE_SCENE}`,
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
