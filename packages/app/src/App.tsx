/**
 * play 壳(M3→M6):舞台/台词窗/选项浮层都是原生 DOM(bootstrap+engine),
 * React 只做 chrome——标题、HUD、面板(存读/设置/历史)、preview/警告。
 * M6:KeyBindings(Enter/Space、Ctrl fast、↑/滚轮 backlog、Esc)、i18n(ja/zh)、
 * 设置面板(字速/音量/语言,global 持久化)。
 */
import { useEffect, useRef, useState } from "react";
import { KeyBindings } from "@gal/engine";
import type { EngineSnapshot } from "@gal/engine";
import type { ClockMode, SaveData } from "@gal/shared";
import { getAssembled } from "./bootstrap.ts";
import type { Assembled } from "./bootstrap.ts";
import { loadSettings, saveSettings } from "./state/settings.ts";
import { t, type Lang } from "./i18n/strings.ts";
import { SaveLoadPanel } from "./ui/SaveLoadPanel.tsx";
import { SettingsPanel } from "./ui/SettingsPanel.tsx";
import { BacklogPanel } from "./ui/BacklogPanel.tsx";

type PanelMode = "save" | "load" | "settings" | "backlog";

export function App() {
  const [asm, setAsm] = useState<Assembled | null>(null);
  const [fatal, setFatal] = useState("");
  const [snap, setSnap] = useState<EngineSnapshot | null>(null);
  const [preview, setPreview] = useState("");
  const [status, setStatus] = useState("");
  const [warning, setWarning] = useState("");
  const [voiceFail, setVoiceFail] = useState(0);
  const [panel, setPanel] = useState<PanelMode | null>(null);
  const [autoSave, setAutoSave] = useState<SaveData | null>(null);
  const [lang, setLang] = useState<Lang>(() => loadSettings().lang); // 与 bootstrap 初载同源
  const kbRef = useRef<KeyBindings | null>(null);
  const prevMode = useRef<ClockMode>("normal");
  const tr = t(lang);

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
    setAutoSave(asm.saves.latestAuto());
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

  // 键位(M6):面板开时进入"仅 Esc"模式(由 panel 副作用同步)
  useEffect(() => {
    if (!asm) return;
    const kb = new KeyBindings({
      advance: () => asm.engine.advance(),
      setFast: (on) => {
        const clock = asm.engine.clock;
        if (on) {
          if (clock.mode !== "fast") prevMode.current = clock.mode;
          clock.setMode("fast");
        } else {
          clock.setMode(prevMode.current === "fast" ? "normal" : prevMode.current);
        }
      },
      toggleBacklog: () => setPanel((p) => (p === "backlog" ? null : "backlog")),
      togglePause: () => setPanel((p) => (p === "settings" ? null : "settings")),
      closePanel: () => setPanel(null),
    });
    kb.attach();
    kbRef.current = kb;
    return () => {
      kb.detach();
      kbRef.current = null;
    };
  }, [asm]);

  useEffect(() => {
    kbRef.current?.setPanelOpen(panel !== null);
  }, [panel, asm]);

  const changeLang = (l: Lang): void => {
    setLang(l);
    saveSettings({ ...loadSettings(), lang: l }); // 面板内 update() 只在点字速/音量时写盘,语言单独落
  };

  if (fatal) {
    return (
      <div className="chrome fatal">
        <h1>{tr.fatal}</h1>
        <p>{fatal}</p>
      </div>
    );
  }
  if (!asm || !snap) {
    return <div className="chrome loading">{tr.loading}</div>;
  }

  if (snap.phase === "title") {
    return (
      <div className="chrome title-screen">
        <h1 className="game-title">{tr.title}</h1>
        <p className="game-sub">{tr.subtitle}</p>
        <button type="button" className="start-btn" onClick={() => asm.start()}>
          {tr.start}
        </button>
        {autoSave && (
          <button type="button" className="start-btn sub" onClick={() => void asm.startFromSave(autoSave)}>
            {tr.resume}
          </button>
        )}
        <p className="title-note">{tr.titleNote}</p>
      </div>
    );
  }

  const busy = snap.phase !== "choicing";

  return (
    <>
      {/* 画面点击 = 打字机快进(选项浮起/面板开时关闭) */}
      <div
        className="click-catcher"
        style={{ display: busy && panel === null ? "block" : "none" }}
        onClick={() => asm.engine.advance()}
      />

      <div className="chrome hud">
        {status && <span className="chip">{status}</span>}
        {preview && <span className="chip ghost">…{preview.slice(-24)}</span>}
        {warning && (
          <span className="chip warn" title={warning}>
            ⚠
          </span>
        )}
        {voiceFail > 0 && <span className="chip warn">{tr.voiceFail(voiceFail)}</span>}
        <button type="button" className="chip btn" onClick={() => setPanel("save")}>
          {tr.save}
        </button>
        <button type="button" className="chip btn" onClick={() => setPanel("load")}>
          {tr.load}
        </button>
        <button type="button" className="chip btn" onClick={() => setPanel("backlog")}>
          {tr.backlog}
        </button>
        <button type="button" className="chip btn" onClick={() => setPanel("settings")}>
          {tr.settings}
        </button>
        {asm.runner?.running && (
          <button type="button" className="chip btn" onClick={() => asm.stop()}>
            {tr.stop}
          </button>
        )}
      </div>

      {panel === "save" && <SaveLoadPanel asm={asm} lang={lang} mode="save" onClose={() => setPanel(null)} />}
      {panel === "load" && <SaveLoadPanel asm={asm} lang={lang} mode="load" onClose={() => setPanel(null)} />}
      {panel === "settings" && <SettingsPanel asm={asm} lang={lang} onLang={changeLang} onClose={() => setPanel(null)} />}
      {panel === "backlog" && <BacklogPanel asm={asm} lang={lang} onClose={() => setPanel(null)} />}
    </>
  );
}
