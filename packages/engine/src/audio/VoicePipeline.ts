/**
 * 语音演出链(plan §1.7 / P0 p0run 拆解):commit 即入队(行级流水线),
 * 打字机完 → 逐句 play → 最短停留。合成失败该句静音降级,文本照走。
 * 切句归 VoiceSynthPort 实现(app 组装 splitSentences→SynthQueue→TtsRouter)。
 */
import type { LineId, ReadyClip, VoiceSynthPort } from "@gal/shared";
import type { EventBus } from "../core/EventBus.ts";
import type { VoiceChannel } from "../VoiceChannel.ts";

export interface VoiceEntry {
  clipLineId: LineId;
  promise: Promise<ReadyClip>;
}

export interface VoicePipelineDeps {
  bus: EventBus;
  /** null = 无 TTS(测试/纯文本模式),全程静音 */
  synth: VoiceSynthPort | null;
  voiceChannel: VoiceChannel | null;
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class VoicePipeline {
  #bus: EventBus;
  #synth: VoiceSynthPort | null;
  #channel: VoiceChannel | null;

  constructor(deps: VoicePipelineDeps) {
    this.#bus = deps.bus;
    this.#synth = deps.synth;
    this.#channel = deps.voiceChannel;
  }

  /** commit 时调用(不等演出):Port 内部切句,返回与句序一致的就绪 promise */
  enqueue(say: { who: string; text: string }, lineId: LineId, signal?: AbortSignal): VoiceEntry[] {
    if (!this.#synth) return [];
    const promises = this.#synth.enqueueLine({
      lineId,
      text: say.text,
      speaker: say.who,
      configId: say.who,
      speed: 1,
      signal,
    });
    return promises.map((promise, i) => ({ clipLineId: `${lineId}#${i}`, promise }));
  }

  /** 演出链步骤:按句序播;单句失败静音继续;abort 即止 */
  async playOut(entries: VoiceEntry[], signal?: AbortSignal): Promise<void> {
    for (const entry of entries) {
      if (signal?.aborted) return;
      try {
        const clip = await entry.promise;
        this.#bus.emit("voice:state", { lineId: entry.clipLineId, state: "ready" });
        if (!this.#channel) throw new Error("语音通道未解锁");
        this.#bus.emit("voice:state", { lineId: entry.clipLineId, state: "playing" });
        await this.#channel.play(clip);
        this.#bus.emit("voice:state", { lineId: entry.clipLineId, state: "done" });
      } catch {
        this.#bus.emit("voice:state", { lineId: entry.clipLineId, state: "failed" });
      }
    }
  }

  /** narrate / 行尾最小停留 */
  async dwell(ms = 400): Promise<void> {
    await delay(ms);
  }
}
