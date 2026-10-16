#!/usr/bin/env node
/**
 * P1 端到端验收(M6 定稿,plan M6):无头(无 DOM,不碰 EngineCore)直连 DeepSeek。
 * 流程:loadPack(local 优先)→ 导演 nextBeat(清单断言)→ 编剧 generateBeat 逐 chunk
 * → 手工复刻引擎提交事务(commitModelEvent + makeLineId;协议/成员/行号断言)
 * → choice 取 default → world 折叠断言(增量 vs foldWorld 等价)
 * → sceneEnd → Summary 断言 → SaveData(trimLedger+cursor)→ migrateSave 字符串往返
 * → continueFrom 语义校验(拍号延续 + 同拍续写 ledgerTail 不重号)。
 * 可选 --tts:降级链 [GPT-SoVITS → Silent] 走真 TTS(默认纯 Silent,秒回)。
 *
 * 用法:node tools/p1-e2e.mjs [--key sk-..] [--tts] [--ref D:/path/ref.wav] [--prompt 转写]
 * 退出码 = 验收结果(0 PASS / 1 FAIL / 2 配置错误)。
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const hasFlag = (name) => args.includes(name);
const env = existsSync(join(root, ".env"))
  ? Object.fromEntries(
      readFileSync(join(root, ".env"), "utf8")
        .split(/\r?\n/)
        .filter((l) => l.trim() && !l.trim().startsWith("#"))
        .map((l) => {
          const i = l.indexOf("=");
          return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
        }),
    )
  : {};
const KEY = argOf("--key") ?? env.DEEPSEEK_KEY;
if (!KEY) {
  console.error("错误: 缺 DEEPSEEK_KEY(.env 或 --key)");
  process.exit(2);
}
const USE_TTS = hasFlag("--tts");
const REF = argOf("--ref") ?? env.VITE_TTS_REF_PATH;
const PROMPT_TEXT = argOf("--prompt") ?? env.VITE_TTS_PROMPT_TEXT ?? "";
if (USE_TTS && !REF) {
  console.error("错误: --tts 需要 VITE_TTS_REF_PATH(.env 或 --ref)");
  process.exit(2);
}

function fail(msg) {
  console.error(`\nP1 端到端验收 FAIL ❌\n  ${msg}`);
  process.exit(1);
}
function ok(cond, msg) {
  if (!cond) throw new Error(`验收失败: ${msg}`);
  console.log(`   ✅ ${msg}`);
}

// ---- 复用 packages 的 TS 源(Node 原生 type stripping,同 p0-e2e 姿势) ----
const { DeepseekClient, createStoryService, outlineBeatCount, parseContentPack } = await import(
  "../packages/director/src/index.ts"
);
const {
  commitModelEvent,
  makeLineId,
  foldWorld,
  cursorAfter,
  trimLedger,
  migrateSave,
  mergeDelta,
  toHistoryItems,
  WorldDeltaSchema,
  ScriptEventSchema,
  SummarySchema,
  SaveDataSchema,
  EMPTY_SUMMARY,
  EMPTY_WORLD,
  SAVE_SLOTS,
} = await import("../packages/shared/src/index.ts");
const { SilentProvider, TtsRouter } = await import("../packages/tts-bridge/src/index.ts");

// ---- 内容包(裁决4:local 优先) ----
const localPath = join(root, "content", "manifest.local.json");
const plainPath = join(root, "content", "manifest.json");
const manifestFile = existsSync(localPath) ? localPath : plainPath;
if (!existsSync(manifestFile)) fail("content/manifest(.local).json 不存在——先跑 content-sync");
const pack = parseContentPack(JSON.parse(readFileSync(manifestFile, "utf8")));
console.log(`── 内容包: ${manifestFile === localPath ? "local" : "OSS 占位"}(角色 ${Object.keys(pack.characters).length}/场景 ${Object.keys(pack.scenes).length}/BGM ${Object.keys(pack.bgm).length})`);

// ---- 语音链(--tts:GPT-SoVITS 优先,Silent 兜底;默认纯 Silent) ----
const providers = [];
if (USE_TTS) {
  const { GptSovitsProvider } = await import("../packages/tts-bridge/src/index.ts");
  const voiceChar = Object.values(pack.characters).find((c) => c.voice);
  providers.push(
    new GptSovitsProvider(
      voiceChar?.voice
        ? { baseUrl: "http://127.0.0.1:9880", refAudioPath: voiceChar.voice.refAudioPathServer, promptText: voiceChar.voice.promptText, promptLang: voiceChar.voice.promptLang }
        : { baseUrl: "http://127.0.0.1:9880", refAudioPath: REF, promptText: PROMPT_TEXT },
    ),
  );
  console.log("── 语音链: [gpt-sovits → silent]");
} else {
  console.log("── 语音链: [silent](估时;--tts 可选真 TTS)");
}
providers.push(new SilentProvider());
const router = new TtsRouter({ providers });

// ---- StoryService(真实导演/编剧/摘要,同一 LLM) ----
const warnings = [];
const story = createStoryService({
  llm: new DeepseekClient({ apiKey: KEY }),
  apiKey: KEY,
  pack,
  onError: (e) => {
    const m = e instanceof Error ? e.message : String(e);
    warnings.push(m);
    console.log(`   [story] ${m.slice(0, 160)}`);
  },
});

const outlineTotal = outlineBeatCount(pack.story.outlineMd);
console.log(`── 大纲节拍数: ${outlineTotal ?? "(无结构)"}`);

/** 复刻引擎提交事务:模型事件 → 校验 → lineId/ledger(§1.1:拍号引擎分配) */
function commitLikeEngine(m, turnNo, seq, ledger) {
  const ev = commitModelEvent(m, turnNo);
  const parsed = ScriptEventSchema.safeParse(ev);
  if (!parsed.success) fail(`协议断言:提交事件不合法 ${JSON.stringify(parsed.error.issues).slice(0, 200)}`);
  const lineId = makeLineId(turnNo, seq);
  if (ev.t === "say" && !pack.characters[ev.who]) fail(`成员断言:say.who "${ev.who}" 不在角色清单`);
  if (ev.t === "stage" && ev.op.kind === "bg" && !pack.scenes[ev.op.asset]) fail(`成员断言:bg "${ev.op.asset}" 不在场景清单`);
  if (ev.t === "stage" && ev.op.kind === "bgm" && ev.op.asset && !pack.bgm[ev.op.asset]) fail(`成员断言:bgm "${ev.op.asset}" 不在 BGM 清单`);
  if (ev.t === "stage" && ev.op.kind === "se" && !pack.bgm[ev.op.asset]) fail(`成员断言:se "${ev.op.asset}" 不在音频清单`);
  if (ev.t === "choice" && ev.options.length < 2) fail("协议断言:choice 少于 2 项");
  ledger.push({ kind: "ev", lineId, turnNo, seq, ev });
  return { ev, lineId };
}

