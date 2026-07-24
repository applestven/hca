# 权限 Key 说明（当前版本）

## 1. 现在到底有哪些权限 Key？

**结论：当前版本的“脚本权限”Key 就是脚本的 `manifest.json` 里的 `key` 字段。**

也就是说：
- 脚本目录：`scripts/<脚本目录>/manifest.json`
- 取值字段：`key`
- 后端返回权限：`features[脚本key]`

### 示例
`scripts/codeApp/soul/manifest.json`：
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

## 2. 权限匹配规则（重要）

启动脚本时（`scripts:start`）：

1. **本地必须存在该脚本 key**（`listScripts()` 扫到的 manifest）
2. **接口 `features` 中有该 key** → 按接口权限校验（`count` / 订阅 / `lifetime`）
3. **接口没有该 key，或本地匹配不上** → **该本地脚本永久可用**（不扣次、不要求激活）

实现位置：
- `src/main/utils/permission.js`：`resolveScriptFeature` / `canUseScript`
- `src/main/index.js`：`scripts:start` 门禁

版本页展示同样遵循：白名单 key 在接口中无对应项时显示「永久（本地）」。

---

## 3. 如何在应用里快速查看“有哪些脚本 key”？

### 方法 A：直接看脚本清单（最准确）
脚本都在以下目录之一：
- 开发态：`scripts/codeApp/*/manifest.json`（优先）或 `scripts/*/manifest.json`
- 打包后：`resources/scripts/codeApp/*/manifest.json`（优先）或 `resources/scripts/*/manifest.json`

当前仓库里（开发态）常见脚本 key：
- `soul` — Soul自动私聊
- `soul_match_greet` — Soul循环匹配打招呼
- `temp` — 打开微信(示例)

### 方法 B：运行时从 UI 看（脚本面板下拉框）
脚本面板的数据来自主进程 `scripts:list`：
- 主进程：`src/main/utils/scriptRunner.js` 的 `listScripts()`
- 渲染进程：`src/renderer/components/ScriptRunnerPanel.jsx`

---

## 4. 权限结构（后端 features 字段）

### 4.1 基本结构
后端接口 `GET /activation_codes/features?machineId=...` 返回：
```json
{
  "code": 1,
  "data": {
    "machineId": "...",
    "features": {
      "soul": { "type": "count", "remaining": 3 },
      "soul_match_greet": { "type": "lifetime" }
    }
  }
}
```

### 4.2 type 说明
- `count`：次数（`remaining` > 0 有效）；启动时会调用扣次接口
- `monthly` / `yearly`：订阅（`expireDate` 未过期有效）
- `lifetime`：永久

---

## 5. 当前版本“在哪里做了权限校验”？

- **只校验脚本启动**：执行 `scripts:start` 前校验
- 校验位置：`src/main/index.js` 的 `ipcMain.handle('scripts:start', ...)`
- 次数扣减：仅当接口返回 `type=count` 且非本地默认永久时，调用 `POST /user_codes/updateFeaturesCount`
