/**
 * P0-③ 端到端编排(plan §三-3):DeepSeek 流式 → NDJSON 解析 → 逐字上屏 → TTS 连播。
 * 两条独立链:合成链(FIFO,maxInFlight=1,commit 即入队)与演出链(打字机+语音串行)——
 * 行级流水线:上一句播放时下一句已在合成(RTF 0.59 实测余量 1.7×,断档应为 0)。
 * LLM 首 token/合成均不阻塞文本:present 由演出链驱动,preview 只进 ghost 区。
 */
import { generateP0 } from "@gal/director";
import { makeLineId, splitSentences } from "@gal/shared";
import type { LineId, NarrateEvent, ReadyClip, SayEvent, ScriptEvent } from "@gal/shared";
import { GptSovitsProvider, SynthQueue, SynthCancelledError } from "@gal/tts-bridge";
import type { VoiceChannel } from "@gal/engine";

export interface P0RunHooks {
  /** Tier-2 窥视文本(未提交行的半截),只进 ghost 区,绝不进状态 */
  onPreview(text: string): void;
  onStatus(text: string): void;
  /** 事件提交(事务点):记录日志;演出与语音随后由演出链驱动 */
  onCommit(ev: ScriptEvent, lineId: LineId): void;
  /** 呈现一行(app 内跑打字机),resolve 于打字机补完 */
  present(ev: SayEvent | NarrateEvent, lineId: LineId): Promise<void>;
  voiceChannel: VoiceChannel | null;
  onVoiceState?(clipLineId: LineId, state: "synth" | "ready" | "playing" | "done" | "failed"): void;
}

export interface P0RunConfig {
  /** dev 传空串:dev server proxy 注入真实 key;直连时传真实 key */
  apiKey: string;
  llmBaseUrl: string;
  ttsBaseUrl: string;
  refAudioPath: string;
  promptText: string;
  scenePrompt: string;
  signal?: AbortSignal;
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function runP0(cfg: P0RunConfig, hooks: P0RunHooks): Promise<number> {
  const provider = new GptSovitsProvider({
    baseUrl: cfg.ttsBaseUrl,
    refAudioPath: cfg.refAudioPath,
    promptText: cfg.promptText,
  });
  const queue = new SynthQueue(provider);
  let seq = 0;
  let committed = 0;
  let presentation: Promise<void> = Promise.resolve();
  const advance = (step: () => Promise<void>) => {
    presentation = presentation.then(step);
  };

  try {
    for await (const chunk of generateP0({
      apiKey: cfg.apiKey,
      baseUrl: cfg.llmBaseUrl,
      scenePrompt: cfg.scenePrompt,
      signal: cfg.signal,
    })) {
      if (cfg.signal?.aborted) break;
      if (chunk.kind === "preview") {
        hooks.onPreview(chunk.text);
        continue;
      }
      if (chunk.kind === "done") break;

      const ev = chunk.event;
      const lineId = makeLineId(ev.turnNo, seq++);
      committed++;
      hooks.onPreview("");
      hooks.onCommit(ev, lineId);

      if (ev.t === "say") {
        // commit 即入队(行级流水线):不等上一句播完
        const entries = splitSentences(ev.text).map((s, i) => {
          const clipLineId = `${lineId}#${i}`;
          hooks.onVoiceState?.(clipLineId, "synth");
          const h = queue.enqueue({
            lineId: clipLineId,
            text: s,
            speaker: ev.who,
            configId: ev.who,
            speed: 1,
            signal: cfg.signal,
          });
          return { clipLineId, ...h };
        });
        advance(async () => {
          await hooks.present(ev, lineId);
          for (const entry of entries) {
            try {
              const clip: ReadyClip = await entry.promise;
              hooks.onVoiceState?.(entry.clipLineId, "ready");
              if (!hooks.voiceChannel) throw new Error("语音通道未解锁");
              hooks.onVoiceState?.(entry.clipLineId, "playing");
              await hooks.voiceChannel.play(clip);
              hooks.onVoiceState?.(entry.clipLineId, "done");
            } catch (e) {
              if (e instanceof SynthCancelledError) return;
              // 降级:该句静音,文本照走(降级链 P1 接 TtsRouter)
              hooks.onVoiceState?.(entry.clipLineId, "failed");
            }
          }
          await delay(400); // 最小停留(auto 节奏的 P0 版)
        });
      } else if (ev.t === "narrate") {
        advance(async () => {
          await hooks.present(ev, lineId);
          await delay(400);
        });
      }
      // stage:P0 桩编剧不产出;choice:P1 接 ChoiceOverlay
    }
  } finally {
    if (!cfg.signal?.aborted) await presentation;
    hooks.onPreview("");
  }
  return committed;
}
