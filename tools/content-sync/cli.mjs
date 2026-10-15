#!/usr/bin/env node
/**
 * content-sync(P1-M1):内容包扫描 → 校验 → manifest 产出 → 资产派生拷贝。
 *
 * 用法:
 *   node tools/content-sync/cli.mjs           # 构建 OSS 占位包(content/ → manifest.json)
 *   node tools/content-sync/cli.mjs --local   # 额外构建本地包(content-local/ → manifest.local.json)
 *   node tools/content-sync/cli.mjs --check   # 只校验不写(CI)
 *
 * 产出:
 *   content/manifest.json           OSS 包 manifest(入库)
 *   content/manifest.local.json     本地包 manifest(gitignored)
 *   packages/app/public/content/    两份 manifest + OSS 资产(dev/构建由 vite 服务)
 *   packages/app/public/local/      本地包资产副本(gitignored;立绘/场景/BGM)
 *
 * 红线:本脚本之外任何 packages/ 代码不得出现资源路径硬编码;资源引用只走 manifest。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { copyFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import matter from "gray-matter";
// 直连 shared 源文件(validate.ts 无运行时依赖):tools/ 不是 workspace 包,不能用 @gal/shared 包名
import { parseWorldbookMd, validateContent } from "../../packages/shared/src/content/validate.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CONTENT_DIR = path.join(ROOT, "content");
const CONTENT_LOCAL_DIR = path.join(ROOT, "content-local");
const PUBLIC_DIR = path.join(ROOT, "packages/app/public");

const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const AUDIO_EXT = new Set([".m4a", ".mp3", ".ogg", ".wav"]);
const args = new Set(process.argv.slice(2));
const CHECK_ONLY = args.has("--check");
const WITH_LOCAL = args.has("--local");

/** 递归收集相对路径(posix 分隔) */
function walk(dir, prefix = "") {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    const abs = path.join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(abs).isDirectory()) out.push(...walk(abs, rel));
    else out.push(rel);
  }
  return out;
}

/** 相对路径 → ScannedFile 分类(与 shared/validate.ts 的 kind 约定一致) */
function classify(rel) {
  const ext = path.extname(rel).toLowerCase();
  if (rel.startsWith("characters/")) {
    const rest = rel.slice("characters/".length);
    const segments = rest.split("/");
    if (segments.length === 2 && segments[1] === "card.md") return "card";
    if (segments.length === 3 && segments[1] === "voice") return "voice";
    if (segments.length === 2 && IMAGE_EXT.has(ext)) return "sprite";
    return "md";
  }
  if (rel.startsWith("scenes/") && IMAGE_EXT.has(ext)) return "scene";
  if (rel.startsWith("bgm/") && AUDIO_EXT.has(ext)) return "bgm";
  return "md";
}

/** 扫描 + 解析 frontmatter → { files, errors } */
function scanPack(dir) {
  const files = [];
  for (const rel of walk(dir)) {
    const abs = path.join(dir, rel);
    const kind = classify(rel);
    const f = { path: rel, kind };
    if (kind === "card" || kind === "md") {
      const raw = readFileSync(abs, "utf8");
      if (kind === "card") {
        const parsed = matter(raw);
        f.text = parsed.content;
        f.data = parsed.data;
      } else {
        f.text = raw;
      }
    }
    files.push(f);
  }
  return files;
}