/** 选项收束(复刻 resolveChoice:自身+hidden 合一,过 schema,clamp 归 foldWorld) */
function resolveChoiceLikeEngine(ledger, world, optionId) {
  const choiceEv = [...ledger].reverse().find((e) => e.kind === "ev" && e.ev.t === "choice")?.ev;
  if (!choiceEv) fail("continueFrom 断言:找不到已提交的 choice 事件");
  const opt = choiceEv.options.find((o) => o.id === optionId);
  if (!opt) fail(`选项断言:optionId "${optionId}" 不属本组`);
  const parts = [opt.delta, opt.hidden?.delta].filter((d) => d !== undefined).map((d) => WorldDeltaSchema.parse(d));
  let delta;
  for (const p of parts) {
    delta = delta
      ? { affection: sumRecords(delta.affection, p.affection), flags: { ...delta.flags, ...p.flags } }
      : p;
  }
  const merged = delta ? mergeDelta(world, delta) : world;
  const seq = ledger[ledger.length - 1].seq + 1;
  const lineId = makeLineId(ledger[ledger.length - 1].turnNo, seq);
  ledger.push({ kind: "choice", lineId, turnNo: ledger[ledger.length - 1].turnNo, seq, optionId: opt.id, label: opt.label, delta });
  return { world: merged, lineId };
}
const sumRecords = (a, b) => {
  const out = { ...a };
  for (const [k, v] of Object.entries(b ?? {})) out[k] = (out[k] ?? 0) + v;
  return out;
};

