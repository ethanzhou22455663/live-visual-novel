/**
 * TtsRouter(plan §1.7):provider 链按序降级 [gpt-sovits → silent]。
 * 当前 provider 失败(网络/HTTP/WAV 不合法)→ 永久切到下一个并 onDegraded 通知
 * (app 转 voice:state failed/muted);外部 abort(signal)原样上抛不触发降级。
 * 降级不回切——运行时 9880 恢复也保持静音,避免演出中声线突变(重启进程才回真声)。
 */
import type { ReadyClip, SynthRequest, TtsProvider } from "@gal/shared";

export interface TtsRouterDeps {
  /** 优先级从高到低;最后一个应是 SilentProvider(链尾永不失败) */
  providers: TtsProvider[];
  onDegraded?: (from: string, to: string | null) => void;
}

export class TtsRouter implements TtsProvider {
  readonly id = "router";
  #providers: TtsProvider[];
  #active: TtsProvider | null;
  #onDegraded?: (from: string, to: string | null) => void;

  constructor(deps: TtsRouterDeps) {
    this.#providers = deps.providers;
    this.#active = deps.providers[0] ?? null;
    this.#onDegraded = deps.onDegraded;
  }

  /** 当前实际服务的 provider(测试/诊断) */
  get activeId(): string | null {
    return this.#active?.id ?? null;
  }

  async synthesize(req: SynthRequest): Promise<ReadyClip> {
    for (;;) {
      if (!this.#active) throw new Error("无可用 TTS provider");
      try {
        return await this.#active.synthesize(req);
      } catch (e) {
        // 外部中断不是 provider 故障:不降级
        if (req.signal?.aborted) throw e;
        const idx = this.#providers.indexOf(this.#active);
        const next = this.#providers[idx + 1] ?? null;
        this.#onDegraded?.(this.#active.id, next?.id ?? null);
        this.#active = next;
        if (!next) throw e;
      }
    }
  }

  async healthCheck(): Promise<boolean> {
    return this.#active ? this.#active.healthCheck() : false;
  }
}
