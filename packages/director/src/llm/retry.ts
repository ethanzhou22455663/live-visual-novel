/**
 * 退避重试(plan §1.2 / ai-calls §1):指数退避 + jitter。
 * **只有导演允许退避重试**(一次性 JSON,玩家看"生成中");编剧失败一律续写式恢复。
 * 可重试:429 / 5xx / 网络错误(TypeError);4xx 其余一律立即抛。
 */
import { LlmHttpError } from "./deepseek.ts";

export interface RetryOptions {
  retries?: number;
  baseMs?: number;
  onRetry?: (attempt: number, err: unknown, delayMs: number) => void;
}

export function isRetryable(err: unknown): boolean {
  if (err instanceof LlmHttpError) return err.status === 429 || err.status >= 500;
  return err instanceof TypeError; // fetch 网络层失败
}

export async function withRetries<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const retries = opts.retries ?? 3;
  const baseMs = opts.baseMs ?? 800;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt === retries || !isRetryable(err)) throw err;
      const delayMs = baseMs * 2 ** attempt + Math.floor(Math.random() * 300);
      opts.onRetry?.(attempt + 1, err, delayMs);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}
