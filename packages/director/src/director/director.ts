/**
 * DirectorService(ai-calls §1 调用①,2026-10-18 幕制:总导演合并层):
 * 每幕一次输出 {direction(全局走向,可 null=沿用), act(幕设计)}。
 * 失败链:chatOnce(withRetries 退避×3)→ 校验失败把错误附进 user 重试×1
 * → 再失败 fallbackActPlan(沿用当前场景) + onError。**只有导演允许退避重试。**
 */
import { ActPlanSchema, ContentPackSchema, fallbackActPlan } from "@gal/shared";
import type { ActPlan, ContentPack, PlanActRequest, PlanActResult, StoryService } from "@gal/shared";
import type { LlmClient } from "../llm/client.ts";
import { withRetries } from "../llm/retry.ts";
import { buildDirectorMessages, renderPackTables } from "./context.ts";
import { Summarizer } from "./summarize.ts";
import { WriterService } from "./writer.ts";

/** 幕设计结构校验(超出 zod 表达力的剧情规则);消息进 LLM 重试上下文 → 英语 */
export function validateActPlan(act: ActPlan, pack: ContentPack): string[] {
  const errors: string[] = [];
  if (!pack.scenes[act.scene.bg]) errors.push(`scene.bg "${act.scene.bg}" is not in the scene list`);
  if (act.scene.bgm !== null && !pack.bgm[act.scene.bgm]) {
    errors.push(`scene.bgm "${act.scene.bgm}" is not in the BGM list`);
  }
  for (const id of act.scene.cast) {
    if (!pack.characters[id]) errors.push(`cast "${id}" is not in the character list`);
  }
  if (act.scene.cast.length === 0) errors.push("cast is empty");
  const last = act.beats[act.beats.length - 1];
  if (!last || last.endsWith !== "sceneEnd") errors.push('the last beat\'s endsWith must be "sceneEnd" (= end of act)');
  const choices = act.beats.filter((b) => b.endsWith === "choice").length;
  if (choices > 1) errors.push(`at most 1 choice beat per act (found ${choices})`);
  return errors;
}

/** maxLines 每段 clamp 进 [6,14](schema 界 1..30,节奏硬预算) */
function clampAct(act: ActPlan): ActPlan {
  return {
    ...act,
    beats: act.beats.map((b) => ({ ...b, maxLines: Math.min(14, Math.max(6, b.maxLines)) })),
  };
}

export interface DirectorDeps {
  llm: LlmClient;
  apiKey: string;
  baseUrl?: string;
  model?: string;
  pack: ContentPack;
  onError?: (err: unknown) => void;
}

type ParseResult = { ok: true; r: PlanActResult } | { ok: false; errors: string[] };

export class DirectorService {
  #deps: DirectorDeps;

  constructor(deps: DirectorDeps) {
    this.#deps = deps;
  }

  async planAct(req: PlanActRequest): Promise<PlanActResult> {
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
        direction: req.direction,
        stage: req.stage,
        mustRefreshDirection: req.mustRefreshDirection,
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
            maxTokens: 1000,
            responseFormat: { type: "json_object" },
            timeoutMs: 30_000,
            signal: req.signal,
          }),
        { retries: 3, baseMs: 800, onRetry: (a, e, ms) => this.#deps.onError?.(`导演退避重试 #${a}(+${ms}ms):${e}`), signal: req.signal },
      );

    const parse = (raw: string): ParseResult => {
      let obj: unknown;
      try {
        obj = JSON.parse(raw);
      } catch {
        return { ok: false, errors: ["output is not valid JSON"] };
      }
      const o = (obj ?? {}) as Record<string, unknown>;
      if (!("direction" in o) || !("act" in o)) return { ok: false, errors: ["missing \"direction\" or \"act\" key"] };
      if (o.direction !== null && typeof o.direction !== "string") {
        return { ok: false, errors: ["direction must be a string or null"] };
      }
      if (typeof o.direction === "string" && o.direction.trim().length === 0) {
        return { ok: false, errors: ["direction must not be an empty string (output null if no new direction)"] };
      }
      if (req.mustRefreshDirection && o.direction === null) {
        return { ok: false, errors: ["[NEED NEW DIRECTION] marker is present — direction must not be null"] };
      }
      const parsed = ActPlanSchema.safeParse(o.act);
      if (!parsed.success) {
        return { ok: false, errors: parsed.error.issues.map((i) => `act.${i.path.join(".")}: ${i.message}`) };
      }
      const errs = validateActPlan(parsed.data, pack);
      if (errs.length) return { ok: false, errors: errs };
      return { ok: true, r: { direction: (o.direction as string | null) ?? null, act: clampAct(parsed.data) } };
    };

    try {
      const raw = await call();
      const first = parse(raw);
      if (first.ok) return first.r;
      this.#deps.onError?.(`导演输出不合格,附错误重试一次:${first.errors.join("; ")}`);
      const retryRaw = await call(first.errors);
      const second = parse(retryRaw);
      if (second.ok) return second.r;
      throw new Error(`导演两次输出均不合格:${second.errors.join("; ")}`);
    } catch (err) {
      this.#deps.onError?.(err);
      return this.fallback(req);
    }
  }

  /** 兜底:沿用当前场景与在场角色(direction=null=沿用旧走向),不阻塞剧情 */
  private fallback(req: PlanActRequest): PlanActResult {
    const { pack } = this.#deps;
    const bg = req.stage?.bg ?? Object.keys(pack.scenes)[0] ?? "教室";
    const cast = req.stage?.cast.length ? [...req.stage.cast] : Object.keys(pack.characters);
    return { direction: null, act: fallbackActPlan(bg, cast) };
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
    planAct: (req) => director.planAct(req),
    generateBeat: (req) => writer.generateBeat(req),
    summarize: (req) => summarizer.summarize(req),
  };
}
