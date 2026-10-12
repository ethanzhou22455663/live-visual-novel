/**
 * 音频总线(plan §2.2)P0 最小版:三通道 GainNode 骨架 + 首手势解锁
 * (坑 #16:AudioContext 必须在用户手势里创建/resume)。
 * BGM/SE 通道与 ducking、fade 在 P1 补全。
 */
import { VoiceChannel } from "./VoiceChannel.ts";

export class AudioBus {
  private ctx: AudioContext | null = null;
  private gains: Partial<Record<"bgm" | "se" | "voice", GainNode>> = {};
  private volumes: Record<"bgm" | "se" | "voice", number> = { bgm: 0.6, se: 0.8, voice: 1 };

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

  setVolume(ch: "bgm" | "se" | "voice", v: number): void {
    this.volumes[ch] = v;
    const g = this.gains[ch];
    if (g) g.gain.value = v;
  }

  get voiceChannel(): VoiceChannel | null {
    if (!this.ctx || !this.gains.voice) return null;
    return new VoiceChannel(this.ctx, this.gains.voice);
  }

  async close(): Promise<void> {
    if (this.ctx) await this.ctx.close();
    this.ctx = null;
    this.gains = {};
  }
}
