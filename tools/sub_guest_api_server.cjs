/**
 * 开发用：不依赖 Electron 窗口，单独拉起 Sub 获客 CRM HTTP。
 * 用法：node tools/sub_guest_api_server.cjs
 */
const path = require('path')
const { pathToFileURL } = require('url')

process.env.HCA_SUB_GUEST_ROOT = path.join(__dirname, '..', '.sub_guest_data')

async function main() {
  const storePath = path.join(__dirname, '..', 'src', 'main', 'utils', 'subGuestStore.js')
  const mod = await import(pathToFileURL(storePath).href)
  const info = await mod.startSubGuestHttpServer()
  console.log('[subGuest-dev-api]', info.baseUrl)
  console.log('[subGuest-dev-api] root=', process.env.HCA_SUB_GUEST_ROOT)
  process.on('SIGINT', () => {
    mod.stopSubGuestHttpServer()
    process.exit(0)
  })
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
