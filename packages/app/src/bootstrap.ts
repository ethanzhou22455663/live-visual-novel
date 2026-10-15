/**
 * 装配单例(plan §1.9 / M3):manifest 加载(local 优先)→ 内容端口 → 舞台/台词窗 →
 * EventBus/PresentationClock → EngineCore → createStoryService → BeatRunner。
 * main.tsx 无 StrictMode(坑⑨),单例由模块级惰性初始化保证。
 * runner 延迟到标题点击:AudioContext 必须在用户手势里解锁(坑#16),
 * VoiceChannel 依赖解锁后的 ctx。React 只做 chrome(标题/选项/状态),舞台归 engine。
 * 合规:key 只在 dev proxy("/llm");refAudioPathServer 只进 POST body 不落 URL。
 */
import {
  AudioBus,
  BeatRunner,
  EngineCore,
  EventBus,
  PresentationClock,
  VoicePipeline,
  createDomStagePort,
} from "@gal/engine";
import type { StageDeps, StagePort } from "@gal/engine";
import { DeepseekClient, createStoryService, outlineBeatCount, parseContentPack } from "@gal/director";
import type { ContentPack, ContentPort, EnqueueLineRequest, ReadyClip, VoiceSynthPort } from "@gal/shared";
import { splitSentences } from "@gal/shared";
import { GptSovitsProvider, SynthQueue } from "@gal/tts-bridge";

export interface Assembled {
  pack: ContentPack;
  content: ContentPort;
  engine: EngineCore;
  stage: StagePort;
  bus: EventBus;
  audio: AudioBus;
  /** start() 首次调用时建立(需解锁后的 VoiceChannel);此前 null */
  readonly runner: BeatRunner | null;
  /** 标题「スタート」:解锁音频(首次同时建 runner)并启动 beat 主循环 */
  start(): void;
  /** 停止生成:abort + 打字机取消;已提交行保留生效 */
  stop(): void;
  warnings: string[];
}

/** manifest 加载:优先本地包(裁决4),OSS 克隆降级占位包 */
export async function loadPack(): Promise<ContentPack> {
  for (const url of ["/content/manifest.local.json", "/content/manifest.json"]) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      return parseContentPack(await res.json());
    } catch {
      // 换下一个候选
    }
  }
  throw new Error("manifest 加载失败:content/manifest(.local).json 都不可用——先跑 content-sync");
}

export function buildContentPort(pack: ContentPack): ContentPort {
  return {
    characterIds: new Set(Object.keys(pack.characters)),
    sceneIds: new Set(Object.keys(pack.scenes)),
    bgmIds: new Set(Object.keys(pack.bgm)),
    defaultExprOf: (who) => pack.characters[who]?.defaultExpr ?? "",
    emotionsOf: (who) => new Set(Object.keys(pack.characters[who]?.sprites ?? {})),
    displayNameOf: (who) => pack.characters[who]?.displayName ?? who,
  };
}

function buildStageDeps(root: HTMLElement, content: ContentPort, pack: ContentPack, warnings: string[]): StageDeps {
  return {
    root,
    resolve: (kind, who, id) => {
      if (kind === "scene") return pack.scenes[id]?.image ?? null;
      return pack.characters[who ?? ""]?.sprites[id] ?? null;
    },
    content,
    warn: (m) => {
      warnings.push(m);
      console.warn("[stage]", m);
    },
  };
}

/**
 * VoiceSynthPort 实现(plan §1.7):splitSentences→SynthQueue。
 * 切句归 Port 内部;clipLineId `${lineId}#${i}` 与 VoicePipeline 的映射一致。
 * TtsRouter/SilentProvider 降级链 M6;无 voice 的包 → synth=null 全程静音。
 */
class AppVoiceSynth implements VoiceSynthPort {
  #queue: SynthQueue;

  constructor(queue: SynthQueue) {
    this.#queue = queue;
  }

  enqueueLine(req: EnqueueLineRequest): readonly Promise<ReadyClip>[] {
    return splitSentences(req.text).map((s, i) =>
      this.#queue.enqueue({
        lineId: `${req.lineId}#${i}`,
        text: s,
        speaker: req.speaker,
        configId: req.configId,
        speed: req.speed,
        signal: req.signal,
      }).promise,
    );
  }
}

