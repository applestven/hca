import { electronAPI } from '@electron-toolkit/preload'

const onboarding = {
  enableWifiTcpip: (serial, port) =>
    electronAPI.ipcRenderer.invoke('onboarding:enable-wifi-tcpip', { serial, port }),
  pairAndConnect: (ip, port, code) =>
    electronAPI.ipcRenderer.invoke('onboarding:pair-and-connect', { ip, port, code }),
  atxCheck: (serial) => electronAPI.ipcRenderer.invoke('onboarding:atx-check', { serial }),
  atxInstall: (serial) => electronAPI.ipcRenderer.invoke('onboarding:atx-install', { serial }),
  permissionCheck: (serial) => electronAPI.ipcRenderer.invoke('onboarding:permission-check', { serial })
}

export default onboarding
