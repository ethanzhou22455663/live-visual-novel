/**
 * ContentPack 类型(plan §2.8 / P1-M1):资源与代码彻底解耦的事实源。
 * 代码里只允许出现这里的类型与 manifest 读取,任何资源路径硬编码进不了 packages/。
 */

/** 角色语音参考(api_v2 语义:服务端本机可读绝对路径,只进 POST body 不落 URL) */
export interface CharacterVoiceRef {
  refAudioPathServer: string;
  promptText: string;
  promptLang: "ja" | "zh" | "en";
}

export interface CharacterDef {
  /** =目录名=SpeakerId,[a-z0-9_-] */
  id: string;
  displayName: string;
  /** 角色个人色,#rrggbb(nameplate 用) */
  color: string;
  /** 未知表情回退值;必须是 sprites 键之一 */
  defaultExpr: string;
  /** 表情名(开放集合,文件名即表情)→ 资产 URL */
  sprites: Record<string, string>;
  voice?: CharacterVoiceRef;
  /** card.md 正文(性格设定原文),注入导演/编剧 prompt */
  cardMd: string;
}

export interface SceneDef {
  id: string;
  name?: string;
  image: string;
  noteMd?: string;
}

export interface BgmTrack {
  id: string;
  title?: string;
  path: string;
}

/** 世界书条目(SillyTavern 概念模型,AGPL 零代码):keys 精确表层匹配 */
export interface WorldBookEntry {
  id: string;
  keys: readonly string[];
  content: string;
  /** 大者优先 */
  priority: number;
  enabled: boolean;
}

export interface ContentPack {
  version: 1;
  characters: Record<string, CharacterDef>;
  scenes: Record<string, SceneDef>;
  bgm: Record<string, BgmTrack>;
  story: {
    outlineMd: string;
    worldBook: WorldBookEntry[];
  };
}
