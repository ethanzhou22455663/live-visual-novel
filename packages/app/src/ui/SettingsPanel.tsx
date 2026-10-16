/**
 * 设置面板(M6):字速五档 / 三音量 / UI 语言。改动即时生效 + 持久化(global scope)。
 */
import { useState } from "react";
import type { Assembled } from "../bootstrap.ts";
import { t, type Lang } from "../i18n/strings.ts";
import { CPS_TIERS, applySettings, loadSettings, saveSettings, type GameSettings } from "../state/settings.ts";

export function SettingsPanel({
  asm,
  lang,
  onLang,
  onClose,
}: {
  asm: Assembled;
  lang: Lang;
  onLang: (l: Lang) => void;
  onClose: () => void;
}) {
  const [s, setS] = useState<GameSettings>(() => loadSettings());
  const tr = t(lang);
  const update = (next: GameSettings): void => {
    setS(next);
    applySettings(asm, next);
    saveSettings(next);
  };
  const speedIndex = Math.max(0, CPS_TIERS.indexOf(s.cpsMs as (typeof CPS_TIERS)[number]));

  return (
    <div className="panel-overlay" role="dialog" aria-label={tr.settings}>
      <div className="panel">
        <header className="panel-head">
          <h2>{tr.settings}</h2>
          <button type="button" className="panel-close" onClick={onClose}>
            ✕
          </button>
        </header>

        <section className="set-group">
          <h3>{tr.textSpeed}</h3>
          <div className="set-tiers">
            {CPS_TIERS.map((ms, i) => (
              <button
                key={ms}
                type="button"
                className={`tier-btn${i === speedIndex ? " on" : ""}`}
                onClick={() => update({ ...s, cpsMs: ms })}
              >
                {tr.speedLabels[i]}
              </button>
            ))}
          </div>
        </section>

        <section className="set-group">
          <h3>{tr.volume}</h3>
          {(["bgm", "se", "voice"] as const).map((ch) => (
            <label key={ch} className="set-vol">
              <span className="vol-label">{tr[ch]}</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={s.volumes[ch]}
                onChange={(e) => update({ ...s, volumes: { ...s.volumes, [ch]: Number(e.target.value) } })}
              />
              <span className="vol-num">{Math.round(s.volumes[ch] * 100)}</span>
            </label>
          ))}
        </section>

        <section className="set-group">
          <h3>{tr.language}</h3>
          <div className="set-tiers">
            {(["ja", "zh"] as const).map((l) => (
              <button key={l} type="button" className={`tier-btn${lang === l ? " on" : ""}`} onClick={() => onLang(l)}>
                {l === "ja" ? "日本語" : "中文"}
              </button>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