let singleton: Promise<Assembled> | null = null;

export function getAssembled(): Promise<Assembled> {
  singleton ??= assemble();
  return singleton;
}

async function assemble(): Promise<Assembled> {
  const warnings: string[] = [];
  const pack = await loadPack();
  const content = buildContentPort(pack);

  // ---- 舞台挂载:固定全屏底层,1920×1080 逻辑坐标由本层 scale(外层负责 scale) ----
  const holder = document.createElement("div");
  holder.id = "gal-stage-holder";
  document.body.prepend(holder);
  const stage = createDomStagePort(buildStageDeps(holder, content, pack, warnings));

  // 台词窗(最小 chrome;M6 可挪进 React):名牌 + 打字机目标
  const vn = document.createElement("section");
  vn.className = "vn-window";
  const nameEl = document.createElement("div");
  nameEl.className = "vn-name";
  const textEl = document.createElement("div");
  textEl.className = "vn-text";
  vn.append(nameEl, textEl);
  holder.append(vn);

  const fit = () => {
    const scale = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
    holder.style.setProperty("--stage-scale", String(scale));
  };
  fit();
  window.addEventListener("resize", fit);

  // ---- 引擎核心 ----
  const bus = new EventBus();
  const clock = new PresentationClock();
  clock.start();
  const engine = new EngineCore({ bus, clock, stage, content, textEl, cps: 28 });

  // 名牌随提交行更新(commit 事务点;replay 不发 line:commit,M5 读档后补同步)
  bus.on("line:commit", ({ event }) => {
    if (event.t === "say") {
      nameEl.textContent = content.displayNameOf(event.who);
      nameEl.style.color = pack.characters[event.who]?.color || "";
      vn.dataset.narration = "false";
    } else if (event.t === "narrate") {
      nameEl.textContent = "ナレーション";
      nameEl.style.color = "";
      vn.dataset.narration = "true";
    }
  });

  // ---- 语音(裁决7):manifest 带 voice(本地包)才装配真 TTS;供体 = assets/2 ----
  const voiceChar = Object.values(pack.characters).find((c) => c.voice);
  let synth: VoiceSynthPort | null = null;
  if (voiceChar?.voice) {
    const provider = new GptSovitsProvider({
      baseUrl: "", // Provider 自拼 "/tts" → Vite proxy 1:1 转发 9880("/tts/tts" 是 404 陷阱)
      refAudioPath: voiceChar.voice.refAudioPathServer,
      promptText: voiceChar.voice.promptText,
      promptLang: voiceChar.voice.promptLang,
    });
    synth = new AppVoiceSynth(new SynthQueue(provider));
  }

  // ---- 导演/编剧/摘要(同一条 LLM 连接) ----
  const story = createStoryService({
    llm: new DeepseekClient({ apiKey: "", baseUrl: "/llm" }), // dev:key 由 Vite proxy 注入
    apiKey: "",
    baseUrl: "/llm",
    pack,
    onError: (e) => {
      const m = e instanceof Error ? e.message : String(e);
      warnings.push(m);
      console.warn("[story]", m);
    },
  });

  const audio = new AudioBus();
  let runner: BeatRunner | null = null;

  return {
    pack,
    content,
    engine,
    stage,
    bus,
    audio,
    warnings,
    get runner() {
      return runner;
    },
    start() {
      audio.unlock(); // 坑#16:必须在点击手势里
      runner ??= new BeatRunner({
        engine,
        bus,
        story,
        voice: synth ? new VoicePipeline({ bus, synth, voiceChannel: audio.voiceChannel }) : null,
        content,
        outlineBeatCount: outlineBeatCount(pack.story.outlineMd),
        onError: (e) => {
          const m = e instanceof Error ? e.message : String(e);
          warnings.push(m);
          console.warn("[runner]", m);
        },
      });
      void runner.run();
    },
    stop() {
      runner?.stopGeneration();
    },
  };
}
