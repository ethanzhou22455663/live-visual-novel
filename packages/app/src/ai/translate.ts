/**
 * 字幕翻译(app 层,完全非核心;2026-10-18 裁决:translate 剥离出引擎,核心零侵入):
 * 把未译的日文 say/narrate 及选项按钮/prompt 译成简体中文。触发=bootstrap 的
 * line:commit 预取泵(2026-10-28:行提交即入队合批翻译,玩家读到时中文已就位;
 * 原先挂 segment:done 段收束,中文会忽明忽暗)。经 EngineCore.attachTranslations /
 * attachChoiceLabels 回写 ledger。直用 LlmClient 端口(与剧情共用 DeepSeek 连接);
 * 失败/缺行静默放弃——翻译永远不阻塞剧情显示,无译文回退原文。
 */
import type { LlmClient } from "@gal/director";

export interface TranslateItem {
  lineId: string;
  /** 日文原文 */
  text: string;
}

export interface TranslatorDeps {
  llm: LlmClient;
  apiKey: string;
  baseUrl?: string;
  model?: string;
  onError?: (err: unknown) => void;
}

const SYSTEM = [
  "You are a subtitle translator for a Japanese visual novel.",
  "Translate each Japanese line into natural, colloquial Simplified Chinese, keeping each character's tone.",
  "Do not add notes or explanations.",
  'Output ONLY JSON: {"translations":[{"lineId":"<id>","zh":"<译文>"}, ...]} with one entry per input line, same lineId.',
].join(" ");

/** 单次请求的行数上限(输出 token 红线:20 行 ≈ 1k 中文字,远低于截断风险) */
const CHUNK = 20;

export function createTranslator(deps: TranslatorDeps): (items: readonly TranslateItem[]) => Promise<Map<string, string>> {
  const call = async (items: readonly TranslateItem[]): Promise<Map<string, string>> => {
    const out = new Map<string, string>();
    const raw = await deps.llm.chatOnce({
      apiKey: deps.apiKey,
      baseUrl: deps.baseUrl,
      model: deps.model,
      messages: [
        { role: "system", content: SYSTEM },
        {
          role: "user",
          content: JSON.stringify({ lines: items.map((i) => ({ lineId: i.lineId, ja: i.text })) }),
        },
      ],
      temperature: 0.3,
      maxTokens: 2000,
      responseFormat: { type: "json_object" },
      timeoutMs: 30_000,
    });
    let obj: unknown;
    try {
      obj = JSON.parse(raw);
    } catch {
      deps.onError?.(`翻译输出非 JSON:${raw.slice(0, 80)}`);
      return out;
    }
    const list = (obj as { translations?: unknown } | null)?.translations;
    if (!Array.isArray(list)) {
      deps.onError?.("翻译输出缺 translations 数组");
      return out;
    }
    for (const e of list) {
      const lineId = (e as { lineId?: unknown } | null)?.lineId;
      const zh = (e as { zh?: unknown } | null)?.zh;
      if (typeof lineId === "string" && typeof zh === "string" && zh.trim().length > 0) out.set(lineId, zh);
    }
    return out;
  };

  return async (items) => {
    const out = new Map<string, string>();
    for (let i = 0; i < items.length; i += CHUNK) {
      try {
        const part = await call(items.slice(i, i + CHUNK));
        for (const [k, v] of part) out.set(k, v);
      } catch (e) {
        deps.onError?.(e); // 静默放弃本段余下翻译:缺行回退原文,不阻塞任何东西
        break;
      }
    }
    return out;
  };
}
