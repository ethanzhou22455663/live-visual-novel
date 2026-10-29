# 内容包切换(文件夹替换,零代码)

游戏运行时读 `/content/manifest.local.json`(优先)与 `/content/manifest.json`(降级),两者都由
`tools/content-sync/cli.mjs` 从 `content-local/` 构建。**`content-local/` 只是"正在使用的那份副本"**,
原档固定放在 `assets/` 下,换包 = 整夹替换 + 重新同步。

## 目录分层

| 目录 | 角色 | 入库? |
|---|---|---|
| `assets/limelight lemonade jam/` | 现有故事的**原始素材**(供体立绘 JPG/voice ref/BGM 原件)。school 包的 `assets-map.json` 按路径引用它 | 否(gitignored) |
| `assets/school/` | 供体作品的**完整包原档**(card/story/已派生资产/assets-map;供体具体作品不具名,素材自备、路径本地) | 否(gitignored) |
| `assets/dawn/` | 新故事『黎明前打烊』的**完整包原档**(文本层已就绪,立绘/场景生成后补入) | 否(gitignored) |
| `content-local/` | 运行时活动副本,被替换的对象 | 否(gitignored) |
| `assets/_gen/` | gen.mjs 生图产物临时区,挑图后人工归入对应包 | 否(gitignored) |

## 切换操作(PowerShell)

```powershell
# 启用新故事『黎明前打烊』
robocopy assets\dawn content-local /MIR
node tools/content-sync/cli.mjs --local
node tools/content-sync/cli.mjs --check

# 切回现有故事
robocopy assets\school content-local /MIR
node tools/content-sync/cli.mjs --local
node tools/content-sync/cli.mjs --check
```

robocopy 退出码 0–7 都算成功(1=有文件复制)。`public/local/` 里可能残留另一包的旧资产文件,
manifest 只引用当前包,无害;介意可用 `/MIR` 思路清空 `packages/app/public/local/` 后重新同步。

## 新素材入包流程(dawn)

1. `node --env-file=.env tools/asset-gen/gen.mjs sprites --char shiori --expr 平常`(绿幕 JPG 落 `assets/_gen/`;抠图自动识别绿幕/黑底)
2. 挑图 → `node tools/asset-derive/derive.mjs --cutout <绿幕JPG> <输出PNG>` 抠成透明 PNG
3. 成品放 `assets/dawn/characters/<id>/<表情>.png`(表情键固定:害羞/平常/微笑/笑/震惊)
4. 场景成品直接放 `assets/dawn/scenes/<中文名>.jpg`
5. 回到上面「切换操作」刷新 `content-local/`

## 注意

- **不要随手改名 `assets/limelight lemonade jam/`**:school 包的 `assets-map.json` 以路径引用它
  (`from: assets/limelight lemonade jam/bgm` 与 voice ref 路径)。改名需同步改两处
  (`assets/school/assets-map.json` + 当前 `content-local/assets-map.json`),否则构建报
  「donor 路径不存在」并中止(cli.mjs 对缺失 donor 是硬失败)。
- dawn 包的 `assets-map.json` 只带 voice 配置(三位女主共用 assets/2 供体 wav,与 school 包同一裁决),不带 donor `copy` 指令(BGM 三首已直接拷入 `assets/dawn/bgm/`);cli 以「该文件存在」作为构建本地包的前提。
