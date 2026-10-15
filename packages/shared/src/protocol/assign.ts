/**
 * 拍号分配(P1 裁决 §1.1):引擎 commit 事务点把模型面事件补上 turnNo,
 * 变成已提交形态 ScriptEvent;lineId 由 makeLineId(turnNo, seq) 生成。
 * 纯函数——计数器状态归 EngineCore。
 */
import type { ModelScriptEvent } from "./schema.model.ts";
import type { ScriptEvent } from "./script.ts";

export function commitModelEvent(m: ModelScriptEvent, turnNo: number): ScriptEvent {
  switch (m.t) {
    case "say":
      return { ...m, turnNo };
    case "narrate":
      return { ...m, turnNo };
    case "stage":
      return { ...m, turnNo };
    case "choice":
      return { ...m, turnNo };
  }
}
