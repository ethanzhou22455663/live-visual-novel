/**
 * 历史记录面板(M6):ledger 派生只读视图(engine.game.Backlog 的 UI 面)。
 * cap 200(engine 侧同值);say → 名牌+台词,narrate → 旁白,choice → ▶ label。
 */
import { useMemo } from "react";
import { toHistoryItems } from "@gal/shared";
import type { Assembled } from "../bootstrap.ts";
import { t, type Lang } from "../i18n/strings.ts";

const CAP = 200;

export function BacklogPanel({ asm, lang, onClose }: { asm: Assembled; lang: Lang; onClose: () => void }) {
  const tr = t(lang);
  const items = useMemo(() => toHistoryItems(asm.engine.ledger, CAP), [asm]);
  return (
    <div className="panel-overlay" role="dialog" aria-label={tr.backlog}>
      <div className="panel wide">
        <header className="panel-head">
          <h2>{tr.backlog}</h2>
          <button type="button" className="panel-close" onClick={onClose}>
            ✕
          </button>
        </header>
        <div className="backlog-list">
          {items.length === 0 && <p className="slot-meta empty">{tr.noData}</p>}
          {items.map((it, i) => {
            if (it.t === "choice") {
              return (
                <p key={i} className="bl-choice">
                  ▶ {it.label}
                </p>
              );
            }
            if (it.t === "narrate") {
              return (
                <p key={i} className="bl-narrate">
                  {it.text}
                </p>
              );
            }
            return (
              <p key={i} className="bl-say">
                <span className="bl-name" style={{ color: asm.pack.characters[it.who]?.color || "" }}>
                  {asm.content.displayNameOf(it.who)}
                </span>
                {it.text}
              </p>
            );
          })}
        </div>
      </div>
    </div>
  );
}
