# 内置 Python（Embedded distribution）

目标：打包时携带 Python 运行时与依赖（`Lib/site-packages`），用户无需安装 Python，即可运行脚本系统。

## 目录约定

将官方 Windows Embedded Python（**3.11.9 x64**）解压到项目：

- `resources/python/`
  - `python.exe`
  - `python311.dll`
  - `python311.zip`
  - `python311._pth`
  - `DLLs/`（很重要：包含 `_socket.pyd`、`_ssl.pyd` 等）
  - `Lib/`
  - `Lib/site-packages/`（用于放 pip 本身：pip/setuptools/wheel）
  - `Lib/site-packages-codeapp/`（用于放脚本依赖：uiautomator2 等）
  - （可选）`Scripts/`

> 说明
> - 本项目目前按 **embedded** 方式设计：运行时固定优先使用 `resources/python/python.exe`。
> - `DLLs/` 目录如果缺失，可能导致 `get-pip.py` 安装失败（例如缺 `_socket`、`ssl`）。

## 打包

本项目已在 `electron-builder.yml` 里配置：

- `extraResources: resources/python -> python`
- `extraResources: bin/scrcpy -> bin/scrcpy`（用于内置 adb/scrcpy，设备中控与脚本都会用到）

打包后运行目录：

- `<安装目录>/resources/python/`
- `<安装目录>/resources/bin/scrcpy/`

> 如果打包后出现 `spawn ... adb.exe ENOENT`，优先检查上述 `resources/bin/scrcpy/adb.exe` 是否存在。

## 运行时优先级

脚本执行时 Python 选择优先级（见 `src/main/utils/scriptRunner.js`）：

1. `<安装目录>/resources/python/python.exe`（内置）
2. 环境变量 `HCA_PYTHON`
3. 系统 `python`

---

## 项目初始化（第一次把 embedded Python 放进仓库时）

### 1) 准备 embedded Python 文件

1. 下载 `Windows embeddable package (64-bit)`：Python **3.11.9**。
2. 解压到 `resources/python/`。
3. 确认至少存在：
   - `python.exe`
   - `python311.dll`
   - `python311.zip`
   - `python311._pth`
   - `DLLs/`（必须存在；至少要有 `_socket.pyd`）

### 2) 修正 `_pth`（启用标准库与 site-packages）

Embedded Python 默认会禁用 `site`，导致 `site-packages` 不生效。

本项目采用的 `python311._pth` 基准内容如下（关键是：加入 `Lib` / `Lib\\site-packages` / `Lib\\site-packages-codeapp` 并启用 `import site`）：

- `python311.zip`
- `.`
- `Lib`
- `Lib\\site-packages`
- `Lib\\site-packages-codeapp`
- `import site`

> 注：项目内也提供了 `npm run py:bootstrap`，会自动尝试修正该文件。

---

## 正常安装依赖流程（推荐）

本项目把依赖分两类目录存放：

- `resources/python/Lib/site-packages/`
  - **只放 pip 工具链**（pip / setuptools / wheel）
  - 不建议手动清空，否则会把 pip 删掉

- `resources/python/Lib/site-packages-codeapp/`
  - **只放脚本依赖**（以 codeApp 为例：uiautomator2 / adbutils / requests / lxml / pillow ...）
  - 可以放心清空并重装（不会影响 pip 本身）

### 0) requirements 的位置（单一真相）

codeApp 的依赖清单固定在：

- `scripts/codeApp/requirements.txt`

新增/升级依赖：只需要编辑这个文件。

### 1) 安装 pip（仅首次需要）

如果内置 Python 里还没有 pip：

- `npm run py:bootstrap`

该命令会：

- 修正 `python311._pth`
- 如果缺少 pip：用 `resources/python/get-pip.py` 引导安装 pip 到 `Lib/site-packages`

验证：

- `npm run py:pip:version`

### 2) 安装脚本依赖（常用命令）

- `npm run py:codeapp:deps`

它会根据 `scripts/codeApp/requirements.txt`，把依赖安装到：

- `resources/python/Lib/site-packages-codeapp/`

### 3) 清空并重装脚本依赖

- `npm run py:codeapp:deps:clean`
- `npm run py:codeapp:deps`

---

## 常见问题

### 1) import 第三方库失败

优先检查：

- `python311._pth` 是否包含：`Lib`、`Lib\\site-packages`、`Lib\\site-packages-codeapp`，并启用了 `import site`

### 2) `python -m pip ...` 报 `No module named pip`

说明 pip 未安装或被误删。解决：

- 重新执行：`npm run py:bootstrap`

> 注意：不要清空 `Lib/site-packages/`，否则会把 pip 一起删掉。

### 3) 网络/SSL 相关错误（下载依赖失败）

如果 `pip install` 出现 SSL 报错，通常和网络代理/拦截有关。可尝试：

- 改用可用网络
- 或先用本机 pip 执行 `pip download ...` 生成 wheel 缓存（`wheelhouse/`），再离线安装（后续可增强自动化）

## 推荐做法（脚本作者视角）

- 脚本通过环境变量读取 adb 路径：`HCA_ADB_PATH`
- 尽量输出 JSON 行日志，便于 UI 解析：

```python
print(json.dumps({"type": "log", "msg": "hello"}), flush=True)
```
