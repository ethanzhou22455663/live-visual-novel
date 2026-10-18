# AI 调用规范 —— 指令、输入/输出结构、格式合同

状态:**2026-10-18 幕制定稿**(原拍级 BeatDirective 协议已废弃)。参数(温度/max_tokens/预算)随实测微调。
上游:plan §2.1(协议)/ §2.4(记忆与注入顺序)/ §2.8(内容包);架构图见 `architecture.html`。
所有调用走 OpenAI 兼容 `POST /chat/completions`(DeepSeek 首选,GLM/Qwen 同形可换——经 `LlmClient` 端口注入,key 用户自带)。

**提示词语言方针(2026-10-18 裁决)**:指令一律**英语**(LLM 对英文指令遵循更稳);产出物(台词/label/走向文本)在指令内显式要求日语。

---

## 0. 公共约定

### 0.1 三类调用总览

| # | 调用 | 触发时机 | 流式 | response_format | 温度 | 输入≈tok | 输出≈tok |
|---|---|---|---|---|---|---|---|
| ① | 总导演 planAct | **每幕一次**(幕边界/玩家选择后) | 否 | json_object | 0.7 | ~2.5K | ~400(maxTokens 1000) |
| ② | 编剧 generateBeat | 拿到幕设计后(整幕 1〜2 段:choice 硬切分段) | SSE | —(NDJSON 纯文本) | 0.9 | ~5K | ~2K(maxTokens 4000) |
| ③ | 摘要 summarize | 幕以 sceneEnd 收束后 | 否 | json_object | 0.3 | ~3K | ~350 |

大纲(`outline.md` 的 `- ` 行)= 起点**骨架**,一行一幕;走完后总导演按全局走向接管,不终局(结局流程见路线图 R2)。

### 0.2 上下文拼装顺序(缓存友好:稳定前缀在前,易变在后)

**① 总导演**:
```
system(幕设计合同 + 大纲骨架 ▶ + 资产清单,几乎不变)
→ [GLOBAL DIRECTION](全局走向;无则 "(none yet)")
→ [NEED NEW DIRECTION](强制刷新标记时;见 §1)
→ [CURRENT STAGE](引擎真实舞台:当前 bg/bgm/在场角色)
→ [ROLLING SUMMARY] → [WORLD STATE]
→ [RECENT HISTORY](每幕全变,永远靠后)
→ [PLAYER JUST CHOSE](resolveChoice 后的下一幕带)
→ [PREVIOUS OUTPUT ERRORS](校验失败重试时)
```

**② 编剧**:
```
system(格式合同 + 资产清单) → [WORLDBOOK] → [ROLLING SUMMARY] → [WORLD STATE]
→ [ACT DESIGN](幕设计 JSON 原文) → [RECENT HISTORY] → [CONTINUATION](续写时,最尾)
```

**任何调用的 message 顺序不得打乱**(快照测试断言块序)。

### 0.3 资产与角色如何进 prompt(来源=ContentPack manifest,代码零硬编码)

system 中放三张表(格式与 `context.ts renderPackTables` 一致):

```
[AVAILABLE CHARACTERS]
- enagi    / 陽見恵凪 / accent #ff8fb4 / expressions: 平常|微笑|笑|害羞|震惊
- yukitaka / 沖浪雪鷹 / accent #8899ff / expressions: (no sprite)
[AVAILABLE SCENES] 教室|走廊|学校|大街|商场|球场|居民区|男生房间|女生房间
[AVAILABLE BGM] p07 そぞろ歩いて温泉街 | p11 夕涼みの歩み
```

`(no sprite)` = 主人公类(无立绘资产):禁发 sprite、表情不校验不告警、不配音。

**成员约束(所有调用通用)**:`who` 只能输出 charId;`emotion` 只能输出该角色清单内的表情名;`bg`/`bgm`/`se` 只能输出清单项。输出先过 zod 再过清单校验,未知值→回退+告警。

### 0.4 历史渲染格式(紧凑省 token,导演与编剧共用;2026-10-18 起结构英语)

```
(放課後の教室、夕方の光が…)               ← 旁白用圆括号
陽見恵凪 (微笑): "ふふ、真面目ですね。"      ← 角色行:显示名 (表情): "台词"
> 素直についていく                          ← 玩家选择行
```

### 0.5 id 规则(最易错,三句话)

1. **行级 id 模型不产出**——引擎提交时分配 `turnNo.seq`(幕制:一幕 = 一个 turn)与 lineId
2. **选项 id 由模型产出**——作用域仅限本选项组,`defaultOptionId` 指向其中之一
3. 幕号(turnNo)由引擎 `beginTurn` 分配,导演/编剧输出里不含任何 id

---

## 1. 调用① 总导演 planAct(幕设计,合并层)

**用途**:掌握全局走向 + 设计「下一幕」。一幕 = 一个场景(bg+bgm)内连续 1〜5 个分段。每幕调用一次;玩家选择后的下一幕必带 `[PLAYER JUST CHOSE]`,且走向强制刷新。

**走向强制刷新节点**(引擎算好,以 `[NEED NEW DIRECTION]` 标记注入):大纲骨架走完 / 每完成 5 幕 / 上一幕有玩家选择。标记在场时 `direction` 禁止 null(校验拒绝并附错重试)。

**请求参数**:`temperature 0.7, max_tokens 1000, response_format json_object, stream false`;429/5xx 指数退避 ≤3 次(signal 感知)。

**system 模板要点**(全文见 `prompts.ts directorSystem`):

