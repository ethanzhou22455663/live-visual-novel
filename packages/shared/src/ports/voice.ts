/**
 * 语音合成端口(plan §1.7):app 组装 splitSentences→SynthQueue→TtsRouter 后注入。
 * commit 即入队(行级流水线:上一句播放时下一句已在合成);返回每句的就绪 Promise。
 */
import type { LineId, ReadyClip } from "../ports/index.ts";

export interface EnqueueLineRequest {
  lineId: LineId;
  text: string;
  speaker: string;
  configId: string;
  speed: number;
  signal?: AbortSignal;
}

export interface VoiceSynthPort {
  /** 按句切分后逐句入队;返回与句序一致的 ReadyClip promise 数组 */
  enqueueLine(req: EnqueueLineRequest): readonly Promise<ReadyClip>[];
}
