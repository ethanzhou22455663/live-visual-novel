/**
 * 摘要器(ai-calls §3 调用③):非流式 json_object、temp 0.3、失败重试 ×1 后抛出。
 * **绝不阻塞游戏**——调用方(BeatRunner)catch 后沿用旧摘要。
 * 合并为层级摘要:旧摘要 + 自 summarizedThroughLineId 以来的新增行。
 */
import { ModelSummarySchema } from "@gal/shared";
import type { HistoryItem, Summary } from "@gal/shared";
import type { LlmClient } from "../llm/client.ts";
import { LlmHttpError } from "../llm/deepseek.ts";
import { withRetries } from "../llm/retry.ts";
import { renderHistory } from "./history.ts";

export interface SummarizerOptions {
  llm: LlmClient;
  apiKey: string;
  baseUrl?: string;
  model?: string;
  /** 层级合并后旧摘要被压缩的提示上限(字符) */
  maxFactsChars?: number;
}

export class Summarizer {
  #opts: SummarizerOptions;

  constructor(opts: SummarizerOptions) {
    this.#opts = opts;
  }

  /**
   * LLM 输出宽松归一化(2026-10-18 手验:DeepSeek 常把 threads 输出成字符串数组、
   * charUpdates 值输出成对象——直接 schema 校验必挂,摘要永败)。先规整再校验。
   */
  #normalize(obj: unknown): unknown {
    const o = (obj ?? {}) as Record<string, unknown>;
    const threads = Array.isArray(o.threads)
      ? o.threads.map((t, i) => (typeof t === "string" ? { id: `t${i + 1}`, title: t, status: "open" } : t))
      : [];
    const charUpdates: Record<string, string> = {};
    for (const [k, v] of Object.entries((o.charUpdates ?? {}) as Record<string, unknown>)) {
      charUpdates[k] = typeof v === "string" ? v : JSON.stringify(v);
    }
    return { facts: typeof o.facts === "string" ? o.facts : "", charUpdates, threads };
  }

  async summarize(req: {
    old: Summary;
    items: readonly HistoryItem[];
    throughLineId: string;
    names?: Record<string, string>;
    signal?: AbortSignal;
  }): Promise<Summary> {
    const user = [
      `【旧摘要】${JSON.stringify({
        facts: req.old.facts,
        charUpdates: req.old.charUpdates,
        threads: req.old.threads,
      })}`,
      `【新增事件】${renderHistory(req.items, 40, 4000, req.names ?? {}) || "(なし)"}`,
      `【任务】合并为新的摘要 JSON。结构严格如下(threads 是对象数组,不是字符串):{"facts":"≤400字の総述","charUpdates":{"<charId>":"変化の記録テキスト"},"threads":[{"id":"t1","title":"未決の伏線","status":"open"}]}。只输出 JSON。`,
    ].join("\n\n");

    const raw = await withRetries(
      () =>
        this.#opts.llm.chatOnce({
          apiKey: this.#opts.apiKey,
          baseUrl: this.#opts.baseUrl,
          model: this.#opts.model,
          messages: [
            { role: "system", content: "你是视觉小说的剧情摘要器。输入是旧摘要与新增事件,输出合并后的摘要 JSON 对象。" },
            { role: "user", content: user },
          ],
          temperature: 0.3,
          maxTokens: 700,
          responseFormat: { type: "json_object" },
          timeoutMs: 30_000,
          signal: req.signal,
        }),
      { retries: 1, baseMs: 600 },
    );

    let obj: unknown;
    try {
      obj = JSON.parse(raw);
    } catch {
      throw new LlmHttpError(502, `summarize 返回非 JSON:${raw.slice(0, 120)}`);
    }
    const parsed = ModelSummarySchema.safeParse(this.#normalize(obj));
    if (!parsed.success) {
      throw new Error(`summarize schema 不合:${JSON.stringify(parsed.error.issues).slice(0, 300)}`);
    }
    const maxFacts = this.#opts.maxFactsChars ?? 600;
    return {
      facts: parsed.data.facts.slice(0, maxFacts),
      charUpdates: parsed.data.charUpdates,
      threads: parsed.data.threads.slice(0, 12),
      summarizedThroughLineId: req.throughLineId,
    };
  }
}
