/**
 * 内容包纯校验器(P1-M1):只吃 ScannedFile 列表,不碰 fs —— 可单测。
 * cli.mjs 负责扫描与 gray-matter,这里负责全部规则与报错(中文 detail)。
 */
import type { WorldBookEntry } from "./types.ts";

/** 资产后缀白名单(plan §2.8) */
const IMAGE_EXT = new Set(["jpg", "jpeg", "png", "webp"]);
const AUDIO_EXT = new Set(["m4a", "mp3", "ogg", "wav"]);

export type ScannedKind = "card" | "sprite" | "scene" | "bgm" | "md" | "voice";

export interface ScannedFile {
  /** posix 相对 content 根,如 "characters/enagi/card.md" */
  path: string;
  kind: ScannedKind;
  /** md 文本(card/worldbook/outline/note),二进制资产无 */
  text?: string;
  /** card.md 已解析的 frontmatter(gray-matter data) */
  data?: Record<string, unknown>;
}

export type IssueCode =
  | "MISSING_CARD"
  | "BAD_FRONTMATTER"
  | "DANGLING_DEFAULT_EXPR"
  | "MISSING_SPRITE_FILE"
  | "DUP_ID"
  | "BAD_ID_CHARSET"
  | "BAD_ASSET_EXT"
  | "MISSING_OUTLINE"
  | "BAD_WORLDBOOK";

export interface ValidationIssue {
  severity: "error" | "warn";
  code: IssueCode;
  path: string;
  detail: string;
}

export interface WorldbookParseResult {
  entries: WorldBookEntry[];
  issues: ValidationIssue[];
}

const CHAR_ID_RE = /^[a-z0-9_-]+$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

const extOf = (p: string): string => {
  const base = p.split("/").pop() ?? p;
  const dot = base.lastIndexOf(".");
  return dot < 0 ? "" : base.slice(dot + 1).toLowerCase();
};
const baseName = (p: string): string => p.split("/").pop() ?? p;
const stemOf = (p: string): string => {
  const base = baseName(p);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? base : base.slice(0, dot);
};

/**
 * 世界书 md 格式:## 标题 + 元信息行(keys:/priority:)+ --- + 正文。
 * 条目缺 keys 或正文 → issue(不进 entries)。
 */
