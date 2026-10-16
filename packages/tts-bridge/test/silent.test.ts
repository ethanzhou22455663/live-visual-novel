/**
 * SilentProvider(plan §1.7):按字估时 + 空音频。VoiceChannel 对 byteLength===0
 * 定时等待,语音时序(auto 推进/演出链)不因缺 TTS 而坏。
 */
import { describe, expect, it } from "vitest";
import { SilentProvider, estimateSpeechSec } from "../src/index.ts";

describe("estimateSpeechSec", () => {
  it("CJK 按字 130ms", () => {
    // 7 字 × 0.13 = 0.91s
    expect(estimateSpeechSec("こんにちは世界")).toBeCloseTo(0.91, 5);
  });

  it("拉丁按词 300ms", () => {
    expect(estimateSpeechSec("hello world")).toBeCloseTo(0.6, 5);
  });

  it("混排:CJK 字 + 拉丁词相加", () => {
    // 2 字 ×0.13 + 1 词 ×0.3 = 0.56
    expect(estimateSpeechSec("あいhello")).toBeCloseTo(0.56, 5);
  });

  it("speed 折算", () => {
    // 10 字 ×0.13 ÷ 2 = 0.65
    expect(estimateSpeechSec("あいうえおかきくけこ", 2)).toBeCloseTo(0.65, 5);
  });

  it("下限 0.5s(空文本/短句不贴 0)", () => {
    expect(estimateSpeechSec("")).toBe(0.5);
    expect(estimateSpeechSec("あ", 3)).toBe(0.5);
    expect(estimateSpeechSec("あいうえお", 5)).toBe(0.5); // 0.13 ÷ 5 = 0.026 → 0.5
  });
});

describe("SilentProvider", () => {
  it("synthesize:空音频 + 估时时长 + 24kHz 标记", async () => {
    const p = new SilentProvider();
    const clip = await p.synthesize({ lineId: "1.0", text: "こんにちは世界", speed: 1 });
    expect(clip.audio.byteLength).toBe(0);
    expect(clip.durationSec).toBeCloseTo(0.91, 5);
    expect(clip.sampleRate).toBe(24000);
    expect(clip.lineId).toBe("1.0");
  });

  it("healthCheck 恒真(链尾永不失败)", async () => {
    await expect(new SilentProvider().healthCheck()).resolves.toBe(true);
  });
});
