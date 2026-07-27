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

export const subGuest = {
  paths: () => electronAPI.ipcRenderer.invoke('subGuest:paths'),
  apiBase: () => electronAPI.ipcRenderer.invoke('subGuest:api-base'),
  listScripts: () => electronAPI.ipcRenderer.invoke('subGuest:scripts:list'),
  saveScripts: (payload) => electronAPI.ipcRenderer.invoke('subGuest:scripts:save', payload),
  getSelectedIds: () => electronAPI.ipcRenderer.invoke('subGuest:scripts:selected'),
  setSelectedIds: (ids) => electronAPI.ipcRenderer.invoke('subGuest:scripts:set-selected', { ids }),
  listUsers: (opts) => electronAPI.ipcRenderer.invoke('subGuest:users:list', opts),
  getUser: (userId) => electronAPI.ipcRenderer.invoke('subGuest:users:get', { userId }),
  upsertUser: (user) => electronAPI.ipcRenderer.invoke('subGuest:users:upsert', user),
  claimUser: (userId, device, opts) =>
    electronAPI.ipcRenderer.invoke('subGuest:users:claim', { userId, device, ...(opts || {}) }),
  releaseUser: (userId, device) =>
    electronAPI.ipcRenderer.invoke('subGuest:users:release', { userId, device })
}

export default scripts
