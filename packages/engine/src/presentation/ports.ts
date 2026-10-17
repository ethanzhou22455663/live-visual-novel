/**
 * 舞台端口(P1 裁决 §6):engine 核心只依赖此接口;
 * DOM 实现(DomStagePort)在 P1,PixiJS 实现推迟 P2。
 * 一切"舞台内"的时序/层级/转场归本接口实现,React 不插手。
 */
import type { ContentPort, PresentationSnapshot } from "@gal/shared";

/** DomStagePort 的装配依赖(app bootstrap 注入;测试注 fake) */
export interface StageDeps {
  /** 舞台挂载点(1920×1080 逻辑坐标,外层负责 scale) */
  root: HTMLElement;
  /** assetId → 可访问 URL;未知资产返回 null */
  resolve(kind: "scene" | "sprite", who: string | undefined, id: string): string | null;
  /** 内容成员/表情校验 */
  content: ContentPort;
  /** 非致命告警(未知表情回退、缺图占位等)→ bus engine:warning */
  warn(msg: string): void;
  /** 排查 log(布局/表情埋点;bootstrap 注 console.log("[stage]", …);测试可省) */
  log?(msg: string): void;
}

export interface SpriteOp {
  who: string;
  slot?: "left" | "center" | "right";
  action: "enter" | "exit" | "move" | "diff";
  emotion?: string;
}

export interface StagePort {
  /** 切背景;null=无图纯色。fade=交叉淡化 .9s */
  bg(assetId: string | null, transition?: "fade" | "cut" | "slide"): void;
  sprite(op: SpriteOp): void;
  shake(): void;
  flash(): void;
  /** 回标题:清空全部舞台状态 */
  reset(): void;
  snapshot(): PresentationSnapshot;
  restore(p: PresentationSnapshot): void;
}
