import { net } from 'electron'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * 简易 semver 比较（仅支持 x.y.z 的数字形式）
 * @returns 1(a>b) | 0(equal) | -1(a<b)
 */
export function compareVersions(a = '0.0.0', b = '0.0.0') {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0)
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0
    const db = pb[i] ?? 0
    if (da > db) return 1
    if (da < db) return -1
  }
  return 0
}

export function isVersionLessThan(a, b) {
  return compareVersions(a, b) < 0
}

/**
 * 通过 electron.net 拉取 JSON（避免在主进程额外引 node-fetch）
 */
export async function fetchJson(url) {
  return new Promise((resolve, reject) => {
    try {
      const req = net.request({ method: 'GET', url })
      let raw = ''
      req.on('response', (res) => {
        res.on('data', (chunk) => (raw += chunk))
        res.on('end', () => {
          try {
            resolve(JSON.parse(raw || '{}'))
          } catch (e) {
            reject(e)
          }
        })
      })
      req.on('error', reject)
      req.end()
    } catch (e) {
      reject(e)
    }
  })
}

/**
 * 从更新服务器读取策略文件（policy.json）
 * @param {string} baseUrl electron-builder publish url，例如 http://localhost:8088
 */
export async function loadUpdatePolicy(baseUrl) {
  const url = `${String(baseUrl).replace(/\/$/, '')}/policy.json`
  const policy = await fetchJson(url)
  return policy || {}
}

function readGenericUrlFromYml(text = '') {
  // 极简解析：仅匹配 "url: xxx"（generic provider 足够）
  const m = String(text).match(/^\s*url\s*:\s*(.+)\s*$/m)
  if (!m) return ''
  return String(m[1]).trim().replace(/^['"]|['"]$/g, '')
}

function readFileSafe(p) {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return ''
  }
}

/**
 * 获取更新服务器 baseUrl
 * 优先级：
 * 1) UPDATE_BASE_URL / UPDATER_URL（可选覆盖）
 * 2) production: resources/app-update.yml（electron-builder 生成）
 * 3) dev: dev-app-update.yml（项目根，开发调试用）
 */
export function getUpdateBaseUrl() {
  const fromEnv = process.env.UPDATE_BASE_URL || process.env.UPDATER_URL
  if (fromEnv) return String(fromEnv)

  // production：打包后 electron-builder 会生成 resources/app-update.yml
  const prodYmlPath = join(process.resourcesPath, 'app-update.yml')
  const prodUrl = readGenericUrlFromYml(readFileSafe(prodYmlPath))
  if (prodUrl) return prodUrl

  // dev：从项目根 dev-app-update.yml 读取（electron-updater 默认支持）
  const devYmlPath = join(process.cwd(), 'dev-app-update.yml')
  const devUrl = readGenericUrlFromYml(readFileSafe(devYmlPath))
  if (devUrl) return devUrl

  return ''
}

export async function loadUpdatePolicyAuto() {
  const baseUrl = getUpdateBaseUrl()
  if (!baseUrl) return null
  return await loadUpdatePolicy(baseUrl)
}
