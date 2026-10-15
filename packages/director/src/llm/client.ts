/**
 * LLM 客户端抽象(plan §1.2):director 只依赖此接口;
 * DeepSeek 实现在 deepseek.ts,测试注 FakeLlm。
 * 三类调用全走 OpenAI 兼容 /chat/completions(docs/ai-calls.md)。
 */
import type { ChatMessage, StreamChatOptions } from "./deepseek.ts";

export interface ChatOnceOptions extends StreamChatOptions {
  /** 单请求超时(坑:导演/摘要是一次性 JSON,必须能超时);默认 30s */
  timeoutMs?: number;
}

export interface LlmClient {
  /** 非流式:返回完整 assistant 文本(导演 nextBeat / 摘要 summarize) */
  chatOnce(o: ChatOnceOptions): Promise<string>;
  /** SSE 流式:逐 delta 产出(编剧 generate) */
  chatStream(o: StreamChatOptions): AsyncGenerator<string, void, unknown>;
}
