/**
 * 语音旁路观察者测试(2026-10-17 泵重写):VoicePipeline 只订阅 line:show,
 * 结构上不可能门控对话节奏——本文件证明其行为合同。
 * - line:show(say) → 切句入队 → ready/playing/done 状态序列
 * - 播中换行 → stopCurrent + 旧句补发 done(BGM ducking 永不卡压低)+ 旧合成 abort
 * - fast 不入队、auto 正常播;narrate/未知角色静音
 * - 合成悬挂不阻塞、不抛错(display 已与语音彻底解耦,此处证状态面干净)
 */
import { describe, expect, it, vi } from "vitest";
import type { ContentPort, EnqueueLineRequest, ReadyClip, VoiceSynthPort } from "@gal/shared";
import { EventBus } from "../src/core/EventBus.ts";
import { PresentationClock } from "../src/core/PresentationClock.ts";
import { VoiceChannel } from "../src/VoiceChannel.ts";
import { VoicePipeline } from "../src/audio/VoicePipeline.ts";

const content: ContentPort = {
  characterIds: new Set(["enagi"]),
  sceneIds: new Set<string>(),
  bgmIds: new Set<string>(),
  defaultExprOf: () => "平常",
  emotionsOf: () => new Set(["平常"]),
  displayNameOf: (who) => (who === "enagi" ? "陽見恵凪" : who),
};

const tick = (ms = 30) => new Promise<void>((r) => setTimeout(r, ms));

const sayEv = (text: string, who = "enagi") => ({ t: "say" as const, who, emotion: "", text });
const narrateEv = (text: string) => ({ t: "narrate" as const, text });

function fakeSynth(): VoiceSynthPort & { calls: EnqueueLineRequest[] } {
  const calls: EnqueueLineRequest[] = [];
  return {
    calls,
    enqueueLine: (req) => {
      calls.push(req);
      const clip: ReadyClip = { lineId: `${req.lineId}#0`, audio: new ArrayBuffer(8), durationSec: 0.1, sampleRate: 24000 };
      return [Promise.resolve(clip)];
    },
  };
}

/** play 在 holdMs 后自然收束(模拟播完);stopCurrent 立即收束 */
function fakeChannel(holdMs = 10) {
  const plays: string[] = [];
  let release: (() => void) | null = null;
  const stopCurrent = vi.fn(() => release?.());
  const play = (clip: ReadyClip): Promise<void> => {
    plays.push(clip.lineId);
    return new Promise<void>((r) => {
      const done = () => {
        release = null;
        r();
      };
      const t = setTimeout(done, holdMs);
      release = () => {
        clearTimeout(t);
        done();
      };
    });
  };
  return { plays, stopCurrent, play };
}

function makeVoice(synth: VoiceSynthPort, channel: VoiceChannel | null, clock = new PresentationClock()) {
  const bus = new EventBus();
  void new VoicePipeline({ bus, synth, voiceChannel: channel, content, clock });
  const states: string[] = [];
  bus.on("voice:state", ({ lineId, state }) => states.push(`${lineId}:${state}`));
  return { bus, clock, states };
}

describe("VoicePipeline 观察者", () => {
  it("line:show(say) → 切句入队 → ready/playing/done 状态序列", async () => {
    const synth = fakeSynth();
    const ch = fakeChannel();
    const v = makeVoice(synth, ch as unknown as VoiceChannel);
    v.bus.emit("line:show", { lineId: "1.0", ev: sayEv("あいう") as never });
    await vi.waitFor(() => expect(v.states.at(-1)).toBe("1.0#0:done"));
    expect(synth.calls[0]).toMatchObject({ lineId: "1.0", text: "あいう", speaker: "enagi", configId: "enagi" });
    expect(ch.plays).toEqual(["1.0#0"]);
    expect(v.states).toEqual(["1.0#0:ready", "1.0#0:playing", "1.0#0:done"]);
  });

  it("播中换行 → stopCurrent 收旧句;旧句补发 done(ducking 不卡);新句照走", async () => {
    const synth = fakeSynth();
    const ch = fakeChannel(400); // 旧句播不完,靠 stopCurrent 收束
    const v = makeVoice(synth, ch as unknown as VoiceChannel);
    v.bus.emit("line:show", { lineId: "1.0", ev: sayEv("一") as never });
    await vi.waitFor(() => expect(v.states).toContain("1.0#0:playing"));
    v.bus.emit("line:show", { lineId: "1.1", ev: sayEv("二") as never }); // 顶掉在播行
    expect(ch.stopCurrent).toHaveBeenCalled(); // 同步停播
    expect(synth.calls[0]!.signal?.aborted).toBe(true); // 旧句合成也 abort
    await vi.waitFor(() => expect(v.states.at(-1)).toBe("1.1#0:done"));
    expect(v.states).toContain("1.0#0:done"); // 旧句终态必发(每句 play 收束后必发 done/failed)
    expect(v.states.filter((s) => s.endsWith("done")).length).toBe(2);
  });

  it("fast 不入队、auto 正常播;normal 恢复后照常", async () => {
    const synth = fakeSynth();
    const v = makeVoice(synth, null);
    v.clock.setMode("fast");
    v.bus.emit("line:show", { lineId: "1.0", ev: sayEv("す") as never });
    await tick();
    expect(synth.calls).toEqual([]);
    v.clock.setMode("auto");
    v.bus.emit("line:show", { lineId: "1.1", ev: sayEv("は") as never }); // auto:语音照常
    await vi.waitFor(() => expect(synth.calls.length).toBe(1));
    expect(synth.calls[0]!.lineId).toBe("1.1");
    v.clock.setMode("normal");
    v.bus.emit("line:show", { lineId: "1.2", ev: sayEv("い") as never });
    await vi.waitFor(() => expect(synth.calls.length).toBe(2));
    expect(synth.calls[1]!.lineId).toBe("1.2");
  });

  it("narrate / 未知角色静音:不发状态、不入队", async () => {
    const synth = fakeSynth();
    const v = makeVoice(synth, null);
    v.bus.emit("line:show", { lineId: "1.0", ev: narrateEv("地の文") as never });
    v.bus.emit("line:show", { lineId: "1.1", ev: sayEv("…", "ghost") as never });
    await tick();
    expect(synth.calls).toEqual([]);
    expect(v.states).toEqual([]);
  });

  it("合成悬挂不阻塞不抛错:token 换代后旧句被放弃,状态面干净", async () => {
    const hang: VoiceSynthPort = {
      enqueueLine: (req) => {
        req.signal?.addEventListener("abort", () => {}, { once: true });
        return [new Promise<ReadyClip>(() => {})];
      },
    };
    const v = makeVoice(hang, null);
    v.bus.emit("line:show", { lineId: "1.0", ev: sayEv("長いセリフ") as never });
    await tick();
    v.bus.emit("line:show", { lineId: "1.1", ev: sayEv("次の行") as never }); // 顶掉:旧句悬挂 promise 泄漏但不阻塞
    await tick();
    expect(v.states).toEqual([]); // 没有任何半截状态(ready 都没到)
    expect(() => v.bus.emit("line:show", { lineId: "1.2", ev: sayEv("も一度") as never })).not.toThrow();
  });
});
