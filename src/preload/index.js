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
  device: {
    list: () => electronAPI.ipcRenderer.invoke('device:list'),
    connectWifi: (ip, port) => electronAPI.ipcRenderer.invoke('device:connect-wifi', { ip, port }),
    disconnect: (serial) => electronAPI.ipcRenderer.invoke('device:disconnect', { serial }),
    scrcpyStart: (serial) => electronAPI.ipcRenderer.invoke('device:scrcpy:start', { serial }),
    tap: (serial, x, y) => electronAPI.ipcRenderer.invoke('device:tap', { serial, x, y }),
    swipe: (serial, x1, y1, x2, y2, durationMs) =>
      electronAPI.ipcRenderer.invoke('device:swipe', { serial, x1, y1, x2, y2, durationMs }),
    text: (serial, text) => electronAPI.ipcRenderer.invoke('device:text', { serial, text }),
    keyevent: (serial, keyCode) => electronAPI.ipcRenderer.invoke('device:keyevent', { serial, keyCode }),
    startApp: (serial, pkg, activity) =>
      electronAPI.ipcRenderer.invoke('device:start-app', { serial, pkg, activity }),
    reconnect: (serial) => electronAPI.ipcRenderer.invoke('device:reconnect', { serial }),
    scanRange: (range, port, options) =>
      electronAPI.ipcRenderer.invoke('device:scan-range', {
        range,
        port,
        concurrency: options?.concurrency,
        pingFirst: options?.pingFirst
      })
  },
  scripts,
  onboarding,
  updater
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
