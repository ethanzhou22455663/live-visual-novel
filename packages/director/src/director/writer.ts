/**
 * WriterService(ai-calls §2 调用②):NDJSON 流式编剧,全系统核心。
 * - 一次 SSE 调用;parser 换 ModelScriptEventSchema(turnNo 由引擎分配)
 * - watchdog:20s 无增量 → abort + aborted(canContinue) —— BeatRunner 带 ledgerTail 再入
 * - 内部续写:overrun(超 maxLines+4)/ missing-choice(endsWith=choice 无 choice 行)
 *   → user 尾部追加【续写指示】+ ledgerTail 再入一次(每拍内部上限 1 次)
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
    // WatchdogError 永远传不出去(整拍死锁)。收尾由 WriterService 自己的 ctrl.abort() 做。
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
    // 内部续写预算:1 次(overrun/missing-choice 合并计);watchdog/parse 由 BeatRunner 再入
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
          directive: req.directive,
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

        try {
          const stream = withWatchdog(
            this.#deps.llm.chatStream({
              apiKey: this.#deps.apiKey,
              baseUrl: this.#deps.baseUrl,
              model: this.#deps.model,
              messages,
              temperature: 0.9,
              maxTokens: 1200,
              signal,
            }),
            this.#deps.watchdogMs ?? 20_000,
          );
          for await (const delta of stream) {
            lineTail += delta;
            for (const ev of parser.push(delta)) {
              if (ev.t === "say" || ev.t === "narrate") lineCount++;
              else if (ev.t === "choice") sawChoice = true;
              committedEvents.push(ev);
              yield { kind: "commit", event: ev };
            }
            lineTail = lineTail.slice(Math.max(lineTail.lastIndexOf("\n") + 1, 0));
            const preview = peekPartialText(lineTail);
            if (preview) yield { kind: "preview", text: preview };
          }
          for (const ev of parser.end()) {
            if (ev.t === "say" || ev.t === "narrate") lineCount++;
            else if (ev.t === "choice") sawChoice = true;
            committedEvents.push(ev);
            yield { kind: "commit", event: ev };
          }
        } catch (e) {
          if (e instanceof WatchdogError) failure = "watchdog";
          else if (e instanceof ParserAbortedError) failure = "parse";
          else {
            yield { kind: "aborted", reason: `LLM 流失败:${e instanceof Error ? e.message : String(e)}`, canContinue: false };
            return;
          }
        }

        if (failure) {
          // 半行原子丢弃已由 parser.abort 负责;已提交行保留生效
          yield { kind: "aborted", reason: failure === "watchdog" ? "生成停滞" : "连续坏行", canContinue: true };
          return;
        }

        const overran = lineCount > req.directive.maxLines + 4;
        const missingChoice = req.directive.endsWith === "choice" && !sawChoice;
        if ((overran || missingChoice) && internalContinuation < 1) {
          internalContinuation++;
          reason = overran ? "overrun:超出行数预算,尽快收尾" : "missing-choice:本拍应以 choice 行收束";
          this.#deps.onError?.(`编剧续写纠正(${reason})`);
          continue;
        }

        yield {
          kind: "done",
          result: sawChoice ? "choice" : req.directive.endsWith,
          lineCount,
        };
        return;
      }
    } finally {
      ctrl.abort();
    }
  }
}
