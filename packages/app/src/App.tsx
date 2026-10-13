import { useCallback, useRef, useState } from "react";
import { AudioBus, Typewriter } from "@gal/engine";
import type { VoiceChannel } from "@gal/engine";
import type { LineId, NarrateEvent, SayEvent } from "@gal/shared";
import { runP0 } from "./p0run.ts";

type Phase = "idle" | "running" | "done" | "error";

interface LogLine {
  key: string;
  who: string | null;
  emotion: string | null;
  text: string;
}

const SCENE_PROMPT =
  "夕暮れの商店街。主人公の前に、同級生のユキが待っていた。久しぶりの再会を喜ぶ、穏やかで温かい日常シーン。";

export function App() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [status, setStatus] = useState("");
  const [current, setCurrent] = useState<{ who: string | null; emotion: string | null } | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);
  const [preview, setPreview] = useState("");
  const [error, setError] = useState("");
  const [voiceFail, setVoiceFail] = useState(0);

  const textRef = useRef<HTMLDivElement>(null);
  const typewriterRef = useRef<Typewriter | null>(null);
  const busRef = useRef<AudioBus | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const vcRef = useRef<VoiceChannel | null>(null);

  const start = useCallback(async () => {
    const refPath = import.meta.env.VITE_TTS_REF_PATH;
    if (!refPath) {
      setError("未配置 VITE_TTS_REF_PATH——复制 .env.example 为 .env 并填入参考音频绝对路径");
      setPhase("error");
      return;
    }
    const bus = (busRef.current ??= new AudioBus());
    bus.unlock(); // 坑 #16:必须在点击手势里解锁
    vcRef.current = bus.voiceChannel;
    typewriterRef.current = new Typewriter(textRef.current!, { cps: 28 });

    setPhase("running");
    setError("");
    setVoiceFail(0);
    setLog([]);
    setCurrent(null);
    setStatus("LLM 接続中…");
    const abort = new AbortController();
    abortRef.current = abort;

    try {
      const n = await runP0(
        {
          apiKey: "", // dev:key 由 Vite proxy 注入,浏览器永远拿不到
          llmBaseUrl: "/llm",
          ttsBaseUrl: "", // dev:Provider 自拼 "/tts" → Vite proxy 1:1 转发 9880("/tts/tts" 是 404 陷阱,勿传 "/tts")
          refAudioPath: refPath,
          promptText: import.meta.env.VITE_TTS_PROMPT_TEXT ?? "",
          scenePrompt: SCENE_PROMPT,
          signal: abort.signal,
        },
        {
          onPreview: setPreview,
          onStatus: setStatus,
          onCommit: (ev, lineId) => {
            if (ev.t === "say" || ev.t === "narrate") {
              setLog((prev) => [
                ...prev.slice(-8),
                {
                  key: lineId,
                  who: ev.t === "say" ? ev.who : null,
                  emotion: ev.t === "say" ? ev.emotion : null,
                  text: ev.text,
                },
              ]);
            }
          },
          present: async (ev: SayEvent | NarrateEvent) => {
            if (ev.t === "say") setCurrent({ who: ev.who, emotion: ev.emotion });
            else setCurrent(null);
            await typewriterRef.current!.start(ev.text);
          },
          voiceChannel: vcRef.current,
          onVoiceState: (lineId, state) => {
            if (state === "failed") setVoiceFail((n) => n + 1); // 降级可见化:静音不再无声无息
          },
        },
      );
      setStatus(`完走:${n} 行`);
      setPhase("done");
    } catch (e) {
      if (abort.signal.aborted) {
        setStatus("停止しました");
        setPhase("idle");
        return;
      }
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }, []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    typewriterRef.current?.cancel();
  }, []);

  const skipTyping = useCallback(() => typewriterRef.current?.skip(), []);

  return (
    <main className="stage" onClick={skipTyping}>
      <h1 className="title">AI 実時生成 Prototype — P0</h1>
      <p className="subtitle">DeepSeek 流式 → NDJSON → 逐字上屏 → GPT-SoVITS 连播</p>

      <section className="vn-window">
        <div className="nameplate">
          {current?.who ? (
            <>
              <span className="name">{current.who}</span>
              {current.emotion && <span className="emo">{current.emotion}</span>}
            </>
          ) : (
            <span className="name dim">ナレーション</span>
          )}
        </div>
        <div className="text" ref={textRef} />
      </section>

      <div className="ghost">{preview ? `生成中… ${preview}` : ""}</div>

      <section className="log" aria-label="backlog">
        {log.map((l) => (
          <p key={l.key} className="logline">
            {l.who && (
              <strong>
                {l.who}
                {l.emotion ? `(${l.emotion})` : ""}:
              </strong>
            )}{" "}
            {l.text}
          </p>
        ))}
      </section>

      <div className="controls" onClick={(e) => e.stopPropagation()}>
        {phase === "running" ? (
          <button type="button" onClick={stop}>
            ■ 停止
          </button>
        ) : (
          <button type="button" onClick={start}>
            ▶ 開始
          </button>
        )}
        <span className="status">{status}</span>
        {voiceFail > 0 && <span className="error">音声失敗×{voiceFail}(静音降級)</span>}
      </div>
      {error && <div className="error">{error}</div>}
      <p className="hint">画面クリック=打字机快进 / GPT-SoVITS(127.0.0.1:9880)と DeepSeek proxy が稼働中であること</p>
    </main>
  );
}
