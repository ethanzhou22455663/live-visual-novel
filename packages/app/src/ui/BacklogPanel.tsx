/**
 * 历史记录面板(M6;mock/ui.html 类名 .logrow/.n/.t):ledger 派生只读视图
 * (engine.game.Backlog 的 UI 面)。cap 200(engine 侧同值);
 * say → 名牌(个人色)+台词,narrate → 暗色旁白,choice → 朱色 ▶ label。
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
    <div className="panel wide" role="dialog" aria-label={tr.backlog}>
      <div className="pbox">
        <header className="phead">
          <h2>{tr.backlog}</h2>
          <button type="button" className="pclose" onClick={onClose}>
            ✕
          </button>
        </header>
        <div className="pbody">
          {items.length === 0 && <p className="bl-empty">{tr.noData}</p>}
          {items.map((it, i) => {
            if (it.t === "choice") {
              return (
                <div key={i} className="logrow ch">
                  <span className="n" />
                  <span className="t">▶ {it.label}</span>
                </div>
              );
            }
            if (it.t === "narrate") {
              return (
                <div key={i} className="logrow nar">
                  <span className="n" />
                  <span className="t">{it.text}</span>
                </div>
              );
            }
            return (
              <div key={i} className="logrow">
                <span className="n" style={{ color: asm.pack.characters[it.who]?.color || "" }}>
                  {asm.content.displayNameOf(it.who)}
                </span>
                <span className="t">{it.text}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
