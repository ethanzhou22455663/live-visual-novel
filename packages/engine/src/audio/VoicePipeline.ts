/**
 * 语音旁路观察者(2026-10-17 显示泵重写):纯 bus 订阅者,结构上不可能再门控任何东西。
 * line:show(say)→ 顶掉在播行(abort 合成 + stopCurrent)→ 切句入队 fire-and-forget。
 * - skip/fast 不入队(显示时刻读 clock.mode;切模式发生在行间,句内由 stopCurrent 收束)
 * - 新行顶掉在播行(经典推进即切音);token 代际在句间检查,句内由 channel.play 的
 *   onended(stopCurrent 触发)收束——每句 play resolve 后必发 done/failed,
 *   BGM ducking 永不卡在压低状态
 * - 合成失败该句静音降级,文本照走;合成悬挂只泄漏一个 pending promise,不阻塞显示
 * 切句归 VoiceSynthPort 实现(app 组装 splitSentences→SynthQueue→TtsRouter)。
 */
import type { ContentPort, EnqueueLineRequest, ReadyClip, VoiceSynthPort } from "@gal/shared";
import type { PresentationClock } from "../core/PresentationClock.ts";
import type { EventBus } from "../core/EventBus.ts";
import type { VoiceChannel } from "../VoiceChannel.ts";

export interface VoiceEntry {
  clipLineId: string;
  promise: Promise<ReadyClip>;
}

export interface VoicePipelineDeps {
  bus: EventBus;
  /** null = 无 TTS(测试/纯文本模式),全程静音 */
  synth: VoiceSynthPort | null;
  voiceChannel: VoiceChannel | null;
  /** 未知角色静音(skip 语音);角色表来自内容包 */
  content: ContentPort;
  /** 显示时刻读模式:skip/fast 静音 */
  clock: PresentationClock;
  /** 有语音配置的角色白名单;在册但不在此表 → 静音(主角无配音,2026-10-17 裁决)。
   *  省略 = 不做此过滤(测试)。 */
  voiced?: ReadonlySet<string>;
  /** 排查 log(静音卫兵/请求/状态;bootstrap 注 console.log("[voice]", …);测试可省) */
  log?(msg: string): void;
}

export class VoicePipeline {
  #bus: EventBus;
  #synth: VoiceSynthPort | null;
  #channel: VoiceChannel | null;
  #content: ContentPort;
  #clock: PresentationClock;
  #voiced: ReadonlySet<string> | null;
  #log: (msg: string) => void;
  /** 行代际:新行顶旧行(合成 signal + 句间检查都用它) */
  #lineAbort: AbortController | null = null;
  #token = 0;

  constructor(deps: VoicePipelineDeps) {
    this.#bus = deps.bus;
    this.#synth = deps.synth;
    this.#channel = deps.voiceChannel;
    this.#content = deps.content;
    this.#clock = deps.clock;
    this.#voiced = deps.voiced ?? null;
    this.#log = deps.log ?? (() => {});
    // 唯一入口:泵显示台词行时触发(replay 不发 line:show,读档静音,天然正确)
    deps.bus.on("line:show", ({ lineId, ev }) => {
      if (ev.t === "say") this.#speak(ev.who, ev.text, lineId);
    });
  }

  #speak(who: string, text: string, lineId: string): void {
    if (!this.#synth) return this.#log(`[${lineId}] 无 TTS → 静音`);
    if (!this.#content.characterIds.has(who)) return this.#log(`[${lineId}] 未知角色「${who}」→ 静音`);
    if (this.#voiced && !this.#voiced.has(who)) return this.#log(`[${lineId}] 「${who}」无语音配置 → 静音(主角不配音)`);
    const mode = this.#clock.mode;
    if (mode === "skip" || mode === "fast") return this.#log(`[${lineId}] 模式 ${mode} → 静音`);
    // 新行顶掉在播行:停旧合成、停旧播放;旧句终态由其 playOut 在 play 收束后补发 done
    if (this.#token > 0) this.#log(`[${lineId}] 新行顶旧行 #${this.#token}`);
    this.#lineAbort?.abort();
    this.#channel?.stopCurrent();
    const signal = (this.#lineAbort = new AbortController()).signal;
    const token = ++this.#token;
    const req: EnqueueLineRequest = {
      lineId,
      text,
      speaker: who,
      configId: who, // 即角色 charId(plan §2.8)
      speed: 1,
      signal,
    };
    const entries = this.#synth.enqueueLine(req).map((promise, i) => ({
      clipLineId: `${lineId}#${i}`,
      promise,
    }));
    this.#log(`[${lineId}] speak ${who} config=${req.configId} ${entries.length}句 「${text.slice(0, 20)}」`);
    void this.#playOut(entries, token);
  }

  /** 按句序播;单句失败静音继续;被新行顶掉(token 变)即止。终态必发,ducking 不卡 */
  async #playOut(entries: VoiceEntry[], token: number): Promise<void> {
    for (const entry of entries) {
      if (token !== this.#token) return this.#log(`[${entry.clipLineId}] 放弃(被新行顶掉)`);
      let clip: ReadyClip;
      try {
        clip = await entry.promise;
      } catch (e) {
        this.#log(`[${entry.clipLineId}] 合成失败: ${(e as Error | undefined)?.message ?? "?"}`);
        this.#bus.emit("voice:state", { lineId: entry.clipLineId, state: "failed" });
        continue;
      }
      if (token !== this.#token) return this.#log(`[${entry.clipLineId}] 放弃(合成后已被顶掉)`);
      this.#bus.emit("voice:state", { lineId: entry.clipLineId, state: "ready" });
      try {
        if (!this.#channel) throw new Error("语音通道未解锁");
        this.#bus.emit("voice:state", { lineId: entry.clipLineId, state: "playing" });
        this.#log(`[${entry.clipLineId}] 播放`);
        await this.#channel.play(clip);
      } catch (e) {
        this.#log(`[${entry.clipLineId}] 播放失败: ${(e as Error | undefined)?.message ?? "?"}`);
        this.#bus.emit("voice:state", { lineId: entry.clipLineId, state: "failed" });
        continue;
      }
      // play 已收束(自然播完或被 stopCurrent 切断):必发终态
      this.#bus.emit("voice:state", { lineId: entry.clipLineId, state: "done" });
      if (token !== this.#token) return;
    }
  }
}
