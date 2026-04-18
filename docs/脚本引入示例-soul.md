# 脚本引入示例：`scripts/soul`（从本地测试到打包发布）

本文把 `scripts/soul` 当作“官方示例脚本”，说明如何：
1) 在开发态引入并测试；
2) 让中控 UI 自动发现并显示参数；
3) 打包后随应用分发；
4) 给脚本注入设备 serial（多设备并发）。

> 约定：本项目脚本系统由 `src/main/utils/scriptRunner.js` 扫描 `scripts/*/manifest.json` 并通过 Python 子进程运行 entry。

---

## 1. 目录结构（必须满足）

把你的 Soul 脚本整理为标准结构：

```
<projectRoot>/scripts/
  soul/
    manifest.json
    main.py          # 统一入口（解析参数/输出 JSON 行/调用业务模块）
    soul.py          # 业务模块（负责 UI 自动化流程，可复用）
    chatSoul.py
    common/
      utils.py
      getSoulMsg.py
      sendMsgSoul.py
```

### 为什么要 `main.py`
- 中控脚本 runner 约定：启动方式是 `python <entry> <jsonParams>`。
- 你原来的 `soul.py` 更偏“业务代码”，不适合直接暴露成 entry：
  - 参数解析不统一
  - 输出缺少结构化（JSON 行）
  - 设备注入方式需要统一（runner 会注入 `device`）

因此我们用 `main.py` 做“脚本入口层”，`soul.py` 做“业务层”。

---

## 2. `manifest.json`（让 UI 自动生成参数表单）

`manifest.json` 示例（已在 `scripts/soul/manifest.json` 落地）：
- `key`: 唯一标识
- `entry`: 入口文件（一般用 `main.py`）
- `params`: 参数定义（UI 动态渲染）

打包后 UI 会显示：脚本名称、描述、参数输入框、开始/停止按钮。

---

## 3. 开发态测试（不打包时）

开发态脚本目录来自：
- `process.cwd()/scripts`

你只要把 `scripts/soul` 放在仓库根目录，启动应用后：
- 进入 **设备中控** → **脚本** Tab
- 点击 **刷新**
- 选择 `Soul自动私聊(示例)`
- 选设备后点 **开始执行**

### 设备注入规则（关键）
- 在 UI 里选择的设备 serial 列表，会由 runner 注入到脚本 params 的 `device` 字段。
- runner 会对每台设备开一个 Python 子进程：
  - 你在 `main.py` 会读到 `params.device`
  - 并设置到环境变量 `device` / `HCA_DEVICE_SERIAL`
  - `soul.py` 内部用 `u2.connect(serial)` 连接对应设备

---

## 4. 打包发布（让脚本随安装包分发）

### 4.1 打包配置（已完成）
`electron-builder.yml` 已包含：

- `extraResources: scripts/ -> resources/scripts`

因此打包后脚本实际路径为：
- Windows: `<安装目录>/resources/scripts/soul/...`

`src/main/utils/scriptRunner.js` 会优先取：
- `process.resourcesPath/scripts`（打包态）
- 不存在则退回 `process.cwd()/scripts`（开发态）

### 4.2 Python 环境（已支持内置优先级）
runner 的 Python 选择优先级：
1) `resources/python/python.exe`（内置 Python）
2) 环境变量 `HCA_PYTHON`
3) 系统 `python`

> 如果你要做到“用户免安装 Python”，需要把 Windows Embedded Python 解压到 `resources/python/` 并随包带上 `Lib/site-packages`。

---

## 5. 脚本输出规范（让中控能显示日志/进度）

建议脚本 stdout 输出 **JSON 行**：

```python
print(json.dumps({"type": "log", "msg": "hello"}, ensure_ascii=False), flush=True)
```

runner 会解析：
- `type=log/progress/done/error/stderr/exit`
- 并在中控日志面板展示

`main.py` 里已提供 `emit()` 示例。

---

## 6. 一个“最小可用”的新脚本模板（复制即可用）

你新增脚本时，只需要复制一个新目录：

```
scripts/my_script/
  manifest.json
  main.py
```

其中 `main.py` 只要做到：
- 解析 `sys.argv[1]`
- 输出 JSON 行
- 使用 `params.device`（可选）

---

## 7. 常见问题

### Q1: UI 看不到脚本
- 检查目录下是否有 `manifest.json`
- `manifest.json` 必须是合法 JSON 且包含 `key/name/entry`
- 进入脚本面板点一次“刷新”

### Q2: 打包后脚本不可用
- 检查 `electron-builder.yml` 是否包含 `extraResources scripts/`
- 检查安装目录 `resources/scripts` 下是否有脚本文件

### Q3: 报 “未找到 Python”
- 临时方案：安装 Python，并确保命令行能执行 `python`
- 推荐方案：配置/内置 `resources/python` 或设置 `HCA_PYTHON`

### Q4: uiautomator2 找不到/导入失败
- 这属于 Python 依赖没打进 `Lib/site-packages`：
  - 你选择内置 Python 时，需要把 `uiautomator2/requests/...` 放进 `resources/python/Lib/site-packages`。