export function parseWorldbookMd(md: string, path = "story/worldbook.md"): WorldbookParseResult {
  const entries: WorldBookEntry[] = [];
  const issues: ValidationIssue[] = [];
  const normalized = md.replace(/\r\n?/g, "\n");
  const blocks = normalized.split(/^## /m).slice(1); // 首段(标题前内容)丢弃
  blocks.forEach((block, i) => {
    const eol = block.indexOf("\n");
    const title = (eol < 0 ? block : block.slice(0, eol)).trim();
    const body = eol < 0 ? "" : block.slice(eol + 1);
    const dash = body.indexOf("\n---\n");
    const metaPart = dash < 0 ? body : body.slice(0, dash);
    let content = dash < 0 ? "" : body.slice(dash + 5);
    let keys: string[] = [];
    let priority = 5;
    for (const line of metaPart.split("\n")) {
      const t = line.trim();
      if (t.startsWith("keys:")) {
        keys = t
          .slice(5)
          .split(/[,、,]/)
          .map((k) => k.trim())
          .filter(Boolean);
      } else if (t.startsWith("priority:")) {
        const n = Number.parseInt(t.slice(9).trim(), 10);
        if (Number.isFinite(n)) priority = n;
      }
    }
    content = content.trim();
    const id = `${i + 1}-${title || "untitled"}`;
    if (keys.length === 0 || content === "") {
      issues.push({
        severity: "error",
        code: "BAD_WORLDBOOK",
        path,
        detail: `条目「${title}」${keys.length === 0 ? "缺 keys" : ""}${keys.length === 0 && content === "" ? "且" : ""}${content === "" ? "缺正文" : ""}(格式:## 标题 + keys:/priority: + --- + 正文)`,
      });
      return;
    }
    entries.push({ id, keys, content, priority, enabled: true });
  });
  if (blocks.length === 0 && normalized.trim() !== "") {
    issues.push({ severity: "error", code: "BAD_WORLDBOOK", path, detail: "未找到任何「## 标题」条目" });
  }
  return { entries, issues };
}

/** 全量校验。同一条规则重复触发只报第一条,防刷屏。 */
export function validateContent(files: readonly ScannedFile[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const byPath = new Map(files.map((f) => [f.path, f]));

  // ---- 角色目录 ----
  const charDirs = new Set(
    files
      .filter((f) => f.path.startsWith("characters/"))
      .map((f) => f.path.split("/")[1])
      .filter((d): d is string => Boolean(d)),
  );
  const seenCharIds = new Set<string>();
  for (const dir of charDirs) {
    const dirPath = `characters/${dir}`;
    const card = byPath.get(`${dirPath}/card.md`);
    if (!CHAR_ID_RE.test(dir)) {
      issues.push({ severity: "error", code: "BAD_ID_CHARSET", path: dirPath, detail: `角色目录名「${dir}」仅限 [a-z0-9_-]` });
      continue;
    }
    if (seenCharIds.has(dir)) continue; // Set 已去重,防御
    seenCharIds.add(dir);
    if (!card || !card.text) {
      issues.push({ severity: "error", code: "MISSING_CARD", path: dirPath, detail: "缺 card.md(性格设定原文,注入 prompt 用)" });
      continue;
    }
    // frontmatter:name/color 必填;defaultExpr 必须落在 sprites 集
    const data = card.data ?? {};
    const nameOk = typeof data.name === "string" && data.name.trim() !== "";
    const colorOk = typeof data.color === "string" && COLOR_RE.test(data.color);
    if (!nameOk || !colorOk) {
      issues.push({
        severity: "error",
        code: "BAD_FRONTMATTER",
        path: card.path,
        detail: `${nameOk ? "" : "缺 name "}${colorOk ? "" : "或 color 非法(#rrggbb)"}`.trim(),
      });
    }
    const sprites = new Set(
      files
        .filter((f) => f.kind === "sprite" && f.path.startsWith(`${dirPath}/`) && IMAGE_EXT.has(extOf(f.path)))
        .map((f) => stemOf(f.path)),
    );
    // 无立绘角色(如主人公)忽略 defaultExpr;有立绘时必须落在 sprites 集
    const defaultExpr = typeof data.defaultExpr === "string" ? data.defaultExpr : "";
    if (defaultExpr !== "" && sprites.size > 0 && !sprites.has(defaultExpr)) {
      issues.push({
        severity: "error",
        code: "DANGLING_DEFAULT_EXPR",
        path: card.path,
        detail: `defaultExpr「${defaultExpr}」不在该角色 sprites 集(${[...sprites].join("|") || "无"})`,
      });
    }
    // 有图片形态文件但无一通过白名单 → 立绘实际缺失(雪鷹类无立绘角色不受影响)
    const dirFiles = files.filter((f) => f.path.startsWith(`${dirPath}/`) && f.kind !== "card" && f.kind !== "md" && f.kind !== "voice");
    const badExt = dirFiles.filter((f) => !IMAGE_EXT.has(extOf(f.path)));
    if (dirFiles.length > 0 && sprites.size === 0 && badExt.length > 0) {
      issues.push({
        severity: "error",
        code: "MISSING_SPRITE_FILE",
        path: dirPath,
        detail: `有疑似立绘文件但扩展名全部非法(白名单:${[...IMAGE_EXT].join("/")}),如 ${baseName(badExt[0]!.path)}`,
      });
    }
  }
  // 白名单外资产
  for (const f of files) {
    if (f.kind === "card" || f.kind === "md") continue;
    const ext = extOf(f.path);
    if (f.kind === "sprite" || f.kind === "scene") {
      if (!IMAGE_EXT.has(ext)) issues.push({ severity: "error", code: "BAD_ASSET_EXT", path: f.path, detail: `扩展名「${ext}」不在白名单(${[...IMAGE_EXT].join("/")})` });
    } else if (f.kind === "bgm" || f.kind === "voice") {
      if (!AUDIO_EXT.has(ext)) issues.push({ severity: "error", code: "BAD_ASSET_EXT", path: f.path, detail: `扩展名「${ext}」不在白名单(${[...AUDIO_EXT].join("/")})` });
    }
  }

  // ---- 场景/BGM 重名 id(跨子目录同名以先出现者为准)----
  const checkDup = (kind: ScannedKind, label: string) => {
    const seen = new Map<string, string>();
    for (const f of files) {
      if (f.kind !== kind) continue;
      const id = stemOf(f.path);
      const prev = seen.get(id);
      if (prev !== undefined) {
        issues.push({ severity: "error", code: "DUP_ID", path: f.path, detail: `${label} id「${id}」与 ${prev} 重名` });
      } else {
        seen.set(id, f.path);
      }
    }
  };
  checkDup("scene", "场景");
  checkDup("bgm", "BGM");

  // ---- story ----
  if (!byPath.get("story/outline.md")?.text) {
    issues.push({ severity: "warn", code: "MISSING_OUTLINE", path: "story/", detail: "缺 story/outline.md(导演节拍骨架;可后补)" });
  }
  const wb = byPath.get("story/worldbook.md");
  if (wb?.text) {
    const { issues: wbIssues } = parseWorldbookMd(wb.text, wb.path);
    issues.push(...wbIssues);
  }
  return issues;
}
