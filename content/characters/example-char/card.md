---
name: サンプル
color: "#9aa7b0"
defaultExpr: 平常
---

# サンプル(占位キャラクター)

替换本目录为你的角色:`content/characters/<charId>/`,charId 仅限 `[a-z0-9_-]`。

- frontmatter:name(表示名)/ color(个人色 #rrggbb)/ defaultExpr(默认表情,须是 sprites 文件名之一)
- 正文:角色性格设定原文,会整段注入导演/编剧 prompt
- 立绘:往本目录丢图片即成表情(文件名=表情名,如 `平常.png`/`微笑.png`)
- 语音(可选):在本包 `assets-map.json` 的 `voice` 块配置(ref 音频 + 转写;见 docs/pack-switch.md)

本仓库的 OSS 占位包不含任何第三方 IP 素材;本地测试包放 `content-local/`(gitignored)。
