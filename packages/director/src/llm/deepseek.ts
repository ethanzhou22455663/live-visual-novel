/**
 * OpenAI 兼容 chat/completions 流式客户端(手写 fetch + SSE,plan §1.3 裁决:
 * 不引 AI SDK——自定义 NDJSON 行协议 + 换/加端点零成本)。
 * DeepSeek/GLM/Qwen 同形可换;dev 期 baseUrl 走 "/llm"(Vite proxy 注入 key)。
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

export async function* streamChat(o: StreamChatOptions): AsyncGenerator<string, void, unknown> {
  // dev 期 apiKey 传空串:Vite proxy 注入真实 Authorization(浏览器永远拿不到 key)
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (o.apiKey) headers.authorization = `Bearer ${o.apiKey}`;
  const res = await fetch(`${o.baseUrl ?? "https://api.deepseek.com"}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: o.model ?? "deepseek-chat",
      messages: o.messages,
      stream: true,
      temperature: o.temperature,
      max_tokens: o.maxTokens,
      ...(o.responseFormat ? { response_format: o.responseFormat } : {}),
    }),
    signal: o.signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
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
