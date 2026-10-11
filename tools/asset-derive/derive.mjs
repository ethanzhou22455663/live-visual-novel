// 素材加工：黑底立绘 JPG → 真·透明 PNG；场景 JPG → 水印修补。
// 仅本地测试用（原素材有版权，产物同样不得公开）。
import sharp from "sharp";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = (...p) => path.join(ROOT, "assets", ...p);
const OUT = (...p) => path.join(ROOT, "mock", "assets", ...p);

const W = 1920, H = 1080, N = W * H;
const EXPRS = ["平常", "微笑", "笑", "害羞", "震惊"];
const SCENES = ["商场", "大街", "居民区", "学校", "教室", "走廊", "球场", "男生房间", "女生房间"];

/** 4-连通域标记。返回 labels 与每块面积。 */
function components(mask) {
  const labels = new Int32Array(N).fill(-1);
  const sizes = [];
  const stack = new Int32Array(N);
  let cur = 0;
  for (let s = 0; s < N; s++) {
    if (!mask[s] || labels[s] !== -1) continue;
    let sp = 0, size = 0;
    stack[sp++] = s; labels[s] = cur;
    while (sp > 0) {
      const p = stack[--sp]; size++;
      const x = p % W;
      if (x > 0 && mask[p - 1] && labels[p - 1] === -1) { labels[p - 1] = cur; stack[sp++] = p - 1; }
      if (x < W - 1 && mask[p + 1] && labels[p + 1] === -1) { labels[p + 1] = cur; stack[sp++] = p + 1; }
      if (p >= W && mask[p - W] && labels[p - W] === -1) { labels[p - W] = cur; stack[sp++] = p - W; }
      if (p < N - W && mask[p + W] && labels[p + W] === -1) { labels[p + W] = cur; stack[sp++] = p + W; }
    }
    sizes.push(size); cur++;
  }
  return { labels, sizes };
}

/** 3×3 盒滤波（alpha 羽化用）。 */
function blur3(a) {
  const t = new Float32Array(N), o = new Uint8ClampedArray(N);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    const l = x > 0 ? a[i - 1] : a[i], r = x < W - 1 ? a[i + 1] : a[i];
    t[i] = (l + 2 * a[i] + r) / 4;
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    const u = y > 0 ? t[i - W] : t[i], d = y < H - 1 ? t[i + W] : t[i];
    o[i] = (u + 2 * t[i] + d) / 4;
  }
  return o;
}

