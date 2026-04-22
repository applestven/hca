import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import Store from 'electron-store'
import { join } from 'path'
import { optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
process.env['ELECTRON_DISABLE_SECURITY_WARNINGS'] = 'true'
import initIpc from '../utils/initIpc'
import { autoUpdater } from 'electron-updater'
import { isVersionLessThan, loadUpdatePolicy, getUpdateBaseUrl } from './utils/updatePolicy'
import {
  adbListDevices,
  adbConnect,
  spawnScrcpy,
  adbKillServer,
  adbStartServer,
  adbDisconnect,
  adbTap,
  adbSwipe,
  adbInputText,
  adbKeyEvent,
  adbStartApp,
  adbScanIpRange,
  adbReconnectSmart
} from './utils/adb'

import {
  enableWifiTcpip,
  pairAndConnect,
  atxCheck,
  atxInstall,
  permissionCheck
} from './utils/onboarding'

import { listScripts, startScript, stopScript, stopScriptGroup, checkPythonRuntime } from './utils/scriptRunner'
import { getOrCreateMachineId, createApiClient, featureIsValid } from './utils/permission'

// 更新模式：ui（手动） | force（强制）
// 优先走更新服务器策略（policy.json），拉取失败再回退到环境变量
let UPDATE_MODE = process.env.UPDATE_MODE || 'ui'
let UPDATE_POLICY = null

// 提前注册 IPC，避免渲染进程过早调用导致 "No handler registered"
ipcMain.handle('update:mode', () => UPDATE_MODE)
ipcMain.handle('update:policy', () => UPDATE_POLICY)

// 主题配置（electron-store 持久化）
const themeStore = new Store({
  name: 'hca-settings',
  defaults: {
    theme: {
      mode: 'system', // system | light | dark
      background: 'default', // default | slate | grape | sea | sunset
      gradient: true // 是否启用渐变背景
    }
  }
})

const BUILTIN_THEMES = [
  { key: 'default', name: '默认' },
  { key: 'slate', name: '深灰' },
  { key: 'grape', name: '葡萄紫' },
  { key: 'sea', name: '海蓝' },
  { key: 'sunset', name: '落日橙' },
  { key: 'graphite', name: '石墨灰(#1F1F1F)' }
]

// 主题 IPC（尽量提前注册，避免渲染进程过早 invoke 导致 No handler registered）
ipcMain.handle('theme:get', async () => {
  const theme = themeStore.get('theme')
  return { theme, builtins: BUILTIN_THEMES }
})

ipcMain.handle('theme:set', async (_e, next = {}) => {
  const prev = themeStore.get('theme') || {}
  const merged = {
    ...prev,
    ...next,
    mode: next?.mode ?? prev?.mode ?? 'system',
    background: next?.background ?? prev?.background ?? 'default',
    gradient: typeof next?.gradient === 'boolean' ? next.gradient : (typeof prev?.gradient === 'boolean' ? prev.gradient : true)
  }

  // 白名单校验，避免写入无效值
  if (!['system', 'light', 'dark'].includes(merged.mode)) merged.mode = 'system'
  if (!BUILTIN_THEMES.some((t) => t.key === merged.background)) merged.background = 'default'
  merged.gradient = Boolean(merged.gradient)

  themeStore.set('theme', merged)
  return { theme: merged }
})

function createWindow() {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    autoHideMenuBar: true,
    // 隐藏原生标题栏，让页面使用自定义通用页眉
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 12, y: 12 } } : {}),
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      webSecurity: false
    },
    icon: icon
  })

  mainWindow.on('ready-to-show', () => {
    //初始化ipc通信
    initIpc(mainWindow)
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return mainWindow
}

async function initUpdateModeFromPolicy() {
  // publish url（generic）：优先从 app-update.yml/dev-app-update.yml 读取
  const baseUrl = getUpdateBaseUrl()
  console.log('[update] baseUrl:', baseUrl)
  if (!baseUrl) return

  try {
    const policy = await loadUpdatePolicy(baseUrl)
    UPDATE_POLICY = policy

    // mode: ui|force
    if (policy?.mode === 'ui' || policy?.mode === 'force') {
      UPDATE_MODE = policy.mode
    }
    console.log('[update] mode:', UPDATE_MODE)
    // minVersion：低于该版本则强制更新（优先级最高）
    const current = app.getVersion()
    if (policy?.minVersion && isVersionLessThan(current, policy.minVersion)) {
      UPDATE_MODE = 'force'
    }
  } catch {
    // ignore
  }
}

function wireAutoUpdater(mainWindow) {
  // 开发环境也要注册 IPC（否则渲染进程 invoke('update:check') 会报 No handler registered）
  // 仅在非 dev 时真正连接 electron-updater 能力。

  const send = (channel, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, payload)
    }
  }

  // UI 按钮调用的 IPC：开发环境给出友好提示
  ipcMain.handle('update:check', async () => {
    if (is.dev) {
      send('update:error', '开发环境未启用自动更新（electron-updater）')
      return false
    }
    await autoUpdater.checkForUpdates()
    return true
  })

  ipcMain.handle('update:download', async () => {
    if (is.dev) {
      send('update:error', '开发环境未启用自动更新（electron-updater）')
      return false
    }
    try {
      await autoUpdater.downloadUpdate()
      return true
    } catch (e) {
      throw new Error(e?.message || String(e))
    }
  })

  ipcMain.handle('update:install', async () => {
    if (is.dev) {
      send('update:error', '开发环境未启用自动更新（electron-updater）')
      return false
    }
    autoUpdater.quitAndInstall(false, true)
    return true
  })

  if (is.dev) return

  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.autoDownload = UPDATE_MODE === 'force'

  autoUpdater.on('checking-for-update', () => send('update:checking'))
  autoUpdater.on('update-available', async (info) => {
    send('update:available', info)

    // 强制更新：弹窗提示并自动下载
    if (UPDATE_MODE === 'force') {
      try {
        await dialog.showMessageBox(mainWindow, {
          type: 'info',
          title: '发现新版本',
          message: `检测到新版本 ${info?.version ?? ''}，应用将开始下载并在完成后重启安装。`,
          buttons: ['确定'],
          defaultId: 0
        })
      } catch {}

      // autoDownload=true 时会自动触发下载，这里仅做兜底
      try {
        await autoUpdater.downloadUpdate()
      } catch (e) {
        send('update:error', e?.message || String(e))
      }
    }
  })
  autoUpdater.on('update-not-available', (info) => send('update:not-available', info))
  autoUpdater.on('error', (err) => send('update:error', err?.message || String(err)))
  autoUpdater.on('download-progress', (progress) => send('update:download-progress', progress))
  autoUpdater.on('update-downloaded', async (info) => {
    send('update:downloaded', info)

    if (UPDATE_MODE === 'force') {
      try {
        await dialog.showMessageBox(mainWindow, {
          type: 'info',
          title: '更新已就绪',
          message: '更新已下载完成，即将重启安装。',
          buttons: ['立即重启'],
          defaultId: 0
        })
      } catch {}

      autoUpdater.quitAndInstall(false, true)
    }
  })

  // 渲染进程控制能力的 IPC 已在函数开头注册（含 dev 兼容），这里不再重复注册

  autoUpdater.checkForUpdates().catch(() => {})
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(async () => {
  // Set app user model id for windows
  // electronApp.setAppUserModelId('com.electron')

  // Default open or
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // IPC test
  ipcMain.on('ping', () => console.log('pong'))

  // 软件版本号（给版本页显示用）
  ipcMain.handle('app:get-version', () => app.getVersion())

  // 窗口控制（给自定义页眉按钮用）
  ipcMain.handle('window:minimize', () => {
    const win = BrowserWindow.getFocusedWindow()
    win?.minimize()
  })
  ipcMain.handle('window:maximize-toggle', () => {
    const win = BrowserWindow.getFocusedWindow()
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.handle('window:close', () => {
    const win = BrowserWindow.getFocusedWindow()
    win?.close()
  })
  ipcMain.handle('window:is-maximized', () => {
    const win = BrowserWindow.getFocusedWindow()
    return win?.isMaximized() ?? false
  })

  // 设备中控：ADB/Scrcpy
  ipcMain.handle('device:list', async () => {
    const list = await adbListDevices()
    return list
  })

  ipcMain.handle('device:connect-wifi', async (_e, { ip, port } = {}) => {
    if (!ip) throw new Error('ip is required')
    const out = await adbConnect(ip, port ?? 5555)
    return out
  })

  ipcMain.handle('device:scrcpy:start', async (_e, { serial } = {}) => {
    if (!serial) throw new Error('serial is required')

    // 先做“启动即可”，后续再做：进程列表管理/退出/复用/窗口嵌入
    const child = spawnScrcpy({ serial, windowTitle: `HCA - ${serial}` })
    return { pid: child.pid }
  })

  // ADB 管理
  ipcMain.handle('adb:restart', async () => {
    await adbKillServer().catch(() => {})
    const out = await adbStartServer().catch(() => '')
    return out
  })

  ipcMain.handle('device:disconnect', async (_e, { serial } = {}) => {
    if (!serial) throw new Error('serial is required')
    const out = await adbDisconnect(serial)
    return out
  })

  ipcMain.handle('device:tap', async (_e, { serial, x, y } = {}) => {
    if (!serial) throw new Error('serial is required')
    return await adbTap(serial, x, y)
  })

  ipcMain.handle('device:swipe', async (_e, { serial, x1, y1, x2, y2, durationMs } = {}) => {
    if (!serial) throw new Error('serial is required')
    return await adbSwipe(serial, x1, y1, x2, y2, durationMs)
  })

  ipcMain.handle('device:text', async (_e, { serial, text } = {}) => {
    if (!serial) throw new Error('serial is required')
    return await adbInputText(serial, text)
  })

  ipcMain.handle('device:keyevent', async (_e, { serial, keyCode } = {}) => {
    if (!serial) throw new Error('serial is required')
    return await adbKeyEvent(serial, keyCode)
  })

  ipcMain.handle('device:start-app', async (_e, { serial, pkg, activity } = {}) => {
    if (!serial) throw new Error('serial is required')
    if (!pkg) throw new Error('pkg is required')
    return await adbStartApp(serial, pkg, activity)
  })

  ipcMain.handle('device:scan-range', async (_e, { range, port, concurrency, pingFirst } = {}) => {
    const r = await adbScanIpRange(range, {
      port: port ?? 5555,
      concurrency: concurrency ?? 50,
      pingFirst: pingFirst ?? true
    })
    return r
  })

  ipcMain.handle('device:reconnect', async (_e, { serial } = {}) => {
    if (!serial) throw new Error('serial is required')
    return await adbReconnectSmart(serial)
  })

  // Setup Wizard / Onboarding
  ipcMain.handle('onboarding:enable-wifi-tcpip', async (_e, { serial, port } = {}) => {
    if (!serial) throw new Error('serial is required')
    return await enableWifiTcpip(serial, port ?? 5555)
  })

  ipcMain.handle('onboarding:pair-and-connect', async (_e, { ip, port, code } = {}) => {
    if (!ip || !port || !code) throw new Error('ip/port/code is required')
    return await pairAndConnect(ip, port, code)
  })

  ipcMain.handle('onboarding:atx-check', async (_e, { serial } = {}) => {
    if (!serial) throw new Error('serial is required')
    return await atxCheck(serial)
  })

  ipcMain.handle('onboarding:atx-install', async (_e, { serial } = {}) => {
    if (!serial) throw new Error('serial is required')
    return await atxInstall(serial)
  })

  ipcMain.handle('onboarding:permission-check', async (_e, { serial } = {}) => {
    if (!serial) throw new Error('serial is required')
    return await permissionCheck(serial)
  })

  // 脚本系统
  ipcMain.handle('scripts:list', async () => {
    return listScripts()
  })

  // 为什么要新增：你要求脚本必须依赖 uiautomator2，因此提供一个主进程自检能力
  // 让 UI 能明确提示“内置 Python/依赖缺失”而不是执行时才崩。
  ipcMain.handle('scripts:check-runtime', async () => {
    return await checkPythonRuntime()
  })

  // ===== 机器码/权限系统（仅对脚本功能做权限管控） =====
  const permissionStore = new Store({
    name: 'hca-permission',
    defaults: {
      machineId: '',
      permission: null
    }
  })

  const PERMISSION_API_BASE = process.env.HCA_PERMISSION_API_BASE || 'http://139.199.192.179:7001'
  const permissionApi = createApiClient({ baseUrl: PERMISSION_API_BASE })

  async function refreshPermission() {
    const machineId = permissionStore.get('machineId') || getOrCreateMachineId()
    permissionStore.set('machineId', machineId)
    const r = await permissionApi.getFeatures(machineId)
    permissionStore.set('permission', r)
    return r
  }

  ipcMain.handle('permission:get-machine-id', async () => {
    const machineId = permissionStore.get('machineId') || getOrCreateMachineId()
    permissionStore.set('machineId', machineId)
    return { machineId }
  })

  ipcMain.handle('permission:refresh', async () => {
    return await refreshPermission()
  })

  ipcMain.handle('permission:activate', async (_e, { code } = {}) => {
    const machineId = permissionStore.get('machineId') || getOrCreateMachineId()
    permissionStore.set('machineId', machineId)
    if (!code) throw new Error('code is required')

    // 激活
    await permissionApi.activateCode(machineId, code)
    // 激活后刷新权限
    return await refreshPermission()
  })

  ipcMain.handle('scripts:start', async (_e, { key, params, deviceSerials } = {}) => {
    // 在开始执行脚本前校验权限：按“脚本 key”校验（例如 soul 的 manifest.json key= soul）
    if (!key) throw new Error('key is required')

    const machineId = permissionStore.get('machineId') || getOrCreateMachineId()
    permissionStore.set('machineId', machineId)

    const permission = permissionStore.get('permission') || (await refreshPermission())
    const f = permission?.data?.features?.[key]
    if (!featureIsValid(f)) {
      throw new Error('您没有权限使用该脚本，或权限已过期/次数不足。请前往“版本”页面激活后再试。')
    }

    // 次数型：在启动前做一次扣减（服务端原子扣减）
    if (f?.type === 'count') {
      await permissionApi.updateFeatureCount(machineId, key)
      // 扣减后刷新缓存，保证 UI 展示一致
      await refreshPermission().catch(() => {})
    }

    // 使用主窗口（第一个窗口）确保事件一定发到 UI
    const mainWindow = BrowserWindow.getAllWindows()?.[0]
    const send = (payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('scripts:event', payload)
      }
    }

    const r = startScript({ key, params, deviceSerials }, (evt) => send(evt))
    return r
  })

  ipcMain.handle('scripts:stop', async (_e, { runId, group } = {}) => {
    if (!runId) throw new Error('runId is required')
    if (group) return stopScriptGroup(runId)
    return stopScript(runId)
  })

  await initUpdateModeFromPolicy()

  const mainWindow = createWindow()
  wireAutoUpdater(mainWindow)

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app"s specific main process
// code. You can also put them in separate files and require them here.
