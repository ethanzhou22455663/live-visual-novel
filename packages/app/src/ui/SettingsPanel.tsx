/**
 * 设置面板(M6;mock/ui.html 类名 .cfgrow/.tier-btn):字速五档 / 三音量 / UI 语言。
 * 改动即时生效 + 持久化(global scope)。
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
    <div className="panel" role="dialog" aria-label={tr.settings}>
      <div className="pbox">
        <header className="phead">
          <h2>{tr.settings}</h2>
          <button type="button" className="pclose" onClick={onClose}>
            ✕
          </button>
        </header>
        <div className="pbody">
          {/* 字速:五档文字按钮(mock .set-tiers) */}
          <div className="cfgrow">
            <label>{tr.textSpeed}</label>
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
          </div>

          {/* 三音量:range + 数值(mock .cfgrow) */}
          {(["bgm", "se", "voice"] as const).map((ch) => (
            <div key={ch} className="cfgrow">
              <label>{tr[ch]}</label>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={s.volumes[ch]}
                onChange={(e) => update({ ...s, volumes: { ...s.volumes, [ch]: Number(e.target.value) } })}
              />
              <span className="val">{Math.round(s.volumes[ch] * 100)}</span>
            </div>
          ))}

          {/* UI 语言 */}
          <div className="cfgrow">
            <label>{tr.language}</label>
            <div className="set-tiers">
              {(["ja", "zh"] as const).map((l) => (
                <button key={l} type="button" className={`tier-btn${lang === l ? " on" : ""}`} onClick={() => onLang(l)}>
                  {l === "ja" ? "日本語" : "中文"}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
