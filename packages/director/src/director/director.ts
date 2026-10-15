/**
 * DirectorService(ai-calls §1 调用①):每拍开始定调。
 * 失败链:chatOnce(withRetries 退避×3)→ zod/清单校验失败把错误附进 user 重试×1
 * → 再失败 fallbackDirective + onError。**只有导演允许退避重试。**
 */
import {
  BeatDirectiveSchema,
  ContentPackSchema,
  fallbackDirective,
} from "@gal/shared";
import type { BeatDirective, ContentPack } from "@gal/shared";
import type { HistoryItem, NextBeatRequest, StoryService, Summary, WorldState } from "@gal/shared";
import type { LlmClient } from "../llm/client.ts";
import { withRetries } from "../llm/retry.ts";
import { buildDirectorMessages, renderPackTables } from "./context.ts";
import { Summarizer } from "./summarize.ts";
import { WriterService } from "./writer.ts";

export function validateDirective(d: BeatDirective, pack: ContentPack): string[] {
  const errors: string[] = [];
  if (!pack.scenes[d.scene.bg]) errors.push(`scene.bg "${d.scene.bg}" 不在场景清单`);
  if (d.scene.bgm !== null && d.scene.bgm !== undefined && !pack.bgm[d.scene.bgm]) {
    errors.push(`scene.bgm "${d.scene.bgm}" 不在 BGM 清单(null=不换)`);
  }
  for (const id of d.scene.cast) {
    if (!pack.characters[id]) errors.push(`cast "${id}" 不在角色清单`);
  }
  if (d.scene.cast.length === 0) errors.push("cast 为空");
  return errors;
}

export interface DirectorDeps {
  llm: LlmClient;
  apiKey: string;
  baseUrl?: string;
  model?: string;
  pack: ContentPack;
  onError?: (err: unknown) => void;
}

export class DirectorService {
  #deps: DirectorDeps;

  constructor(deps: DirectorDeps) {
    this.#deps = deps;
  }

  async nextBeat(req: NextBeatRequest): Promise<BeatDirective> {
    const { pack } = this.#deps;
    const tables = renderPackTables(pack);
    const mkMessages = (validationErrors?: string[]) =>
      buildDirectorMessages({
        outlineMd: pack.story.outlineMd,
        outlineBeatIndex: req.outlineBeatIndex,
        tables,
        world: req.world,
        summary: req.summary,
        history: req.history,
        names: this.names(),
        lastChoice: req.lastChoice ?? null,
        validationErrors,
      });

    const call = (validationErrors?: string[]): Promise<string> =>
      withRetries(
        () =>
          this.#deps.llm.chatOnce({
            apiKey: this.#deps.apiKey,
            baseUrl: this.#deps.baseUrl,
            model: this.#deps.model,
            messages: mkMessages(validationErrors),
            temperature: 0.7,
            maxTokens: 400,
            responseFormat: { type: "json_object" },
            timeoutMs: 30_000,
            signal: req.signal,
          }),
        { retries: 3, baseMs: 800, onRetry: (a, e, ms) => this.#deps.onError?.(`导演退避重试 #${a}(+${ms}ms):${e}`) },
      );

    const parse = (raw: string): { ok: true; d: BeatDirective } | { ok: false; errors: string[] } => {
      let obj: unknown;
      try {
        obj = JSON.parse(raw);
      } catch {
        return { ok: false, errors: ["输出不是合法 JSON"] };
      }
      const parsed = BeatDirectiveSchema.safeParse(obj);
      if (!parsed.success) {
        return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
      }
      const errs = validateDirective(parsed.data, pack);
      return errs.length ? { ok: false, errors: errs } : { ok: true, d: this.clamp(parsed.data) };
    };

    try {
      const raw = await call();
      const first = parse(raw);
      if (first.ok) return first.d;
      this.#deps.onError?.(`导演输出不合格,附错误重试一次:${first.errors.join("; ")}`);
      const retryRaw = await call(first.errors);
      const second = parse(retryRaw);
      if (second.ok) return second.d;
      throw new Error(`导演两次输出均不合格:${second.errors.join("; ")}`);
    } catch (err) {
      this.#deps.onError?.(err);
      return this.fallback(req);
    }
  }

  /** maxLines clamp 进 [6,14](schema 界 1..30,拍摄节奏硬预算) */
  private clamp(d: BeatDirective): BeatDirective {
    return { ...d, maxLines: Math.min(14, Math.max(6, d.maxLines)) };
  }

  private fallback(req: NextBeatRequest): BeatDirective {
    const { pack } = this.#deps;
    const bg = Object.keys(pack.scenes)[0] ?? "教室";
    return fallbackDirective(bg, Object.keys(pack.characters));
  }

  private names(): Record<string, string> {
    return Object.fromEntries(Object.values(this.#deps.pack.characters).map((c) => [c.id, c.displayName]));
  }
}

/** 从未知原始数据安全构造内容包(bootstrap 用;失败抛中文错误) */
export function parseContentPack(raw: unknown): ContentPack {
  const r = ContentPackSchema.safeParse(raw);
  if (!r.success) throw new Error(`manifest 不合法:${JSON.stringify(r.error.issues).slice(0, 400)}`);
  return r.data;
}

/** 便捷装配:三个服务共用一条 LLM 连接配置(plan §1.4 createStoryService) */
export interface StoryServiceDeps extends DirectorDeps {
  watchdogMs?: number;
}

export function createStoryService(deps: StoryServiceDeps): StoryService {
  const director = new DirectorService(deps);
  const writer = new WriterService(deps);
  const summarizer = new Summarizer({
    llm: deps.llm,
    apiKey: deps.apiKey,
    baseUrl: deps.baseUrl,
    model: deps.model,
  });
  return {
    nextBeat: (req) => director.nextBeat(req),
    generateBeat: (req) => writer.generateBeat(req),
    summarize: (req) => summarizer.summarize(req),
  };
}
