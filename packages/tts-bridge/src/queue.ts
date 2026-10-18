/**
 * 合成队列(plan §2.3):FIFO,maxInFlight=1——GPU 推理并发无益且破坏权重一致性
 * (P0-① 实测:多角色运行时零热切,同权重要求串行天然成立)。
 * 取消语义(2026-10-18 审计后收口):统一走 SynthRequest.signal(fetch 级 abort,
 * 拒绝经 playOut 兜为 failed);队列级 cancel API 已删(生产零调用,dead-lock 的
 * cancelled 残留 Set 反而是隐患)。
 */
import type { ReadyClip, SynthRequest, TtsProvider } from "@gal/shared";

export class SynthQueue {
  private chain: Promise<unknown> = Promise.resolve();

  private provider: TtsProvider;

  constructor(provider: TtsProvider) {
    this.provider = provider;
  }

  enqueue(req: SynthRequest): { promise: Promise<ReadyClip> } {
    const run = async (prev: Promise<unknown>): Promise<ReadyClip> => {
      await prev.catch(() => {});
      return this.provider.synthesize(req);
    };
    const promise = run(this.chain);
    this.chain = promise;
    return { promise };
  }
}