const TIMEOUT = AbortSignal.timeout(240_000);
try {
  // ============ 拍 1:导演 → 编剧 → choice → fold ============
  console.log("\n── 拍 1:导演定调");
  const world0 = EMPTY_WORLD; // 合同:WorldState = { affection, flags } 双键恒在
  const directive = await story.nextBeat({
    world: world0,
    summary: EMPTY_SUMMARY,
    history: [],
    lastChoice: null,
    outlineBeatIndex: 0,
    signal: TIMEOUT,
  });
  ok(typeof directive.goal === "string" && directive.goal.length > 0, `导演产出 goal:「${directive.goal}」`);
  ok(pack.scenes[directive.scene.bg], `清单断言:scene.bg「${directive.scene.bg}」在场景清单`);
  ok(directive.scene.cast.length > 0 && directive.scene.cast.every((id) => pack.characters[id]), `清单断言:cast=[${directive.scene.cast.join(",")}] 全在角色清单`);
  ok(directive.maxLines >= 6 && directive.maxLines <= 14, `预算断言:maxLines=${directive.maxLines} ∈ [6,14]`);

  console.log("\n── 拍 1:编剧流式(逐 chunk 提交)");
  const turnNo = 1;
  const ledger = [];
  let seq = 0;
  let result = null;
  let previews = 0;
  const lineIds = [];
  for await (const chunk of story.generateBeat({
    directive,
    turnNo,
    world: world0,
    summary: EMPTY_SUMMARY,
    history: [],
    ledgerTail: "",
    signal: TIMEOUT,
  })) {
    if (chunk.kind === "preview") {
      previews++;
      continue;
    }
    if (chunk.kind === "commit") {
      const { ev, lineId } = commitLikeEngine(chunk.event, turnNo, seq++, ledger);
      lineIds.push(lineId);
      const who = ev.t === "say" ? `${ev.who}(${ev.emotion || "-"})` : ev.t === "narrate" ? "―" : `[${ev.t}]`;
      console.log(`   [${lineId}] ${who} ${ev.t === "say" || ev.t === "narrate" ? ev.text.slice(0, 42) : ""}`);
    } else if (chunk.kind === "done") {
      result = chunk.result;
    }
  }
  ok(previews > 0, "流式断言:收到 preview 增量(真流式而非整段)");
  ok(lineIds.length >= 3, `产出断言:提交 ${lineIds.length} 行(≥3)`);
  const idLt = (a, b) => {
    const [ta, sa] = a.split(".").map(Number);
    const [tb, sb] = b.split(".").map(Number);
    return ta < tb || (ta === tb && sa < sb);
  };
  ok(lineIds.every((id, i) => i === 0 || idLt(lineIds[i - 1], id)), `行号断言:严格升序 ${lineIds[0]} … ${lineIds[lineIds.length - 1]}`);
  ok(result === "choice" || result === "beatEnd" || result === "sceneEnd", `收束断言:done.result=${result}`);

  // ---- choice → default 收束 → fold 断言 ----
  let world = world0;
  if (result === "choice") {
    console.log("\n── 拍 1:选项(default 收束)");
    const choiceEv = [...ledger].reverse().find((e) => e.kind === "ev" && e.ev.t === "choice").ev;
    ok(choiceEv.options.every((o) => o.label), "协议断言:选项均有 label");
    console.log(`   「${choiceEv.prompt ?? "(無題)"}」→ 取 default「${choiceEv.options.find((o) => o.id === choiceEv.defaultOptionId)?.label}」`);
    const r = resolveChoiceLikeEngine(ledger, world, choiceEv.defaultOptionId);
    world = r.world;
  }
  const folded = foldWorld(ledger);
  ok(JSON.stringify(folded) === JSON.stringify(world), "fold 断言:foldWorld(ledger) 与增量 world 等价");

  // ============ sceneEnd → Summary 断言 ============
  let summary = EMPTY_SUMMARY;
  if (result === "sceneEnd") {
    console.log("\n── 拍 1:摘要");
    const lastLine = ledger[ledger.length - 1].lineId;
    summary = await story.summarize({
      old: EMPTY_SUMMARY,
      items: toHistoryItems(ledger, 40),
      throughLineId: lastLine,
      names: Object.fromEntries(Object.values(pack.characters).map((c) => [c.id, c.displayName])),
      signal: TIMEOUT,
    });
    const parsed = SummarySchema.safeParse(summary);
    ok(parsed.success, "Summary 断言:schema 合法");
    ok(summary.summarizedThroughLineId === lastLine, `Summary 断言:游标=${summary.summarizedThroughLineId}`);
  } else {
    console.log("\n(拍 1 非 sceneEnd:摘要步跳过,SaveData 用 EMPTY_SUMMARY)");
  }

  // ============ SaveData v1:构造 → 字符串往返 ============
  console.log("\n── SaveData v1(trimLedger + migrateSave 往返)");
  const cursor = cursorAfter(ledger);
  const saveData = {
    version: 1,
    meta: { savedAt: new Date().toISOString(), playTimeSec: 42, chapterLabel: `${turnNo}拍目:${directive.goal}`, slot: "manual-0" },
    world,
    summary,
    ledger: trimLedger(ledger, summary.summarizedThroughLineId),
    presentation: { bg: null, bgm: null, sprites: {} },
    cursor,
    outlineBeatIndex: 1,
    pendingContinuation: false,
    currentBeat: null,
    readState: [],
  };
  const schemaOk = SaveDataSchema.safeParse(saveData);
  ok(schemaOk.success, `SaveDataSchema 校验通过(ledger ${saveData.ledger.length}/${ledger.length} 条)`);
  const back = migrateSave(JSON.stringify(saveData));
  // SaveDataSchema.parse 按 schema 字段序重建对象:语义等价但键序可能不同 → 规范化(键排序)后比较
  const canon = (v) =>
    JSON.stringify(v, (_k, val) =>
      val && typeof val === "object" && !Array.isArray(val)
        ? Object.keys(val).sort().reduce((o, key) => ((o[key] = val[key]), o), {})
        : val,
    );
  ok(canon(back) === canon(saveData), "migrateSave 断言:字符串→解析→结构等价(键序无关)");
  ok(JSON.stringify(cursorAfter(back.ledger)) === JSON.stringify(back.cursor), "cursor 断言:裁剪后 cursorAfter === save.cursor");
  ok(SAVE_SLOTS.includes("auto") && SAVE_SLOTS.length === 4, "槽位断言:auto+manual×3");

  // ============ continueFrom 语义:拍 2 拍号延续 + 同拍续写不重号 ============
  console.log("\n── 拍 2:continueFrom 语义(cursor 延续,不回退)");
  const resumeCursor = back.cursor;
  ok(resumeCursor.turnNo === turnNo && resumeCursor.seq === seq, `游标断言:cursor=${resumeCursor.turnNo}.${resumeCursor.seq}`);
  const nextTurnNo = resumeCursor.turnNo + 1; // 引擎 beginTurn 语义(拍已开始)
  const directive2 = await story.nextBeat({
    world,
    summary,
    history: toHistoryItems(ledger, 30),
    lastChoice: null,
    outlineBeatIndex: 1,
    signal: TIMEOUT,
  });
  ok(!!directive2.goal, `导演拍 2 产出:「${directive2.goal}」(拍号将为 ${nextTurnNo})`);

  console.log("── 拍 2:同拍续写(continueFrom 同拍语义:先提交 1 行→中断→带 ledgerTail 再入)");
  const ledger2 = [];
  let seq2 = 0;
  let gotFirst = false;
  const stream2 = story.generateBeat({
    directive: directive2,
    turnNo: nextTurnNo,
    world,
    summary,
    history: toHistoryItems(ledger, 30),
    ledgerTail: "",
    signal: TIMEOUT,
  });
  for await (const chunk of stream2) {
    if (chunk.kind === "commit") {
      commitLikeEngine(chunk.event, nextTurnNo, seq2++, ledger2);
      gotFirst = true;
      if (gotFirst) break; // 模拟中断:已提交 1 行后停
    }
    if (chunk.kind === "done") break;
  }
  ok(ledger2.length === 1, `中断断言:已提交 ${ledger2.length} 行(${ledger2[0]?.lineId})后中断`);
  const firstLine2 = ledger2[0].lineId;

  // 再入(续写):ledgerTail 让模型看到已确定行,行号延续不重号
  const tailJson = ledger2
    .filter((e) => e.kind === "ev")
    .map((e) => {
      const { turnNo: _t, ...rest } = e.ev;
      return JSON.stringify(rest);
    })
    .join("\n");
  let reentryLines = [];
  for await (const chunk of story.generateBeat({
    directive: directive2,
    turnNo: nextTurnNo,
    world,
    summary,
    history: toHistoryItems(ledger, 30),
    ledgerTail: tailJson,
    continuation: { reason: "前次生成中断,继续本拍", count: 1 },
    signal: TIMEOUT,
  })) {
    if (chunk.kind === "commit") {
      const { lineId } = commitLikeEngine(chunk.event, nextTurnNo, seq2++, ledger2);
      reentryLines.push(lineId);
    } else if (chunk.kind === "done") break;
  }
  ok(reentryLines.length >= 1, `续写断言:再入新增 ${reentryLines.length} 行`);
  ok(reentryLines.every((id) => idLt(firstLine2, id)), `续写断言:行号延续不重号(${firstLine2} → ${reentryLines[0]} …)`);
  const allIds2 = ledger2.map((e) => e.lineId);
  ok(allIds2.every((id, i) => i === 0 || idLt(allIds2[i - 1], id)), "续写断言:拍 2 全线号严格升序");

  // ============ 汇总 ============
  console.log("\n── 汇总");
  console.log(`   提交行:拍1 ${lineIds.length} / 拍2 ${ledger2.length}(含续写)`);
  console.log(`   world.affection: ${JSON.stringify(world.affection ?? {})}`);
  console.log(`   warnings: ${warnings.length}${warnings.length ? "(导演退避等,不拦验收)" : ""}`);
  console.log("\nP1 端到端验收 PASS ✅");
  process.exit(0);
} catch (e) {
  fail(`${e instanceof Error ? e.message : String(e)}`);
}
