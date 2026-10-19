import { describe, expect, it } from "vitest";
import {
  ModelChoiceOfferEventSchema,
  ModelNarrateEventSchema,
  ModelSayEventSchema,
  ModelScriptEventSchema,
  ModelStageEventSchema,
} from "../src/protocol/schema.model.ts";
import { commitModelEvent } from "../src/protocol/assign.ts";
import { ScriptEventSchema } from "../src/protocol/schema.ts";

describe("模型面 schema(P1 §1.1:模型禁产 turnNo)", () => {
  it("say/narrate 无 turnNo 通过", () => {
    expect(ModelSayEventSchema.safeParse({ t: "say", who: "enagi", emotion: "平常", text: "ですふぁっきゅー!" }).success).toBe(true);
    expect(ModelNarrateEventSchema.safeParse({ t: "narrate", text: "夕暮れの教室。" }).success).toBe(true);
  });

  it("模型违规输出 turnNo 被静默剥离(zod 默认 strip)", () => {
    const r = ModelSayEventSchema.parse({ t: "say", who: "enagi", emotion: "平常", text: "あっ。", turnNo: 99 });
    expect("turnNo" in r).toBe(false);
  });

  it("stage/choice 四变体判别", () => {
    expect(ModelStageEventSchema.safeParse({ t: "stage", op: { kind: "bg", asset: "教室" } }).success).toBe(true);
    const choice = ModelChoiceOfferEventSchema.safeParse({
      t: "choice",
      options: [
        { id: "a", label: "ああ" },
        { id: "b", label: "いいえ" },
      ],
      defaultOptionId: "a",
    });
    expect(choice.success).toBe(true);
    expect(ModelScriptEventSchema.safeParse({ t: "nonsense" }).success).toBe(false);
  });

  it("坏行拒绝:text 带裸换行", () => {
    expect(ModelNarrateEventSchema.safeParse({ t: "narrate", text: "一行\n二行" }).success).toBe(false);
  });

  it("commitModelEvent 补拍号 → 通过已提交 schema", () => {
    const m = ModelScriptEventSchema.parse({ t: "say", who: "enagi", emotion: "微笑", text: "ふふ。" });
    const ev = commitModelEvent(m, 3);
    expect(ev.turnNo).toBe(3);
    expect(ScriptEventSchema.safeParse(ev).success).toBe(true);
  });

  it("commitModelEvent 对 choice 同样生效", () => {
    const m = ModelScriptEventSchema.parse({
      t: "choice",
      options: [
        { id: "a", label: "行く" },
        { id: "b", label: "行かない" },
      ],
      defaultOptionId: "a",
    });
    expect(commitModelEvent(m, 7).t).toBe("choice");
  });

  it("zh 译文(2026-10-18 字幕翻译):模型可不给;给了则 commit 保留且过已提交 schema", () => {
    expect(ModelSayEventSchema.safeParse({ t: "say", who: "enagi", emotion: "平常", text: "あ。" }).success).toBe(true);
    const m = ModelSayEventSchema.parse({ t: "say", who: "enagi", emotion: "平常", text: "あ。", zh: "啊。" });
    expect(m.zh).toBe("啊。");
    const ev = commitModelEvent(m, 2);
    expect((ev as { zh?: string }).zh).toBe("啊。");
    expect(ScriptEventSchema.safeParse(ev).success).toBe(true);
  });
});
