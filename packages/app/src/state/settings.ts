/**
 * 全局设置(M6):字速五档 + 三音量 + UI 语言。global scope 持久化
 * (gal.v1.global.settings),即时生效(applySettings)且重启保留。
 */

import type { Assembled } from "../bootstrap.ts";
import type { Lang } from "../i18n/strings.ts";
import { LocalStorageAdapter } from "../storage/LocalStorageAdapter.ts";

/** ms/字,快→慢(plan:五档 [52,40,28,18,10]) */
export const CPS_TIERS = [52, 40, 28, 18, 10] as const;

export interface GameSettings {
  cpsMs: number;
  volumes: { bgm: number; se: number; voice: number };
  lang: Lang;
}

export const DEFAULT_SETTINGS: GameSettings = {
  cpsMs: 28,
  volumes: { bgm: 0.6, se: 0.8, voice: 1 },
  lang: "ja",
};

const KEY = "settings";
const adapter = new LocalStorageAdapter();

const clamp01 = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback;

export function loadSettings(): GameSettings {
  try {
    const raw = adapter.getRaw("global", KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const o = JSON.parse(raw) as Partial<GameSettings>;
    const v: Partial<GameSettings["volumes"]> = o.volumes ?? {};
    return {
      cpsMs: CPS_TIERS.includes(o.cpsMs as (typeof CPS_TIERS)[number]) ? (o.cpsMs as number) : DEFAULT_SETTINGS.cpsMs,
      volumes: {
        bgm: clamp01(v.bgm, DEFAULT_SETTINGS.volumes.bgm),
        se: clamp01(v.se, DEFAULT_SETTINGS.volumes.se),
        voice: clamp01(v.voice, DEFAULT_SETTINGS.volumes.voice),
      },
      lang: o.lang === "zh" ? "zh" : "ja",
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(s: GameSettings): void {
  try {
    adapter.setRaw("global", KEY, JSON.stringify(s));
  } catch {
    // 设置保存失败可接受(不拦游戏)
  }
}

/** 即时生效:字速进打字机,音量进 AudioBus(未解锁时仅记值,unlock 后建 gain 用同值) */
export function applySettings(asm: Pick<Assembled, "engine" | "audio">, s: GameSettings): void {
  asm.engine.typewriter.setCps(1000 / s.cpsMs);
  asm.audio.setVolume("bgm", s.volumes.bgm);
  asm.audio.setVolume("se", s.volumes.se);
  asm.audio.setVolume("voice", s.volumes.voice);
}
