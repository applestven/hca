import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
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

// 更新模式：ui（手动） | force（强制）
// 优先走更新服务器策略（policy.json），拉取失败再回退到环境变量
let UPDATE_MODE = process.env.UPDATE_MODE || 'ui'
let UPDATE_POLICY = null

// 提前注册 IPC，避免渲染进程过早调用导致 "No handler registered"
ipcMain.handle('update:mode', () => UPDATE_MODE)
ipcMain.handle('update:policy', () => UPDATE_POLICY)

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

  // Default open or close DevTools by F12 in development
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
