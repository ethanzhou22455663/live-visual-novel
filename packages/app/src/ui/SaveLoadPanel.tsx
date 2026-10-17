/**
 * 存读面板(M5,M6 i18n 化;mock/ui.html 类名):4 槽(auto+manual×3)一覧。
 * セーブモードでは auto をシステム専用として無効化;ロードは空槽「データなし」、
 * 壊档は理由表示。実読書きは SaveSystem へ委譲。
 */
import { useState } from "react";
import type { SaveData, SaveSlot } from "@gal/shared";
import type { Assembled } from "../bootstrap.ts";
import { t, type Lang } from "../i18n/strings.ts";

function fmtPlayTime(sec: number): string {
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`
    : `${m}:${String(ss).padStart(2, "0")}`;
}

function fmtSavedAt(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function SaveLoadPanel({
  asm,
  lang,
  mode,
  onClose,
}: {
  asm: Assembled;
  lang: Lang;
  mode: "save" | "load";
  onClose: () => void;
}) {
  const [slots] = useState(() => asm.saves.list());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const tr = t(lang);
  const slotLabel = (slot: SaveSlot): string =>
    slot === "auto" ? tr.auto : tr.slot(Number(slot.slice("manual-".length)) + 1);

  const doSave = (slot: SaveSlot): void => {
    setErr("");
    const r = asm.saves.save(slot);
    if (!r.ok) {
      setErr(r.reason === "quota" ? tr.saveFailedQuota : tr.saveFailed);
      return;
    }
    onClose(); // deferred(生成中)でも受理済み:次の行境界で落ちる
  };

  const doLoad = async (data: SaveData): Promise<void> => {
    setBusy(true);
    setErr("");
    try {
      await asm.continueFrom(data);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel" role="dialog" aria-label={mode === "save" ? tr.save : tr.load}>
      <div className="pbox">
        <header className="phead">
          <h2>{mode === "save" ? tr.save : tr.load}</h2>
          <button type="button" className="pclose" onClick={onClose}>
            ✕
          </button>
        </header>
        <div className="pbody">
          {err && <p className="panel-err">{err}</p>}
          <div className="slots">
            {slots.map(({ slot, data, error }) => (
              <div key={slot} className="slot" data-slot={slot}>
                <span className={`tag${slot === "auto" ? " off" : ""}`}>{slotLabel(slot)}</span>
                <div className="meta">
                  {data ? (
                    <>
                      <b>{data.meta.chapterLabel}</b>
                      {fmtSavedAt(data.meta.savedAt)} / {fmtPlayTime(data.meta.playTimeSec)}
                    </>
                  ) : (
                    <b className="empty">{error ? tr.broken(error) : tr.noData}</b>
                  )}
                </div>
                <div className="slot-actions">
                  {mode === "save" && slot !== "auto" && (
                    <button type="button" className="slot-btn" disabled={busy} onClick={() => doSave(slot)}>
                      {tr.doSave}
                    </button>
                  )}
                  {mode === "load" && (
                    <button
                      type="button"
                      className="slot-btn"
                      disabled={busy || !data}
                      onClick={() => data && void doLoad(data)}
                    >
                      {tr.doLoad}
                    </button>
                  )}
                  {data && slot !== "auto" && (
                    <button
                      type="button"
                      className="slot-btn danger"
                      disabled={busy}
                      onClick={() => {
                        asm.saves.remove(slot);
                        onClose();
                      }}
                    >
                      {tr.doDelete}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
