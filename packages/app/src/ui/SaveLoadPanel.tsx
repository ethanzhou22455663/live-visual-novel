/**
 * 存读面板(M5):4 槽(auto+manual×3)一覧。セーブモードでは auto をシステム専用として
 * 无効化;ロードは空槽「データなし」、壊档は理由表示。実読書きは SaveSystem へ委譲。
 */
import { useState } from "react";
import type { SaveData, SaveSlot } from "@gal/shared";
import type { Assembled } from "../bootstrap.ts";

const SLOT_LABEL: Record<SaveSlot, string> = {
  auto: "オート",
  "manual-0": "セーブ 1",
  "manual-1": "セーブ 2",
  "manual-2": "セーブ 3",
};

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
  mode,
  onClose,
}: {
  asm: Assembled;
  mode: "save" | "load";
  onClose: () => void;
}) {
  const [slots] = useState(() => asm.saves.list());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const doSave = (slot: SaveSlot): void => {
    setErr("");
    const r = asm.saves.save(slot);
    if (!r.ok) {
      setErr(r.reason === "quota" ? "保存に失敗しました(容量不足)" : "保存に失敗しました");
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
    <div className="panel-overlay" role="dialog" aria-label={mode === "save" ? "セーブ" : "ロード"}>
      <div className="panel">
        <header className="panel-head">
          <h2>{mode === "save" ? "セーブ" : "ロード"}</h2>
          <button type="button" className="panel-close" onClick={onClose}>
            ✕
          </button>
        </header>
        {err && <p className="panel-err">{err}</p>}
        <div className="slot-list">
          {slots.map(({ slot, data, error }) => (
            <div key={slot} className="slot-row" data-slot={slot}>
              <div className="slot-info">
                <span className="slot-name">{SLOT_LABEL[slot]}</span>
                {data ? (
                  <span className="slot-meta">
                    {fmtSavedAt(data.meta.savedAt)} / {fmtPlayTime(data.meta.playTimeSec)} / {data.meta.chapterLabel}
                  </span>
                ) : (
                  <span className="slot-meta empty">{error ? `壊れたデータ(${error})` : "データなし"}</span>
                )}
              </div>
              <div className="slot-actions">
                {mode === "save" && slot !== "auto" && (
                  <button type="button" className="slot-btn" disabled={busy} onClick={() => doSave(slot)}>
                    保存
                  </button>
                )}
                {mode === "load" && (
                  <button
                    type="button"
                    className="slot-btn"
                    disabled={busy || !data}
                    onClick={() => data && void doLoad(data)}
                  >
                    ロード
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
                    消去
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
