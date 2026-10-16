/**
 * SaveData v1(plan §1.6)测试:trimLedger 头部裁剪+游标不变、schema 往返、
 * migrateSave(字符串解析/过新版本拒/缺迁移步骤拒/合法档过)。
 */
import { describe, expect, it } from "vitest";
import {
  EMPTY_SUMMARY,
  SAVE_VERSION,
  cursorAfter,
  makeLineId,
  migrateSave,
  trimLedger,
} from "@gal/shared";
import type { LedgerEntry, SaveData } from "@gal/shared";
import { SaveDataSchema } from "@gal/shared";

const evEntry = (turnNo: number, seq: number, text: string): LedgerEntry => ({
  kind: "ev",
  lineId: makeLineId(turnNo, seq),
  turnNo,
  seq,
  ev: { t: "narrate", turnNo, text },
});

const choiceEntry = (turnNo: number, seq: number): LedgerEntry => ({
  kind: "choice",
  lineId: makeLineId(turnNo, seq),
  turnNo,
  seq,
  optionId: "a",
  label: "ら",
  delta: { affection: { enagi: 1 } },
});

function makeSave(ledger: LedgerEntry[]): SaveData {
  return {
    version: 1,
    meta: { savedAt: "2026-10-16T00:00:00.000Z", playTimeSec: 42.5, chapterLabel: "1拍目:再会" },
    world: { affection: { enagi: 5 }, flags: { met: true } },
    summary: { ...EMPTY_SUMMARY, summarizedThroughLineId: "" },
    ledger,
    presentation: { bg: null, bgm: null, sprites: {} },
    cursor: cursorAfter(ledger),
    outlineBeatIndex: 0,
    pendingContinuation: false,
    currentBeat: null,
    readState: [],
  };
}

describe("trimLedger", () => {
  const entries = [evEntry(1, 0, "あ"), choiceEntry(1, 1), evEntry(1, 2, "い"), evEntry(2, 0, "う")];

  it("未摘要(空游标)→ 全量浅拷贝", () => {
    const out = trimLedger(entries, "");
    expect(out).toEqual(entries);
    expect(out).not.toBe(entries); // 拷贝:调用方随便改不伤原 ledger
  });

  it("摘要已覆盖到 1.1 → 头部两条裁掉;游标不变(裁剪只砍头部)", () => {
    const out = trimLedger(entries, makeLineId(1, 1));
    expect(out.map((e) => e.lineId)).toEqual(["1.2", "2.0"]);
    expect(cursorAfter(out)).toEqual(cursorAfter(entries));
  });

  it("游标不在 ledger 中 → 原样全量(不猜测)", () => {
    expect(trimLedger(entries, "9.9")).toEqual(entries);
  });
});

describe("SaveDataSchema / migrateSave", () => {
  it("合法档:对象/字符串两路都能过 schema,字段原样", () => {
    const save = makeSave([evEntry(1, 0, "あ")]);
    expect(SaveDataSchema.parse(save)).toEqual(save);
    expect(migrateSave(JSON.stringify(save))).toEqual(save);
  });

  it("mid-beat 档:pendingContinuation+currentBeat 合法;缺字段拒", () => {
    const save = makeSave([]);
    save.pendingContinuation = true;
    save.currentBeat = { turnNo: 3, directive: { scene: { bg: "classroom", bgm: null, cast: ["enagi"] }, goal: "再会", endsWith: "beatEnd", maxLines: 6 } };
    expect(SaveDataSchema.parse(save).currentBeat).toEqual(save.currentBeat);

    const broken = makeSave([]) as unknown as Record<string, unknown>;
    delete broken.cursor;
    expect(SaveDataSchema.safeParse(broken).success).toBe(false);
  });

  it("过新版本拒载;缺迁移步骤拒;v1 直通", () => {
    const future = { ...makeSave([]), version: SAVE_VERSION + 1 };
    expect(() => migrateSave(future)).toThrow(/版本过新/);

    expect(() => migrateSave({ version: 0 })).toThrow(/迁移/);

    const v1 = makeSave([]);
    expect(migrateSave(v1)).toEqual(v1);
  });

  it("坏 ledger 条目(缺 label 的 choice)拒", () => {
    const bad = makeSave([{ kind: "choice", lineId: "1.0", turnNo: 1, seq: 0, optionId: "a" } as unknown as LedgerEntry]);
    expect(SaveDataSchema.safeParse(bad).success).toBe(false);
  });
});
