# live-visual-novel

[![CI](https://github.com/ethanzhou22455663/live-visual-novel/actions/workflows/ci.yml/badge.svg)](https://github.com/ethanzhou22455663/live-visual-novel/actions/workflows/ci.yml)

![运行画面:AI 实时生成的剧情、立绘与配音](docs/screenshot.jpg)

> 画面:本地自备内容包『黎明前打烊』。立绘/场景为 AI 生成,台词与走向由 LLM 实时生成,配音由 GPT-SoVITS 实时合成。素材不入库,见 [CREDITS.md](CREDITS.md)。

AI 实时生成剧情、台词与配音的视觉小说引擎(Web/TypeScript monorepo)。

总导演(LLM)按「幕」设计场景与走向 → 编剧(LLM)整幕流式写台词 → 引擎按玩家节奏逐句演出,GPT-SoVITS 逐句配音(主角与旁白静音)。剧情不是剧本库——每一局的走向、场景与对话都由模型即时编排,玩家的选择会真实改变后续剧情与结局叙述。

> **本项目包含 AI 生成内容**:全部剧情文本与配音由 AI 实时生成,不代表任何真实人物与事件;美术素材(立绘/场景图)也可由 AI 生成,见 [CREDITS.md](CREDITS.md);界面与引擎代码由人工编写。

## 故事与人物:『黎明前打烊』

全世界的便利店都标榜 24 小时营业,唯独车站前这家「曙便利店」只在 **0:00–5:00** 开门——招牌上的「24」被划掉,手写着「0時〜5時」。招聘启事写着「夜班店员,时薪三倍」,条件只有一句:**没有要回家的人。**

慢性失眠的复读生**深見徹**来这里上夜班。深夜来店的客人,都是些回不了家的人:接下客人的请求,倾听,但别问过去——店规三条,是每个故事的入口。

**夜是温柔的;可怕的不是怪事,是天亮。**(深夜食堂式的温柔与微苦,全年龄)

| 人物 | 一句话 |
|---|---|
| **常盤栞**(店长) | 说话极短、公事公办的神秘少女,算盘打得比收银机快,手机永远打不通;「微笑」是全剧最稀有的画面。打烊后留下的结算字条,日期好像有点不对劲 |
| **三日月灯里**(周三 2:14 的常客) | 每周三凌晨 2:14 准时来店,误差从不超过一分钟;每次只买同一款便当,从不当时吃,抱着纸袋的样子像抱着什么重要的东西 |
| **宇佐美宵**(窗边的作家) | 一坐四小时的毒舌作家,从不买东西,只用店规第二条理直气壮地「请求」续杯。她的信条:「被写下来的人,就不会消失」 |

三条角色线各揭开「这家店到底是什么」的一面镜子,终局各有三岔——真相由你走进的那条线决定。而且剧情由 LLM 实时展开:同一份大纲,每一局的对话与走向都不完全相同。

> 示例故事的素材不入库(克隆者需按 [CREDITS.md](CREDITS.md) 自备);台本全文与设定档案见 [docs/dawn/](docs/dawn/)。

## 特性

**剧情编排**

- **幕制编排**:总导演每幕输出「全局走向 + 幕设计」(场景/BGM/登场角色/分段目标);换景换曲由引擎在幕首统一落实,幕内绝不乱切
- **整幕长写**:编剧一次生成整幕台词(几十行),选项行到达即停——玩家选择后带上下文续写,剧情真实分岔,多线结局由走向系统驱动
- **大纲 + 世界书驱动**:`story/outline.md` 定义剧情骨架(`- ` 一行一拍),`story/worldbook.md` 定义世界观条目,按关键词精准匹配注入,剧情不跑设定

**演出与体验**

- **显示泵**:生成与演出彻底解耦——LLM 再快也不乱闪,一句一句停;点击推进 / Ctrl 快进 / ▶自动 三种节奏
- **恒速打字机**:严格等间隔逐字显示,快进瞬完;文字速度 5 档可调
- **中日双语**:界面与台词日文/中文一键切换;中文字幕由翻译泵实时预取,玩家读到之前就位;译文迟到时整句静默换写,绝不打断演出
- **生成等待提示**:LLM 生成期间对话区给出明确提示,不再像卡死

**语音**

- **语音预取**:播当前句时后台合成下两句,翻页零等待
- 快进自动静音;没有 GPT-SoVITS 服务时自动降级为无声运行
- 每个角色独立参考音色;主角与旁白静音

**系统**

- **存读档**:auto 槽 + 手动 3 槽,幕写作中途可存、读档从断点续写,走向/幕进度随档恢复
- **工程质量**:195 例测试、依赖方向门禁(dependency-cruiser)、GitHub Actions CI 全链路校验

## 环境要求

| 项目 | 要求 |
|---|---|
| Node.js | ≥ 20(CI 在 Node 22 运行) |
| 包管理器 | pnpm 12(`corepack enable` 即可,仓库已锁定版本) |
| 操作系统 | Windows / macOS / Linux 均可;语音链在 Windows 实测 |
| DeepSeek API key | **必填**(剧情/台词全部由它实时生成) |
| GPT-SoVITS | 可选,本机部署才有配音;没有也能玩(自动静音) |
| GPU | 仅语音需要:中端独显 8GB 显存级别即可实时合成(实测 RTF 0.59) |

## 快速开始

```bash
git clone https://github.com/ethanzhou22455663/live-visual-novel.git
cd live-visual-novel
corepack enable         # 激活 pnpm 12
pnpm install
cp .env.example .env    # Windows PowerShell 用: copy .env.example .env
# 编辑 .env:填入 DEEPSEEK_KEY(https://platform.deepseek.com 申请;只存本地,永不入库)
pnpm dev                # http://localhost:5173
```

`pnpm dev` 会先自动执行内容包同步再起 dev server。不带任何素材也能跑:自动使用内置占位包 `content/`(纯文本、无配音),可以完整体验「生成 → 演出 → 选择 → 存读档」全流程。

## 游戏内操作

| 操作 | 方式 |
|---|---|
| 推进台词 | 点击画面 / ▼ |
| 快进 | 按住 Ctrl |
| 自动播放 | ▶自动 按钮 |
| 存 / 读档 | SAVE / LOAD 面板(auto 槽 + 手动 3 槽) |
| 回看历史 | BACKLOG |
| 设置 | 文字速度 5 档 / 每个角色的配音开关 / 界面语言(日文 / 中文) |

## 用你自己的故事(内容包)

内容包 = 一个文件夹,装着大纲、世界书、角色卡、立绘。仓库自带 `content/` 占位包,**直接改它**就能换成你的故事;正式创作建议用 `content-local/`(已被 .gitignore 排除,素材不外传):

```bash
# 1. 复制占位包作为起点
cp -r content content-local        # Windows: robocopy content content-local /E

# 2. 按下面「内容包结构」改内容

# 3. 构建、校验、跑起来
node tools/content-sync/cli.mjs --local
node tools/content-sync/cli.mjs --check
pnpm dev
```

### 内容包结构

```
content-local/
├─ assets-map.json             # 语音配置(见下「语音」节)+ 素材拷贝声明
├─ characters/<charId>/        # charId 仅限 [a-z0-9_-]
│  ├─ card.md                  # 角色卡(格式见下)
│  └─ 平常.png  微笑.png …     # 立绘:文件名 = 表情名,丢进来即生效
├─ scenes/店内.jpg …           # 场景图(16:9)
├─ bgm/*.mp3                   # BGM(可选)
└─ story/
   ├─ outline.md               # 大纲:`- ` 开头的每一行 = 一拍,导演按序取用
   └─ worldbook.md             # 世界书:## 条目 + keys:/priority: 元信息行 + 正文
```

角色卡 `card.md`:

```markdown
---
name: 表示名
color: #c8503a
defaultExpr: 平常
---

角色性格与设定的原文——会整段注入导演/编剧的提示词,写得越具体人越稳。
```

改完跑 `node tools/content-sync/cli.mjs`(或 `--local`)重新生成 manifest,`--check` 通过即可进游戏。世界书条目按关键词精确匹配注入(扫描窗口 = 最近 12 条已提交文本 + 玩家最近选择 + 本拍指令),`priority` 越大越优先。更多细节见 [docs/pack-switch.md](docs/pack-switch.md)。

## 语音(GPT-SoVITS,可选)

本机部署一次 GPT-SoVITS,即可获得全程语音(零样本克隆,**无需任何训练/微调**):

1. 下载 **GPT-SoVITS Windows 整合包**:[RVC-Boss/GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS) 的 README/Releases 提供整合包下载,解压即用(自带 Python 运行时与 v2 预训练权重,无需配环境)
2. (推荐)编辑 `GPT_SoVITS/configs/tts_infer.yaml` 的 `custom` 段:`device: cuda`、`is_half: true` —— 半精度推理,显存占用减半
3. 在整合包根目录启动 api_v2 服务:

   ```powershell
   runtime\python.exe api_v2.py -a 127.0.0.1 -p 9880 -c GPT_SoVITS/configs/tts_infer.yaml
   ```

4. 首次加载权重约需 1 分钟(属正常),日志出现 `Running on http://127.0.0.1:9880` 即就绪
5. 回到本引擎:内容包里配好参考音频(见下),进游戏即有语音

其他要点:

- 显卡调度建议(实测 RTF 0.59 的前提):NV 控制面板 preferred GPU 设独立显卡 + CUDA 帧率锁定 off + Windows 电源计划「高性能」——推理时别让 GPU 降频
- dev 下浏览器经 Vite proxy 访问(`/tts` → 9880),无 CORS 问题;参考音频路径只进 POST body,不出现在 URL
- 语音配在本包 `assets-map.json` 的 `voice` 块,多角色可共用同一份 ref,也能按角色覆盖:

  ```json
  {
    "voice": {
      "characters": ["heroine1", "heroine2"],
      "shared": {
        "refAudioPathServer": "D:/path/to/ref.wav",
        "promptText": "参考音频里说的原话",
        "promptLang": "ja"
      },
      "overrides": {}
    }
  }
  ```

  `refAudioPathServer` 必须是 GPT-SoVITS 服务进程可读的本机路径;没配进 `characters` 的角色(如主人公)自动静音
- 实测数据与调参:[docs/p0-tts-findings.md](docs/p0-tts-findings.md)、`tools/tts-probe/`

## 素材工具(可选)

| 工具 | 用途 |
|---|---|
| `tools/asset-gen` | 火山方舟 Seedream 批量生图(绿幕底立绘/场景;`.env` 填 `ARK_KEY`) |
| `tools/asset-derive` | 绿幕抠图 → 透明 PNG 立绘、批量归一化 |
| `tools/content-sync` | 内容包扫描 / 校验 / manifest 产出 / 资产拷贝(CI 门禁同款) |
| `tools/tts-probe` | GPT-SoVITS 零依赖探测脚本(测 RTF / 调参) |

**红线**:`assets/`、`content-local/`、`packages/app/public/local/` 永不入库;原素材与生成产物都不得公开,信任模型详见 [CREDITS.md](CREDITS.md)。

## 架构

```
app(React 壳+装配根) ─→ engine(显示泵/状态机/存档) ─→ shared(端口与协议)
        │                     ↑ StoryService 端口
        ├─→ director(总导演/编剧/摘要,LLM 经 LlmClient 端口注入)
        └─→ tts-bridge(GPT-SoVITS/Silent 降级链,经 TtsProvider 端口注入)
```

- **核心层**(engine/director/shared):剧情编排、状态机、存档——不关心用哪个 AI 模型,换模型只改装配
- **外层**(演出/语音/UI):全部经端口注入,`packages/app/src/bootstrap.ts` 是唯一装配点
- LLM 的 key 只存在于 dev server 进程(经 `/llm` proxy 注入 Authorization),浏览器永远拿不到

## 项目结构

```
├─ packages/
│  ├─ app/          React 壳 + 装配根(bootstrap.ts 唯一装配点)
│  ├─ engine/       显示泵 / 状态机 / 存档 / 打字机
│  ├─ director/     总导演 / 编剧 / 摘要(DeepSeek 经 LlmClient 端口注入)
│  ├─ tts-bridge/   GPT-SoVITS / Silent 降级链(TtsProvider 端口注入)
│  └─ shared/       端口与协议(zod schema、内容包校验)
├─ content/         OSS 占位内容包(入库;可直接改着玩)
├─ content-local/   本地内容包(gitignored,自备素材)
├─ assets/          原始素材(gitignored,自备)
├─ tools/           内容同步 / 生图 / 抠图 / TTS 探测 / 无头 e2e
└─ docs/            架构 / AI 调用协议 / 换包指南 / 实测报告 / 创作文档
```

## 开发

```bash
pnpm -s turbo run typecheck test   # 全仓类型检查 + 195 例测试
pnpm build                         # 产出 packages/app/dist(vite build)
node tools/content-sync/cli.mjs --check   # 内容包校验(CI 同款门禁)
npx dependency-cruiser validate packages  # 依赖方向规则(app→其余,其余只→shared)
```

无头 e2e(需真 key / 真服务):`pnpm e2e:p0`(LLM+TTS 全链路断档率)、`node tools/p1-e2e.mjs`(编排事务链)。

CI(GitHub Actions)在每次 push / PR 时依次跑:内容包校验 → typecheck + test → 依赖门禁 → build。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/architecture.html](docs/architecture.html) | 四层模型、依赖矩阵、端口契约、工程规范(浏览器打开) |
| [docs/ai-calls.md](docs/ai-calls.md) | 三类 LLM 调用协议(导演/编剧/摘要)、上下文块序、失败矩阵 |
| [docs/pack-switch.md](docs/pack-switch.md) | 内容包结构与切换操作 |
| [docs/p0-tts-findings.md](docs/p0-tts-findings.md) | GPT-SoVITS 本机实测与决策 |

## 合规须知(必读)

- `assets/`、`content-local/`、`packages/app/public/local/` 已被 `.gitignore` 排除:借用素材仅限**本机测试**,不得入库、不得截图/录屏公开;仓库内不含任何游戏素材,克隆者按 [CREDITS.md](CREDITS.md) 自备
- 语音音源仅可使用自录 / 授权录音 / 授权链清晰的 TTS,**禁止真实声优声音**
- API key 只存用户本地(`.env`,已 gitignore),永远不入库
- 剧情/配音为 AI 实时生成:全年龄红线写入系统提示(性/暴力/真实人物禁止),但模型输出仍有不确定性,使用者自行判断传播内容

## 开源前终检(维护者清单)

- [x] 历史提交的占位身份 `dev <dev@local>` 已处理(2026-10-29 按维护者裁决全部重写为
      GitHub 账号 `ethanzhou22455663` 的 noreply 署名;本机无 Python,用 git 自带的
      `filter-branch --env-filter` 而非 filter-repo,重写后已清理 `refs/original/` 与 reflog)
- [x] 各 `package.json` 的 `repository` 字段填真实仓库地址
- [x] `git ls-files` 复扫:无 assets/content-local/.env 等本地文件入库

## License

代码 [MIT](LICENSE)。游戏素材不入库,归属与授权见 [CREDITS.md](CREDITS.md)。