```
你是视觉小说的总导演:掌握全局走向,并设计「下一幕」。
输出一个 JSON:
{"direction":"<未来5〜10幕走向,日语≤400字;无需新走向时 null>",
 "act":{"scene":{"bg":"<场景id>","bgm":"<BGM id 或 null>","cast":[...]},
        "actGoal":"<幕目标,日语一句>","toneHint":"<可选>",
        "beats":[{"goal":"<分段目标>","endsWith":"beatEnd|choice|sceneEnd","maxLines":<6〜14>},...]}}
规则:换景只在幕首(系统自动落实);beats 最后一段必须 sceneEnd;choice 全幕 ≤1;cast 1〜3。
```

**user 侧块**见 §0.2;`[CURRENT STAGE]` 例:`bg=教室 / bgm=p07 / on-stage=enagi,akari`。

**输出校验链**(`director.ts`):

1. zod:`ActPlanSchema`(scene/beats 形状)
2. 代码级:清单成员;**最后一段 endsWith=sceneEnd**;**choice 段 ≤1**;各段 maxLines clamp [6,14]
3. 失败 → 错误附进 user 重试 ×1 → 仍失败 → `fallbackActPlan`(**沿用当前舞台 bg/cast**,direction=null 沿用旧走向;绝不跳回第一场景)

---

## 2. 调用② 编剧 generateBeat(NDJSON 流式,整幕长写)

**用途**:按幕设计把**完整一幕**写成台词流。一次 SSE 调用写几十行;`maxTokens 4000`,watchdog 30s 无增量即 abort。

### 2.1 system —— 格式合同(全文见 `prompts.ts WRITER_SYSTEM`)

行类型(仅四种):`narrate` / `say`(who/emotion/text)/ `stage`(sprite: who+action enter|exit)/ `choice`。

关键硬性规则:**bg・bgm 行禁止**(换景换曲由系统按幕设计自动落实);角色登场**必须在首句台词前发 sprite enter**;位置指定(slot/move)禁止(系统按在场人数自动布局);表情变化写 say 的 emotion;**写出 choice 行必须立即停止**(其后内容依赖玩家选择)。

### 2.2 choice 硬切(2026-10-18 幕制核心机制)

流中一旦产出 choice 行 → 该行照常 commit → **writer 立即终止底层生成**(`AbortController` 掐断 fetch),choice 之后模型已生成的内容**全部丢弃**——本段以 `done{result:"choice"}` 收束。BeatRunner 弹选项停等玩家;玩家选择后带 `[CONTINUATION]`(`The player chose "X". Continue after the choice...`)+ `ledgerTail`(本幕已确定行)续写,写完剩余分段至 sceneEnd。

### 2.3 输出预算与容错

| 情况 | 处理 |
|---|---|
| 单行 JSON 不全/校验失败 | 丢弃该行,不影响后续行;连续 3 坏行 → 中止+`[CONTINUATION]` 续写(禁原样重试) |
| 流无增量 >30s | watchdog → abort → BeatRunner 带 ledgerTail 再入(≤2 次) |
| overrun(超各段 maxLines 之和+8) | 内部续写纠正一次(注入"尽快收束本幕") |
| missing-choice(幕设计含 choice 段但未写出) | 内部续写纠正一次 |
| **空流(HTTP 200 零行)** | 续写重试一次;仍空 → `aborted(canContinue)`;幕尾零产出时引擎不推进大纲游标 |
| **外部停止(ESC)** | 静默 return,不产生任何 aborted/错误状态 |

**两级预算关系(显式约定)**:writer 内部纠正预算 = 1 − `req.continuation.count`;BeatRunner 每次再入都带 `count≥1` → **外部再入过的幕不再做内部纠正**,收束责任交回 BeatRunner 再入循环(≤2 次),避免两级预算互相放大。

**Tier 2 窥视解析**:对未完整行做 `"text":"..."` 字段扫描,只喂状态栏预览,绝不进状态/TTS(失败无副作用)。

---

## 3. 调用③ 摘要 summarize

**触发**:幕以 sceneEnd 收束后(同步);**绝不在流式中途触发**。

**输入**:`[PREVIOUS SUMMARY]`(JSON 原文回喂)+ `[NEW EVENTS]`(0.4 格式,自 summarizedThroughLineId 以来的行)。`[TASK]` 里给出严格结构示例(threads 是对象数组不是字符串)。

**输出**:`{facts(≤400字), charUpdates(Record<charId,string>), threads(SummaryThread[])}` + 引擎回填 `summarizedThroughLineId`。

**失败策略**:schema 前先**宽松归一化**(2026-10-18 实测:DeepSeek 常把 threads 输出成字符串数组、charUpdates 值输出成对象——归一化兜住后再校验);校验失败/超时 → **沿用旧摘要,绝不阻塞游戏**。

---

## 4. 校验与失败处理矩阵

| 调用 | 校验 | 首次失败 | 最终失败 | 是否阻塞 |
|---|---|---|---|---|
| ① 总导演 | zod ActPlan + 结构规则 + 清单成员 | 附错误重试 ×1 | fallbackActPlan(沿用当前舞台)+ onError | 阻塞(玩家看"生成中");退避可被停止打断 |
| ② 编剧 | 逐行 zod + 格式合同 | 丢行 / 括号续行修复 / 空流重试 | 3 连坏 → ledgerTail 续写(≤2) | 阻塞但可打断(停止=静默) |
| ③ 摘要 | 归一化 + zod Summary | 重试 ×1 | 沿用旧摘要 | **不阻塞** |

---

## 5. 关联文档

- plan §2.1 流式协议与 ledger 不变量 ｜ §2.4 记忆三层与注入顺序 ｜ §2.8 内容包(三张表来源)
- `docs/architecture.html`:幕生命周期与时序图
- 代码即真相:`packages/director/src/director/prompts.ts`(合同原文)、`context.ts`(块序)、`director.ts`/`writer.ts`(失败链)
