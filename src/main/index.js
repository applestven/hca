import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join } from 'path'
import { optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
process.env['ELECTRON_DISABLE_SECURITY_WARNINGS'] = 'true'
import initIpc from '../utils/initIpc'
import { autoUpdater } from 'electron-updater'
import { isVersionLessThan, loadUpdatePolicy, getUpdateBaseUrl } from './utils/updatePolicy'

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
    }
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
  if (is.dev) return

  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.autoDownload = UPDATE_MODE === 'force'

  const send = (channel, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, payload)
    }
  }

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

  // 给渲染进程的控制能力（UI 更新模式使用）
  // update:mode / update:policy 已在文件顶部注册，这里不要重复注册

  ipcMain.handle('update:check', async () => {
    await autoUpdater.checkForUpdates()
    return true
  })

  // 兼容处理：某些依赖组合下 downloadUpdate 可能抛 retry not a function
  ipcMain.handle('update:download', async () => {
    try {
      await autoUpdater.downloadUpdate()
      return true
    } catch (e) {
      // 直接把错误抛给渲染进程展示
      throw new Error(e?.message || String(e))
    }
  })

  ipcMain.handle('update:install', async () => {
    autoUpdater.quitAndInstall(false, true)
    return true
  })

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
