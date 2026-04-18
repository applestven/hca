# 内置 Python（Embedded distribution）

目标：打包时携带 Python 运行时与依赖（`Lib/site-packages`），用户无需安装 Python，即可运行脚本系统。

## 目录约定

将官方 Windows Embedded Python 解压到项目：

- `resources/python/`
  - `python.exe`
  - `python3*.dll`
  - `python._pth`
  - `Lib/`
  - `Lib/site-packages/`
  - （可选）`Scripts/`

> 说明：建议直接把你需要的依赖（如 requests、uiautomator2 的依赖等）提前安装/拷贝到 `Lib/site-packages`。

## 打包

本项目已在 `electron-builder.yml` 里配置：

- `extraResources: resources/python -> python`

打包后运行目录：

- `<安装目录>/resources/python/`

## 运行时优先级

脚本执行时 Python 选择优先级（见 `src/main/utils/scriptRunner.js`）：

1. `<安装目录>/resources/python/python.exe`（内置）
2. 环境变量 `HCA_PYTHON`
3. 系统 `python`

## 常见问题

### 1) import 第三方库失败

Embedded Python 默认 `python._pth` 会禁用 `site`，导致 `site-packages` 不生效。

本项目在运行时会自动修订 `python._pth`：

- 追加 `Lib` 与 `Lib\\site-packages`
- 启用 `import site`

### 2) 如何安装依赖

建议在准备 `resources/python` 时，使用同版本 Python 在本机安装依赖，然后拷贝对应的 `site-packages` 目录到 `resources/python/Lib/site-packages`。

（也可用离线 wheels，但这是后续增强项）

## 推荐做法（脚本作者视角）

- 脚本通过环境变量读取 adb 路径：`HCA_ADB_PATH`
- 尽量输出 JSON 行日志，便于 UI 解析：

```python
print(json.dumps({"type": "log", "msg": "hello"}), flush=True)
```
