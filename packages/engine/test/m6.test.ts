/**
 * M6 合同测试:
 * - 坑③ skip 演出直通:clock.mode==="skip" 时 say/narrate 不等语音(hang synth 证明),
 *   commit/ledger 照常入账,循环顺畅进下一拍
 * - stage bgm/se 指令 → EngineCore onBgm/onSe 出口;replay 不重触发(读档走 presentation 权威恢复)
 * - KeyBindings 滚轮向上 = backlog;面板开时吞掉
 * - VoiceChannel 空音频(SilentProvider)按估时定时等待且串行保序
 */
import { describe, expect, it, vi } from "vitest";
import type { ContentPort, ReadyClip, VoiceSynthPort } from "@gal/shared";
import { KeyBindings } from "../src/core/KeyBindings.ts";
import { BeatRunner } from "../src/core/BeatRunner.ts";
import { EngineCore } from "../src/core/EngineCore.ts";
import { EventBus } from "../src/core/EventBus.ts";
import { PresentationClock } from "../src/core/PresentationClock.ts";
import { VoiceChannel } from "../src/VoiceChannel.ts";
import { VoicePipeline } from "../src/audio/VoicePipeline.ts";
import type { SpriteOp, StagePort } from "../src/presentation/ports.ts";
import { fakeStory, pad } from "./beatRunnerHarness.ts";

const content: ContentPort = {
  characterIds: new Set(["enagi"]),
  sceneIds: new Set(["classroom"]),
  bgmIds: new Set<string>(),
  defaultExprOf: () => "平常",
  emotionsOf: () => new Set(["平常"]),
  displayNameOf: (who) => (who === "enagi" ? "陽見恵凪" : who),
};

function fakeStage(): StagePort {
  return {
    bg: () => {},
    sprite: (_o: SpriteOp) => {},
    speak: () => {},
    shake: () => {},
    flash: () => {},
    reset: () => {},
    snapshot: () => ({ bg: null, bgm: null, sprites: {} }),
    restore: () => {},
  };
}

describe("M6 skip 演出直通(坑③)", () => {
  it("skip 模式:不等语音(hang synth 永不 resolve 也不拦路),ledger 照常入账,循环进下一拍", async () => {
    const bus = new EventBus();
    const clock = new PresentationClock();
    const engine = new EngineCore({ bus, clock, stage: fakeStage(), content, textEl: document.createElement("p") });
    clock.setMode("skip");
    // 永不 resolve 的合成:若 skip 路径没生效,#drainPresentation 会挂死在 playOut
    const hangSynth: VoiceSynthPort = {
      enqueueLine: () => [new Promise<ReadyClip>(() => {})],
    };
    const voice = new VoicePipeline({ bus, synth: hangSynth, voiceChannel: null });
    const story = fakeStory([
      {
        chunks: [
          { kind: "commit", event: { t: "say", who: "enagi", emotion: "平常", text: "スキップ一段落" } },
          { kind: "done", result: "beatEnd", lineCount: 1 },
        ],
      },
      {
        chunks: [
          { kind: "commit", event: { t: "narrate", text: "二拍目も直通" } },
          { kind: "done", result: "beatEnd", lineCount: 1 },
        ],
      },
      pad(),
    ]);
    const runner = new BeatRunner({ engine, bus, story, voice, content, outlineBeatCount: 3 });
    const states: string[] = [];
    bus.on("voice:state", ({ state }) => states.push(state));

    const p = runner.run();
    await vi.waitFor(() => expect(engine.ledger.map((e) => e.lineId)).toEqual(["1.0", "2.0"]), { timeout: 4000 });
    runner.stopGeneration();
    await p;

    expect(engine.ledger.every((e) => e.kind === "ev")).toBe(true); // commit/fold 照常
    expect(states).not.toContain("playing"); // 语音根本没被等
    expect(states).not.toContain("ready");
  });
});

describe("M6 stage bgm/se 出口", () => {
  it("commit 转发 onBgm/onSe;replay 不重触发", () => {
    const onBgm = vi.fn();
    const onSe = vi.fn();
    const engine = new EngineCore({
      bus: new EventBus(),
      clock: new PresentationClock(),
      stage: fakeStage(),
      content,
      textEl: document.createElement("p"),
      onBgm,
      onSe,
    });
    engine.commitModel({ t: "stage", op: { kind: "bgm", action: "play", asset: "bgm-p07" } });
    engine.commitModel({ t: "stage", op: { kind: "bgm", action: "fade", asset: "bgm-p11", fadeMs: 400 } });
    engine.commitModel({ t: "stage", op: { kind: "se", asset: "se-knock" } });
    expect(onBgm.mock.calls).toEqual([["bgm-p07", undefined], ["bgm-p11", 400]]);
    expect(onSe).toHaveBeenCalledWith("se-knock");

    // replay(读档回放):瞬态与音频指令都不重触发
    onBgm.mockClear();
    onSe.mockClear();
    engine.replay(engine.ledger);
    expect(onBgm).not.toHaveBeenCalled();
    expect(onSe).not.toHaveBeenCalled();

    // stop → assetId null(单参调用:省略 fadeMs)
    engine.commitModel({ t: "stage", op: { kind: "bgm", action: "stop" } });
    expect(onBgm).toHaveBeenCalledWith(null);
  });
});

describe("M6 KeyBindings 滚轮", () => {
  it("滚轮向上触发 toggleBacklog;面板开时忽略;detach 后不再响应", () => {
    const calls: string[] = [];
    const kb = new KeyBindings({
      advance: () => calls.push("advance"),
      setFast: () => {},
      toggleBacklog: () => calls.push("backlog"),
      togglePause: () => calls.push("pause"),
      closePanel: () => calls.push("close"),
    });
    kb.attach(window);
    window.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, cancelable: true }));
    expect(calls).toEqual(["backlog"]);

    kb.setPanelOpen(true);
    window.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, cancelable: true }));
    expect(calls).toEqual(["backlog"]); // 面板开:吞掉

    kb.detach();
    kb.setPanelOpen(false);
    window.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, cancelable: true }));
    expect(calls).toEqual(["backlog"]); // 已 detach
  });
});

describe("VoiceChannel 空音频(SilentProvider 路径)", () => {
  it("byteLength 0 → 按估时定时等待,串行保序,不触碰 AudioContext", async () => {
    vi.useFakeTimers();
    try {
      const ch = new VoiceChannel({} as AudioContext, {} as GainNode);
      const order: string[] = [];
      const a = ch
        .play({ lineId: "1.0", audio: new ArrayBuffer(0), durationSec: 0.5, sampleRate: 24000 })
        .then(() => order.push("a"));
      const b = ch
        .play({ lineId: "1.1", audio: new ArrayBuffer(0), durationSec: 0.3, sampleRate: 24000 })
        .then(() => order.push("b"));
      let settled = false;
      void Promise.all([a, b]).then(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(499);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(400); // a 到 0.5s 完成,b 再走 0.3s → 共 0.8s
      expect(order).toEqual(["a", "b"]);
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("真实音频路径不变:非空 clip 仍走 decode(此处仅证 stopCurrent 不抛)", () => {
    const ch = new VoiceChannel({} as AudioContext, {} as GainNode);
    expect(() => ch.stopCurrent()).not.toThrow();
  });
});
