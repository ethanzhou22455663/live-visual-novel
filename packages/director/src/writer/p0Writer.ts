/**
 * P0 编剧服务(桩):给一段场景提示,产出 NDJSON ScriptEvent 流。
 * P1 会换成 plan §2.1 的完整 WriterService(角色卡/世界书/ledger 注入),
 * 协议与消费端不变——这正是先定协议的意义。
 */
import type { ScriptEvent } from "@gal/shared";
import { streamChat, type ChatMessage } from "../llm/deepseek.ts";
import { ScriptStreamParser, peekPartialText } from "../stream/ScriptStreamParser.ts";

export interface P0WriterRequest {
  apiKey: string;
  baseUrl?: string;
  /** 场景提示(日语,自由文本):地点/角色/氛围/该发生什么 */
  scenePrompt: string;
  temperature?: number;
  signal?: AbortSignal;
}

export type WriterChunk =
  | { kind: "preview"; text: string }
  | { kind: "commit"; event: ScriptEvent }
  | { kind: "done"; committedCount: number };

export const P0_WRITER_SYSTEM = `あなたは日本語のビジュアルノベル脚本家です。全年齢対象。選択肢はまだ不要。
出力は markdown も説明文も禁止。NDJSON として、1行 = 1 JSON オブジェクトのみ:

{"t":"narrate","turnNo":N,"text":"地の文(日本語)"}
{"t":"say","turnNo":N,"who":"キャラ名","emotion":"平常|微笑|悲しい|驚き","text":"セリフ(日本語)"}

規則:
- turnNo は 1 から始まり各行で +1
- text に生の改行を含めない(1 行 = 1 文)
- セリフは 1 行あたり 1〜2 文、地の文を交えてリズムよく
- emotion は上記 4 種のみ
- 12〜16 行書いたら黙って終了する(締めの挨拶や解説を書かない)`;

export async function* generateP0(req: P0WriterRequest): AsyncGenerator<WriterChunk, void, unknown> {
  const messages: ChatMessage[] = [
    { role: "system", content: P0_WRITER_SYSTEM },
    { role: "user", content: `シーン:\n${req.scenePrompt}\n\nNDJSON で書いてください。` },
  ];

  const parser = new ScriptStreamParser();
  let lineTail = ""; // 只保留未完整行:窥视绝不能看到已提交行的旧 "text"
  let committed = 0;

  for await (const delta of streamChat({
    apiKey: req.apiKey,
    baseUrl: req.baseUrl,
    messages,
    temperature: req.temperature ?? 0.9,
    signal: req.signal,
  })) {
    lineTail += delta;
    const events = parser.push(delta);
    lineTail = lineTail.slice(Math.max(lineTail.lastIndexOf("\n") + 1, 0));
    for (const ev of events) {
      committed++;
      yield { kind: "commit", event: ev };
    }
    // Tier-2 窥视:未完整行的 text 字段喂打字机(失败即丢弃,无副作用)
    const preview = peekPartialText(lineTail);
    if (preview) yield { kind: "preview", text: preview };
  }
  for (const ev of parser.end()) {
    committed++;
    yield { kind: "commit", event: ev };
  }
  yield { kind: "done", committedCount: committed };
}
