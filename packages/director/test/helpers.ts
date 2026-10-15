/**
 * M3 测试夹具:最小内容包(2 角色/1 场景/1 BGM/2 世界书条目)+ FakeLlm。
 * 全年龄占位文案;测试不依赖真实资产。
 */
import type { BeatDirective, ContentPack } from "@gal/shared";
import type { ChatOnceOptions, LlmClient } from "../src/llm/client.ts";
import type { StreamChatOptions } from "../src/llm/deepseek.ts";

export function makePack(): ContentPack {
  return {
    version: 1,
    characters: {
      enagi: {
        id: "enagi",
        displayName: "陽見恵凪",
        color: "#ff8fb4",
        defaultExpr: "平常",
        sprites: { 平常: "/local/sprites/enagi_a.png", 笑: "/local/sprites/enagi_smile.png" },
        cardMd: "内気で面倒くさがり。口癖は「ですふぁっきゅー!」。",
      },
      yukitaka: {
        id: "yukitaka",
        displayName: "沖浪雪鷹",
        color: "#8899ff",
        defaultExpr: "",
        sprites: {},
        cardMd: "主人公。ベース担当。",
      },
    },
    scenes: { 教室: { id: "教室", image: "/local/scenes/教室.png" } },
    bgm: { p07: { id: "p07", path: "/local/bgm/p07.ogg" } },
    story: {
      outlineMd: "# 序章\n- 放課後の教室、歌声との再会\n- レモネードファクトリー結成へ\n",
      worldBook: [
        { id: "wb-lemonade", keys: ["レモネード"], content: "バンド「レモネードファクトリー」の設定。", priority: 10, enabled: true },
        { id: "wb-rooftop", keys: ["屋上"], content: "屋上は昼休みのみ開放される。", priority: 1, enabled: true },
      ],
    },
  };
}

export const DIRECTIVE: BeatDirective = {
  scene: { bg: "教室", bgm: null, cast: ["enagi"] },
  goal: "放課後の教室で、歌う声の主と再会する",
  endsWith: "beatEnd",
  maxLines: 6,
};

export interface FakeLlmOptions {
  chatOnce?: (o: ChatOnceOptions, call: number) => Promise<string>;
  chatStream?: (o: StreamChatOptions, call: number) => AsyncGenerator<string, void, unknown>;
}

export type FakeLlm = LlmClient & {
  onceCalls: ChatOnceOptions[];
  streamCalls: StreamChatOptions[];
};

export function fakeLlm(impl: FakeLlmOptions = {}): FakeLlm {
  const onceCalls: ChatOnceOptions[] = [];
  const streamCalls: StreamChatOptions[] = [];
  return {
    onceCalls,
    streamCalls,
    async chatOnce(o) {
      onceCalls.push(o);
      return impl.chatOnce ? impl.chatOnce(o, onceCalls.length) : "";
    },
    async *chatStream(o) {
      streamCalls.push(o);
      if (impl.chatStream) {
        yield* impl.chatStream(o, streamCalls.length);
      }
    },
  };
}

/** NDJSON 行列をストリーミング断片化して yield(行途中の分割も耐えることを確認) */
export function ndStream(...lines: unknown[]): AsyncGenerator<string, void, unknown> {
  const whole = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  return (async function* () {
    // 半分ずつ吐く:パーサの半行バッファを跨ぐ
    const mid = Math.floor(whole.length / 2);
    yield whole.slice(0, mid);
    yield whole.slice(mid);
  })();
}
