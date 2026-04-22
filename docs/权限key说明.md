# 权限 Key 说明（当前版本）

## 1. 现在到底有哪些权限 Key？

**结论：当前版本的“脚本权限”Key 就是脚本的 `manifest.json` 里的 `key` 字段。**

也就是说：
- 脚本目录：`scripts/<脚本目录>/manifest.json`
- 取值字段：`key`
- 后端返回权限：`features[脚本key]`

### 示例
`scripts/soul/manifest.json`：
```json
{
  "key": "soul",
  "name": "Soul自动私聊"
}
```
那么你要给该脚本造权限，激活码的 `features` 就应该是：
```json
{
  "soul": { "type": "count", "remaining": 3 }
}
```

---

## 2. 如何在应用里快速查看“有哪些脚本 key”？

### 方法 A：直接看脚本清单（最准确）
脚本都在以下目录之一：
- 开发态：`scripts/codeApp/*/manifest.json`（优先）或 `scripts/*/manifest.json`
- 打包后：`resources/scripts/codeApp/*/manifest.json`（优先）或 `resources/scripts/*/manifest.json`

你只需要打开每个 `manifest.json`，看 `key` 字段即可。

当前仓库里（开发态）能看到的示例脚本 key：
- `soul`
- `demo_auto_chat`

### 方法 B：运行时从 UI 看（脚本面板下拉框）
脚本面板的数据来自主进程 `scripts:list`：
- 主进程：`src/main/utils/scriptRunner.js` 的 `listScripts()` 会扫描脚本目录，读取 `manifest.json` 并返回列表
- 渲染进程：`src/renderer/components/ScriptRunnerPanel.jsx` 调用 `window.api.scripts.list()` 后渲染下拉框

---

## 3. 权限结构（后端 features 字段）

### 3.1 基本结构
后端接口 `GET /activation_codes/features?machineId=...` 返回：
```json
{
  "code": 1,
  "data": {
    "machineId": "...",
    "features": {
      "soul": { "type": "count", "remaining": 3 },
      "demo_auto_chat": { "type": "lifetime" }
    }
  }
}
```

### 3.2 type 说明
- `count`：次数（`remaining` > 0 有效）
- `monthly` / `yearly`：订阅（`expireDate` 未过期有效）
- `lifetime`：永久

---

## 4. 当前版本“在哪里做了权限校验”？

- **只校验脚本启动**：执行 `scripts:start` 前校验
- 校验位置：`src/main/index.js` 的 `ipcMain.handle('scripts:start', ...)`
- 校验逻辑：读取 `permission.data.features[key]`
- 次数扣减：当 `type=count` 时调用 `POST /user_codes/updateFeaturesCount`，参数 `featuresKeyword=key`

---

## 5. 建议：如何“集中化管理”避免分散

建议把“脚本 key 清单”做成一个 IPC：
- 新增 `permission:list-keys` → 主进程直接调用 `listScripts()` 返回 `{ key, name, category }` 列表
- 版本页/调试页展示一张表：脚本 key、脚本名、当前授权状态

如果你需要，我可以把这个 IPC + 版本页展示一并补上。
