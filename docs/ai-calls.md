# AI 调用规范 —— 指令、输入/输出结构、格式合同

状态：**设计定稿**，参数（温度/max_tokens/预算）随 P0 实测微调。
上游文档：plan §2.1（协议）/ §2.4（记忆与注入顺序）/ §2.8（内容包）；架构图见 `architecture.html`。
所有调用走 OpenAI 兼容 `POST /chat/completions`（DeepSeek 首选，GLM/Qwen 同形可换，key 用户自带）。

---

## 0. 公共约定

### 0.1 三类调用总览

| # | 调用 | 触发时机 | 流式 | response_format | 温度初值 | 输入≈tok | 输出≈tok |
|---|---|---|---|---|---|---|---|
| ① | 导演 nextBeat | 每拍开始 / 玩家选择后 | 否 | json_object | 0.7 | ~2.0K | ~200 |
| ② | 编剧 generate | 拿到 BeatDirective 后 | SSE | —（NDJSON 纯文本） | 0.9 | ~4.0K | ~1.5K |
| ③ | 摘要 summarize | sceneEnd / 新增>1200tok | 否 | json_object | 0.3 | ~2.2K | ~350 |

成本复核：①+② ≈ **¥0.03/拍**（与 plan §2.1 成本表一致）。

### 0.2 上下文拼装顺序（缓存友好：稳定前缀在前，易变在后）

```
system（格式合同 + 资产清单，几乎不变）
→ 世界书命中块
→ 滚动摘要
→ 世界状态
→ 本拍指令（仅②）
→ 近期历史（每拍全变，永远放最后）
```

重复前缀命中 DeepSeek 上下文缓存，输入费进一步下降。**任何调用的 message 顺序不得打乱。**

### 0.3 资产与角色如何进 prompt（来源=ContentPack manifest，代码零硬编码）

system 中放三张表（由 `content/manifest.json` 生成）：

```
【可用角色】
- yuki   / 雪村結衣   / 主题色 #f2a7c3 / 可用表情: 平常|微笑|笑|害羞|震惊|脸红
- akari  / 火村あかり / 主题色 #e8826f / 可用表情: 平常|微笑|笑|害羞|震惊
【可用场景】教室|走廊|学校|大街|商场|球场|居民区|男生房间|女生房间
【可用BGM】p07 そぞろ歩いて温泉街 | p11 夕涼みの歩み | p14 ぬくもりを伝えて
```

**成员约束（所有调用通用）**：`who` 只能输出 charId；`emotion` 只能输出该角色清单内的表情名；`bg`/`bgm`/`se` 只能输出清单项。输出先过 zod 再过清单校验，未知值→回退+onError 告警（plan 坑⑧）。

### 0.4 历史渲染格式（紧凑省 token，导演与编剧共用）

```
（放課後の教室、夕方の光が…）          ← 旁白用全角括号
【結衣】(微笑)「ふふ、真面目ですね。」   ← 角色行：显示名(表情)「台词」
▶ 素直についていく                     ← 玩家选择行
```

### 0.5 id 规则（最易错，三句话）

1. **行级 id 模型不产出**——引擎提交时分配 `turnNo.seq` 与 lineId
2. **选项 id 由模型产出**——作用域仅限本选项组，`defaultOptionId` 指向其中之一
3. **beatId 引擎分配**——导演指令里不含任何 id

---

## 1. 调用① 导演 nextBeat

**用途**：为下一"拍"定调——场景、目标、收束方式。玩家选择作为上拍结果一并输入（`resolveChoice` 与 nextBeat 是**同一调用形态**，只是多带一个"玩家选择"块）。

**请求参数**：

```json
{ "model": "deepseek-chat", "temperature": 0.7, "max_tokens": 400,
  "response_format": {"type": "json_object"}, "stream": false }
```

**messages 模板**：

