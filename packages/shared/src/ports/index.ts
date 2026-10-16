/**
 * 端口契约(plan §2.2/§2.3):平台相关实现(app)构造后注入,
 * engine/director/tts-bridge 只依赖这里的接口。
 * P0 只落地 TTS 相关端口;GameEventMap 全量先定义(引擎 P1 实现完整总线)。
 */
import type { PublicChoiceOffer } from "../protocol/script.ts";
import type { ScriptEvent } from "../protocol/script.ts";

export type LineId = string;

/** 舞台呈现快照(存档/恢复用;bgm 归音频侧单独记录) */
export interface PresentationSnapshot {
  bg: string | null;
  bgm: string | null;
  sprites: Record<string, { slot: "left" | "center" | "right"; emotion: string }>;
}

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
  "engine:phase": { phase: "title" | "play" | "choicing" | "pause" | "menu" | "ending" };
  "generation:status": {
    phase: "idle" | "directing" | "writing" | "choicing" | "aborted" | "error";
    turnNo: number;
    error?: string;
  };
  /** Tier-2 窥视文本(未提交行的半截):只进 ghost 区,绝不进状态/TTS */
  "generation:preview": { text: string };
  /** 事务点:存档/TTS 入队/backlog 全挂这(replay 重放时不发,见 EngineCore.replay) */
  "line:commit": { event: ScriptEvent; lineId: LineId };
  "line:skip": { lineId: LineId };
  "typewriter:progress": { lineId: LineId; ratio: number };
  "typewriter:done": { lineId: LineId };
  /** 只携带公开视图;hidden 后果仅 resolveChoice 路径可见(plan §1.5) */
  "choice:offered": { choice: PublicChoiceOffer };
  "choice:resolved": { optionId: string; label: string };
  "voice:state": {
    lineId: LineId;
    state: "synth" | "ready" | "playing" | "done" | "failed" | "muted";
  };
  "clock:mode": { mode: ClockMode };
  /** 一拍收束(BeatRunner 在拍尾、摘要/大纲推进之后发;M5 自动存档挂这里) */
  "beat:end": { result: "choice" | "beatEnd" | "sceneEnd"; turnNo: number };
  "save:written": { slot: string };
  /** 非致命告警:未知表情回退、缺图占位、TTS 降级等 */
  "engine:warning": { message: string };
}
