/**
 * Sub 获客 CRM 存储
 * - 用户状态：SQLite（sql.js，免原生编译；落盘 userData/sub_guest/sub_guest.db）
 * - 话术：scripts.json
 * - 日志：logs/YYYY-MM-DD.jsonl（append）
 */
import fs from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { createRequire } from 'module'
import { createServer } from 'http'

const require = createRequire(import.meta.url)

const DEFAULT_LOCK_TTL_MS = 120_000
const MAX_RETRY = 3

let SQL = null
let db = null
let rootDir = ''
let scriptsPath = ''
let dbPath = ''
let logsDir = ''
let persistTimer = null
let writeChain = Promise.resolve()

function nowStr() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function todayStr() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function getRootDir() {
  return join(app.getPath('userData'), 'sub_guest')
}

function locateWasm() {
  const candidates = [
    join(process.cwd(), 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
    join(app.getAppPath(), 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
    process.resourcesPath ? join(process.resourcesPath, 'sql.js', 'sql-wasm.wasm') : ''
  ].filter(Boolean)
  for (const p of candidates) {
    if (fs.existsSync(p)) return p
  }
  // sql.js 可无 wasm 文件时走默认（部分环境）
  return candidates[0]
}

function schedulePersist() {
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    persistTimer = null
    persistDb()
  }, 200)
}

function persistDb() {
  if (!db || !dbPath) return
  try {
    const data = db.export()
    const tmp = `${dbPath}.tmp`
    fs.writeFileSync(tmp, Buffer.from(data))
    fs.renameSync(tmp, dbPath)
  } catch (e) {
    console.error('[subGuest] persistDb failed', e)
  }
}

function runExclusive(fn) {
  const next = writeChain.then(fn, fn)
  writeChain = next.catch(() => {})
  return next
}

function rowToUser(row) {
  if (!row) return null
  let lastSendContent = null
  if (row.last_send_content) {
    try {
      lastSendContent = JSON.parse(row.last_send_content)
    } catch {
      lastSendContent = [String(row.last_send_content)]
    }
  }
  return {
    userId: row.user_id,
    displayName: row.display_name || '',
    scriptId: row.script_id,
    scriptName: row.script_name || '',
    completedStep: Number(row.completed_step) || 0,
    nextStep: Number(row.next_step) || 1,
    status: row.status || 'pending',
    waitingReply: Boolean(row.waiting_reply),
    lastSendMessageId: row.last_send_message_id || null,
    lastSendContent,
    lastSendAt: row.last_send_at || null,
    lastReplyMessageId: row.last_reply_message_id || null,
    lastReplyAt: row.last_reply_at || null,
    retryCount: Number(row.retry_count) || 0,
    lastFailReason: row.last_fail_reason || null,
    lockedBy: row.locked_by || null,
    lockExpireAt: row.lock_expire_at || null,
    updatedAt: row.updated_at || ''
  }
}

