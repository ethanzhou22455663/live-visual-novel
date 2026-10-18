/**
 * NDJSON 流式剧情协议 —— 全系统的事实源(plan §2.1)。
 * 模型每输出一个完整 JSON 对象跟一个换行;模型不产出行 id,
 * 引擎提交时按 turnNo.seq 分配(见 makeLineId)。
 */

export type SpeakerId = string;
/** 开放集合:合法值 = 该角色 sprites/ 目录的文件名(内容包决定,P1 落地)。未知值运行时回退 defaultExpr。 */
export type EmotionTag = string;

export interface SayEvent {
  readonly t: "say";
  readonly turnNo: number;
  readonly who: SpeakerId;
  readonly emotion: EmotionTag;
  /** 禁止裸换行(schema 层校验) */
  readonly text: string;
}

export interface NarrateEvent {
  readonly t: "narrate";
  readonly turnNo: number;
  readonly text: string;
}

export type StageOp =
  | { kind: "bg"; asset: string; transition?: "fade" | "cut" | "slide" }
  | {
      kind: "sprite";
      who: SpeakerId;
      slot?: "left" | "center" | "right";
      action: "enter" | "exit" | "diff";
      emotion?: EmotionTag;
    }
  | { kind: "bgm"; asset?: string; action: "play" | "stop" | "fade"; fadeMs?: number }
  | { kind: "se"; asset: string }
  | { kind: "shake" }
  | { kind: "flash" };

export interface StageEvent {
  readonly t: "stage";
  readonly turnNo: number;
  readonly op: StageOp;
}

export interface WorldDelta {
  readonly affection?: Record<string, number>;
  readonly flags?: Record<string, boolean | number | string>;
}

/** 绝不上 UI,branded type 隔离出渲染路径 */
export interface HiddenConsequence {
  readonly delta?: WorldDelta;
  readonly beatHint?: string;
}

export interface ChoiceOption {
  readonly id: string;
  /** 按钮日文 */
  readonly label: string;
  readonly delta?: WorldDelta;
  readonly hidden?: HiddenConsequence;
}

/**
 * 选项是玩家唯一的输入方式(2026-10-11 裁决:玩家自由文本输入已否决,不做)。
 */
export interface ChoiceOfferEvent {
  readonly t: "choice";
  readonly turnNo: number;
  readonly prompt?: string;
  /** 3-4 个,全部由编剧产出 */
  readonly options: readonly ChoiceOption[];
  /** auto 模式/超时用 */
  readonly defaultOptionId: string;
}

/** 剥离 hidden 的公开视图——UI/快照/总线只见过这个(plan §1.5) */
export type PublicChoiceOption = Omit<ChoiceOption, "hidden">;

export interface PublicChoiceOffer {
  readonly prompt?: string;
  readonly options: readonly PublicChoiceOption[];
  readonly defaultOptionId: string;
}

export type ScriptEvent = SayEvent | NarrateEvent | StageEvent | ChoiceOfferEvent;

/** 行 id 由引擎在提交时分配:turnNo.seq */
export function makeLineId(turnNo: number, seq: number): string {
  return `${turnNo}.${seq}`;
}
