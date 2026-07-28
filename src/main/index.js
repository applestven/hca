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
  adbReconnectSmart,
  adbAutoConnectTargets,
  adbConnectMany
} from './utils/adb'

import {
  enableWifiTcpip,
  pairAndConnect,
  atxCheck,
  atxInstall,
  atxForceInstall,
  ensureAtx,
  permissionCheck,
  ATX_DOWNLOAD_URLS
} from './utils/onboarding'

import { listScripts, startScript, stopScript, stopScriptGroup, checkPythonRuntime } from './utils/scriptRunner'
import { getOrCreateMachineId, createApiClient, canUseScript } from './utils/permission'
import {
  startSubGuestHttpServer,
  stopSubGuestHttpServer,
  getSubGuestHttpBaseUrl,
  listScripts as listSubGuestScripts,
  saveScripts as saveSubGuestScripts,
  getSelectedScriptIds as getSubGuestSelectedIds,
  setSelectedScriptIds as setSubGuestSelectedIds,
  listUsers as listSubGuestUsers,
  getUser as getSubGuestUser,
  upsertUser as upsertSubGuestUser,
  claimUser as claimSubGuestUser,
  releaseUser as releaseSubGuestUser,
  getSubGuestPaths
} from './utils/subGuestStore'

// 更新模式：ui（手动） | force（强制）
// 优先走更新服务器策略（policy.json），拉取失败再回退到环境变量
let UPDATE_MODE = process.env.UPDATE_MODE || 'ui'
let UPDATE_POLICY = null

// 提前注册 IPC，避免渲染进程过早调用导致 "No handler registered"
ipcMain.handle('update:mode', () => UPDATE_MODE)
ipcMain.handle('update:policy', () => UPDATE_POLICY)

// WiFi 已知设备 / 自动重连（electron-store 持久化）
const deviceStore = new Store({
  name: 'hca-devices',
  defaults: {
    knownWifi: [], // [{ target, ip, port, lastConnectedAt }]
    autoReconnect: true,
    // 设备中控「添加 WiFi」表单上次填写内容
    wifiForm: { ip: '', port: '5555', pairPort: '', pairCode: '' }
  }
})

function saveWifiForm({ ip, port, pairPort, pairCode } = {}) {
  deviceStore.set('wifiForm', {
    ip: String(ip || '').trim(),
    port: String(port ?? '5555').trim() || '5555',
    pairPort: String(pairPort ?? '').trim(),
    pairCode: String(pairCode || '').trim()
  })
}

function getWifiForm() {
  const form = deviceStore.get('wifiForm') || {}
  return {
    ip: String(form.ip || ''),
    port: String(form.port || '5555'),
    pairPort: String(form.pairPort || ''),
    pairCode: String(form.pairCode || '')
  }
}

function rememberWifiTarget(ip, port) {
  const p = Number(port) || 5555
  const target = `${String(ip).trim()}:${p}`
  if (!String(ip).trim() || !target.includes(':')) return
  const list = deviceStore.get('knownWifi') || []
  const next = [
    { target, ip: String(ip).trim(), port: p, lastConnectedAt: Date.now() },
    ...list.filter((x) => x?.target !== target)
  ].slice(0, 64)
  deviceStore.set('knownWifi', next)
}

function rememberWifiFromTarget(target) {
  const t = String(target || '').trim()
  if (!t.includes(':')) return
  const [ip, portStr] = t.split(':')
  rememberWifiTarget(ip, Number(portStr) || 5555)
}

function forgetWifiTarget(target) {
  const t = String(target || '').trim()
  const list = deviceStore.get('knownWifi') || []
  deviceStore.set(
    'knownWifi',
    list.filter((x) => x?.target !== t)
  )
}

