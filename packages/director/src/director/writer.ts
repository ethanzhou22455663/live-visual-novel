/**
 * WriterService(ai-calls §2 调用②,2026-10-18 幕制):整幕长写,NDJSON 流式编剧。
 * - 一次 SSE 调用写完整一幕(按幕设计 beats 顺序;maxTokens 4000 / watchdog 30s)
 * - **choice 硬切**:流中一旦产出 choice 行立即 commit 并终止底层生成——
 *   其后的内容依赖玩家选择,LLM 提前写完也必须丢弃;本段以 done{result:"choice"} 收束,
 *   BeatRunner 等玩家选择后续写(ledgerTail + 玩家选择)写完本幕
 * - watchdog:30s 无增量 → abort + aborted(canContinue) —— BeatRunner 带 ledgerTail 再入
 * - 内部续写:overrun(超幕级行预算)/ missing-choice(幕设计含 choice 段但未写出)
 *   → user 尾部追加【续写指示】+ ledgerTail 再入一次(每幕内部上限 1 次)
 * - **禁原样重试**——续写必须让模型看到已确定行
 * - Tier-2 窥视:peekPartialText 只喂打字机,绝不进状态/TTS
 */
import type { ContentPack } from "@gal/shared";
import type { GenerateBeatRequest, StoryChunk } from "@gal/shared";
import type { ModelScriptEvent } from "@gal/shared";
import type { LlmClient } from "../llm/client.ts";
import { peekPartialText, ScriptStreamParser, ParserAbortedError } from "../stream/ScriptStreamParser.ts";
import { buildWriterMessages, renderPackTables } from "./context.ts";

export class WatchdogError extends Error {
  constructor() {
    super("生成停滞(watchdog)");
    this.name = "WatchdogError";
  }
}

/** 无增量超 ms 即抛 WatchdogError,并中止底层迭代(调用方 abort fetch) */
export async function* withWatchdog(
  gen: AsyncGenerator<string, void, unknown>,
  ms: number,
): AsyncGenerator<string, void, unknown> {
  const it = gen[Symbol.asyncIterator]();
  try {
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new WatchdogError()), ms);
      });
      timeout.catch(() => {}); // 输家 timer:race 已 settle 时 reject 不成 unhandled
      try {
        const r = (await Promise.race([it.next(), timeout])) as IteratorResult<string>;
        if (r.done) return;
        yield r.value;
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  } finally {
    // 不 await it.return:底层迭代器可能悬挂在未定的 next(fetch 卡死)上,await 会让
    // WatchdogError 永远传不出去(整幕死锁)。收尾由 WriterService 自己的 ctrl.abort() 做。
    try {
      it.return?.(undefined)?.catch(() => {});
    } catch {
      // 已结束的迭代器
    }
  }
}

export interface WriterDeps {
  llm: LlmClient;
  apiKey: string;
  baseUrl?: string;
  model?: string;
  pack: ContentPack;
  watchdogMs?: number;
  onError?: (err: unknown) => void;
}

export class WriterService {
  #deps: WriterDeps;

  constructor(deps: WriterDeps) {
    this.#deps = deps;
  }

