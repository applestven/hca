import fs from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { machineIdSync } from 'node-machine-id'

function fallbackUuid() {
  // Node.js 16+ 支持 randomUUID；Electron 31 使用的 Node 版本满足
  try {
    // eslint-disable-next-line n/no-unsupported-features/node-builtins
    const { randomUUID } = require('crypto')
    if (typeof randomUUID === 'function') return randomUUID()
  } catch {
    // ignore
  }

  // 最后兜底：时间戳 + 随机数
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`
}

/**
 * 获取/生成本机 machineId（持久化到 userData/device-id.txt）。
 * - 优先 node-machine-id
 * - 失败则 randomUUID()
 */
export function getOrCreateMachineId() {
  const userDataPath = app.getPath('userData')
  const idFilePath = join(userDataPath, 'device-id.txt')

  try {
    if (fs.existsSync(idFilePath)) {
      const v = fs.readFileSync(idFilePath, 'utf8').trim()
      if (v) return v
    }
  } catch {
    // ignore
  }

  let id = ''
  try {
    id = machineIdSync({ original: true })
  } catch {
    id = fallbackUuid()
  }

  try {
    fs.mkdirSync(userDataPath, { recursive: true })
    fs.writeFileSync(idFilePath, id, 'utf8')
  } catch {
    // ignore
  }

  return id
}

/**
 * 极简接口请求封装（主进程使用 electron.net，避免引入 node-fetch/axios）。
 * 约定：后端返回 { code: 1, data, msg }
 */
export function createApiClient({ baseUrl }) {
  const base = String(baseUrl || '').replace(/\/$/, '')

  async function request(path, { method = 'GET', query, body, headers } = {}) {
    const { net } = await import('electron')

    let url = `${base}${path.startsWith('/') ? '' : '/'}${path}`
    if (query && typeof query === 'object') {
      const qs = new URLSearchParams()
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null) continue
        qs.set(k, String(v))
      }
      const s = qs.toString()
      if (s) url += (url.includes('?') ? '&' : '?') + s
    }

    const payload = body === undefined ? undefined : JSON.stringify(body)

    return await new Promise((resolve, reject) => {
      const req = net.request({
        method,
        url,
        headers: {
          'content-type': 'application/json',
          ...(headers || {})
        }
      })

      let chunks = ''
      req.on('response', (res) => {
        res.on('data', (d) => (chunks += d.toString()))
        res.on('end', () => {
          try {
            const json = chunks ? JSON.parse(chunks) : null
            if (!json) return reject(new Error('empty response'))
            if (json.code !== 1) return reject(new Error(json.msg || 'request failed'))
            resolve(json)
          } catch (e) {
            reject(e)
          }
        })
      })
      req.on('error', (e) => reject(e))
      if (payload) req.write(payload)
      req.end()
    })
  }

  return {
    getFeatures: (machineId) => request('/activation_codes/features', { method: 'GET', query: { machineId } }),
    activateCode: (user_id, code) =>
      request('/user_activation_codes/activation', { method: 'POST', body: { user_id, code } }),
    updateFeatureCount: (id, featuresKeyword) =>
      request('/user_codes/updateFeaturesCount', { method: 'POST', body: { id, featuresKeyword } })
  }
}

export function featureIsValid(f) {
  if (!f || typeof f !== 'object') return false
  const t = f.type
  if (t === 'lifetime') return true
  if (t === 'monthly' || t === 'yearly') {
    if (!f.expireDate) return false
    const now = Date.now()
    const exp = Date.parse(f.expireDate)
    return Number.isFinite(exp) && now <= exp
  }
  if (t === 'count') {
    return Number(f.remaining || 0) > 0
  }
  return false
}
