import { electronAPI } from '@electron-toolkit/preload'

const scripts = {
  list: () => electronAPI.ipcRenderer.invoke('scripts:list'),
  checkRuntime: () => electronAPI.ipcRenderer.invoke('scripts:check-runtime'),
  start: ({ key, params, deviceSerials }) =>
    electronAPI.ipcRenderer.invoke('scripts:start', { key, params, deviceSerials }),
  stop: (runId, options) => electronAPI.ipcRenderer.invoke('scripts:stop', { runId, group: options?.group }),
  onEvent: (callback) => {
    const listener = (_evt, payload) => callback(payload)
    electronAPI.ipcRenderer.on('scripts:event', listener)
    return () => electronAPI.ipcRenderer.removeListener('scripts:event', listener)
  }
}

export default scripts