```
system:
你是视觉小说的导演。依据大纲骨架与现状，给出"下一拍"的执导指令。只输出一个 JSON 对象。
【大纲骨架（▶=当前进度）】
{content/story/outline.md 全文，引擎在当前节拍前插 ▶ 标记}
【可用角色/场景/BGM】
{0.3 的三张表}

user:
【滚动摘要】{summary.globalSummary + openThreads 列表}
【世界状态】好感度: yuki=+2, akari=0 ｜ flags: 约会之约=true
【近期历史】{0.4 格式，最近 ~10 行，含玩家最近选择（若有）}
【玩家刚选择】▶ 素直についていく        ← 仅 resolveChoice 变体带此块
【任务】给出下一拍指令 JSON。上一拍 endsWith=sceneEnd 时应考虑换场。
```

**输出 BeatDirective**：

```json
{
  "scene":    { "bg": "教室", "bgm": "p07", "cast": ["yuki", "akari"] },
  "goal":     "結衣试探主角对昨日之约的态度，气氛微妙但克制",
  "endsWith": "choice",
  "maxLines": 10,
  "toneHint": "日常、含蓄、微紧张"
}
```

| 字段 | 类型 | 约束 |
|---|---|---|
| scene.bg | string | 必须在场景清单 |
| scene.bgm | string\|null | 清单项，null=不换 |
| scene.cast | charId[] | 1–3 个，本拍可出场角色 |
| goal | string | ≤60 字，本拍戏剧目标（给编剧看） |
| endsWith | enum | `choice` 以选项收 ｜ `beatEnd` 拍尾 ｜ `sceneEnd` 场景尾（触发摘要③） |
| maxLines | int | 6–14，行数硬预算（控 token 与节奏） |
| toneHint | string | ≤20 字 |

**失败策略**：zod/清单校验失败 → 把错误信息附进 user 重试 1 次；再失败 → 引擎兜底指令（同场景、泛化 goal、`endsWith:'beatEnd'`）+ onError。HTTP 429/5xx → 指数退避最多 3 次（导演是一次性 JSON，允许退避重试；见 §2 编剧的对比策略）。

---

## 2. 调用② 编剧 generate（NDJSON 流式，全系统核心）

**用途**：按指令把一拍写成台词流。**一次 SSE 调用**，模型每输出一个完整 JSON 对象跟一个 `\n`（NDJSON），无围栏、无散文。

**请求参数**：`"temperature": 0.9, "max_tokens": 1200, "stream": true`。

### 2.1 system —— 格式合同（实现时原样作为蓝本）

```
你是视觉小说编剧。按【本拍指令】写一拍台词，输出 NDJSON：每行一个 JSON 对象 + 换行符。
可用行类型（仅此四种）：
{"t":"narrate","text":"…"}
{"t":"say","who":"<charId>","emotion":"<表情>","text":"…"}
{"t":"stage","op":{"kind":"bg","asset":"<场景id>"}}
{"t":"choice","options":[{"id":"a","label":"…"},…],"defaultOptionId":"a"}

stage.op.kind 全集：bg(换背景)｜sprite(立绘: who,slot,action,emotion)｜bgm(音乐: asset,action,fadeMs)｜se(音效)｜shake｜flash
sprite.action ⊆ enter|exit|move|diff；slot ⊆ left|center|right

硬性规则：
1. text 是裸文本：不加「」，禁止换行/空行/markdown/代码围栏/注释
2. 台词每句 ≤60 字；旁白每段 ≤80 字
3. who 只能用【可用角色】的 charId；emotion 只能用该角色的可用表情
4. say+narrate 总行数 ≤ maxLines
5. endsWith='choice' 时最后一行必须是 choice 行；否则写完即止（流结束=拍结束）
6. 禁止输出 id、turnNo、 apologies、解释文字

示例：
{"t":"stage","op":{"kind":"sprite","who":"yuki","slot":"center","action":"enter","emotion":"平常"}}
{"t":"narrate","text":"夕日の差す教室。"}
{"t":"say","who":"yuki","emotion":"微笑","text":"あ、先輩……。まだ帰ってなかったんですか。"}
```

### 2.2 user 模板

