/**
 * LLM 客户端端口(plan §1.2):director 只依赖此接口;实现(deepseek.ts 等)反向实现它。
 * 契约类型(ChatMessage/StreamChatOptions/LlmHttpError)定义在端口上——换 provider
 * 不必回头 import 任何具体实现文件(2026-10-18 审计:端口自足)。
 * 三类调用全走 OpenAI 兼容 /chat/completions(docs/ai-calls.md)。
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

/** 带 HTTP status 的失败:retry.ts 据此判 429/5xx;实现方必须抛此类型 */
export class LlmHttpError extends Error {
  readonly status: number;

  constructor(status: number, body: string) {
    super(`LLM HTTP ${status}: ${body.slice(0, 300)}`);
    this.status = status;
    this.name = "LlmHttpError";
  }
}


export interface ChatOnceOptions extends StreamChatOptions {
  /** 单请求超时(坑:导演/摘要是一次性 JSON,必须能超时);默认 30s */
  timeoutMs?: number;
}

export interface LlmClient {
  /** 非流式:返回完整 assistant 文本(总导演 planAct / 摘要 summarize) */
  chatOnce(o: ChatOnceOptions): Promise<string>;
  /** SSE 流式:逐 delta 产出(编剧 generate) */
  chatStream(o: StreamChatOptions): AsyncGenerator<string, void, unknown>;
}
