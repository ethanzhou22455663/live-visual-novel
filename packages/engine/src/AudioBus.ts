/**
 * 音频总线(plan §1.8 / M6):三通道 GainNode + 首手势解锁(坑 #16)。
 * - playBgm:同曲幂等;换曲旧 ramp→0 停、新曲 0→base 交叉淡入;loop
 * - playSe:一次触发;decode 缓存(BGM/SE 分池,容量截断)
 * - duckBgm:语音期间 bgm→base×0.35,结束回 base(VoiceChannel onStart/onEnd 接线)
 * - onError:加载失败回调(bootstrap 转 warnings;音频坏不拦剧情)
 */
import { VoiceChannel } from "./VoiceChannel.ts";

type Channel = "bgm" | "se" | "voice";

export class AudioBus {
  /** 加载/播放失败(非致命) */
  onError: ((message: string) => void) | null = null;

  private ctx: AudioContext | null = null;
  private gains: Partial<Record<Channel, GainNode>> = {};
  private volumes: Record<Channel, number> = { bgm: 0.6, se: 0.8, voice: 1 };
  private bgm: { src: AudioBufferSourceNode; assetId: string; gain: GainNode } | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private bufferLimit = 60;
  /** 语音通道单例(2026-10-18):串行播放链在实例内,每次新建会断链乱序 */
  private voiceChannelInst: VoiceChannel | null = null;

  /** 必须在用户手势(点击开始)中调用 */
  unlock(): void {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      for (const ch of ["bgm", "se", "voice"] as const) {
        const g = this.ctx.createGain();
        g.gain.value = this.volumes[ch];
        g.connect(this.ctx.destination);
        this.gains[ch] = g;
      }
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
  }

  setVolume(ch: Channel, v: number): void {
    this.volumes[ch] = v;
    const g = this.gains[ch];
    if (g) g.gain.value = ch === "bgm" && this.ducking ? v * 0.35 : v;
  }

  get voiceChannel(): VoiceChannel | null {
    if (!this.ctx || !this.gains.voice) return null;
    this.voiceChannelInst ??= new VoiceChannel(this.ctx, this.gains.voice);
    return this.voiceChannelInst;
  }

  /** 当前 BGM assetId(存档 presentation.bgm 用) */
  get currentBgm(): string | null {
    return this.bgm?.assetId ?? null;
  }

  /**
   * 播放/切换 BGM:同曲幂等;新曲 0→base 淡入,旧曲 ramp→0 后 stop。
   * ctx 未解锁时静默忽略(标题前不会有 bgm 指令)。
   */
  async playBgm(assetId: string, url: string, fadeMs = 800): Promise<void> {
    if (!this.ctx || !this.gains.bgm) return;
    if (this.bgm?.assetId === assetId) return;
    let buffer: AudioBuffer;
    try {
      buffer = await this.#decode(assetId, url);
    } catch (e) {
      this.onError?.(`BGM 加载失败 ${assetId}:${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    this.#fadeOutBgm(fadeMs);
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    const gain = this.ctx.createGain();
    const now = this.ctx.currentTime;
    const tIn = Math.max(fadeMs, 1) / 1000;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(this.ducking ? this.volumes.bgm * 0.35 : this.volumes.bgm, now + tIn);
    src.connect(gain);
    gain.connect(this.gains.bgm);
    src.start();
    this.bgm = { src, assetId, gain };
  }

  stopBgm(fadeMs = 800): void {
    this.#fadeOutBgm(fadeMs);
  }

  /** 语音 ducking:开 = bgm→base×0.35;关 = 回 base(设置面板改音量也经此保持) */
  private ducking = false;
  duckBgm(on: boolean, ms = 300): void {
    this.ducking = on;
    if (!this.ctx || !this.gains.bgm) return;
    const g = this.gains.bgm.gain;
    const now = this.ctx.currentTime;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(on ? this.volumes.bgm * 0.35 : this.volumes.bgm, now + Math.max(ms, 1) / 1000);
  }

  async playSe(assetId: string, url: string): Promise<void> {
    if (!this.ctx || !this.gains.se) return;
    let buffer: AudioBuffer;
    try {
      buffer = await this.#decode(assetId, url);
    } catch (e) {
      this.onError?.(`SE 加载失败 ${assetId}:${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.gains.se);
    src.start();
  }

  /** 旧曲 ramp→0 → stop;node 被 GC 前 onended 自然落定 */
  #fadeOutBgm(fadeMs: number): void {
    const cur = this.bgm;
    if (!cur || !this.ctx) return;
    this.bgm = null;
    const now = this.ctx.currentTime;
    try {
      cur.gain.gain.cancelScheduledValues(now);
      cur.gain.gain.setValueAtTime(cur.gain.gain.value, now);
      cur.gain.gain.linearRampToValueAtTime(0, now + Math.max(fadeMs, 1) / 1000);
      cur.src.stop(now + Math.max(fadeMs, 1) / 1000 + 0.05);
    } catch {
      // 已停止的 source 再 stop 抛错,忽略
    }
  }

  async #decode(assetId: string, url: string): Promise<AudioBuffer> {
    const hit = this.buffers.get(assetId);
    if (hit) return hit;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    const buffer = await this.ctx!.decodeAudioData(buf);
    this.buffers.set(assetId, buffer);
    if (this.buffers.size > this.bufferLimit) {
      const oldest = this.buffers.keys().next().value;
      if (oldest !== undefined) this.buffers.delete(oldest);
    }
    return buffer;
  }

  async close(): Promise<void> {
    this.#fadeOutBgm(0);
    if (this.ctx) await this.ctx.close();
    this.ctx = null;
    this.gains = {};
    this.buffers.clear();
  }
}
