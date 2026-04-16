# electron-temp

An Electron application with React

## 介绍 

react+vite+electron 构建项目  构建参考：https://zhuanlan.zhihu.com/p/659545980

## Project Setup

### Install

```bash
$ npm install
```

### Development

```bash
$ npm run dev
```

### Build

```bash
# For windows
$ npm run build:win

# For macOS
$ npm run build:mac

# For Linux
$ npm run build:linux
```

## 自动更新（electron-updater）

本项目支持两种更新模式：

- `ui`：由渲染进程单独界面控制（检查/下载/安装）。适合“可选更新”。
- `force`：强制更新模式，主进程弹窗提示并自动下载，下载完成后提示并重启安装。适合“必须更新”。

### 切换模式

通过环境变量 `UPDATE_MODE` 控制（默认 `ui`）：

- `UPDATE_MODE=ui`
- `UPDATE_MODE=force`

### 行为差异

#### UI 模式（ui）

- 主进程：只检查更新，不自动下载
- 渲染进程：显示 `UpdaterPanel`（示例）并控制下载/安装

#### 强制模式（force）

- 主进程：检查到更新后弹窗提示并自动下载
- 下载完成后弹窗提示并自动安装（重启）
- 渲染进程：不显示更新面板（避免 UI 冲突）

### 1) 依赖

- `electron-updater`

### 2) 配置文件

#### 2.1 `dev-app-update.yml`

开发环境用于模拟更新源（默认模板为 generic）。本项目主进程已禁止 dev 环境触发更新检查（`is.dev` 直接 return）。

#### 2.2 `electron-builder.yml` 的 `publish`

打包后自动更新依赖 `publish` 配置。你需要把 `provider/url` 改成自己的更新服务器地址（或改成 GitHub 等 provider）。

当前 `electron-builder.yml`：

- `publish.provider: generic`
- `publish.url: https://example.com/auto-updates`

### 3) 主进程（`src/main/index.js`）

- 启动后自动检查更新（production）
- `autoUpdater.autoDownload = false`（不自动下载，交给 UI 控制）
- IPC：
  - `update:check`
  - `update:download`
  - `update:install`
- 事件转发到渲染进程：
  - `update:checking`
  - `update:available`
  - `update:not-available`
  - `update:error`
  - `update:download-progress`
  - `update:downloaded`

### 4) preload（`src/preload/index.js`）

对渲染进程暴露：`window.api.updater`

- `window.api.updater.check()`
- `window.api.updater.download()`
- `window.api.updater.install()`
- `window.api.updater.on(channel, cb)`：订阅事件，返回 `unsubscribe`

### 5) 渲染进程 UI 示例

示例组件：`src/renderer/components/UpdaterPanel.jsx`

你可以把它放到任何页面使用（当前示例已在一个页面里引入）。

### 6) 常见问题

1. **安装包才能稳定更新**：Windows 推荐 NSIS 安装版。
2. **版本号必须递增**：按 `package.json#version` 判断。
3. **发布产物必须完整**：generic 方式需要把 `latest*.yml`、安装包、blockmap 一起上传。
4. **Cannot find module 'conf'**：如果打包后出现该错误，说明 `conf` 未包含进生产依赖（常见于 lockfile/依赖安装不一致）。建议使用npm 重新安装依赖 不要使用yarn cnpm pnpm



### Build Project Route 

#### 支持Sass/Scss/Less/Stylus
- Vite本身提供了对.scss/.sass/.less/.styl/.stylus文件的内置支持 选其一 
yarn add -D sass

yarn add -D less

yarn add -D stylus

安装后，就可以直接使用以上对应的CSS预处理语言了，非常方便

### 设置路径别名 

electron-vite已经预设了路径别名配置 

例如：src/renderer/App.jsx，可以直接省略成@renderer/App.jsx。

已经删除了src/renderer/src目录，因此需要修改对应的预设配置 


在 electron.vite.config.mjs  中配置 


### 样式命名规范

G-xx： 表示全局样式，用来定义公用样式。
P-xx: 表示页面样式，用来设置页面的背景色、尺寸、定制化调整在此页面的组件样式。
M-xx: 表示组件样式，专注组件本身样式。

### 引入 Ant Design

yarn add antd

ConfigProvider 为组件提供统一的全局化配置  main/index.jsx 

### 配置preload  
vite 自带配置@electron-toolkit/preload
### 配置本地electron-store 

npm i electron-store 

/src/utils/stote

注意：electron-store 不同版本有bug  需要指定版本比如8.10.0


## 配置initIpc 渲染进程通信 

/src/utils/initIpc


## electron-vite初始化shadcn

初始化之前需要先初始化tailwindcss ，步骤走官网

npm i @radix-ui/react-slot class-variance-authority tailwind-merge

npm i autoprefixer @tailwindcss/forms  -D


## 在渲染目录下renderer/ ，创建 lib/utils.ts
```js
import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

```

## 给目录取别名 

因为npx 添加的shadcn的组件 里面的引用都是使用了别名 ， 又因为这是electron-vite项目 ， 所以需要修改别名

```js
'@m': resolve('src'),
'@': resolve('src/renderer')
```

## 后续如果需要使用界面 就需要从shadcn的组件库里拷贝过来

## 自动更新策略（policy.json）

为了解决“有时强制更新、有时可选更新（UI）”的问题，本项目支持从更新服务器读取策略文件 `policy.json`，无需重新打包即可切换行为。

### 1) policy.json 放置位置

将 `policy.json` 放到更新服务器根目录（与 `latest.yml` 同级）：

- `publish.url/latest.yml`
- `publish.url/policy.json`

例如：

- `http://localhost:8088/latest.yml`
- `http://localhost:8088/policy.json`

可参考示例：`resources/update-policy.example.json`

### 2) policy.json 字段

- `mode`: `'ui' | 'force'`
  - `ui`：渲染进程界面控制下载/安装
  - `force`：主进程弹窗提示 + 自动下载 + 下载后强制重启安装
- `minVersion`: string（例如 `"1.0.5"`）
  - 当 `当前版本 < minVersion` 时，无论 mode 是什么都按 **强制更新**处理（优先级最高）
- `message`: string
  - 可用于 UI/弹窗展示更新提示文案（扩展字段，业务按需使用）

### 3) 客户端读取逻辑

主进程启动后会尝试从 `publish.url/policy.json` 拉取策略；拉取失败会回退到环境变量 `UPDATE_MODE`（默认 `ui`）。

