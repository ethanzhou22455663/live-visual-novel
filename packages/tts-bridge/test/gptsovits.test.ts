/**
 * GptSovitsProvider 多 ref 化(M6 裁决7):synthesize 按 configId 选 ref——
 * refs[configId] → refs[defaultRefId] → 构造 endpoint 兜底;ref_audio_path 只进 POST body。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReadyClip, SynthRequest } from "@gal/shared";
import { GptSovitsProvider } from "../src/index.ts";

/** 最小合法 WAV(44B 头 + data),wavInfo 可解析出时长 */
function tinyWav(sampleRate = 24000, channels = 1, bits = 16, dataBytes = 4800): ArrayBuffer {
  const byteRate = (sampleRate * channels * bits) / 8;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const w = (off: number, s: string): void => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  w(0, "RIFF");
  v.setUint32(4, 36 + dataBytes, true);
  w(8, "WAVE");
  w(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, byteRate, true);
  v.setUint16(32, (channels * bits) / 8, true);
  v.setUint16(34, bits, true);
  w(36, "data");
  v.setUint32(40, dataBytes, true);
  return buf;
}

const OK = {
  ok: true,
  status: 200,
  text: async () => "",
  arrayBuffer: async () => tinyWav(),
} as unknown as Response;

const BASE = {
  baseUrl: "",
  refAudioPath: "D:/assets/default.wav",
  promptText: "デフォルト",
};

function synthReq(configId?: string): SynthRequest {
  return { lineId: "1.0", text: "テスト", configId, speed: 1 } as SynthRequest;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GptSovitsProvider ref 解析", () => {
  it("refs[configId] 优先:per-char 覆盖生效", async () => {
    const fetchMock = vi.fn(async () => OK);
    vi.stubGlobal("fetch", fetchMock);
    const p = new GptSovitsProvider(BASE, { ririko: { refAudioPath: "D:/assets/ririko.wav", promptText: "りりこ" } }, "enagi");
    await p.synthesize(synthReq("ririko"));
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const sent = JSON.parse(String(init.body));
    expect(fetchMock.mock.calls[0]![0]).toBe("/tts"); // baseUrl "" 自拼 "/tts"(proxy 1:1 语义)
    expect(sent.ref_audio_path).toBe("D:/assets/ririko.wav");
    expect(sent.prompt_text).toBe("りりこ");
    expect(sent.text_split_method).toBe("cut0");
    expect(sent.batch_size).toBe(1);
  });

  it("未知 configId → defaultRefId;再未知 → 构造 endpoint 兜底", async () => {
    const fetchMock = vi.fn(async () => OK);
    vi.stubGlobal("fetch", fetchMock);
    const p = new GptSovitsProvider(
      BASE,
      {
        enagi: { refAudioPath: "D:/assets/enagi.wav", promptText: "えなぎ" },
        ririko: { refAudioPath: "D:/assets/ririko.wav", promptText: "りりこ" },
      },
      "enagi",
    );
    const r1 = await p.synthesize(synthReq("miku")); // 无 per-char → default
    const r2 = await p.synthesize(synthReq()); // 无 configId → default
    const b1 = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body));
    const b2 = JSON.parse(String((fetchMock.mock.calls[1]![1] as RequestInit).body));
    expect(b1.ref_audio_path).toBe("D:/assets/enagi.wav");
    expect(b2.ref_audio_path).toBe("D:/assets/enagi.wav");
    void r1;
    void r2;
  });

  it("空 refs + 无 default:完全回退构造 endpoint", async () => {
    const fetchMock = vi.fn(async () => OK);
    vi.stubGlobal("fetch", fetchMock);
    const p = new GptSovitsProvider(BASE);
    const clip = await p.synthesize(synthReq("anyone"));
    const sent = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body));
    expect(sent.ref_audio_path).toBe("D:/assets/default.wav");
    expect(sent.prompt_text).toBe("デフォルト");
    // WAV 头解析出时长:4800B / 48000B/s = 0.1s
    expect(clip.durationSec).toBeCloseTo(0.1, 5);
  });

  it("HTTP 非 2xx:抛错(触发 TtsRouter 降级)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, text: async () => "boom" }) as unknown as Response),
    );
    const p = new GptSovitsProvider(BASE);
    await expect(p.synthesize(synthReq())).rejects.toThrow("TTS HTTP 500");
  });
});

describe("ReadyClip 返回", () => {
  it("clip 携带请求 lineId 与采样率", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => OK));
    const p = new GptSovitsProvider(BASE);
    const clip: ReadyClip = await p.synthesize({ lineId: "2.3", text: "あ", speed: 1 } as SynthRequest);
    expect(clip.lineId).toBe("2.3");
    expect(clip.sampleRate).toBe(24000);
  });
});
