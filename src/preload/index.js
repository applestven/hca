import { contextBridge } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import onboarding from './onboarding'
import scripts from './scripts'

const updater = {
  mode: () => electronAPI.ipcRenderer.invoke('update:mode'),
  policy: () => electronAPI.ipcRenderer.invoke('update:policy'),
  check: () => electronAPI.ipcRenderer.invoke('update:check'),
  download: () => electronAPI.ipcRenderer.invoke('update:download'),
  install: () => electronAPI.ipcRenderer.invoke('update:install'),
  /**
   * 订阅更新事件
   * @param {string} channel update:checking|update:available|update:not-available|update:error|update:download-progress|update:downloaded
   * @param {(payload:any)=>void} callback
   * @returns {() => void} unsubscribe
   */
  on: (channel, callback) => {
    const listener = (_event, payload) => callback(payload)
    electronAPI.ipcRenderer.on(channel, listener)
    return () => electronAPI.ipcRenderer.removeListener(channel, listener)
  }
}

// Custom APIs for renderer
const api = {
  window: {
    minimize: () => electronAPI.ipcRenderer.invoke('window:minimize'),
    maximizeToggle: () => electronAPI.ipcRenderer.invoke('window:maximize-toggle'),
    close: () => electronAPI.ipcRenderer.invoke('window:close'),
    isMaximized: () => electronAPI.ipcRenderer.invoke('window:is-maximized')
  },
  app: {
    getVersion: () => electronAPI.ipcRenderer.invoke('app:get-version')
  },
  theme: {
    get: () => electronAPI.ipcRenderer.invoke('theme:get'),
    set: (next) => electronAPI.ipcRenderer.invoke('theme:set', next)
  },
  device: {
    list: () => electronAPI.ipcRenderer.invoke('device:list'),
    connectWifi: (ip, port) => electronAPI.ipcRenderer.invoke('device:connect-wifi', { ip, port }),
    /**
     * 添加 WiFi 设备（输入即存本地）
     * - 有 pairCode：adb pair IP:port CODE → adb connect IP:port
     * - 无 pairCode：直接 adb connect IP:port
     * @param {{ ip: string, port?: number|string, pairCode?: string }} payload
     */
    addWifi: (payload) => electronAPI.ipcRenderer.invoke('device:add-wifi', payload),
    getWifiForm: () => electronAPI.ipcRenderer.invoke('device:wifi-form:get'),
    setWifiForm: (payload) => electronAPI.ipcRenderer.invoke('device:wifi-form:set', payload),
    connectMany: (targets, options) =>
      electronAPI.ipcRenderer.invoke('device:connect-many', {
        targets,
        concurrency: options?.concurrency
      }),
    disconnect: (serial, options) =>
      electronAPI.ipcRenderer.invoke('device:disconnect', { serial, forget: options?.forget }),
    scrcpyStart: (serial) => electronAPI.ipcRenderer.invoke('device:scrcpy:start', { serial }),
    // Scrcpy 预览窗口大小（持久化）
    scrcpySettingsGet: (serial) => electronAPI.ipcRenderer.invoke('scrcpy:get-settings', { serial }),
    scrcpySettingsSet: ({ serial, width, height, maxSize, scope }) =>
      electronAPI.ipcRenderer.invoke('scrcpy:set-settings', { serial, width, height, maxSize, scope }),
    tap: (serial, x, y) => electronAPI.ipcRenderer.invoke('device:tap', { serial, x, y }),
    swipe: (serial, x1, y1, x2, y2, durationMs) =>
      electronAPI.ipcRenderer.invoke('device:swipe', { serial, x1, y1, x2, y2, durationMs }),
    text: (serial, text) => electronAPI.ipcRenderer.invoke('device:text', { serial, text }),
    keyevent: (serial, keyCode) => electronAPI.ipcRenderer.invoke('device:keyevent', { serial, keyCode }),
    startApp: (serial, pkg, activity) =>
      electronAPI.ipcRenderer.invoke('device:start-app', { serial, pkg, activity }),
    reconnect: (serial) => electronAPI.ipcRenderer.invoke('device:reconnect', { serial }),
    listKnownWifi: () => electronAPI.ipcRenderer.invoke('device:known-wifi:list'),
    forgetKnownWifi: (target) => electronAPI.ipcRenderer.invoke('device:known-wifi:forget', { target }),
    rememberKnownWifi: (payload) => electronAPI.ipcRenderer.invoke('device:known-wifi:remember', payload),
    getAutoReconnect: () => electronAPI.ipcRenderer.invoke('device:auto-reconnect:get'),
    setAutoReconnect: (enabled) =>
      electronAPI.ipcRenderer.invoke('device:auto-reconnect:set', { enabled }),
    autoConnectKnown: (options) =>
      electronAPI.ipcRenderer.invoke('device:auto-connect-known', {
        concurrency: options?.concurrency
      })
  },
  adb: {
    restart: () => electronAPI.ipcRenderer.invoke('adb:restart')
  },
  scripts,
  onboarding,
  updater,
  permission: {
    getMachineId: () => electronAPI.ipcRenderer.invoke('permission:get-machine-id'),
    refresh: () => electronAPI.ipcRenderer.invoke('permission:refresh'),
    activate: (code) => electronAPI.ipcRenderer.invoke('permission:activate', { code })
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  window.electron = electronAPI
  window.api = api
}
