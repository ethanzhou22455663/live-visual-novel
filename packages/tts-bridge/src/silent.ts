/**
 * SilentProvider(plan §1.7):无 TTS/降级终点。按字数估时返回空音频,
 * VoiceChannel 对空 clip 走定时等待——语音时序(auto 推进/演出链)不因缺 TTS 而坏。
 * 估时:CJK 字×130ms + 拉丁词×300ms,÷ speed,下限 0.5s。
 */
import type { ReadyClip, SynthRequest, TtsProvider } from "@gal/shared";

export function estimateSpeechSec(text: string, speed = 1): number {
  const cjk = (text.match(/[　-ヿ㐀-䶿一-鿿豈-﫿＀-￯]/g) ?? []).length;
  const latinWords = (text.match(/[A-Za-z0-9]+/g) ?? []).length;
  const sec = (cjk * 0.13 + latinWords * 0.3) / Math.max(speed, 0.1);
  return Math.max(0.5, sec);
}

export class SilentProvider implements TtsProvider {
  readonly id = "silent";

  async synthesize(req: SynthRequest): Promise<ReadyClip> {
    return {
      lineId: req.lineId,
      audio: new ArrayBuffer(0), // 空音频标记:VoiceChannel 定时等待 durationSec
      durationSec: estimateSpeechSec(req.text, req.speed),
      sampleRate: 24000,
    };
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}
