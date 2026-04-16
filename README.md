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



