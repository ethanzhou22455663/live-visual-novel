# mock/assets —— 被gitignore的目录

此目录存放由 [`tools/asset-derive`](../../tools/asset-derive/) 从 `assets/` 原素材加工出的
**透明立绘 PNG 与去水印场景 JPG**。由于原素材是借用的版权 material，
加工产物同样**不入库、不公开**。

克隆本仓库后此目录为空，界面没有图属正常。要本地跑 `mock/ui.html`：

1. 把原始素材放入 `assets/`（立绘 `assets/{1,2,3}/{表情}.jpg`、场景 `assets/场景/*.jpg`）
2. 执行：

   ```bash
   cd tools/asset-derive
   npm i
   node derive.mjs
   ```

正式版将改用授权清晰的 CC0 / 自绘素材，不再依赖此加工流程。