```
【世界书命中】{命中条目正文，≤600 tok（扫描与预算见 plan §2.4）}
【滚动摘要】{同①}
【世界状态】{同①}
【本拍指令】{BeatDirective JSON 原文}
【近期历史】{0.4 格式，最近 ~12 行}
```

### 2.3 输出——一个完整拍的示例流

```
{"t":"stage","op":{"kind":"sprite","who":"yuki","slot":"center","action":"enter","emotion":"平常"}}
{"t":"narrate","text":"放課後の教室、夕方の光が机の上に長い影を落としている。"}
{"t":"say","who":"yuki","emotion":"平常","text":"あ、先輩……。まだ帰ってなかったんですか。"}
{"t":"say","who":"yuki","emotion":"微笑","text":"ふふ、真面目ですね。でも、休むのも仕事ですよ？"}
{"t":"say","who":"yuki","emotion":"害羞","text":"その……昨日の、件なんですけど。"}
{"t":"choice","options":[{"id":"a","label":"素直についていく"},{"id":"b","label":"興味がないふりをする"},{"id":"c","label":"話題を変える"}],"defaultOptionId":"a"}
```

**ChoiceOption 全字段**：`{ id, label, delta?{affection,flags}, hidden?{delta,beatHint} }`——`label` 日文 ≤20 字上按钮；`hidden` 引擎专用、branded type 隔离，**永不上 UI**（plan 坑⑮）。

### 2.4 容错与恢复（对应 plan §2.1 解析器容错 + 坑⑨⑩⑪）

| 情况 | 处理 |
|---|---|
| 单行 JSON 不全/校验失败 | 丢弃该行，不影响后续行 |
| JSON string 内裸换行 | 括号未平衡则继续吞行，平衡后再 parse |
| 连续 3 个坏行 | 中止本次流，带 `ledgerTail` 发**续写**请求（禁原样重试——会重复行） |
| 流无增量 >20s | watchdog 提示"生成停滞"，用户可从最后提交行续写 |
| 超 maxLines | 软预算：超后注入"尽快收尾"不硬切；超 maxLines+4 → abort+续写纠正 |

**Tier 2 窥视解析**：对未完整行做 `"text":"..."` 字段扫描，只喂打字机显示，绝不进状态/TTS（失败无副作用）。

---

## 3. 调用③ 摘要 summarize

**触发**：`sceneEnd`（同步触发）；距上次摘要新增 >1200 tok（下次 nextBeat 前异步触发）。**绝不在流式中途触发**（plan §2.4）。

**user 模板**：

```
【旧摘要】{summary JSON 原文}
【新增事件】{0.4 格式，自 summarizedThroughLineId 以来的全部行}
【任务】合并为新的摘要 JSON：facts(≤400字总述)、charUpdates(每角色变化记录)、threads(未决伏笔)
```

**输出**：

```json
{ "facts": "主角与結衣约定放学后同去商店街；あかり 对主角态度尚不明朗；三年前天台事件仍未解开。",
  "charUpdates": { "yuki": "因昨日之约好感升温，但仍在试探主角心意" },
  "threads": [ { "id": "t1", "title": "昨日之约的真相", "status": "open" } ] }
```

**失败策略**：校验失败/超时 → **沿用旧摘要 + 截断历史，绝不阻塞游戏**。

---

## 4. 校验与失败处理矩阵

| 调用 | 校验 | 首次失败 | 最终失败 | 是否阻塞 |
|---|---|---|---|---|
| ① 导演 | zod BeatDirective + 清单成员 | 附错误重试 ×1 | 兜底指令 + onError | 阻塞（玩家看"生成中"） |
| ② 编剧 | 逐行 zod + 格式合同 | 丢行 / 括号续行修复 | 3 连坏 → ledgerTail 续写 | 阻塞但可打断 |
| ③ 摘要 | zod Summary | 重试 ×1 | 沿用旧摘要 | **不阻塞** |

---

## 5. 关联文档

- plan §2.1 流式协议与 ledger 不变量 ｜ §2.4 记忆三层与注入顺序 ｜ §2.8 内容包（prompt 三张表的来源）
- `docs/architecture.html`：beat 生命周期与时序图
