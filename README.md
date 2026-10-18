# AI Galgame

AI 实时生成剧情、台词与配音的视觉小说引擎(Web/TypeScript monorepo)。

总导演(LLM)按「幕」设计场景与走向 → 编剧(LLM)整幕流式写台词 → 引擎按玩家节奏逐句演出,GPT-SoVITS 逐句配音(主角与旁白静音)。剧情不是剧本库——每一局的走向、场景与对话都由模型即时编排,玩家的选择会真实改变后续剧情与结局叙述。

> **本项目包含 AI 生成内容**:全部剧情文本与配音由 AI 实时生成,不代表任何真实人物与事件;界面与引擎代码由人工编写。

## 特性

- **幕制编排**:总导演每幕输出「全局走向 + 幕设计」(场景/BGM/登场角色/分段目标);换景换曲由引擎在幕首统一落实,幕内绝不乱切
- **整幕长写**:编剧一次生成整幕台词(几十行),选项行到达即停——玩家选择后带上下文续写,剧情真实分岔
- **显示泵**:生成与演出彻底解耦——LLM 再快也不乱闪,一句一句停,normal 点击 / Ctrl 快进 / ▶自动 三种节奏
- **语音预取**:播当前句时后台合成下两句,翻页零等待;fast 快进自动静音
- **存读档**:auto+手动 3 槽,幕写作中途存档、读档从断点续写;走向/幕进度随档恢复
- **179 例测试** + 无头 e2e(tools/)

## 架构

```
app(React 壳+装配根) ─→ engine(显示泵/状态机/存档) ─→ shared(端口与协议)
        │                     ↑ StoryService 端口
        ├─→ director(总导演/编剧/摘要,LLM 经 LlmClient 端口注入)
        └─→ tts-bridge(GPT-SoVITS/Silent 降级链,经 TtsProvider 端口注入)
```

- **核心层**(engine/director/shared):剧情编排、状态机、存档——不关心用哪个 AI 模型,换模型只改装配
- **外层**(演出/语音/UI):全部经端口注入,`packages/app/src/bootstrap.ts` 是唯一装配点
- 详细设计:[docs/architecture.html](docs/architecture.html)(浏览器打开)、[docs/ai-calls.md](docs/ai-calls.md)(LLM 调用协议)

## 快速开始

前置:Node ≥ 20、pnpm(推荐 `corepack enable`,仓库锁定 pnpm 12)。

```bash
pnpm install
cp .env.example .env          # 填 DEEPSEEK_KEY(只存本地,永不入库)
pnpm dev                      # http://localhost:5174
```

无本地素材也能跑:自动使用 `content/manifest.json` 占位包(纯文本、无配音)。

### 自备内容包(有立绘/配音)

```bash
# assets/ 放立绘与场景图,content-local/ 放角色卡与大纲(均可 gitignore,不外传)
# assets-map.json 声明 donor 拷贝关系(见 tools/content-sync)
node tools/content-sync/cli.mjs --local     # 产出 content/manifest.local.json + 拷贝资产到 public/local
pnpm dev
```

### 语音(GPT-SoVITS)

- 本机跑 GPT-SoVITS **api_v2** 服务,监听 `127.0.0.1:9880`(启动约需 1 分钟,属正常)
- 显卡调度建议(实测 RTF 0.59 的前提):NV 控制面板 preferred GPU 设独立显卡 + CUDA 帧率锁定 off + Windows 电源计划「高性能」——推理时别让 GPU 降频
- dev 下浏览器经 Vite proxy 访问(`/tts` → 9880),无 CORS 问题;参考音频路径只进 POST body,不出现在 URL
- 每个角色的 `voice`(ref 音频路径 + prompt 文本)配在内容包 `characters.<id>.voice`;无 voice 配置的角色(如主人公)自动静音
- 实测数据与调参:[docs/p0-tts-findings.md](docs/p0-tts-findings.md)、`tools/tts-probe/`

## 开发

```bash
pnpm -s turbo run typecheck test   # 全仓类型检查 + 179 例测试
pnpm build                         # 产出 packages/app/dist(vite build)
node tools/content-sync/cli.mjs --check   # 内容包校验(CI 同款门禁)
npx dependency-cruiser validate packages  # 依赖方向规则(app→其余,其余只→shared)
```

无头 e2e(需真 key / 真服务):`pnpm e2e:p0`(LLM+TTS 全链路断档率)、`node tools/p1-e2e.mjs`(编排事务链)。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/architecture.html](docs/architecture.html) | 四层模型、依赖矩阵、端口契约、工程规范 |
| [docs/ai-calls.md](docs/ai-calls.md) | 三类 LLM 调用协议(导演/编剧/摘要)、上下文块序、失败矩阵 |
| [docs/p0-tts-findings.md](docs/p0-tts-findings.md) | GPT-SoVITS 本机实测与决策 |

## 合规须知(必读)

- `assets/`、`content-local/`、`packages/app/public/local/` 已被 `.gitignore` 排除:借用素材仅限**本机测试**,不得入库、不得截图/录屏公开;仓库内不含任何游戏素材,克隆者按 [CREDITS.md](CREDITS.md) 自备
- 语音音源仅可使用自录 / 授权录音 / 授权链清晰的 TTS,**禁止真实声优声音**
- API key 只存用户本地(`.env`,已 gitignore),永远不入库
- 剧情/配音为 AI 实时生成:全年龄红线写入系统提示(性/暴力/真实人物禁止),但模型输出仍有不确定性,使用者自行判断传播内容

## 开源前终检(维护者清单)

- [ ] 历史提交的占位身份 `dev <dev@local>` 已处理:
      `git filter-repo --name-callback 'return name if name != "dev" else "你的名字"' --email-callback 'return email if email != "dev@local" else "你的邮箱"'`
      (会重写全部历史,需强推;是否执行由维护者决定)
- [ ] 各 `package.json` 的 `repository` 字段填真实仓库地址
- [ ] `git ls-files` 复扫:无 assets/content-local/.env 等本地文件入库

## License

代码 [MIT](LICENSE)。游戏素材不入库,归属与授权见 [CREDITS.md](CREDITS.md)。
