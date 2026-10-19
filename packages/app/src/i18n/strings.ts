/**
 * UI 文案(M6):ja/zh 双语。游戏内文本是模型生成的日语,只有 chrome(标题/HUD/面板)走这里。
 */

export type Lang = "ja" | "zh";

export interface Strings {
  title: string;
  subtitle: string;
  start: string;
  resume: string;
  loading: string;
  fatal: string;
  titleNote: string;
  save: string;
  load: string;
  settings: string;
  backlog: string;
  stop: string;
  voiceFail: (n: number) => string;
  textSpeed: string;
  bgm: string;
  se: string;
  voice: string;
  language: string;
  speedLabels: [string, string, string, string, string];
  auto: string;
  slot: (n: number) => string;
  noData: string;
  broken: (r: string) => string;
  saveFailed: string;
  saveFailedQuota: string;
  doSave: string;
  doLoad: string;
  doDelete: string;
  /** ending 画面(终幕 sceneEnd 后):标题与回标题按钮 */
  endTitle: string;
  endBack: string;
}

export const STRINGS: Record<Lang, Strings> = {
  ja: {
    title: "レモネード・ファクトリー",
    subtitle: "AI 実時生成ノベル — P1",
    start: "スタート",
    resume: "つづきから",
    loading: "読み込み中…",
    fatal: "起動に失敗しました",
    titleNote: "DeepSeek proxy(/llm)と GPT-SoVITS(:9880)が稼働中であること",
    save: "セーブ",
    load: "ロード",
    settings: "設定",
    backlog: "バックログ",
    stop: "■ 停止",
    voiceFail: (n) => `音声失敗×${n}`,
    textSpeed: "文字速度",
    bgm: "BGM",
    se: "効果音",
    voice: "音声",
    language: "言語",
    speedLabels: ["とても速い", "速い", "普通", "遅い", "とても遅い"],
    auto: "オート",
    slot: (n) => `セーブ ${n}`,
    noData: "データなし",
    broken: (r) => `壊れたデータ(${r})`,
    saveFailed: "保存に失敗しました",
    saveFailedQuota: "保存に失敗しました(容量不足)",
    doSave: "保存",
    doLoad: "ロード",
    doDelete: "消去",
    endTitle: "物語・完",
    endBack: "タイトルへ",
  },
  zh: {
    title: "柠檬水工厂",
    subtitle: "AI 实时生成视觉小说 — P1",
    start: "开始游戏",
    resume: "继续游戏",
    loading: "载入中…",
    fatal: "启动失败",
    titleNote: "需要 DeepSeek 代理(/llm)与 GPT-SoVITS(:9880)处于运行状态",
    save: "保存",
    load: "读取",
    settings: "设置",
    backlog: "历史记录",
    stop: "■ 停止",
    voiceFail: (n) => `语音失败×${n}`,
    textSpeed: "文字速度",
    bgm: "背景音乐",
    se: "音效",
    voice: "语音",
    language: "语言",
    speedLabels: ["非常快", "快", "标准", "慢", "非常慢"],
    auto: "自动",
    slot: (n) => `存档 ${n}`,
    noData: "暂无数据",
    broken: (r) => `数据损坏(${r})`,
    saveFailed: "保存失败",
    saveFailedQuota: "保存失败(空间不足)",
    doSave: "保存",
    doLoad: "读取",
    doDelete: "删除",
    endTitle: "故事・完",
    endBack: "回到标题",
  },
};

export function t(lang: Lang): Strings {
  return STRINGS[lang];
}
