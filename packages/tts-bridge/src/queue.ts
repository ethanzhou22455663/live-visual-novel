/**
 * 合成队列(plan §2.3):FIFO,maxInFlight=1——GPU 推理并发无益且破坏权重一致性
 * (P0-① 实测:多角色运行时零热切,同权重要求串行天然成立)。
 * 取消语义:跳过行 → 未开始任务取消;in-flight 的完成并写缓存(回放重听命中,P1)。
 */
import type { ReadyClip, SynthRequest, TtsProvider } from "@gal/shared";

export class SynthCancelledError extends Error {
  constructor(lineId: string) {
    super(`合成已取消: ${lineId}`);
    this.name = "SynthCancelledError";
  }
}

export class SynthQueue {
  private chain: Promise<unknown> = Promise.resolve();
  private cancelled = new Set<string>();

  private provider: TtsProvider;

  constructor(provider: TtsProvider) {
    this.provider = provider;
  }

  enqueue(req: SynthRequest): { promise: Promise<ReadyClip>; cancel: () => void } {
    const run = async (prev: Promise<unknown>): Promise<ReadyClip> => {
      await prev.catch(() => {});
      if (this.cancelled.has(req.lineId)) throw new SynthCancelledError(req.lineId);
      return this.provider.synthesize(req);
    };
    const promise = run(this.chain);
    this.chain = promise;
    return {
      promise,
      cancel: () => {
        this.cancelled.add(req.lineId);
      },
    };
  }
}
