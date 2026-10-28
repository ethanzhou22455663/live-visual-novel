/**
 * 装配单例(plan §1.9 / M3):manifest 加载(local 优先)→ 内容端口 → 舞台/台词窗 →
 * EventBus/PresentationClock → EngineCore → createStoryService → BeatRunner。
 * main.tsx 无 StrictMode(坑⑨),单例由模块级惰性初始化保证。
 * runner 延迟到标题点击:AudioContext 必须在用户手势里解锁(坑#16),
 * VoiceChannel 依赖解锁后的 ctx。React 只做 chrome(标题/快捷菜单/面板),舞台归 engine。
 * 坐标系:index.html 静态骨架(#stage 1920×1080),fit() 直接写 transform(mock/ui.html
 * 同款,无 CSS 变量中介——旧的 --stage-scale 机制在缩放上不可信,已废)。
 * 合规:key 只在 dev proxy("/llm");refAudioPathServer 只进 POST body 不落 URL。
 */
import {
  AudioBus,
  BeatRunner,
  EngineCore,
  EventBus,
  PresentationClock,
  SaveSystem,
  VoicePipeline,
  createDomStagePort,
} from "@gal/engine";
import type { StageDeps, StagePort } from "@gal/engine";
import { DeepseekClient, createStoryService, outlineBeatCount, parseContentPack } from "@gal/director";
import type { ContentPack, ContentPort, EnqueueLineRequest, LineId, ReadyClip, SaveData, VoiceSynthPort } from "@gal/shared";
import { splitSentences } from "@gal/shared";
import { GptSovitsProvider, SilentProvider, SynthQueue, TtsRouter } from "@gal/tts-bridge";
import type { GptSovitsRefs } from "@gal/tts-bridge";
import { LocalStorageAdapter } from "./storage/LocalStorageAdapter.ts";
import { applySettings, loadSettings } from "./state/settings.ts";
import { createTranslator } from "./ai/translate.ts";
import type { Lang } from "./i18n/strings.ts";

