/**
 * 语音通道(plan §2.2/§2.3):只消费 tts-bridge 的 ReadyClip,
 * 内部串行链保证按 lineId 顺序播放——乱序完成不乱序播放(否则对话声线错位)。
 * AudioBuffer 按 lineId 缓存(容量截断),decodeAudioData 会 detach 原始 buffer,故解码用副本。
 */
import type { LineId, ReadyClip } from "@gal/shared";

export class VoiceChannel {
  private tail: Promise<unknown> = Promise.resolve();
  private current: AudioBufferSourceNode | null = null;
  private cache = new Map<LineId, AudioBuffer>();
  private cacheLimit = 100;

  private ctx: AudioContext;
  private gain: GainNode;

  constructor(ctx: AudioContext, gain: GainNode) {
    this.ctx = ctx;
    this.gain = gain;
  }

  /** 播放一个片段;返回在它之前排队的所有片段播完且它自己播完的 Promise */
  play(clip: ReadyClip): Promise<void> {
    const run = async (prev: Promise<unknown>): Promise<void> => {
      await prev.catch(() => {});
      // SilentProvider 空音频(M6):不开 source,按估时定时等待——
      // 语音时序(auto 推进/演出链)不因缺 TTS 而坏;串行链照常保序
      if (clip.audio.byteLength === 0) {
        await new Promise<void>((r) => setTimeout(r, Math.max(0, clip.durationSec * 1000)));
        return;
      }
      const buffer = await this.#decode(clip);
      return new Promise<void>((resolve) => {
        const src = this.ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(this.gain);
        this.current = src;
        src.onended = () => {
          if (this.current === src) this.current = null;
          resolve();
        };
        src.start();
      });
    };
    const p = run(this.tail);
    this.tail = p;
    return p;
  }

  /** 当前句立即停;后续排队句照播(P1 细化跳过语义) */
  stopCurrent(): void {
    try {
      this.current?.stop();
    } catch {
      // 已停止的 source 再 stop 会抛,忽略
    }
  }

  async #decode(clip: ReadyClip): Promise<AudioBuffer> {
    const hit = this.cache.get(clip.lineId);
    if (hit) return hit;
    const buffer = await this.ctx.decodeAudioData(clip.audio.slice(0));
    this.cache.set(clip.lineId, buffer);
    if (this.cache.size > this.cacheLimit) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    return buffer;
  }
}
