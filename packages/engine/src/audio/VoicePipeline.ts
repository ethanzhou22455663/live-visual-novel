/**
 * 语音旁路观察者(2026-10-17 显示泵重写;2026-10-18 预取调度):纯 bus 订阅者。
 * - line:show(say) → 顶掉在播行(abort 合成 + stopCurrent)→ 切句入队 fire-and-forget
 * - **预取深度 2**:显示第 i 句时,后台提前合成 commit 序列中的下两句 say——
 *   玩家阅读节奏(RTF 0.59:3s 音频≈1.8s 合成)下下一句语音零等待;fast 不预取(与静音一致)
 * - line:commit(say) 只进未来队列不合成(replay 不发 commit → 读档后预取空转,播出现场合成)
 * - 新行顶掉在播行(经典推进即切音);token 代际在句间检查,句内由 channel.play 的
 *   onended(stopCurrent 触发)收束——每句 play resolve 后必发 done/failed,
 *   BGM ducking 永不卡在压低状态
 * - 合成失败该句静音降级,文本照走;合成悬挂只泄漏一个 pending promise,不阻塞显示
 * - 通道活引用(voiceChannelOf):解锁时机与播放解耦——装配时 ctx 未建也能稍后取到
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

/** 预取深度:显示第 i 句时后台合成之后几句 */
const PREFETCH_AHEAD = 2;
/** 预取结果缓存上限(句);超限丢最旧,被淘汰的合成自然完成无引用 GC */
const PREBUILT_CAP = 8;

export interface VoicePipelineDeps {
  bus: EventBus;
  /** null = 无 TTS(测试/纯文本模式),全程静音 */
  synth: VoiceSynthPort | null;
  /** 通道活引用:播放时刻取(装配早于音频解锁,快照会永远拿到 null) */
  voiceChannelOf?: () => VoiceChannel | null;
  /** 未知角色静音;角色表来自内容包 */
  content: ContentPort;
  /** 显示时刻读模式:fast 静音(auto 正常播) */
  clock: PresentationClock;
  /** 有语音配置的角色白名单;在册但不在此表 → 静音(主角无配音,2026-10-17 裁决)。
   *  省略 = 不做此过滤(测试)。 */
  voiced?: ReadonlySet<string>;
  /** 排查 log(静音卫兵/请求/状态/预取;bootstrap 注 console.log("[voice]", …);测试可省) */
  log?(msg: string): void;
}

interface FutureLine {
  lineId: string;
  who: string;
  text: string;
}

export class VoicePipeline {
  #bus: EventBus;
  #synth: VoiceSynthPort | null;
  #voiceChannelOf: () => VoiceChannel | null;
  #content: ContentPort;
  #clock: PresentationClock;
  #voiced: ReadonlySet<string> | null;
  #log: (msg: string) => void;
  /** 行代际:新行顶旧行(合成 signal + 句间检查都用它) */
  #lineAbort: AbortController | null = null;
  #token = 0;
  #muteLogged = new Set<string>(); // 无语音配置角色只提示一次,不刷屏
  /** commit 已知、尚未显示的台词行(预取的素材;replay 不发 commit → 空 = 预取空转) */
  #future: FutureLine[] = [];
  /** 预取结果:lineId → 句集 promise(显示时消费,替代现场入队) */
  #prebuilt = new Map<string, VoiceEntry[]>();

  constructor(deps: VoicePipelineDeps) {
    this.#bus = deps.bus;
    this.#synth = deps.synth;
    this.#voiceChannelOf = deps.voiceChannelOf ?? (() => null);
    this.#content = deps.content;
    this.#clock = deps.clock;
    this.#voiced = deps.voiced ?? null;
    this.#log = deps.log ?? (() => {});
    // 唯一入口:泵显示台词行时触发(replay 不发 line:show,读档静音,天然正确)
    deps.bus.on("line:show", ({ lineId, ev }) => {
      if (ev.t === "say") this.#speak(ev.who, ev.text, lineId);
    });
    // 预取素材:commit 顺序 = 队列顺序(commit 不合成,只记账)
    deps.bus.on("line:commit", ({ lineId, event }) => {
      if (event.t === "say") this.#future.push({ lineId, who: event.who, text: event.text });
    });
  }

