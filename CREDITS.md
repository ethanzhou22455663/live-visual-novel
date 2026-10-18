# CREDITS

## 素材信任模型(重要)

本仓库只包含**代码与文档**,不包含任何游戏素材(立绘、场景图、BGM、参考音频)。
素材目录(`assets/`、`content-local/`、`packages/app/public/local/`)全部被
`.gitignore` 排除——克隆本仓库得到的,是一个需要**自备素材**的引擎。

- 引用任何第三方素材(画作/音乐/声源)时,由使用者自行确认授权链,并把归属
  记录在本文件或自备的 `LICENSE-ASSETS` 中;仓库维护者不对用户自备素材负责。
- 语音参考音源仅限:自录、授权录音、授权链清晰的 TTS 合成音源。
  **禁止使用真实声优的声音**,无论是否付费购买。

## 构建/运行依赖

- [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS) — 语音合成服务(api_v2,本机部署)
- [React](https://react.dev/) / [Vite](https://vite.dev/) / [TypeScript](https://www.typescriptlang.org/) / [Turborepo](https://turbo.build/) / [zod](https://zod.dev/) / [Vitest](https://vitest.dev/)
- [sharp](https://sharp.pixelplumbing.com/) — 本机素材加工工具(tools/asset-derive,产物不入库)

## AI 生成内容标注

- 剧情/台词/走向/摘要:DeepSeek 等兼容 LLM **实时生成**(每次游玩都不同)
- 配音:GPT-SoVITS 对上述文本的实时 zero-shot 合成
- 引擎代码、提示词工程、架构与文档:人工编写(过程中使用 AI 辅助编码)
