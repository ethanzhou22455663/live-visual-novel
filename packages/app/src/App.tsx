/**
 * chrome 壳(M3→M6,mock/ui.html 移植):舞台/台词窗/选项浮层都是原生 DOM
 * (bootstrap+engine),React 只画——标题画面(.title)、快捷菜单(.quick)、
 * 状态角标(.status-tag)、toast、面板(存读/设置/历史)。
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
  const [panel, setPanel] = useState<PanelMode | null>(null);
  const [autoSave, setAutoSave] = useState<SaveData | null>(null);
  const [lang, setLang] = useState<Lang>(() => loadSettings().lang); // 与 bootstrap 初载同源
  const [toast, setToast] = useState<{ id: number; msg: string } | null>(null);
  const kbRef = useRef<KeyBindings | null>(null);
  const prevMode = useRef<ClockMode>("normal");
  const toastSeq = useRef(0);
  const voiceFailToasted = useRef(false);
  const tr = t(lang);
  const trRef = useRef(tr); // bus 回调里拿最新文案(闭包捕获的是挂载时的 lang)
  trRef.current = tr;

  const showToast = (msg: string): void => setToast({ id: ++toastSeq.current, msg });

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
      asm.bus.on("engine:warning", ({ message }) => showToast(message)), // toast(mock;替代旧 ⚠ chip)
      asm.bus.on("voice:state", ({ state }) => {
        // TTS 降级可见化(承 P0):仅首次 failed/muted 弹 toast,不刷屏
        if ((state === "failed" || state === "muted") && !voiceFailToasted.current) {
          voiceFailToasted.current = true;
          showToast(trRef.current.voiceFail(1));
        }
      }),
    ];
    return () => {
      for (const off of offs) off();
    };
  }, [asm]);

  // toast 3.2s 自动消退(新 toast 顶替旧 toast,计时重置)
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(timer);
  }, [toast]);

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

  // 面板:标题与 play 共用(标题里也能开设置);asm 未就绪时自然为 null
  const panelNode = asm
    ? panel === "save"
      ? <SaveLoadPanel asm={asm} lang={lang} mode="save" onClose={() => setPanel(null)} />
      : panel === "load"
        ? <SaveLoadPanel asm={asm} lang={lang} mode="load" onClose={() => setPanel(null)} />
        : panel === "settings"
          ? <SettingsPanel asm={asm} lang={lang} onLang={changeLang} onClose={() => setPanel(null)} />
          : panel === "backlog"
            ? <BacklogPanel asm={asm} lang={lang} onClose={() => setPanel(null)} />
            : null
    : null;

  const toastNode = toast ? (
    <div className="toast" key={toast.id}>
      {toast.msg}
    </div>
  ) : null;

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
      <div className="title">
        <div className="shade" />
        <div className="logo">
          <div className="kicker">{tr.subtitle}</div>
          <h1>{tr.title}</h1>
        </div>
        <div className="menu">
          <button type="button" className="mitem" onClick={() => asm.start()}>
            {tr.start}
          </button>
          {autoSave && (
            <button type="button" className="mitem" onClick={() => void asm.startFromSave(autoSave)}>
              {tr.resume}
            </button>
          )}
          <button type="button" className="mitem" onClick={() => setPanel("settings")}>
            {tr.settings}
          </button>
        </div>
        <div className="tfoot">{tr.titleNote}</div>
        {panelNode}
        {toastNode}
      </div>
    );
  }

  return (
    <>
      {(status || preview) && (
        <div className="status-tag">
          {status}
          {preview ? ` …${preview.slice(-16)}` : ""}
        </div>
      )}
      <div className="quick">
        <button type="button" className="qbtn" onClick={() => setPanel("backlog")}>
          {tr.backlog}
        </button>
        <button type="button" className="qbtn" onClick={() => setPanel("save")}>
          {tr.save}
        </button>
        <button type="button" className="qbtn" onClick={() => setPanel("load")}>
          {tr.load}
        </button>
        <button type="button" className="qbtn" onClick={() => setPanel("settings")}>
          {tr.settings}
        </button>
        {asm.runner?.running && (
          <button type="button" className="qbtn" onClick={() => asm.stop()}>
            {tr.stop}
          </button>
        )}
      </div>
      {panelNode}
      {toastNode}
    </>
  );
}