  #speak(who: string, text: string, lineId: string): void {
    // 消费预取;无预取(回放/读档/future 断供)则现场入队
    const prebuilt = this.#prebuilt.get(lineId);
    this.#prebuilt.delete(lineId);
    if (prebuilt) this.#log(`[${lineId}] prefetch hit`);

    if (!this.#synth) return this.#log(`[${lineId}] 无 TTS → 静音`);
    if (!this.#content.characterIds.has(who)) return this.#log(`[${lineId}] 未知角色「${who}」→ 静音`);
    if (this.#voiced && !this.#voiced.has(who)) {
      if (!this.#muteLogged.has(who)) {
        this.#muteLogged.add(who);
        this.#log(`[${lineId}] 「${who}」无语音配置 → 静音(主角不配音;此后不再提示)`);
      }
      return;
    }
    const mode = this.#clock.mode;
    if (mode === "fast") return this.#log(`[${lineId}] 模式 fast → 静音`);

    // 修剪未来队列:弹出头部直到本行(已显示的行不再预取)
    while (this.#future.length > 0 && this.#future[0]!.lineId !== lineId) this.#future.shift();
    if (this.#future[0]?.lineId === lineId) this.#future.shift();

    // 新行顶掉在播行:停旧合成、停旧播放;旧句终态由其 playOut 在 play 收束后补发 done
    if (this.#token > 0) this.#log(`[${lineId}] 新行顶旧行 #${this.#token}`);
    this.#lineAbort?.abort();
    this.#voiceChannelOf()?.stopCurrent();
    const signal = (this.#lineAbort = new AbortController()).signal;
    const token = ++this.#token;

    const entries = prebuilt ?? this.#enqueueNow(lineId, who, text, signal);
    this.#log(
      `[${lineId}] speak ${who} config=${who} ${entries.length}句 「${text.slice(0, 20)}」${prebuilt ? "(prefetch)" : ""}`,
    );
    void this.#playOut(entries, token);

    // 预取下两句(fast 已在上方 return;voiced 白名单内才值得合成)
    let picked = 0;
    for (const fut of this.#future) {
      if (picked >= PREFETCH_AHEAD) break;
      if (this.#prebuilt.has(fut.lineId)) continue;
      if (this.#voiced && !this.#voiced.has(fut.who)) continue;
      const entries = this.#enqueueNow(fut.lineId, fut.who, fut.text, this.#lineAbort.signal);
      for (const e of entries) e.promise.catch(() => {}); // 预取被顶掉/淘汰后 reject 不成 unhandled
      this.#prebuilt.set(fut.lineId, entries);
      picked++;
    }
    if (picked > 0) {
      this.#log(`[${lineId}] prefetch ${picked}句`);
      // 上限保护:丢最旧(其合成自然完成,无引用 GC)
      while (this.#prebuilt.size > PREBUILT_CAP) {
        const oldest = this.#prebuilt.keys().next().value;
        if (oldest === undefined) break;
        this.#prebuilt.delete(oldest);
      }
    }
  }

  /** 现场切句入队(fire-and-forget;合成失败该句静音降级) */
  #enqueueNow(lineId: string, who: string, text: string, signal: AbortSignal): VoiceEntry[] {
    if (!this.#synth) return [];
    const req: EnqueueLineRequest = {
      lineId,
      text,
      speaker: who,
      configId: who, // 即角色 charId(plan §2.8)
      speed: 1,
      signal,
    };
    return this.#synth.enqueueLine(req).map((promise, i) => ({
      clipLineId: `${lineId}#${i}`,
      promise,
    }));
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
        const channel = this.#voiceChannelOf();
        if (!channel) throw new Error("语音通道未解锁");
        this.#bus.emit("voice:state", { lineId: entry.clipLineId, state: "playing" });
        this.#log(`[${entry.clipLineId}] 播放`);
        await channel.play(clip);
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