/** 组装 manifest(纯数据;URL 预 encode,消费者不得二次 encode) */
function buildManifest(dir, files, voiceMap) {
  const characters = {};
  const scenes = {};
  const bgm = {};
  let outlineMd = "";
  let worldBook = [];
  // encodeURI 不转义 # 与 [];manifest 存预编码 URL,消费者不得二次 encode
  const urlOf = (rel) =>
    encodeURI(`${urlPrefix(dir)}/${rel}`)
      .replace(/#/g, "%23")
      .replace(/\[/g, "%5B")
      .replace(/\]/g, "%5D");

  const voiceCfg = voiceMap?.voice;
  for (const f of files) {
    if (f.kind === "card") {
      const charId = f.path.split("/")[1];
      const data = f.data ?? {};
      const sprites = {};
      for (const s of files) {
        if (s.kind === "sprite" && s.path.startsWith(`characters/${charId}/`)) {
          sprites[path.basename(s.path, path.extname(s.path))] = urlOf(s.path);
        }
      }
      characters[charId] = {
        id: charId,
        displayName: String(data.name ?? charId),
        color: String(data.color ?? "#888888"),
        defaultExpr: String(data.defaultExpr ?? Object.keys(sprites)[0] ?? ""),
        sprites,
        ...(voiceCfg?.characters?.includes(charId)
          ? { voice: { ...voiceCfg.shared, ...(voiceCfg.overrides?.[charId] ?? {}) } }
          : {}),
        cardMd: f.text ?? "",
      };
    } else if (f.kind === "scene") {
      const id = path.basename(f.path, path.extname(f.path));
      scenes[id] = { id, image: urlOf(f.path) };
    } else if (f.kind === "bgm") {
      const id = path.basename(f.path, path.extname(f.path));
      bgm[id] = { id, path: urlOf(f.path) };
    } else if (f.path === "story/outline.md") {
      outlineMd = f.text ?? "";
    } else if (f.path === "story/worldbook.md" && f.text) {
      const parsed = parseWorldbookMd(f.text, f.path);
      worldBook = parsed.entries;
    }
  }
  return { version: 1, characters, scenes, bgm, story: { outlineMd, worldBook } };
}

function urlPrefix(dir) {
  return dir === CONTENT_LOCAL_DIR ? "/local" : "/content";
}

/** 资产副本:OSS → public/content/,本地 → public/local/ */
function copyAssets(dir, files) {
  const destRoot = dir === CONTENT_LOCAL_DIR ? path.join(PUBLIC_DIR, "local") : path.join(PUBLIC_DIR, "content");
  let n = 0;
  for (const f of files) {
    if (f.kind === "card" || f.kind === "md") continue;
    const src = path.join(dir, f.path);
    const dest = path.join(destRoot, f.path);
    mkdirSync(path.dirname(dest), { recursive: true });
    copyFileSync(src, dest);
    n++;
  }
  return n;
}

/** donor 拷贝:assets-map.json 的 copy 指令(content-local 树自举) */
function applyDonorCopy(map) {
  for (const directive of map.copy ?? []) {
    const from = path.join(ROOT, directive.from);
    const to = path.join(CONTENT_LOCAL_DIR, directive.to);
    if (!existsSync(from)) {
      console.error(`[content-sync] donor 路径不存在: ${directive.from}`);
      process.exit(2);
    }
    mkdirSync(to, { recursive: true });
    const rename = directive.rename ?? {};
    for (const name of readdirSync(from)) {
      if (path.extname(name).toLowerCase() !== directive.ext) continue;
      const target = rename[name] ?? name;
      copyFileSync(path.join(from, name), path.join(to, target));
    }
  }
}

function buildPack(label, dir, voiceMap) {
  const files = scanPack(dir);
  const issues = validateContent(files);
  const errors = issues.filter((i) => i.severity === "error");
  for (const i of issues) {
    const tag = i.severity === "error" ? "错误" : "警告 ";
    console.log(`[content-sync] ${label} ${tag} ${i.code} @ ${i.path}: ${i.detail}`);
  }
  if (errors.length > 0) {
    console.error(`[content-sync] ${label} 校验失败:${errors.length} 个错误,中止。`);
    process.exit(2);
  }
  return { manifest: buildManifest(dir, files, voiceMap), files };
}

function writeJson(file, data) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

// ---- 主流程 ----
if (!existsSync(CONTENT_DIR)) {
  console.error("[content-sync] content/ 不存在——仓库不完整?");
  process.exit(2);
}

let voiceMap = null;
if (WITH_LOCAL) {
  const mapPath = path.join(CONTENT_LOCAL_DIR, "assets-map.json");
  if (!existsSync(CONTENT_LOCAL_DIR) || !existsSync(mapPath)) {
    // OSS 克隆没有本地包:告警降级,只构建 OSS 包(风险#10:不失败)
    console.log("[content-sync] --local:无 content-local/assets-map.json,跳过本地包(仅构建 OSS 包)");
  } else {
    voiceMap = JSON.parse(readFileSync(mapPath, "utf8"));
    applyDonorCopy(voiceMap);
  }
}

const base = buildPack("OSS包", CONTENT_DIR);
let local = null;
if (WITH_LOCAL) local = buildPack("本地包", CONTENT_LOCAL_DIR, voiceMap);

if (!CHECK_ONLY) {
  writeJson(path.join(CONTENT_DIR, "manifest.json"), base.manifest);
  writeJson(path.join(PUBLIC_DIR, "content/manifest.json"), base.manifest);
  const copiedBase = copyAssets(CONTENT_DIR, base.files);
  console.log(`[content-sync] OSS包: ${Object.keys(base.manifest.characters).length} 角色 / ${Object.keys(base.manifest.scenes).length} 场景 / ${Object.keys(base.manifest.bgm).length} BGM;资产副本 ${copiedBase} 个`);
  if (local) {
    writeJson(path.join(CONTENT_DIR, "manifest.local.json"), local.manifest);
    writeJson(path.join(PUBLIC_DIR, "content/manifest.local.json"), local.manifest);
    const copiedLocal = copyAssets(CONTENT_LOCAL_DIR, local.files);
    console.log(`[content-sync] 本地包: ${Object.keys(local.manifest.characters).length} 角色 / ${Object.keys(local.manifest.scenes).length} 场景 / ${Object.keys(local.manifest.bgm).length} BGM;资产副本 ${copiedLocal} 个`);
  }
  console.log("[content-sync] 完成。");
}
