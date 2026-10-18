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
  /** abort 即中断退避 sleep(读档/停止时不再干等 800-3200ms;2026-10-18 审计 H2) */
  signal?: AbortSignal;
}

export function isRetryable(err: unknown): boolean {
  if (err instanceof LlmHttpError) return err.status === 429 || err.status >= 500;
  return err instanceof TypeError; // fetch 网络层失败
}

/** 可中断的退避 sleep;abort 时抛 Error 让上层 catch 走各自的兜底 */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("retry aborted"));
      return;
    }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new Error("retry aborted"));
      },
      { once: true },
    );
  });
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
      await delay(delayMs, opts.signal);
    }
  }
  throw lastErr;
}
