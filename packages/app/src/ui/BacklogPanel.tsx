/**
 * 历史记录面板(M6;mock/ui.html 类名 .logrow/.n/.t):ledger 派生只读视图
 * (shared toHistoryItems 的 UI 面(engine/game/Backlog 双实现已删))。cap 200(engine 侧同值);
 * say → 名牌(个人色)+台词,narrate → 暗色旁白,choice → 朱色 ▶ label。
 * 台词语言随 UI 语言:lang=zh 且已有译文显示中文,否则日文原文(与上屏 textOf 同款回退)。
 */
import { useMemo } from "react";
import { toHistoryItems } from "@gal/shared";
import type { Assembled } from "../bootstrap.ts";
import { t, type Lang } from "../i18n/strings.ts";

const CAP = 200;

export function BacklogPanel({ asm, lang, onClose }: { asm: Assembled; lang: Lang; onClose: () => void }) {
  const tr = t(lang);
  const items = useMemo(() => toHistoryItems(asm.engine.ledger, CAP), [asm]);
  const lineOf = (it: { text: string; zh?: string }): string => (lang === "zh" && it.zh ? it.zh : it.text);
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
                  <span className="t">{lineOf(it)}</span>
                </div>
              );
            }
            return (
              <div key={i} className="logrow">
                <span className="n" style={{ color: asm.pack.characters[it.who]?.color || "" }}>
                  {asm.content.displayNameOf(it.who)}
                </span>
                <span className="t">{lineOf(it)}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