async function cutout(n, expr) {
  const { data } = await sharp(SRC(String(n), `${expr}.jpg`)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

  // ① 近黑像素为背景候选
  const dark = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const j = i * 4;
    dark[i] = Math.max(data[j], data[j + 1], data[j + 2]) < 30 ? 1 : 0;
  }
  // ② 只有接触画面边缘的黑色连通域才算背景（角色身上的深色内部不相连 → 保留）
  const { labels: dl, sizes: dsz } = components(dark);
  const border = new Set();
  for (let x = 0; x < W; x++) { if (dark[x]) border.add(dl[x]); if (dark[(H - 1) * W + x]) border.add(dl[(H - 1) * W + x]); }
  for (let y = 0; y < H; y++) { if (dark[y * W]) border.add(dl[y * W]); if (dark[y * W + W - 1]) border.add(dl[y * W + W - 1]); }
  const bg = new Uint8Array(N);
  for (let i = 0; i < N; i++) bg[i] = dark[i] && border.has(dl[i]) ? 1 : 0;

  // ③ 贴着背景的暗色边缘像素并入背景（JPEG 压缩产生的暗晕），两轮
  for (let pass = 0; pass < 2; pass++) {
    const fold = [];
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      if (bg[i]) continue;
      const j = i * 4;
      if (Math.max(data[j], data[j + 1], data[j + 2]) >= 45) continue;
      if (bg[i - 1] || bg[i + 1] || bg[i - W] || bg[i + W]) fold.push(i);
    }
    for (const i of fold) bg[i] = 1;
  }

  // ④ 前景连通域：丢弃小岛（水印文字、右下按钮都是黑底上的孤立亮块）
  const fg = new Uint8Array(N);
  for (let i = 0; i < N; i++) fg[i] = bg[i] ? 0 : 1;
  const { labels: fl, sizes: fsz } = components(fg);
  let maxSz = 0; for (const s of fsz) if (s > maxSz) maxSz = s;
  const keep = new Uint8Array(fsz.length);
  let dropped = 0;
  for (let k = 0; k < fsz.length; k++) if (fsz[k] > maxSz * 0.02) keep[k] = 1; else dropped += fsz[k];

  // ⑤ alpha + 1px 羽化 + 黑底去污染（观测色 = 前景色×alpha → 前景色 = 观测色/alpha）
  const alpha = new Uint8ClampedArray(N);
  for (let i = 0; i < N; i++) alpha[i] = fg[i] && keep[fl[i]] ? 255 : 0;
  const soft = blur3(alpha);
  const out = Buffer.alloc(N * 4);
  for (let i = 0; i < N; i++) {
    const a = soft[i], j = i * 4;
    if (a === 0) continue;
    let r = data[j], g = data[j + 1], b = data[j + 2];
    if (a < 250) {
      const f = 255 / Math.max(a, 40);
      r = Math.min(255, r * f); g = Math.min(255, g * f); b = Math.min(255, b * f);
    }
    out[j] = r; out[j + 1] = g; out[j + 2] = b; out[j + 3] = a;
  }
  await sharp(out, { raw: { width: W, height: H, channels: 4 } })
    .png({ compressionLevel: 6 }).toFile(OUT(String(n), `${expr}.png`));
  console.log(`  ${n}/${expr}: 主体 ${maxSz}px, 去除碎片 ${dropped}px`);
}

/** 场景图水印修补：镜像贴片覆盖 + 区域强模糊。 */
async function patchBg(name) {
  const { data } = await sharp(SRC("场景", `${name}.jpg`)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const regions = [
    { x0: 1700, y0: 0, y1: 105, dir: "down" },   // 右上 logo
    { x0: 0, x1: 680, y0: 1025, y1: 1080, dir: "up" },   // 左下版权行
    { x0: 1490, x1: 1920, y0: 1000, y1: 1080, dir: "up" }, // 右下按钮
  ];
  for (const r of regions) {
    const x1 = r.x1 ?? W;
    const h = r.y1 - r.y0;
    for (let y = r.y0; y < r.y1; y++) {
      const srcY = r.dir === "down" ? 2 * r.y1 - 1 - y : 2 * r.y0 - 1 - y;
      for (let x = r.x0; x < x1; x++) {
        const d = (y * W + x) * 4, s = (srcY * W + x) * 4;
        data[d] = data[s]; data[d + 1] = data[s + 1]; data[d + 2] = data[s + 2];
      }
    }
    const w = x1 - r.x0;
    const { data: reg } = await sharp(data, { raw: { width: W, height: H, channels: 4 } })
      .extract({ left: r.x0, top: r.y0, width: w, height: h }).blur(10).raw().toBuffer({ resolveWithObject: true });
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const d = ((r.y0 + y) * W + (r.x0 + x)) * 4, s = (y * w + x) * 4;
      data[d] = reg[s]; data[d + 1] = reg[s + 1]; data[d + 2] = reg[s + 2];
    }
  }
  await sharp(data, { raw: { width: W, height: H, channels: 4 } })
    .jpeg({ quality: 90 }).toFile(OUT("场景", `${name}.jpg`));
  console.log(`  场景/${name}: 修补 3 处`);
}

for (const d of ["1", "2", "3", "场景"]) fs.mkdirSync(OUT(d), { recursive: true });
console.log("立绘抠图:");
for (let n = 1; n <= 3; n++)
  for (const e of EXPRS)
    if (fs.existsSync(SRC(String(n), `${e}.jpg`))) await cutout(n, e);
console.log("场景修补:");
for (const s of SCENES) await patchBg(s);
console.log("完成 → mock/assets/");
