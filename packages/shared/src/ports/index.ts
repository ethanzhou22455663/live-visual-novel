/**
 * 端口契约(plan §2.2/§2.3):平台相关实现(app)构造后注入,
 * engine/director/tts-bridge 只依赖这里的接口。
 * P0 只落地 TTS 相关端口;GameEventMap 全量先定义(引擎 P1 实现完整总线)。
 */
import type { ScriptEvent } from "../protocol/script.ts";

export type LineId = string;

// ---------- TTS(plan §2.3) ----------

export interface VoiceConfig {
  /** 即角色 charId(plan §2.8);同角色多情绪 = 单权重 + ref_audio 差分 */
  configId: string;
  refAudioPath: string;
  promptText: string;
  promptLang: "ja" | "zh" | "en";
  /** P0 未用:预训练/微调权重绝对路径(服务端本机) */
  gptWeightsPath?: string;
  sovitsWeightsPath?: string;
}

export interface SynthRequest {
  lineId: LineId;
  text: string;
  speaker: string;
  configId: string;
  speed: number;
  signal?: AbortSignal;
}

/** 已合成完毕、可播放的片段 */
export interface ReadyClip {
  lineId: LineId;
  audio: ArrayBuffer;
  durationSec: number;
  sampleRate: number;
}

export interface TtsProvider {
  readonly id: string;
  /** 单句整段返回(P0 主路线;真流式留待首音优化) */
  synthesize(req: SynthRequest): Promise<ReadyClip>;
  healthCheck(): Promise<boolean>;
}

// ---------- 事件总线契约(plan §2.2):全部模块只依赖这个契约互不 import ----------

export type ClockMode = "normal" | "fast" | "skip" | "auto";

export interface GameEventMap {
  "engine:phase": { phase: "title" | "play" | "pause" | "menu" | "ending" };
  "generation:status": {
    phase: "idle" | "directing" | "writing" | "choicing" | "aborted" | "error";
    turnNo: number;
    error?: string;
  };
  /** 事务点:存档/TTS 入队/backlog 全挂这 */
  "line:commit": { event: ScriptEvent; lineId: LineId };
  "line:skip": { lineId: LineId };
  "typewriter:progress": { lineId: LineId; ratio: number };
  "typewriter:done": { lineId: LineId };
  "choice:offered": { choice: Extract<ScriptEvent, { t: "choice" }> };
  "voice:state": {
    lineId: LineId;
    state: "synth" | "ready" | "playing" | "done" | "failed" | "muted";
  };
  "clock:mode": { mode: ClockMode };
  "save:written": { slot: string };
}
