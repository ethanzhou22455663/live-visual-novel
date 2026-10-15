/**
 * 最小 play 壳(M3):舞台与台词窗是原生 DOM(bootstrap),React 只做 chrome——
 * 标题画面、临时选项按钮、状态条/preview/警告。UI 面板(存档/设置/backlog)M4-M6。
 */
import { useEffect, useState } from "react";
import type { EngineSnapshot } from "@gal/engine";
import { getAssembled } from "./bootstrap.ts";
import type { Assembled } from "./bootstrap.ts";

export function App() {
  const [asm, setAsm] = useState<Assembled | null>(null);
  const [fatal, setFatal] = useState("");
  const [snap, setSnap] = useState<EngineSnapshot | null>(null);
  const [preview, setPreview] = useState("");
  const [status, setStatus] = useState("");
  const [warning, setWarning] = useState("");
  const [voiceFail, setVoiceFail] = useState(0);

  useEffect(() => {
    let alive = true;
    getAssembled()
      .then((a) => {
        if (alive) setAsm(a);
      })
      .catch((e) => {
        if (alive) setFatal(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!asm) return;
    setSnap(asm.engine.snapshot());
    const offs = [
      asm.engine.subscribe(() => setSnap(asm.engine.snapshot())),
      asm.bus.on("generation:preview", ({ text }) => setPreview(text)),
      asm.bus.on("generation:status", ({ phase, error }) => {
        setStatus(error ?? (phase === "idle" ? "" : phase));
        if (phase === "idle") setPreview("");
      }),
      asm.bus.on("engine:warning", ({ message }) => setWarning(message)),
      asm.bus.on("voice:state", ({ state }) => {
        if (state === "failed") setVoiceFail((n) => n + 1); // 降级可见化(承 P0)
      }),
    ];
    return () => {
      for (const off of offs) off();
    };
  }, [asm]);

  if (fatal) {
    return (
      <div className="chrome fatal">
        <h1>起動に失敗しました</h1>
        <p>{fatal}</p>
      </div>
    );
  }
  if (!asm || !snap) {
    return <div className="chrome loading">読み込み中…</div>;
  }

  if (snap.phase === "title") {
    return (
      <div className="chrome title-screen">
        <h1 className="game-title">レモネード・ファクトリー</h1>
        <p className="game-sub">AI 実時生成ノベル — P1</p>
        <button type="button" className="start-btn" onClick={() => asm.start()}>
          スタート
        </button>
        <p className="title-note">DeepSeek proxy(/llm)と GPT-SoVITS(:9880)が稼働中であること</p>
      </div>
    );
  }

  const busy = snap.phase !== "choicing";

  return (
    <>
      {/* 画面点击 = 打字机快进(选项浮起时关闭) */}
      <div
        className="click-catcher"
        style={{ display: busy ? "block" : "none" }}
        onClick={() => asm.engine.advance()}
      />

      <div className="chrome hud">
        {status && <span className="chip">{status}</span>}
        {preview && <span className="chip ghost">…{preview.slice(-24)}</span>}
        {warning && <span className="chip warn" title={warning}>⚠</span>}
        {voiceFail > 0 && <span className="chip warn">音声失敗×{voiceFail}</span>}
        {asm.runner?.running && (
          <button type="button" className="chip btn" onClick={() => asm.stop()}>
            ■ 停止
          </button>
        )}
      </div>

      {snap.pendingChoice && (
        <div className="choice-overlay">
          {snap.pendingChoice.prompt && <p className="choice-prompt">{snap.pendingChoice.prompt}</p>}
          <div className="choice-list">
            {snap.pendingChoice.options.map((o) => (
              <button
                key={o.id}
                type="button"
                className="choice-btn"
                onClick={() => asm.engine.resolveChoice(o.id)}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