async function autoConnectKnownWifi({ concurrency = 4 } = {}) {
  if (!deviceStore.get('autoReconnect')) {
    return { skipped: true, reason: 'autoReconnect disabled', results: [] }
  }
  const known = deviceStore.get('knownWifi') || []
  const targets = known.map((x) => x?.target).filter(Boolean)
  if (!targets.length) return { skipped: true, reason: 'no known wifi', results: [] }

  const results = await adbAutoConnectTargets(targets, { concurrency })
  for (const r of results) {
    if (r?.ok && r?.target) {
      rememberWifiFromTarget(r.target)
      // 自动重连成功后也确保 ATX（有缓存，不会每次重装）
      r.atx = await ensureAtx(r.target).catch((e) => ({
        ok: false,
        error: e?.message || String(e)
      }))
    }
  }
  return { skipped: false, results }
}

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
    height: 1080,
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
    const p = port ?? 5555
    const out = await adbConnect(ip, p)
    rememberWifiTarget(ip, p)
    const serial = `${String(ip).trim()}:${Number(p) || 5555}`
    const atx = await ensureAtx(serial).catch((e) => ({
      ok: false,
      error: e?.message || String(e)
    }))
    return { message: out, target: serial, atx }
  })

  /**
   * 添加 WiFi 设备：
   * - 有配对码：adb pair IP:port CODE → adb connect IP:port（同一端口）
   * - 无配对码：adb connect IP:port
   * 仅连接成功后写入 knownWifi，并自动检测/安装 ATX
   */
  ipcMain.handle('device:add-wifi', async (_e, { ip, port, pairPort, pairCode, connectPort } = {}) => {
    if (!ip) throw new Error('ip is required')
    const cPort = Number(connectPort ?? port) || 5555
    const pPort = Number(pairPort ?? port ?? connectPort) || cPort
    const code = String(pairCode || '').trim()

    saveWifiForm({
      ip,
      port: cPort,
      pairPort: code ? pPort : '',
      pairCode: code
    })

    let result
    if (code) {
      const r = await pairAndConnect(ip, pPort, code, cPort)
      if (r?.connectTarget) rememberWifiFromTarget(r.connectTarget)
      else if (r?.connectPort) rememberWifiTarget(ip, r.connectPort)
      result = { mode: 'pair', ip, port: r.connectPort || cPort, pairPort: pPort, ...r }
    } else {
      const message = await adbConnect(ip, cPort)
      rememberWifiTarget(ip, cPort)
      result = {
        mode: 'connect',
        ip,
        port: cPort,
        target: `${String(ip).trim()}:${cPort}`,
        message
      }
    }

    const serial = result.connectTarget || result.target || `${String(ip).trim()}:${result.port || cPort}`
    const atx = await ensureAtx(serial).catch((e) => ({
      ok: false,
      serial,
      error: e?.message || String(e)
    }))
    return { ...result, atx }
  })

  ipcMain.handle('device:ensure-atx', async (_e, { serial, force } = {}) => {
    if (!serial) throw new Error('serial is required')
    return await ensureAtx(serial, { force: Boolean(force) })
  })

  ipcMain.handle('device:atx-install', async (_e, { serial } = {}) => {
    if (!serial) throw new Error('serial is required')
    return await atxForceInstall(serial)
  })

  ipcMain.handle('device:atx-check', async (_e, { serial } = {}) => {
    if (!serial) throw new Error('serial is required')
    return await atxCheck(serial)
  })

  /** 打开 ATX / uiautomator APK / atx-agent 官方下载页 */
  ipcMain.handle('device:atx-open-downloads', async (_e, { which } = {}) => {
    const urls =
      which === 'apk'
        ? [ATX_DOWNLOAD_URLS.apk]
        : which === 'apkDirect'
          ? [ATX_DOWNLOAD_URLS.apkDirect]
          : which === 'agent'
            ? [ATX_DOWNLOAD_URLS.agent]
            : [ATX_DOWNLOAD_URLS.apk, ATX_DOWNLOAD_URLS.agent]
    for (const url of urls) {
      await shell.openExternal(url)
    }
    return { ok: true, urls }
  })

  ipcMain.handle('shell:open-external', async (_e, { url } = {}) => {
    const u = String(url || '').trim()
    if (!/^https?:\/\//i.test(u)) throw new Error('invalid url')
    await shell.openExternal(u)
    return { ok: true, url: u }
  })

  ipcMain.handle('device:wifi-form:get', () => getWifiForm())

  ipcMain.handle('device:wifi-form:set', (_e, payload = {}) => {
    saveWifiForm(payload)
    return getWifiForm()
  })

  ipcMain.handle('device:connect-many', async (_e, { targets, concurrency } = {}) => {
    const list = Array.isArray(targets) ? targets : []
    const results = await adbConnectMany(list, {
      concurrency: concurrency ?? 8,
      pingFirst: false,
      tcpProbeFirst: true
    })
    for (const r of results) {
      if (r?.ok && r?.target) {
        rememberWifiFromTarget(r.target)
        r.atx = await ensureAtx(r.target).catch((e) => ({
          ok: false,
          error: e?.message || String(e)
        }))
      }
    }
    return results
  })

  ipcMain.handle('device:known-wifi:list', () => deviceStore.get('knownWifi') || [])

  ipcMain.handle('device:known-wifi:forget', (_e, { target } = {}) => {
    if (!target) throw new Error('target is required')
    forgetWifiTarget(target)
    return deviceStore.get('knownWifi') || []
  })

  ipcMain.handle('device:known-wifi:remember', (_e, { ip, port, target } = {}) => {
    if (target) rememberWifiFromTarget(target)
    else if (ip) rememberWifiTarget(ip, port ?? 5555)
    else throw new Error('ip or target is required')
    return deviceStore.get('knownWifi') || []
  })

  ipcMain.handle('device:auto-reconnect:get', () => Boolean(deviceStore.get('autoReconnect')))

  ipcMain.handle('device:auto-reconnect:set', (_e, { enabled } = {}) => {
    deviceStore.set('autoReconnect', Boolean(enabled))
    return Boolean(deviceStore.get('autoReconnect'))
  })

  ipcMain.handle('device:auto-connect-known', async (_e, { concurrency } = {}) => {
    return await autoConnectKnownWifi({ concurrency: concurrency ?? 4 })
  })

  ipcMain.handle('device:scrcpy:start', async (_e, { serial } = {}) => {
    if (!serial) throw new Error('serial is required')

    const def = scrcpyStore.get('default') || { width: 0, height: 0, maxSize: 0 }
    const overrides = scrcpyStore.get('deviceOverrides') || {}
    const s = overrides[serial] ? { ...def, ...overrides[serial] } : def

    // 先做“启动即可”，后续再做：进程列表管理/退出/复用/窗口嵌入
    const child = spawnScrcpy({
      serial,
      windowTitle: `HCA - ${serial}`,
      windowWidth: s.width > 0 ? s.width : undefined,
      windowHeight: s.height > 0 ? s.height : undefined,
      maxSize: s.maxSize > 0 ? s.maxSize : undefined
    })
    return { pid: child.pid }
  })

  // ADB 管理
  ipcMain.handle('adb:restart', async () => {
    await adbKillServer().catch(() => {})
    const out = await adbStartServer().catch(() => '')
    return out
  })

  ipcMain.handle('device:disconnect', async (_e, { serial, forget } = {}) => {
    if (!serial) throw new Error('serial is required')
    const out = await adbDisconnect(serial)
    if (forget && String(serial).includes(':')) forgetWifiTarget(serial)
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

  ipcMain.handle('device:reconnect', async (_e, { serial } = {}) => {
    if (!serial) throw new Error('serial is required')
    const out = await adbReconnectSmart(serial)
    if (String(serial).includes(':')) rememberWifiFromTarget(serial)
    return out
  })

  // Setup Wizard / Onboarding
  ipcMain.handle('onboarding:enable-wifi-tcpip', async (_e, { serial, port } = {}) => {
    if (!serial) throw new Error('serial is required')
    const r = await enableWifiTcpip(serial, port ?? 5555)
    if (r?.ip) rememberWifiTarget(r.ip, r.port ?? 5555)
    return r
  })

  ipcMain.handle('onboarding:pair-and-connect', async (_e, { ip, port, code, pairPort, connectPort } = {}) => {
    if (!ip || !code) throw new Error('ip/code is required')
    const pPair = Number(pairPort ?? port)
    const pConnect = Number(connectPort ?? 0)
    if (!pPair) throw new Error('pairPort/port is required')
    const r = await pairAndConnect(ip, pPair, code, pConnect || undefined)
    if (r?.connectTarget) rememberWifiFromTarget(r.connectTarget)
    return r
  })

  ipcMain.handle('onboarding:atx-check', async (_e, { serial } = {}) => {
    if (!serial) throw new Error('serial is required')
    return await atxCheck(serial)
  })

  ipcMain.handle('onboarding:atx-install', async (_e, { serial } = {}) => {
    if (!serial) throw new Error('serial is required')
    return await atxInstall(serial)
  })

  ipcMain.handle('onboarding:ensure-atx', async (_e, { serial, force } = {}) => {
    if (!serial) throw new Error('serial is required')
    return await ensureAtx(serial, { force: Boolean(force) })
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

  // ===== Sub 获客 CRM（话术 / 用户状态） =====
  ipcMain.handle('subGuest:paths', async () => getSubGuestPaths())
  ipcMain.handle('subGuest:api-base', async () => getSubGuestHttpBaseUrl())
  ipcMain.handle('subGuest:scripts:list', async () => listSubGuestScripts())
  ipcMain.handle('subGuest:scripts:save', async (_e, payload) => saveSubGuestScripts(payload))
  ipcMain.handle('subGuest:scripts:selected', async () => getSubGuestSelectedIds())
  ipcMain.handle('subGuest:scripts:set-selected', async (_e, { ids } = {}) =>
    setSubGuestSelectedIds(ids || [])
  )
  ipcMain.handle('subGuest:users:list', async (_e, opts) => listSubGuestUsers(opts || {}))
  ipcMain.handle('subGuest:users:get', async (_e, { userId } = {}) => getSubGuestUser(userId))
  ipcMain.handle('subGuest:users:upsert', async (_e, user) => upsertSubGuestUser(user))
  ipcMain.handle('subGuest:users:claim', async (_e, { userId, device, ttlMs } = {}) =>
    claimSubGuestUser(userId, device, { ttlMs })
  )
  ipcMain.handle('subGuest:users:release', async (_e, { userId, device } = {}) =>
    releaseSubGuestUser(userId, device)
  )

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
    // 规则：接口 features 有对应 key → 按接口权限校验；接口无此 key / 本地匹配不上 → 永久可用
    if (!key) throw new Error('key is required')

    const machineId = permissionStore.get('machineId') || getOrCreateMachineId()
    permissionStore.set('machineId', machineId)

    const localKeys = listScripts().map((s) => s.key).filter(Boolean)
    if (!localKeys.includes(key)) {
      throw new Error('script not found')
    }

    let permission = permissionStore.get('permission')
    try {
      if (!permission) permission = await refreshPermission()
    } catch {
      // 接口不可用时：本地脚本按「无对应关键字」处理 → 永久可用
      permission = permission || { data: { features: {} } }
    }

    const features = permission?.data?.features
    const { ok, feature, fromLocalDefault } = canUseScript(features, key, localKeys)
    if (!ok) {
      throw new Error('您没有权限使用该脚本，或权限已过期/次数不足。请前往“版本”页面激活后再试。')
    }

    // 次数型：在启动前做一次扣减（服务端原子扣减）；本地默认永久权限不扣减
    if (!fromLocalDefault && feature?.type === 'count') {
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

    // 脚本启动不再检测/安装 ATX：uiautomator2 连接不依赖 atx-agent 预检
    const r = startScript({ key, params, deviceSerials }, (evt) => send(evt))
    return r
  })

  ipcMain.handle('scripts:stop', async (_e, { runId, group } = {}) => {
    if (!runId) throw new Error('runId is required')
    if (group) return stopScriptGroup(runId)
    return stopScript(runId)
  })

  // Scrcpy 预览设置（持久化）
  // 说明：外部 scrcpy 窗口尺寸难以可靠自动读取，因此采用“保存参数 -> 下次启动时应用参数”。
  const scrcpyStore = new Store({
    name: 'hca-scrcpy',
    defaults: {
      default: { width: 0, height: 0, maxSize: 0 },
      deviceOverrides: {}
    }
  })

  ipcMain.handle('scrcpy:get-settings', async (_e, { serial } = {}) => {
    const def = scrcpyStore.get('default') || { width: 0, height: 0, maxSize: 0 }
    const overrides = scrcpyStore.get('deviceOverrides') || {}
    const s = serial && overrides[serial] ? overrides[serial] : null
    return { serial, settings: { ...def, ...(s || {}) } }
  })

  ipcMain.handle('scrcpy:set-settings', async (_e, { serial, width, height, maxSize, scope = 'device' } = {}) => {
    const next = {
      width: Number(width) || 0,
      height: Number(height) || 0,
      maxSize: Number(maxSize) || 0
    }

    const hasWH = next.width > 0 && next.height > 0
    if (!hasWH) {
      next.width = 0
      next.height = 0
    }
    if (next.maxSize > 0 && hasWH) {
      next.maxSize = 0
    }

    if (scope === 'global') {
      scrcpyStore.set('default', next)
      return { scope, settings: next }
    }

    if (!serial) throw new Error('serial is required for device scope')
    const overrides = scrcpyStore.get('deviceOverrides') || {}
    overrides[serial] = next
    scrcpyStore.set('deviceOverrides', overrides)
    return { scope: 'device', serial, settings: next }
  })

  await initUpdateModeFromPolicy()

  try {
    const sub = await startSubGuestHttpServer()
    console.log('[subGuest] http:', sub.baseUrl)
  } catch (e) {
    console.error('[subGuest] init failed', e)
  }

  const mainWindow = createWindow()
  wireAutoUpdater(mainWindow)

  // 启动后自动连接历史 WiFi 设备（不阻塞窗口创建）
  setTimeout(() => {
    autoConnectKnownWifi({ concurrency: 4 }).catch(() => {})
  }, 1500)

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

app.on('before-quit', () => {
  try {
    stopSubGuestHttpServer()
  } catch {}
})

// In this file you can include the rest of your app"s specific main process
// code. You can also put them in separate files and require them here.
