/**
 * OpenAI 兼容 chat/completions 客户端(手写 fetch + SSE,plan §1.3 裁决:
 * 不引 AI SDK——自定义 NDJSON 行协议 + 换/加端点零成本)。
 * DeepSeek/GLM/Qwen 同形可换;dev 期 baseUrl 走 "/llm"(Vite proxy 注入 key)。
 * LlmHttpError 带 status:retry.ts 据此判 429/5xx。
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface StreamChatOptions {
  apiKey: string;
  messages: ChatMessage[];
  baseUrl?: string; // 默认 https://api.deepseek.com;dev 传 "/llm" 经 proxy
  model?: string; // 默认 deepseek-chat
  temperature?: number;
  maxTokens?: number;
  responseFormat?: { type: "json_object" };
  signal?: AbortSignal;
}

export class LlmHttpError extends Error {
  readonly status: number;

  constructor(status: number, body: string) {
    super(`LLM HTTP ${status}: ${body.slice(0, 300)}`);
    this.status = status;
    this.name = "LlmHttpError";
  }
}

export type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

interface InternalOptions extends StreamChatOptions {
  fetchImpl?: FetchImpl;
}

function buildRequest(o: InternalOptions, stream: boolean): { url: string; init: RequestInit } {
  // dev 期 apiKey 传空串:Vite proxy 注入真实 Authorization(浏览器永远拿不到 key)
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (o.apiKey) headers.authorization = `Bearer ${o.apiKey}`;
  return {
    url: `${o.baseUrl ?? "https://api.deepseek.com"}/chat/completions`,
    init: {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: o.model ?? "deepseek-chat",
        messages: o.messages,
        stream,
        temperature: o.temperature,
        max_tokens: o.maxTokens,
        ...(o.responseFormat ? { response_format: o.responseFormat } : {}),
      }),
      signal: o.signal,
    },
  };
}

/** 非流式(导演 nextBeat / 摘要 summarize):整段返回 assistant 文本 */
export async function chatOnce(o: InternalOptions & { timeoutMs?: number }): Promise<string> {
  const doFetch = o.fetchImpl ?? fetch;
  const { url, init } = buildRequest(o, false);
  // 超时与外部 signal 合流(两者任一触发即中止)
  const signal = o.timeoutMs
    ? AbortSignal.any([o.signal, AbortSignal.timeout(o.timeoutMs)].filter((s): s is AbortSignal => Boolean(s)))
    : o.signal;
  let res: Response;
  try {
    res = await doFetch(url, { ...init, signal });
  } catch (e) {
    // 超时统一抛 LlmHttpError 504:上层退避逻辑只认这个类型
    if (signal?.aborted && !o.signal?.aborted) throw new LlmHttpError(504, "chatOnce timeout");
    throw e;
  }
  if (!res.ok) throw new LlmHttpError(res.status, await res.text().catch(() => ""));
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return json.choices?.[0]?.message?.content ?? "";
}

/** SSE 流式(编剧 generate):逐 delta 产出 */
export async function* chatStream(o: InternalOptions): AsyncGenerator<string, void, unknown> {
  const doFetch = o.fetchImpl ?? fetch;
  const { url, init } = buildRequest(o, true);
  const res = await doFetch(url, init);
  if (!res.ok) throw new LlmHttpError(res.status, await res.text().catch(() => ""));
  if (!res.body) throw new Error("LLM 响应无 body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") return;
        try {
          const json = JSON.parse(payload) as {
            choices?: Array<{ delta?: { content?: string } }>;
          };
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) yield delta;
        } catch {
          // 心跳/注释行,忽略
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** @deprecated P0 兼容别名(p0-e2e 在用);新代码用 DeepseekClient */
export const streamChat = chatStream;

/** 组合实现:构造时定 apiKey/baseUrl/fetchImpl,调用时只传覆盖项 */
export class DeepseekClient {
  #base: { apiKey: string; baseUrl?: string; model?: string; fetchImpl?: FetchImpl };

  constructor(base: { apiKey: string; baseUrl?: string; model?: string; fetchImpl?: FetchImpl }) {
    this.#base = base;
  }

  chatOnce(o: Omit<InternalOptions, "apiKey" | "baseUrl" | "model" | "fetchImpl"> & { timeoutMs?: number }): Promise<string> {
    return chatOnce({ ...this.#base, ...o });
  }

  chatStream(o: Omit<InternalOptions, "apiKey" | "baseUrl" | "model" | "fetchImpl">): AsyncGenerator<string, void, unknown> {
    return chatStream({ ...this.#base, ...o });
  }
}
