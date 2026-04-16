import { ipcMain } from 'electron'
import Store from 'electron-store'

const store = new Store({
  defaults: {
    fileList: []
  }
})
export function initStoreIpc() {
  //渲染进程 调用示例
  // const fileList = await ipcRenderer.invoke("store", "get", "fileList")
  // console.log("获取到本地store", fileList)
  ipcMain.handle('store', (event, method, ...args) => {
    return store[method](...args)
  })
}

// export default store