  async *generateBeat(req: GenerateBeatRequest): AsyncGenerator<StoryChunk, void, unknown> {
    const { pack } = this.#deps;
    const tables = renderPackTables(pack);
    const names = Object.fromEntries(Object.values(pack.characters).map((c) => [c.id, c.displayName]));
    // 幕级行预算:各小节 maxLines 之和 + 余量(overrun 检查用)
    const lineBudget = req.act.beats.reduce((sum, b) => sum + b.maxLines, 0) + 8;
    const wantsChoice = req.act.beats.some((b) => b.endsWith === "choice");
    // 内部续写预算:1 次(overrun/missing-choice/空流 合并计)。
    // **隐性行为显式化(2026-10-18 审计 D2)**:初值取 req.continuation.count——
    // BeatRunner 每次再入(watchdog/parse/choice/空流)都带 count≥1,即外部再入过的幕
    // 不再做内部纠正,直接把收束责任交回 BeatRunner 的再入循环,避免两级预算互相放大
    let internalContinuation = req.continuation?.count ?? 0;
    let reason = req.continuation?.reason;
    let committedEvents: ModelScriptEvent[] = [];
    let sawChoice = false;
    let lineCount = 0;

    // 本生成器退出(完成/被打断)时终止 fetch
    const ctrl = new AbortController();
    const signal = req.signal
      ? AbortSignal.any([req.signal, ctrl.signal])
      : ctrl.signal;
    try {
      for (;;) {
        const messages = buildWriterMessages({
          tables,
          worldbookEntries: pack.story.worldBook,
          world: req.world,
          summary: req.summary,
          act: req.act,
          history: req.history,
          names,
          // 续写再入时本 generator 从零开始,引擎侧已提交行(先前中断的调用)在 req.ledgerTail
          ledgerTail: [req.ledgerTail, ...committedEvents.map((e) => JSON.stringify(e))]
            .filter(Boolean)
            .join("\n"),
          continuationReason: reason,
        });

        const parser = new ScriptStreamParser({
          onError: (e, line) => this.#deps.onError?.(`编剧坏行已丢弃:${String(e).slice(0, 120)} @${line.slice(0, 80)}`),
        });
        let lineTail = "";
        let failure: "watchdog" | "parse" | null = null;
        let cutByChoice = false;

        try {
          const stream = withWatchdog(
            this.#deps.llm.chatStream({
              apiKey: this.#deps.apiKey,
              baseUrl: this.#deps.baseUrl,
              model: this.#deps.model,
              messages,
              temperature: 0.9,
              maxTokens: 4000,
              signal,
            }),
            this.#deps.watchdogMs ?? 30_000,
          );
          for await (const delta of stream) {
            lineTail += delta;
            let stop = false;
            for (const ev of parser.push(delta)) {
              if (ev.t === "say" || ev.t === "narrate") lineCount++;
              else if (ev.t === "choice") sawChoice = true;
              committedEvents.push(ev);
              yield { kind: "commit", event: ev };
              if (ev.t === "choice") {
                // choice 硬切:其后内容依赖玩家选择,确定性终止底层生成并丢弃
                cutByChoice = true;
                stop = true;
                ctrl.abort();
                break;
              }
            }
            if (stop) break;
            lineTail = lineTail.slice(Math.max(lineTail.lastIndexOf("\n") + 1, 0));
            const preview = peekPartialText(lineTail);
            if (preview) yield { kind: "preview", text: preview };
          }
          if (!cutByChoice) {
            for (const ev of parser.end()) {
              if (ev.t === "say" || ev.t === "narrate") lineCount++;
              else if (ev.t === "choice") sawChoice = true;
              committedEvents.push(ev);
              yield { kind: "commit", event: ev };
            }
          }
        } catch (e) {
          if (cutByChoice) {
            // choice 硬切引发的中断(预期路径):不当失败
          } else if (signal.aborted) {
            // 外部停止(ESC/停止钮):静默收尾,不报"LLM 流失败"(2026-10-18 审计 M4)
            return;
          } else if (e instanceof WatchdogError) {
            failure = "watchdog";
          } else if (e instanceof ParserAbortedError) {
            failure = "parse";
          } else {
            yield { kind: "aborted", reason: `LLM 流失败:${e instanceof Error ? e.message : String(e)}`, canContinue: false };
            return;
          }
        }

        if (cutByChoice) {
          yield { kind: "done", result: "choice", lineCount };
          return;
        }
        if (failure) {
          // 原子性由"每次尝试 new ScriptStreamParser"保证(失败即整体丢弃旧 parser 与半行 tail)
          yield { kind: "aborted", reason: failure === "watchdog" ? "生成停滞" : "连续坏行", canContinue: true };
          return;
        }

        // 空流(HTTP 200 但零行):不算幕尾——续写重试,防大纲被空幕烧穿(审计 A4)。
        // 两续写预算已由 internalContinuation 上限兜住:仍空则 done(sceneEnd) 交给
        // BeatRunner 的"幕有产出才推进游标"兜底
        if (lineCount === 0 && committedEvents.length === 0) {
          if (internalContinuation < 1) {
            internalContinuation++;
            reason = "empty stream: the model returned nothing, write this act from the beginning";
            this.#deps.onError?.("编剧空流,续写重试");
            continue;
          }
          yield { kind: "aborted", reason: "LLM 连续空流", canContinue: true };
          return;
        }

        const overran = lineCount > lineBudget;
        const missingChoice = wantsChoice && !sawChoice;
        if ((overran || missingChoice) && internalContinuation < 1) {
          internalContinuation++;
          reason = overran
            ? "overrun: you exceeded the line budget, wrap up the act as soon as possible"
            : "missing-choice: this act design includes a choice beat — close the segment with a choice line";
          this.#deps.onError?.(`编剧续写纠正(${reason})`);
          continue;
        }

        // 自然流结束 = 幕终(幕设计校验保证最后一段 sceneEnd)
        yield {
          kind: "done",
          result: "sceneEnd",
          lineCount,
        };
        return;
      }
    } finally {
      ctrl.abort();
    }
  }
}