export interface Assembled {
  pack: ContentPack;
  content: ContentPort;
  engine: EngineCore;
  stage: StagePort;
  bus: EventBus;
  audio: AudioBus;
  saves: SaveSystem;
  /** start() 首次调用时建立(需解锁后的 VoiceChannel);此前 null */
  readonly runner: BeatRunner | null;
  /** 标题「スタート」:解锁音频(首次同时建 runner)并启动 beat 主循环 */
  start(): void;
  /** 标题「つづきから」:读 auto/指定档 → 续写起跑 */
  startFromSave(save: SaveData): Promise<void>;
  /** 游戏中读档(菜单):停旧循环 → 恢复 → 起新循环 */
  continueFrom(save: SaveData): Promise<void>;
  /** 停止生成:只 abort;已提交行保留,继续按玩家节奏显示 */
  stop(): void;
  /** ending 画面「タイトルへ」:清空回标题 */
  newGame(): void;
  /** UI 语言切换(设置面板):上屏文本源(textOf)下一行生效 */
  setUiLang(l: Lang): void;
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
    log: (m) => console.log("[stage]", m), // 排查埋点(人数布局/表情),常驻
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

// 首帧即摆正舞台(manifest fetch 前 React 就挂了 loading 分支,不能等 assemble;
// script type=module 在 DOM 解析完后执行,getElementById 此时可用)
{
  const el = document.getElementById("stage");
  if (el) {
    const s0 = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
    el.style.transform = `translate(-50%, -50%) scale(${s0})`;
  }
}

async function assemble(): Promise<Assembled> {
  const warnings: string[] = [];
  const pack = await loadPack();
  const content = buildContentPort(pack);

  // ---- 舞台挂载:index.html 静态骨架,mock/ui.html 同构 ----
  // 场景层(engine DomStagePort)在 .scene;台词窗 .win 与 React chrome(#root)
  // 全部活在 #stage 的 1920×1080 逻辑坐标里,由 fit() 等比缩放。
  const stageEl = document.getElementById("stage");
  const sceneEl = document.getElementById("gal-scene");
  const winEl = document.getElementById("gal-win");
  const plateEl = document.getElementById("gal-plate");
  const plateNm = plateEl?.querySelector<HTMLElement>(".nm") ?? null;
  const textEl = document.getElementById("gal-text");
  const nextEl = document.getElementById("gal-next");
  if (!stageEl || !sceneEl || !winEl || !plateEl || !plateNm || !textEl || !nextEl) {
    throw new Error("舞台骨架缺失:index.html 的 #stage/#gal-scene/#gal-win 等元素不存在");
  }
  const stage = createDomStagePort(buildStageDeps(sceneEl, content, pack, warnings));

  // 标题视觉(mock titleVisual 同款:学校背景,透过 .title .shade 的半透明渐变可见;
  // 2026-10-17 手验:此前标题相位舞台无 bg → 纯黑一整片)。场景 id 是内容包数据,不硬编码:
  // 优先「学校」,退而取第一个;进入游戏后第一拍的 bg 指令自然覆盖。
  const titleScene = [...content.sceneIds].find((id) => id === "学校") ?? [...content.sceneIds][0];
  if (titleScene) stage.bg(titleScene);

  const fit = (): void => {
    const s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
    stageEl.style.transform = `translate(-50%, -50%) scale(${s})`;
  };
  fit();
  window.addEventListener("resize", fit);

  // ---- 音频总线(bgm/se 出口要被 EngineCore 引用,先于 engine 建立坑#16:解锁仍归手势) ----
  const audio = new AudioBus();

  // UI 语言(设置面板可切):textOf 闭包读它,中文且已有译文时台词直接显示中文(2026-10-18)
  let uiLang: Lang = loadSettings().lang;

  // ---- 引擎核心 ----
  const bus = new EventBus();
  const clock = new PresentationClock();
  audio.onError = (m) => {
    warnings.push(m);
    bus.emit("engine:warning", { message: m });
    console.warn("[audio]", m);
  };
  const engine = new EngineCore({
    bus,
    clock,
    stage,
    content,
    textEl,
    choiceRoot: stageEl, // 选项浮层挂舞台内(engine DOM;z-index 6:窗上、面板下)
    cps: 28,
    // 上屏文本源:lang=zh → 中文(有译文立即用;没有则等预取翻译≤1.2s,超时先打日文原文,
    // 译文回写后整句静默换中文——见 curLine 换写。翻译永不阻塞剧情的 2026-10-18 裁决保持,
    // 等待上限从 6s 收到 1.2s:2026-10-28 用户裁决,久等=打字一卡一卡的体感来源)。
    // 只影响打字内容——语音/切句/日志仍用原始 ev.text(日语),配音节奏与字幕语言解耦。
    // lineId 精确对应等待中的译文(zhWaiters,预取泵回写时唤醒)
    textOf: (ev, lineId) => {
      if (uiLang !== "zh") return ev.text;
      if (ev.zh) return ev.zh;
      return new Promise<string>((res) => {
        let done = false;
        const finish = (zh: string | null): void => {
          if (done) return;
          done = true;
          res(zh ?? ev.text);
        };
        const set = zhWaiters.get(lineId) ?? new Set<(zh: string | null) => void>();
        set.add(finish);
        zhWaiters.set(lineId, set);
        setTimeout(() => {
          set.delete(finish);
          finish(null);
        }, 1200);
      });
    },
    // 译文显示开关(选项浮层渲染时实时读):日文模式下已带译文的选项也必须显示日文
    zhOn: () => uiLang === "zh",
    // stage bgm/se 指令 → AudioBus;assetId→URL 查 pack.bgm 表(未知 id 告警不拦)
    onBgm: (assetId, fadeMs) => {
      if (assetId === null) {
        audio.stopBgm(fadeMs ?? 800);
        return;
      }
      const track = pack.bgm[assetId];
      if (!track) {
        warnings.push(`未知 BGM「${assetId}」`);
        console.warn("[audio]", `未知 BGM「${assetId}」`);
        return;
      }
      void audio.playBgm(assetId, track.path, fadeMs);
    },
    onSe: (assetId) => {
      const track = pack.bgm[assetId];
      if (!track) {
        warnings.push(`未知 SE「${assetId}」`);
        console.warn("[audio]", `未知 SE「${assetId}」`);
        return;
      }
      void audio.playSe(assetId, track.path);
    },
  });

  // 语音播放中压低 BGM(ducking):voice:state 驱动(每句 playing→on / done|failed|muted→off)
  bus.on("voice:state", ({ state }) => {
    if (state === "playing") audio.duckBgm(true);
    else if (state === "done" || state === "failed" || state === "muted") audio.duckBgm(false);
  });

  // ---- 台词窗接线(mock 同款):line:show(泵显示行)更新名牌并熄 ▼,打字完点亮 ▼ ----
  bus.on("line:show", ({ ev }) => {
    nextEl.classList.remove("on");
    if (ev.t === "say") {
      plateNm.textContent = content.displayNameOf(ev.who);
      plateEl.style.setProperty("--pc", pack.characters[ev.who]?.color || "");
      plateEl.classList.add("on");
    } else if (ev.t === "narrate") {
      plateEl.classList.remove("on"); // 旁白无名牌(mock 同款)
    }
  });
  bus.on("typewriter:done", () => {
    nextEl.classList.add("on");
  });
  // 排查埋点(2026-10-17 手验:表情/语音报错但现象不明)——每显示一行打一条,常驻
  bus.on("line:show", ({ lineId, ev }) => {
    const emo = ev.t === "say" ? ` emotion=${ev.emotion ?? "(无)"}` : "";
    const who = ev.t === "say" ? ` who=${ev.who}` : "";
    console.log(`[line] ${lineId} ${ev.t}${who}${emo} 「${ev.text.slice(0, 20)}」`);
  });
  bus.on("engine:phase", ({ phase }) => {
    const show = phase === "play" || phase === "choicing";
    winEl.classList.toggle("on", show);
    if (!show) {
      plateEl.classList.remove("on");
      nextEl.classList.remove("on");
    }
  });

  // ---- 生成等待提示(2026-10-28 用户裁决:画面卡住时对话区要给文字提示) ----
  // 两个空档来源:①显示队列排空而 runner 仍在生成(玩家此刻点击不会有任何反应)
  // ②第一次生成——显示队列还没转过,display:drained 从未发过,开局总导演/写作的
  // 等待也要给提示(displayedThrough 仍为 null = 还没有任何行上屏)。
  // 提示显示到下一行上屏(打字覆盖)/选项弹出/生成结束为止。
  const genHintText = (): string => (uiLang === "zh" ? "……(生成中,请稍候)" : "……(生成中、しばらくお待ちください)");
  let hintOn = false;
  const hideGenHint = (): void => {
    if (!hintOn) return;
    hintOn = false;
    textEl.classList.remove("gen-wait");
  };
  const showGenHint = (): void => {
    if (hintOn || engine.phase !== "play" || !runner?.running) return;
    hintOn = true;
    nextEl.classList.remove("on"); // ▼ 只在「可以继续」时亮
    textEl.textContent = genHintText();
    textEl.classList.add("gen-wait");
  };
  bus.on("display:drained", showGenHint);
  bus.on("generation:status", ({ phase }) => {
    // 开局(尚无已看行)的生成空档;中期 displayThrough 非空,空档由 display:drained 负责
    if ((phase === "directing" || phase === "writing") && engine.displayedThrough === null) showGenHint();
  });
  bus.on("line:show", hideGenHint);
  bus.on("choice:offered", hideGenHint);
  bus.on("engine:phase", ({ phase }) => {
    if (phase !== "play") hideGenHint(); // 选项/结尾/回标题都不该留着提示
  });
  bus.on("generation:status", ({ phase }) => {
    if (phase === "idle" || phase === "error" || phase === "aborted") hideGenHint(); // 停止/失败=不再有下一行
  });

  // ---- 迟到译文整句换写(2026-10-28 用户裁决:等译文不能久等) ----
  // textOf 超时先打日文后,译文才回来:若该行仍停在正文区且已打完,把整句换成中文——
  // 不打断打字、不重打;行已翻页/被提示占据(textContent 对不上原文)则不动。
  let curLine: { id: LineId; ja: string; done: boolean } | null = null;
  bus.on("line:show", ({ lineId, ev }) => {
    curLine = { id: lineId, ja: ev.text, done: false };
  });
  bus.on("typewriter:done", ({ lineId }) => {
    if (curLine?.id === lineId) curLine.done = true;
  });

  // ---- 舞台点击推进(mock 同款守卫:按钮/面板/选项/toast 不透传) ----
  stageEl.addEventListener("click", (ev) => {
    const target = ev.target as HTMLElement | null;
    if (target?.closest("button, a, input, .panel, .mitem, .gal-choice, .toast, .status-tag")) return;
    if (document.querySelector(".panel")) return; // 面板开着:点击只关面板逻辑归 React
    const ph = engine.phase;
    if (ph !== "play" && ph !== "choicing") return;
    engine.advance();
  });

  // ---- 语音(M6 降级链):[GPT-SoVITS(per-char ref) → SilentProvider] ----
  // 裁决7:三角色暂共用 assets/2 供体(defaultRefId),manifest per-char 覆盖即生效;
  // 降级永久不回切(演出中声线不变),onDegraded 转 voice:state + warnings 可见化。
  const voiceChar = Object.values(pack.characters).find((c) => c.voice);
  let synth: VoiceSynthPort | null = null;
  if (voiceChar?.voice) {
    const refs: GptSovitsRefs = {};
    for (const [id, c] of Object.entries(pack.characters)) {
      if (c.voice) {
        refs[id] = {
          refAudioPath: c.voice.refAudioPathServer,
          promptText: c.voice.promptText,
          promptLang: c.voice.promptLang,
        };
      }
    }
    const gptsovits = new GptSovitsProvider(
      {
        baseUrl: "", // Provider 自拼 "/tts" → Vite proxy 1:1 转发 9880("/tts/tts" 是 404 陷阱)
        refAudioPath: voiceChar.voice.refAudioPathServer,
        promptText: voiceChar.voice.promptText,
        promptLang: voiceChar.voice.promptLang,
      },
      refs,
      voiceChar.id, // defaultRefId
    );
    const router = new TtsRouter({
      providers: [gptsovits, new SilentProvider()],
      onDegraded: (from, to) => {
        const m = `TTS 降級:${from} → ${to ?? "なし"}(再起動まで復帰しません)`;
        warnings.push(m);
        bus.emit("voice:state", { lineId: "router", state: to === "silent" ? "muted" : "failed" });
        console.warn("[tts]", m);
      },
    });
    synth = new AppVoiceSynth(new SynthQueue(router));
  }

  // 语音 = 纯旁路观察者(2026-10-17 泵重写):只订阅 line:show,结构上不可能门控对话节奏
  // voiced 白名单:无语音配置的角色(主角)静音——Router 的默认供体回落只服务在册角色
  if (synth) {
    const voiced = new Set(Object.values(pack.characters).filter((c) => c.voice).map((c) => c.id));
    void new VoicePipeline({
      bus,
      synth,
      voiceChannelOf: () => audio.voiceChannel, // 活引用:装配早于解锁,快照会永远拿到 null
      content,
      clock,
      voiced,
      log: (m) => console.log("[voice]", m), // 排查埋点(静音卫兵/切句/预取/状态),常驻
    });
  }

  // ---- 导演/编剧/摘要(同一条 LLM 连接)+ 字幕翻译(app 层非核心,共用连接) ----
  const llm = new DeepseekClient({ apiKey: "", baseUrl: "/llm" }); // dev:key 由 Vite proxy 注入
  const story = createStoryService({
    llm,
    apiKey: "",
    baseUrl: "/llm",
    pack,
    onError: (e) => {
      const m = e instanceof Error ? e.message : String(e);
      warnings.push(m);
      console.warn("[story]", m);
    },
  });

  // ---- 字幕翻译预取泵(app 层非核心;2026-10-28 裁决:中文不许忽明忽暗、选项也要中文) ----
  // 行提交即入待译池(150ms 防抖合批),不等段收束——玩家读到该行时中文基本已就位
  // (textOf 等它);选项按钮/prompt 同批翻译,attachChoiceLabels 回写。失败静默回退日文。
  const translate = createTranslator({
    llm,
    apiKey: "",
    baseUrl: "/llm",
    onError: (e) => console.warn("[translate]", e instanceof Error ? e.message : String(e)),
  });
  const transQueue = new Map<string, string>(); // lineId 或伪 id(`${lineId}|opt:${id}`/`${lineId}|prompt`)→ 日文
  const zhWaiters = new Map<LineId, Set<(zh: string | null) => void>>(); // textOf 等译文的行
  let transTimer = 0;
  const flushTranslate = (): void => {
    transTimer = 0;
    if (transQueue.size === 0) return;
    const items = [...transQueue].map(([lineId, text]) => ({ lineId, text }));
    transQueue.clear();
    void translate(items)
      .then((map) => {
        if (map.size === 0) return;
        const lines: { lineId: LineId; zh: string }[] = [];
        const choices = new Map<LineId, { prompt?: string; labels: { optionId: string; zh: string }[] }>();
        for (const [id, zh] of map) {
          const bar = id.indexOf("|");
          if (bar < 0) {
            lines.push({ lineId: id as LineId, zh });
            continue;
          }
          const lineId = id.slice(0, bar) as LineId;
          const rest = id.slice(bar + 1); // "prompt" 或 "opt:<optionId>"
          const entry = choices.get(lineId) ?? { labels: [] };
          if (rest === "prompt") entry.prompt = zh;
          else entry.labels.push({ optionId: rest.slice(4), zh });
          choices.set(lineId, entry);
        }
        if (lines.length > 0) {
          engine.attachTranslations(lines);
          for (const { lineId, zh } of lines) {
            const set = zhWaiters.get(lineId);
            if (set) {
              for (const res of set) res(zh);
              zhWaiters.delete(lineId);
            }
            // 迟到译文换写:该行超时先打了日文、现已打完且仍停在正文区 → 整句换中文
            if (curLine && curLine.done && curLine.id === lineId && textEl.textContent === curLine.ja) {
              textEl.textContent = zh;
              curLine.ja = zh; // 后续同 id 重复回写不会再换(对不上即跳过)
            }
          }
        }
        if (choices.size > 0) engine.attachChoiceLabels([...choices].map(([lineId, v]) => ({ lineId, ...v })));
      })
      .catch(() => {}); // translate 内部已吞错;兜一层防 unhandled
  };
  bus.on("line:commit", ({ event, lineId }) => {
    if (uiLang !== "zh") return; // 日文模式:不做翻译(选项浮层由 zhOn 关兜底,2026-10-28)
    if (event.t === "say" || event.t === "narrate") {
      transQueue.set(lineId, event.text);
    } else if (event.t === "choice") {
      if (event.prompt) transQueue.set(`${lineId}|prompt`, event.prompt);
      for (const o of event.options) transQueue.set(`${lineId}|opt:${o.id}`, o.label);
    } else {
      return;
    }
    if (!transTimer) transTimer = window.setTimeout(flushTranslate, 150);
  });

  let runner: BeatRunner | null = null;
  const ensureRunner = (): BeatRunner => {
    runner ??= new BeatRunner({
      engine,
      bus,
      story,
      content,
      outlineBeatCount: outlineBeatCount(pack.story.outlineMd),
      onError: (e) => {
        const m = e instanceof Error ? e.message : String(e);
        warnings.push(m);
        console.warn("[runner]", m);
      },
    });
    return runner;
  };

  // 名牌是 line:show 驱动的;读档 restoreFromSave 的已看前缀 replay 不发该事件 →
  // 按 displayedThrough 扫 ledger 补同步(未读尾部由泵逐行显示时自然接上)
  const syncNamePlate = (): void => {
    if (!engine.displayedThrough) {
      plateEl.classList.remove("on");
      return;
    }
    for (const e of engine.ledger) {
      if (e.kind !== "ev") continue;
      if (e.ev.t === "say") {
        plateNm.textContent = content.displayNameOf(e.ev.who);
        plateEl.style.setProperty("--pc", pack.characters[e.ev.who]?.color || "");
        plateEl.classList.add("on");
      } else if (e.ev.t === "narrate") {
        plateEl.classList.remove("on");
      }
      if (e.lineId === engine.displayedThrough) break;
    }
  };

  const saves = new SaveSystem({ engine, bus, storage: new LocalStorageAdapter(), getRunner: () => runner });

  // 设置初载(M6):字速/音量/语言,重启保留(App 的 lang 初始值同源读取)
  applySettings({ engine, audio }, loadSettings());

  /** 读档共用:恢复引擎+runner → 名牌同步 → 起循环。
   *  旧 run() 可能挂在 LLM 退避/流等待里——等它真正退出再起跑,否则单飞保护静默拒绝,
   *  读档后永不再生成(2026-10-18 审计 H2;50ms 轮询 ×100 = 5s 上限) */
  const resumeAndRun = async (save: SaveData): Promise<void> => {
    audio.unlock(); // 手势入口(菜单/标题按钮)内调用,坑#16
    const r = ensureRunner();
    saves.continueFrom(save);
    syncNamePlate();
    for (let i = 0; r.running && i < 100; i++) {
      await new Promise((res) => setTimeout(res, 50));
    }
    await r.run();
  };

  return {
    pack,
    content,
    engine,
    stage,
    bus,
    audio,
    saves,
    warnings,
    get runner() {
      return runner;
    },
    start() {
      audio.unlock(); // 坑#16:必须在点击手势里
      engine.startPlayClock();
      void ensureRunner().run();
    },
    startFromSave(save: SaveData) {
      engine.startPlayClock();
      return resumeAndRun(save);
    },
    continueFrom(save: SaveData) {
      return resumeAndRun(save);
    },
    stop() {
      runner?.stopGeneration();
    },
    newGame() {
      runner?.newGame();
    },
    setUiLang(l: Lang) {
      uiLang = l; // 闭包引用:下一行显示生效,不重打当前行
      engine.refreshChoice(); // 开着的选项浮层按新语言重画(浮层渲染时实时读 zhOn)
    },
  };
}
