/**
 * 世界状态纯函数测试(M4):
 * - mergeDelta:affection 累加+clamp ±100、未知角色建条目、flags last-wins、入参不可变
 * - combineDeltas:单侧透传、affection 相加、flags last-wins
 * - foldWorld:只认 choice 条目的 delta;幂等;与逐条 apply 等价
 * - WorldDeltaSchema:坏 delta 在入口被拒(坑⑮ 的最后一道)
 */
import { describe, expect, it } from "vitest";
import {
  AFFECTION_MAX,
  AFFECTION_MIN,
  EMPTY_WORLD,
  WorldDeltaSchema,
  combineDeltas,
  cursorAfter,
  foldWorld,
  mergeDelta,
} from "@gal/shared";
import type { LedgerEntry, WorldDelta } from "@gal/shared";

const evEntry = (turnNo: number, seq: number): LedgerEntry => ({
  kind: "ev",
  lineId: `${turnNo}.${seq}`,
  turnNo,
  seq,
  ev: { t: "narrate", turnNo, text: "n" },
});
const choiceEntry = (turnNo: number, seq: number, delta?: WorldDelta): LedgerEntry => ({
  kind: "choice",
  lineId: `${turnNo}.${seq}`,
  turnNo,
  seq,
  optionId: "a",
  label: "らべる",
  delta,
});

describe("mergeDelta", () => {
  it("affection 在现有值上累加;未知角色从 0 起建条目", () => {
    const w = mergeDelta({ affection: { enagi: 10 }, flags: {} }, { affection: { enagi: 5, miku: -3 } });
    expect(w.affection).toEqual({ enagi: 15, miku: -3 });
  });

  it("clamp 到 [-100, 100]:越界落边界,边界上再加减不再动", () => {
    const up = mergeDelta(EMPTY_WORLD, { affection: { a: 150 } });
    expect(up.affection.a).toBe(AFFECTION_MAX);
    expect(mergeDelta(up, { affection: { a: 5 } }).affection.a).toBe(100);

    const down = mergeDelta(EMPTY_WORLD, { affection: { a: -150 } });
    expect(down.affection.a).toBe(AFFECTION_MIN);
    expect(mergeDelta(down, { affection: { a: -5 } }).affection.a).toBe(-100);
  });

  it("flags last-wins 整值覆盖(类型也可换)", () => {
    const w = mergeDelta(
      { affection: {}, flags: { route: "a", met: true, count: 1 } },
      { flags: { route: "b", count: 7 } },
    );
    expect(w.flags).toEqual({ route: "b", met: true, count: 7 });
  });

  it("入参不可变:返回新对象,原 world/delta 不被改写", () => {
    const world = { affection: { enagi: 1 }, flags: { f: true } };
    const delta: WorldDelta = { affection: { enagi: 2 }, flags: { g: "x" } };
    const w = mergeDelta(world, delta);
    expect(world.affection).toEqual({ enagi: 1 });
    expect(world.flags).toEqual({ f: true });
    expect(delta.affection).toEqual({ enagi: 2 });
    expect(w).not.toBe(world);
    expect(w.affection).not.toBe(world.affection);
  });
});

describe("combineDeltas", () => {
  it("单侧缺省透传另一侧;双缺省 → undefined(经 a undefined→return b)", () => {
    const d: WorldDelta = { affection: { a: 1 } };
    expect(combineDeltas(undefined, d)).toEqual(d);
    expect(combineDeltas(d, undefined)).toEqual(d);
    expect(combineDeltas(undefined, undefined)).toBeUndefined();
  });

  it("affection 同键相加、异键并集;flags last-wins", () => {
    const out = combineDeltas(
      { affection: { enagi: 5, miku: 1 }, flags: { met: false } },
      { affection: { enagi: 3 }, flags: { met: true, route: "x" } },
    );
    expect(out).toEqual({
      affection: { enagi: 8, miku: 1 },
      flags: { met: true, route: "x" },
    });
  });

  it("合并后 affection 为空 → 字段置 undefined(不带空 record 进 ledger)", () => {
    const out = combineDeltas({ flags: { a: 1 } }, { flags: { b: 2 } });
    expect(out).toEqual({ affection: undefined, flags: { a: 1, b: 2 } });
  });
});

describe("foldWorld", () => {
  it("只认 choice 条目的 delta;ev 条目不改变世界", () => {
    const entries = [
      evEntry(1, 0),
      choiceEntry(1, 1, { affection: { enagi: 5 } }),
      evEntry(1, 2),
      choiceEntry(2, 0, { affection: { enagi: 3 }, flags: { met: true } }),
    ];
    expect(foldWorld(entries)).toEqual({ affection: { enagi: 8 }, flags: { met: true } });
  });

  it("幂等:fold 两次 = fold 一次;与逐条 mergeDelta 等价", () => {
    const entries = [
      choiceEntry(1, 0, { affection: { a: 90 } }),
      choiceEntry(1, 1, { affection: { a: 40 } }), // 90+40 → clamp 100
      choiceEntry(1, 2, { flags: { x: 1 } }),
    ];
    const once = foldWorld(entries);
    expect(foldWorld(entries)).toEqual(once);
    let manual = EMPTY_WORLD;
    for (const e of entries) {
      if (e.kind === "choice" && e.delta) manual = mergeDelta(manual, e.delta);
    }
    expect(once).toEqual(manual);
    expect(once.affection.a).toBe(100);
  });

  it("空 ledger → EMPTY_WORLD", () => {
    expect(foldWorld([])).toEqual(EMPTY_WORLD);
  });
});

describe("WorldDeltaSchema(入口拒坏增量)", () => {
  it("合法通过(两字段均可选)", () => {
    expect(WorldDeltaSchema.parse({})).toEqual({});
    expect(WorldDeltaSchema.parse({ affection: { a: 1 } })).toEqual({ affection: { a: 1 } });
    expect(WorldDeltaSchema.parse({ flags: { s: "str", n: 2, b: false } })).toEqual({
      flags: { s: "str", n: 2, b: false },
    });
  });

  it("affection 非数值 / flags 非标量 → 拒", () => {
    expect(WorldDeltaSchema.safeParse({ affection: { a: "5" } }).success).toBe(false);
    expect(WorldDeltaSchema.safeParse({ flags: { o: { deep: true } } }).success).toBe(false);
    expect(WorldDeltaSchema.safeParse({ flags: { n: null } }).success).toBe(false);
  });
});

describe("cursorAfter", () => {
  it("尾条目 seq+1;空 ledger 从 1.0", () => {
    expect(cursorAfter([evEntry(1, 0), evEntry(1, 1)])).toEqual({ turnNo: 1, seq: 2 });
    expect(cursorAfter([choiceEntry(3, 2)])).toEqual({ turnNo: 3, seq: 3 });
    expect(cursorAfter([])).toEqual({ turnNo: 1, seq: 0 });
  });
});
