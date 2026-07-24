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
    // 固定模板名，避免不同项目/环境生成规则不一致
    id = machineIdSync({ original: true, templateName: 'hca' })
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

  function escapeShellArg(v) {
    // curl 在 shell 下最稳妥：统一用双引号包裹，并转义双引号与反斜杠
    return `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  }

  function toCurl({ method, url, headers, body }) {
    const parts = ['curl', '-i', '-sS', '-X', method]
    for (const [k, v] of Object.entries(headers || {})) {
      if (v === undefined || v === null) continue
      parts.push('-H', escapeShellArg(`${k}: ${v}`))
    }
    if (body !== undefined && body !== null && body !== '') {
      parts.push('--data-raw', escapeShellArg(body))
    }
    parts.push(escapeShellArg(url))
    return parts.join(' ')
  }

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

    // 说明：
    // - GET 请求不要强行带 content-type（有些后端/网关会因此走错误分支甚至 500）
    // - 仅在有 body 时再声明 content-type
    const baseHeaders = {
      accept: 'application/json, text/plain, */*'
    }
    const finalHeaders = {
      ...baseHeaders,
      ...(payload ? { 'content-type': 'application/json' } : {}),
      ...(headers || {})
    }

    // 开发环境：打印可复制的 curl（用于外部复现请求）
    if (process.env.NODE_ENV === 'development') {
      const curl = toCurl({ method, url, headers: finalHeaders, body: payload })
      console.log(`[permission-api] ${method} ${url}`)
      console.log(`[permission-api] curl: ${curl}`)
    }

    return await new Promise((resolve, reject) => {
      const req = net.request({
        method,
        url,
        headers: finalHeaders
      })

      let chunks = ''
      req.on('response', (res) => {
        const status = res.statusCode || 0
        const ctRaw = Array.isArray(res.headers?.['content-type'])
          ? res.headers['content-type'].join(';')
          : res.headers?.['content-type']
        const contentType = String(ctRaw || '')

        res.on('data', (d) => (chunks += d.toString()))
        res.on('end', () => {
          const bodyText = String(chunks || '')
          const snippet = bodyText.slice(0, 200)

          // 1) 空响应
          if (!bodyText) return reject(new Error(`empty response (status=${status})`))

          // 2) 非 2xx：很多情况下会返回 HTML 错误页（例如 404/500/反代异常）
          if (status < 200 || status >= 300) {
            return reject(
              new Error(
                `HTTP ${status} ${method} ${url} (content-type=${contentType || 'unknown'}) body: ${JSON.stringify(snippet)}`
              )
            )
          }

          // 3) content-type 不是 json 或 body 以 < 开头：大概率是 HTML（例如 nginx/express 默认错误页）
          const looksLikeHtml = /^\s*</.test(bodyText)
          const looksLikeJsonCT = /application\/json/i.test(contentType)
          if (!looksLikeJsonCT || looksLikeHtml) {
            return reject(
              new Error(
                `Non-JSON response ${method} ${url} (content-type=${contentType || 'unknown'}) body: ${JSON.stringify(snippet)}`
              )
            )
          }

          // 4) JSON 解析
          try {
            const json = JSON.parse(bodyText)
            if (!json) return reject(new Error('empty json'))
            if (json.code !== 1) return reject(new Error(json.msg || 'request failed'))
            resolve(json)
          } catch (e) {
            reject(
              new Error(
                `JSON parse error ${method} ${url}: ${(e && e.message) || String(e)} body: ${JSON.stringify(snippet)}`
              )
            )
          }
        })
      })
      req.on('error', (e) => reject(e))
      if (payload) req.write(payload)
      req.end()
    })
  }

  return {
    // 注册/初始化（后端会在此接口内自动创建用户记录）
    getFeatures: (machineId) =>
      request('/activation_codes/features', { method: 'GET', query: { machineId, templateName: 'hca' } }),
    activateCode: (user_id, code) => request('/user_activation_codes/activation', { method: 'POST', body: { user_id, code } }),
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

/** 本地脚本默认永久权限（接口无对应 key / 无法匹配时使用） */
export const LOCAL_LIFETIME_FEATURE = Object.freeze({ type: 'lifetime', source: 'local' })

/**
 * 解析本地脚本权限：
 * - 接口 features 中有该 key → 使用接口权限
 * - 接口没有该 key，或本地脚本列表无法匹配到该 key → 永久可用
 *
 * @param {object|null|undefined} features 接口返回的 features 对象
 * @param {string} key 本地脚本 manifest.key
 * @param {string[]|Set<string>|null} localKeys 本地脚本 key 集合；传入时用于判断「本地匹配不上」
 */
export function resolveScriptFeature(features, key, localKeys = null) {
  const k = String(key || '').trim()
  if (!k) return null

  if (localKeys) {
    const set = localKeys instanceof Set ? localKeys : new Set(localKeys)
    if (!set.has(k)) {
      // 本地不存在该脚本：无权限对象可校验（启动路径不应走到这里）
      return null
    }
  }

  const f = features && typeof features === 'object' ? features[k] : null
  if (!f || typeof f !== 'object') {
    // 接口没有该功能关键字 → 本地脚本永久可用
    return { ...LOCAL_LIFETIME_FEATURE }
  }
  return f
}

/**
 * 判断脚本是否可启动。
 * @returns {{ ok: boolean, feature: object|null, fromLocalDefault: boolean }}
 */
export function canUseScript(features, key, localKeys = null) {
  const feature = resolveScriptFeature(features, key, localKeys)
  if (!feature) return { ok: false, feature: null, fromLocalDefault: false }
  const fromLocalDefault = feature?.source === 'local'
  if (fromLocalDefault) return { ok: true, feature, fromLocalDefault: true }
  return { ok: featureIsValid(feature), feature, fromLocalDefault: false }
}
