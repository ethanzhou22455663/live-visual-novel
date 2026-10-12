/**
 * GPT-SoVITS api_v2 Provider(plan §2.3)。
 * P0-① 实测结论落地(docs/p0-tts-findings.md):
 * - 主路线单句整段(streaming_mode=0),cut0 不切(切句在 shared/split 完成)
 * - batch_size 固定 1(=8 实测慢 4×);prompt_text 必传(空转写掉 naive_infer 慢路径)
 * - api_v2 无 CORS:浏览器经 dev proxy(/tts → 127.0.0.1:9880)访问
 * - 多角色运行时零热切:VoiceConfig per-char ref_audio,不调 set_*_weights
 */
import type { ReadyClip, SynthRequest, TtsProvider } from "@gal/shared";

export interface GptSovitsEndpoint {
  baseUrl: string; // 如 "/tts-proxy" 或 "http://127.0.0.1:9880"
  refAudioPath: string; // 服务端本机可读的绝对路径
  promptText: string;
  promptLang?: string;
  textLang?: string;
  speed?: number;
}

/** WAV 头解析(取时长算 RTF/进度);流式响应的 data 长度可能为 0/0xFFFFFFFF,以实收为准 */
export function wavInfo(buf: ArrayBuffer): { durationSec: number; sampleRate: number } | null {
  const view = new DataView(buf);
  if (buf.byteLength < 44) return null;
  const riff = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (riff !== "RIFF") return null;
  let off = 12;
  let dataOff = -1;
  let dataLen = 0;
  while (off + 8 <= buf.byteLength) {
    const id = String.fromCharCode(
      view.getUint8(off),
      view.getUint8(off + 1),
      view.getUint8(off + 2),
      view.getUint8(off + 3),
    );
    const size = view.getUint32(off + 4, true);
    if (id === "data") {
      dataOff = off + 8;
      dataLen = size;
      break;
    }
    off += 8 + size + (size % 2);
  }
  if (dataOff < 0) return null;
  const channels = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  const bits = view.getUint16(34, true);
  const byteRate = view.getUint32(28, true) || (sampleRate * channels * bits) / 8;
  let bytes = dataLen;
  if (bytes === 0 || bytes === 0xffffffff || dataOff + bytes > buf.byteLength) bytes = buf.byteLength - dataOff;
  if (byteRate <= 0) return null;
  return { durationSec: bytes / byteRate, sampleRate };
}

export class GptSovitsProvider implements TtsProvider {
  readonly id = "gpt-sovits";
  private ep: GptSovitsEndpoint;

  constructor(ep: GptSovitsEndpoint) {
    this.ep = ep;
  }

  updateEndpoint(ep: Partial<GptSovitsEndpoint>): void {
    this.ep = { ...this.ep, ...ep };
  }

  async synthesize(req: SynthRequest): Promise<ReadyClip> {
    const res = await fetch(`${this.ep.baseUrl}/tts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: req.text,
        text_lang: this.ep.textLang ?? "ja",
        ref_audio_path: this.ep.refAudioPath,
        prompt_text: this.ep.promptText,
        prompt_lang: this.ep.promptLang ?? "ja",
        text_split_method: "cut0",
        media_type: "wav",
        streaming_mode: 0,
        batch_size: 1,
        speed_factor: req.speed,
      }),
      signal: req.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`TTS HTTP ${res.status}: ${detail.slice(0, 200)}`);
    }
    const audio = await res.arrayBuffer();
    const info = wavInfo(audio);
    if (!info) throw new Error("TTS 响应不是合法 WAV");
    return { lineId: req.lineId, audio, durationSec: info.durationSec, sampleRate: info.sampleRate };
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(this.ep.baseUrl, { method: "GET" });
      return res.status < 500;
    } catch {
      return false;
    }
  }
}