function ensureSchema() {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY,
      display_name TEXT,
      script_id TEXT NOT NULL,
      script_name TEXT,
      completed_step INTEGER NOT NULL DEFAULT 0,
      next_step INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL,
      waiting_reply INTEGER NOT NULL DEFAULT 0,
      last_send_message_id TEXT,
      last_send_content TEXT,
      last_send_at TEXT,
      last_reply_message_id TEXT,
      last_reply_at TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      last_fail_reason TEXT,
      locked_by TEXT,
      lock_expire_at TEXT,
      updated_at TEXT NOT NULL
    );
  `)
  // 兼容旧库：补 last_send_content
  try {
    const cols = queryAll('PRAGMA table_info(users)')
    if (!cols.some((c) => c.name === 'last_send_content')) {
      db.run('ALTER TABLE users ADD COLUMN last_send_content TEXT')
    }
  } catch {
    // ignore
  }
  db.run(`CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_users_locked ON users(locked_by);`)
}

function defaultScriptsPayload() {
  return {
    version: 1,
    selectedIds: ['default'],
    scripts: [
      {
        id: 'default',
        name: '默认话术',
        variables: ['name'],
        steps: [
          { order: 1, messages: ['哈哈', '你好'], delay: { min: 0.8, max: 1.5 } },
          {
            order: 2,
            messages: ['你经常玩这个吗', '好怕被人发现啊'],
            delay: { min: 0.8, max: 1.5 }
          },
          { order: 3, messages: ['哈哈哈'], delay: { min: 0.5, max: 1.2 } }
        ]
      }
    ]
  }
}

function loadDefaultScriptsFromPackage() {
  const candidates = [
    join(process.cwd(), 'scripts', 'codeApp', 'sub_guest', 'scripts.default.json'),
    process.resourcesPath
      ? join(process.resourcesPath, 'scripts', 'codeApp', 'sub_guest', 'scripts.default.json')
      : '',
    process.resourcesPath
      ? join(process.resourcesPath, 'scripts', 'sub_guest', 'scripts.default.json')
      : ''
  ].filter(Boolean)

  for (const p of candidates) {
    if (!fs.existsSync(p)) continue
    try {
      return JSON.parse(fs.readFileSync(p, 'utf-8'))
    } catch {
      // ignore
    }
  }
  return defaultScriptsPayload()
}

/**
 * 仅在「没有任何话术」时生成并落盘一条默认话术。
 * 已有话术（含用户改过的默认话术）一律原样读写，不覆盖。
 */
function ensureScriptsFile() {
  if (!scriptsPath) {
    rootDir = getRootDir()
    scriptsPath = join(rootDir, 'scripts.json')
    fs.mkdirSync(rootDir, { recursive: true })
  }

  const seedAndWrite = () => {
    const payload = loadDefaultScriptsFromPackage()
    const out = {
      version: payload.version || 1,
      selectedIds: Array.isArray(payload.selectedIds) ? payload.selectedIds : ['default'],
      scripts: Array.isArray(payload.scripts) && payload.scripts.length ? payload.scripts : defaultScriptsPayload().scripts
    }
    if (!out.selectedIds.length && out.scripts[0]?.id) {
      out.selectedIds = [out.scripts[0].id]
    }
    fs.writeFileSync(scriptsPath, JSON.stringify(out, null, 2), 'utf-8')
    return out
  }

  if (!fs.existsSync(scriptsPath)) {
    return seedAndWrite()
  }

  try {
    const pack = JSON.parse(fs.readFileSync(scriptsPath, 'utf-8'))
    const scripts = Array.isArray(pack?.scripts) ? pack.scripts : []
    if (!scripts.length) {
      return seedAndWrite()
    }
    if (!Array.isArray(pack.selectedIds)) {
      pack.selectedIds = scripts.some((s) => s.id === 'default') ? ['default'] : []
    }
    return pack
  } catch {
    return seedAndWrite()
  }
}

export async function initSubGuestStore() {
  rootDir = getRootDir()
  scriptsPath = join(rootDir, 'scripts.json')
  dbPath = join(rootDir, 'sub_guest.db')
  logsDir = join(rootDir, 'logs')
  fs.mkdirSync(logsDir, { recursive: true })

  ensureScriptsFile()

  const initSqlJs = require('sql.js')
  const wasmPath = locateWasm()
  SQL = await initSqlJs({
    locateFile: (file) => (file.endsWith('.wasm') ? wasmPath : join(wasmPath, '..', file))
  })

  if (fs.existsSync(dbPath)) {
    const buf = fs.readFileSync(dbPath)
    db = new SQL.Database(buf)
  } else {
    db = new SQL.Database()
  }
  ensureSchema()
  persistDb()

  return { rootDir, dbPath, scriptsPath, logsDir }
}

export function getSubGuestPaths() {
  return { rootDir, dbPath, scriptsPath, logsDir }
}

export function listScripts() {
  return ensureScriptsFile()
}

export function getSelectedScriptIds() {
  const pack = listScripts()
  const ids = Array.isArray(pack.selectedIds) ? pack.selectedIds.map(String) : []
  const valid = new Set((pack.scripts || []).map((s) => s.id))
  return ids.filter((id) => valid.has(id))
}

export function setSelectedScriptIds(ids = []) {
  const pack = listScripts()
  const valid = new Set((pack.scripts || []).map((s) => s.id))
  const nextIds = Array.from(new Set((ids || []).map(String).filter((id) => valid.has(id))))
  return saveScripts({ ...pack, selectedIds: nextIds })
}

export function saveScripts(payload) {
  const next = payload && typeof payload === 'object' ? payload : null
  if (!next || !Array.isArray(next.scripts)) throw new Error('scripts must be an array')
  if (next.scripts.length > 100) throw new Error('最多 100 个话术')
  for (const s of next.scripts) {
    if (!s?.id) throw new Error('话术缺少 id')
    if ((s.steps || []).length > 10) throw new Error(`话术 ${s.id} 句本超过 10`)
    // 规范化间隔 0.1–10（默认话术也可改）
    for (const st of s.steps || []) {
      if (!st.delay) st.delay = { min: 0.8, max: 1.5 }
      const minRaw = Number(st.delay.min)
      const maxRaw = Number(st.delay.max)
      const min = Number.isFinite(minRaw) ? Math.min(10, Math.max(0.1, minRaw)) : 0.8
      const max = Number.isFinite(maxRaw) ? Math.min(10, Math.max(0.1, maxRaw)) : Math.max(min, 1.5)
      st.delay = { min, max: Math.max(max, min) }
    }
  }

  // 允许保存空列表；下次 listScripts/ensureScriptsFile 会再生成默认话术
  if (!scriptsPath) {
    rootDir = getRootDir()
    scriptsPath = join(rootDir, 'scripts.json')
    fs.mkdirSync(rootDir, { recursive: true })
  }

  const valid = new Set(next.scripts.map((s) => s.id))
  const selectedIds = Array.isArray(next.selectedIds)
    ? next.selectedIds.map(String).filter((id) => valid.has(id))
    : []

  const out = {
    version: next.version || 1,
    selectedIds,
    scripts: next.scripts
  }
  const tmp = `${scriptsPath}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2))
  fs.renameSync(tmp, scriptsPath)
  return listScripts()
}

