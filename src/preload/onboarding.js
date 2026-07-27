import { electronAPI } from '@electron-toolkit/preload'

const onboarding = {
  enableWifiTcpip: (serial, port) =>
    electronAPI.ipcRenderer.invoke('onboarding:enable-wifi-tcpip', { serial, port }),
  pairAndConnect: (ip, port, code, connectPort) =>
    electronAPI.ipcRenderer.invoke('onboarding:pair-and-connect', {
      ip,
      port,
      pairPort: port,
      connectPort,
      code
    }),
  atxCheck: (serial) => electronAPI.ipcRenderer.invoke('onboarding:atx-check', { serial }),
  atxInstall: (serial) => electronAPI.ipcRenderer.invoke('onboarding:atx-install', { serial }),
  ensureAtx: (serial, force = false) =>
    electronAPI.ipcRenderer.invoke('onboarding:ensure-atx', { serial, force }),
  permissionCheck: (serial) => electronAPI.ipcRenderer.invoke('onboarding:permission-check', { serial })
}

export default onboarding