function queryOne(sql, params = []) {
  const stmt = db.prepare(sql)
  stmt.bind(params)
  if (stmt.step()) {
    const row = stmt.getAsObject()
    stmt.free()
    return row
  }
  stmt.free()
  return null
}

function queryAll(sql, params = []) {
  const stmt = db.prepare(sql)
  stmt.bind(params)
  const out = []
  while (stmt.step()) out.push(stmt.getAsObject())
  stmt.free()
  return out
}

export function getUser(userId) {
  if (!userId) return null
  return rowToUser(queryOne('SELECT * FROM users WHERE user_id = ?', [String(userId)]))
}

export function listUsers({ limit = 200, status } = {}) {
  if (status) {
    return queryAll('SELECT * FROM users WHERE status = ? ORDER BY updated_at DESC LIMIT ?', [
      status,
      limit
    ]).map(rowToUser)
  }
  return queryAll('SELECT * FROM users ORDER BY updated_at DESC LIMIT ?', [limit]).map(rowToUser)
}

function upsertUserSync(user) {
  const userId = String(user?.userId || '').trim()
  if (!userId) throw new Error('userId is required')

  const prev = getUser(userId)
  let lastSendContent = user.lastSendContent !== undefined ? user.lastSendContent : prev?.lastSendContent ?? null
  if (Array.isArray(lastSendContent)) {
    lastSendContent = lastSendContent.map((x) => String(x ?? ''))
  } else if (lastSendContent != null && typeof lastSendContent !== 'string') {
    lastSendContent = [String(lastSendContent)]
  }

  const next = {
    userId,
    displayName: user.displayName ?? prev?.displayName ?? '',
    scriptId: user.scriptId ?? prev?.scriptId ?? 'default',
    scriptName: user.scriptName ?? prev?.scriptName ?? '',
    completedStep: user.completedStep ?? prev?.completedStep ?? 0,
    nextStep: user.nextStep ?? prev?.nextStep ?? 1,
    status: user.status ?? prev?.status ?? 'pending',
    waitingReply: user.waitingReply ?? prev?.waitingReply ?? false,
    lastSendMessageId: user.lastSendMessageId ?? prev?.lastSendMessageId ?? null,
    lastSendContent,
    lastSendAt: user.lastSendAt ?? prev?.lastSendAt ?? null,
    lastReplyMessageId: user.lastReplyMessageId ?? prev?.lastReplyMessageId ?? null,
    lastReplyAt: user.lastReplyAt ?? prev?.lastReplyAt ?? null,
    retryCount: user.retryCount ?? prev?.retryCount ?? 0,
    lastFailReason: user.lastFailReason ?? prev?.lastFailReason ?? null,
    lockedBy: user.lockedBy === undefined ? prev?.lockedBy ?? null : user.lockedBy,
    lockExpireAt: user.lockExpireAt === undefined ? prev?.lockExpireAt ?? null : user.lockExpireAt,
    updatedAt: nowStr()
  }

  const contentStr = Array.isArray(next.lastSendContent)
    ? JSON.stringify(next.lastSendContent)
    : next.lastSendContent
      ? JSON.stringify([String(next.lastSendContent)])
      : null

  db.run(
    `INSERT OR REPLACE INTO users (
      user_id, display_name, script_id, script_name,
      completed_step, next_step, status, waiting_reply,
      last_send_message_id, last_send_content, last_send_at, last_reply_message_id, last_reply_at,
      retry_count, last_fail_reason, locked_by, lock_expire_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      next.userId,
      next.displayName,
      next.scriptId,
      next.scriptName,
      next.completedStep,
      next.nextStep,
      next.status,
      next.waitingReply ? 1 : 0,
      next.lastSendMessageId,
      contentStr,
      next.lastSendAt,
      next.lastReplyMessageId,
      next.lastReplyAt,
      next.retryCount,
      next.lastFailReason,
      next.lockedBy,
      next.lockExpireAt,
      next.updatedAt
    ]
  )
  schedulePersist()
  return next
}

export function upsertUser(user) {
  return runExclusive(() => upsertUserSync(user))
}

function lockExpired(lockExpireAt) {
  if (!lockExpireAt) return true
  const t = Date.parse(String(lockExpireAt).replace(' ', 'T'))
  if (!Number.isFinite(t)) return true
  return Date.now() > t
}

export function claimUser(userId, device, { ttlMs = DEFAULT_LOCK_TTL_MS } = {}) {
  return runExclusive(() => {
    const id = String(userId || '').trim()
    const lockedBy = String(device || '').trim()
    if (!id) throw new Error('userId is required')
    if (!lockedBy) throw new Error('device is required')

    const u = getUser(id)
    if (!u) throw new Error('user not found')
    if (u.status === 'done' || u.status === 'blocked') {
      return { ok: false, reason: u.status, user: u }
    }
    if (u.lockedBy && u.lockedBy !== lockedBy && !lockExpired(u.lockExpireAt)) {
      return { ok: false, reason: 'locked', user: u }
    }

    const expire = new Date(Date.now() + ttlMs)
    const p = (n) => String(n).padStart(2, '0')
    const lockExpireAt = `${expire.getFullYear()}-${p(expire.getMonth() + 1)}-${p(expire.getDate())} ${p(expire.getHours())}:${p(expire.getMinutes())}`

    const user = upsertUserSync({
      ...u,
      lockedBy,
      lockExpireAt
    })
    return { ok: true, user }
  })
}

export function releaseUser(userId, device) {
  return runExclusive(() => {
    const u = getUser(userId)
    if (!u) return null
    if (u.lockedBy && device && u.lockedBy !== device && !lockExpired(u.lockExpireAt)) {
      throw new Error('user locked by another device')
    }
    return upsertUserSync({ ...u, lockedBy: null, lockExpireAt: null })
  })
}

export function assignScriptIfNeeded(userId, displayName = '', { scriptIds } = {}) {
  return runExclusive(() => {
    const id = String(userId || '').trim()
    if (!id) throw new Error('userId is required')
    const exist = getUser(id)
    if (exist) return exist

    const pack = listScripts()
    const all = pack.scripts || []
    if (!all.length) throw new Error('no scripts')

    const poolIds = Array.isArray(scriptIds) && scriptIds.length
      ? scriptIds.map(String)
      : getSelectedScriptIds()

    const pool = poolIds.length
      ? all.filter((s) => poolIds.includes(s.id))
      : []

    if (!pool.length) {
      throw new Error('未选择可用话术：请先在「话术管理」中勾选至少一个话术')
    }

    const picked = pool[Math.floor(Math.random() * pool.length)]
    return upsertUserSync({
      userId: id,
      displayName: displayName || '',
      scriptId: picked.id,
      scriptName: picked.name || picked.id,
      completedStep: 0,
      nextStep: 1,
      status: 'pending',
      waitingReply: false,
      retryCount: 0
    })
  })
}

export function markSendSuccess(userId, { lastSendMessageId, content, maxSteps, waitReply = true } = {}) {
  return runExclusive(() => {
    const u = getUser(userId)
    if (!u) throw new Error('user not found')
    const completedStep = u.nextStep
    let nextStep = completedStep + 1
    let status = 'pending'
    let waitingReply = false
    if (maxSteps && nextStep > maxSteps) {
      status = 'done'
      nextStep = maxSteps + 1
    } else if (waitReply) {
      status = 'waiting'
      waitingReply = true
    }
    const user = upsertUserSync({
      ...u,
      completedStep,
      nextStep,
      status,
      waitingReply,
      lastSendMessageId: lastSendMessageId || u.lastSendMessageId,
      lastSendContent: Array.isArray(content) ? content : u.lastSendContent,
      lastSendAt: nowStr(),
      retryCount: 0,
      lastFailReason: null
    })
    return { user, content }
  })
}

export function markSendFail(userId, reason, { maxRetry = MAX_RETRY } = {}) {
  return runExclusive(() => {
    const u = getUser(userId)
    if (!u) throw new Error('user not found')
    const retryCount = (u.retryCount || 0) + 1
    const status = retryCount >= maxRetry ? 'blocked' : 'fail'
    return upsertUserSync({
      ...u,
      status,
      waitingReply: false,
      retryCount,
      lastFailReason: reason || 'unknown'
    })
  })
}

export function markReplyDetected(userId, lastReplyMessageId) {
  return runExclusive(() => {
    const u = getUser(userId)
    if (!u) throw new Error('user not found')
    return upsertUserSync({
      ...u,
      waitingReply: false,
      status: 'pending',
      lastReplyMessageId: lastReplyMessageId || u.lastReplyMessageId,
      lastReplyAt: nowStr()
    })
  })
}

export function appendLog(entry) {
  const line = JSON.stringify({ time: nowStr(), ...(entry || {}) })
  const file = join(logsDir, `${todayStr()}.jsonl`)
  fs.appendFileSync(file, `${line}\n`, 'utf-8')
  return { ok: true, file }
}

export function getScriptById(scriptId) {
  const pack = listScripts()
  return (pack.scripts || []).find((s) => s.id === scriptId) || null
}

export function renderMessages(messages, vars = {}) {
  return (messages || []).map((m) =>
    String(m).replace(/\{(\w+)\}/g, (_, key) => {
      const v = vars[key]
      return v == null ? '' : String(v)
    })
  )
}

// ---------- 本机 HTTP（供 Python 脚本调用） ----------

let httpServer = null
let httpPort = 0

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  })
  res.end(body)
}

export async function startSubGuestHttpServer() {
  if (httpServer) return { port: httpPort, baseUrl: `http://127.0.0.1:${httpPort}` }

  await initSubGuestStore()

  httpServer = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      const path = url.pathname
      const method = req.method || 'GET'

      if (method === 'GET' && path === '/health') {
        return sendJson(res, 200, { ok: true, rootDir })
      }
      if (method === 'GET' && path === '/scripts') {
        return sendJson(res, 200, listScripts())
      }
      if (method === 'GET' && path.startsWith('/users/')) {
        const userId = decodeURIComponent(path.slice('/users/'.length))
        return sendJson(res, 200, { user: getUser(userId) })
      }
      if (method === 'POST') {
        const body = await readBody(req)
        if (path === '/scripts') {
          return sendJson(res, 200, saveScripts(body))
        }
        if (path === '/users/upsert') {
          const user = await upsertUser(body)
          return sendJson(res, 200, { user })
        }
        if (path === '/users/assign') {
          const user = await assignScriptIfNeeded(body.userId, body.displayName, {
            scriptIds: body.scriptIds
          })
          return sendJson(res, 200, { user })
        }
        if (path === '/users/claim') {
          const r = await claimUser(body.userId, body.device, { ttlMs: body.ttlMs })
          return sendJson(res, 200, r)
        }
        if (path === '/users/release') {
          const user = await releaseUser(body.userId, body.device)
          return sendJson(res, 200, { user })
        }
        if (path === '/users/send-ok') {
          const r = await markSendSuccess(body.userId, body)
          appendLog({
            action: 'send',
            userId: body.userId,
            result: 'success',
            content: body.content || [],
            completedStep: r.user.completedStep,
            nextStep: r.user.nextStep,
            scriptId: r.user.scriptId,
            device: body.device
          })
          return sendJson(res, 200, r)
        }
        if (path === '/users/send-fail') {
          const user = await markSendFail(body.userId, body.reason, { maxRetry: body.maxRetry })
          appendLog({
            action: 'send_fail',
            userId: body.userId,
            result: 'fail',
            reason: body.reason,
            retryCount: user.retryCount,
            status: user.status,
            device: body.device
          })
          return sendJson(res, 200, { user })
        }
        if (path === '/users/reply') {
          const user = await markReplyDetected(body.userId, body.lastReplyMessageId)
          appendLog({
            action: 'reply_detected',
            userId: body.userId,
            lastReplyMessageId: body.lastReplyMessageId,
            device: body.device
          })
          return sendJson(res, 200, { user })
        }
        if (path === '/logs') {
          appendLog(body)
          return sendJson(res, 200, { ok: true })
        }
        if (path === '/render') {
          return sendJson(res, 200, {
            messages: renderMessages(body.messages, body.vars || {})
          })
        }
      }

      sendJson(res, 404, { error: 'not found' })
    } catch (e) {
      sendJson(res, 500, { error: e?.message || String(e) })
    }
  })

  await new Promise((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => {
      httpPort = httpServer.address().port
      resolve()
    })
  })

  return { port: httpPort, baseUrl: `http://127.0.0.1:${httpPort}` }
}

export function getSubGuestHttpBaseUrl() {
  if (!httpPort) return ''
  return `http://127.0.0.1:${httpPort}`
}

export function stopSubGuestHttpServer() {
  persistDb()
  if (httpServer) {
    try {
      httpServer.close()
    } catch {}
    httpServer = null
    httpPort = 0
  }
}
