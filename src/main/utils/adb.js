import { spawn } from 'child_process'
import { join } from 'path'
import fs from 'fs'
import net from 'net'

function getScrcpyDir() {
  // dev：bin/scrcpy 在项目根目录
  const devDir = join(process.cwd(), 'bin', 'scrcpy')

  // packaged：被 electron-builder 作为 extraResources 带入后，位于 process.resourcesPath 下
  const packagedDir = process.resourcesPath ? join(process.resourcesPath, 'bin', 'scrcpy') : ''

  // 先用 packagedDir（若存在），否则回退 devDir
  if (packagedDir && fs.existsSync(packagedDir)) return packagedDir
  return devDir
}

export function getAdbPath() {
  return join(getScrcpyDir(), process.platform === 'win32' ? 'adb.exe' : 'adb')
}

export function runAdb(args, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const adbPath = getAdbPath()

    if (!fs.existsSync(adbPath)) {
      reject(new Error(`adb not found: ${adbPath}`))
      return
    }

    const child = spawn(adbPath, args, {
      windowsHide: true
    })

    let stdout = ''
    let stderr = ''

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {}
      const err = new Error(`adb timeout after ${timeoutMs}ms: ${args.join(' ')}`)
      err.stdout = stdout
      err.stderr = stderr
      reject(err)
    }, timeoutMs)

    child.stdout.on('data', (d) => {
      stdout += Buffer.isBuffer(d) ? d.toString('utf8') : String(d)
    })
    child.stderr.on('data', (d) => {
      // Windows 下 adb 错误常为系统 ANSI/GBK；先按 utf8，再在上层用错误码兜底
      stderr += Buffer.isBuffer(d) ? d.toString('utf8') : String(d)
    })

    child.on('error', (e) => {
      clearTimeout(timer)
      e.stdout = stdout
      e.stderr = stderr
      reject(e)
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) {
        resolve({ stdout, stderr })
      } else {
        const msg = (stderr || stdout || '').trim() || `adb exited with code ${code}`
        const err = new Error(msg)
        err.code = code
        err.stdout = stdout
        err.stderr = stderr
        reject(err)
      }
    })
  })
}

/** adb connect 即使失败也常返回 exit 0，必须看 stdout */
export function isAdbConnectOk(out) {
  return /connected to|already connected to/i.test(String(out || ''))
}

function normalizeConnectOutput(stdout, stderr) {
  return String(stdout || stderr || '').trim()
}

export async function adbConnect(ip, port = 5555) {
  const target = `${String(ip).trim()}:${Number(port) || 5555}`
  const { stdout, stderr } = await runAdb(['connect', target], { timeoutMs: 5000 })
  const out = normalizeConnectOutput(stdout, stderr)
  if (!isAdbConnectOk(out)) {
    const raw = out || `failed to connect to ${target}`
    if (/10061/.test(raw) || /鐢变簬|积极拒绝|refused/i.test(raw)) {
      throw new Error(
        `无法连接 ${target}（连接被拒绝 10061）。请确认无线调试已开启，且 IP/端口正确。`
      )
    }
    throw new Error(raw)
  }
  return out
}

export async function adbConnectTarget(target) {
  const t = String(target || '').trim()
  if (!t.includes(':')) throw new Error(`invalid wifi target: ${t}`)
  const { stdout, stderr } = await runAdb(['connect', t], { timeoutMs: 3000 })
  const out = normalizeConnectOutput(stdout, stderr)
  if (!isAdbConnectOk(out)) {
    throw new Error(out || `failed to connect to ${t}`)
  }
  return out
}

export async function adbDisconnectTarget(target) {
  // target: serial 或 ip:port
  const { stdout } = await runAdb(['disconnect', String(target)])
  return stdout.trim()
}

// 兼容旧签名：adbDisconnect(ip, port)
export async function adbDisconnect(ipOrTarget, port = 5555) {
  const v = String(ipOrTarget)
  const target = v.includes(':') || v.includes('emulator-') || v.includes('device') ? v : `${v}:${port}`
  return await adbDisconnectTarget(target)
}

export async function adbDevicesLong() {
  const { stdout } = await runAdb(['devices', '-l'])
  return stdout
}

export async function adbGetProp(serial, prop) {
  const { stdout } = await runAdb(['-s', serial, 'shell', 'getprop', prop])
  return stdout.trim()
}

export async function adbListDevices() {
  const raw = await adbDevicesLong()
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)

  // 第一行通常是：List of devices attached
  const out = []
  for (const line of lines) {
    if (line.toLowerCase().startsWith('list of devices')) continue

    // 例：emulator-5554 device product:sdk_gphone64_x86_64 model:sdk_gphone64_x86_64 device:emu64xa transport_id:1
    // 例：192.168.1.101:5555 device product:... model:...
    const [serial, state, ...rest] = line.split(/\s+/)
    if (!serial) continue

    // adb mdns services 会把 `_adb-tls-connect._tcp` 这样的服务名也列进 devices。
    // 这不是一台新的实体设备，而是同一台手机的发现记录；展示到 UI 会看起来像“多了一台 USB/离线设备”。
    if (/_adb(?:-tls-connect)?\._tcp/i.test(serial)) continue

    const kv = {}
    for (const token of rest) {
      const idx = token.indexOf(':')
      if (idx > 0) kv[token.slice(0, idx)] = token.slice(idx + 1)
    }

    const isWifi = serial.includes(':')
    const ip = isWifi ? serial.split(':')[0] : ''

    out.push({
      id: serial,
      serial,
      state,
      ip,
      model: kv.model || '',
      device: kv.device || '',
      product: kv.product || '',
      transportId: kv.transport_id || ''
    })
  }

  // 补丁：有些 ROM 不带 model 字段，则补一次 getprop
  for (const d of out) {
    if (!d.model && d.state === 'device') {
      try {
        d.model = await adbGetProp(d.serial, 'ro.product.model')
      } catch {
        // ignore
      }
    }
  }

  return out
}

export function getScrcpyPath() {
  const dir = getScrcpyDir()
  return join(dir, process.platform === 'win32' ? 'scrcpy.exe' : 'scrcpy')
}

export function spawnScrcpy({ serial, windowTitle, windowWidth, windowHeight, maxSize } = {}) {
  const scrcpyPath = getScrcpyPath()

  if (!fs.existsSync(scrcpyPath)) {
    throw new Error(`scrcpy not found: ${scrcpyPath}`)
  }

  const args = []
  if (serial) args.push('-s', serial)

  // 窗口大小（持久化能力由主进程保存，这里仅负责拼接 scrcpy 参数）
  // 优先 maxSize，其次 windowWidth/windowHeight
  if (Number.isFinite(maxSize) && maxSize > 0) {
    args.push('--max-size', String(maxSize))
  } else {
    if (Number.isFinite(windowWidth) && windowWidth > 0) args.push('--window-width', String(windowWidth))
    if (Number.isFinite(windowHeight) && windowHeight > 0) args.push('--window-height', String(windowHeight))
  }

  if (windowTitle) args.push('--window-title', windowTitle)

  const child = spawn(scrcpyPath, args, {
    cwd: getScrcpyDir(),
    windowsHide: false
  })

  return child
}

export async function adbKillServer() {
  const { stdout } = await runAdb(['kill-server'])
  return stdout.trim()
}

export async function adbStartServer() {
  const { stdout } = await runAdb(['start-server'])
  return stdout.trim()
}

export async function adbReconnectSmart(serial) {
  const s = String(serial)

  // WiFi: serial 是 ip:port
  if (s.includes(':')) {
    await adbDisconnectTarget(s).catch(() => {})
    return await adbConnectTarget(s)
  }

  // USB / emulator：按 serial 做 reconnect（adb reconnect 不支持 -s，退化为重启 server）
  await adbKillServer().catch(() => {})
  const out = await adbStartServer().catch(() => '')
  return out || 'adb restarted'
}

export async function adbTap(serial, x, y) {
  const { stdout } = await runAdb(['-s', serial, 'shell', 'input', 'tap', String(x), String(y)])
  return stdout.trim()
}

export async function adbSwipe(serial, x1, y1, x2, y2, durationMs) {
  const args = ['-s', serial, 'shell', 'input', 'swipe', String(x1), String(y1), String(x2), String(y2)]
  if (durationMs != null && durationMs !== '') args.push(String(durationMs))
  const { stdout } = await runAdb(args)
  return stdout.trim()
}

export async function adbInputText(serial, text) {
  // adb input text 需要对空格做转义：用 %s
  const safe = String(text ?? '').replace(/ /g, '%s')
  const { stdout } = await runAdb(['-s', serial, 'shell', 'input', 'text', safe])
  return stdout.trim()
}

export async function adbKeyEvent(serial, keyCode) {
  const { stdout } = await runAdb(['-s', serial, 'shell', 'input', 'keyevent', String(keyCode)])
  return stdout.trim()
}

export async function adbStartApp(serial, pkg, activity) {
  // -n package/activity
  const comp = activity ? `${pkg}/${activity}` : pkg
  const { stdout } = await runAdb(['-s', serial, 'shell', 'am', 'start', '-n', comp])
  return stdout.trim()
}

export async function tcpProbe(ip, port, timeoutMs = 400) {
  return await new Promise((resolve) => {
    const socket = new net.Socket()
    let done = false
    const finish = (ok) => {
      if (done) return
      done = true
      try {
        socket.destroy()
      } catch {}
      resolve(ok)
    }

    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
    try {
      socket.connect(Number(port), String(ip))
    } catch {
      finish(false)
    }
  })
}

async function pingOnce(ip, timeoutMs = 300) {
  // Windows: ping -n 1 -w 300 192.168.1.1
  // mac/linux: ping -c 1 -W 1 192.168.1.1
  const args = process.platform === 'win32'
    ? ['-n', '1', '-w', String(timeoutMs), ip]
    : ['-c', '1', '-W', String(Math.ceil(timeoutMs / 1000)), ip]

  return await new Promise((resolve) => {
    const child = spawn('ping', args, { windowsHide: true })
    child.on('close', (code) => resolve(code === 0))
    child.on('error', () => resolve(false))
  })
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length)
  let idx = 0
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (true) {
      const cur = idx++
      if (cur >= items.length) break
      results[cur] = await mapper(items[cur], cur)
    }
  })
  await Promise.all(workers)
  return results
}

export async function adbConnectMany(targetsOrIps, { port = 5555, concurrency = 20, pingFirst = false, tcpProbeFirst = false } = {}) {
  const list = Array.from(new Set((targetsOrIps || []).map((x) => String(x).trim()).filter(Boolean)))
  const results = []

  await mapLimit(list, concurrency, async (item) => {
    const hasPort = item.includes(':')
    const ip = hasPort ? item.split(':')[0] : item
    const p = hasPort ? Number(item.split(':')[1]) || port : port
    const target = `${ip}:${p}`

    try {
      if (tcpProbeFirst) {
        const open = await tcpProbe(ip, p, 350)
        if (!open) {
          results.push({ ip, port: p, target, ok: false, skipped: true, message: 'tcp closed' })
          return
        }
      } else if (pingFirst) {
        const ok = await pingOnce(ip, 300)
        if (!ok) {
          results.push({ ip, port: p, target, ok: false, skipped: true, message: 'ping failed' })
          return
        }
      }

      const out = await adbConnect(ip, p)
      results.push({ ip, port: p, target, ok: true, message: out })
    } catch (e) {
      results.push({ ip, port: p, target, ok: false, message: e?.message || String(e) })
    }
  })

  return results
}

/**
 * 自动重连一组 WiFi 目标（ip:port），带并发限制。
 * @param {string[]} targets
 */
export async function adbAutoConnectTargets(targets, { concurrency = 4 } = {}) {
  const list = Array.from(new Set((targets || []).map((x) => String(x).trim()).filter((x) => x.includes(':'))))
  return await adbConnectMany(list, { concurrency, pingFirst: false, tcpProbeFirst: true })
}

/**
 * 通过 adb mdns 发现 Android 11+ 无线调试的 connect 端口。
 * @returns {Promise<Array<{ip:string,port:number,target:string,service:string}>>}
 */
export async function adbMdnsDiscoverConnectServices() {
  try {
    const { stdout } = await runAdb(['mdns', 'services'], { timeoutMs: 8000 })
    const lines = String(stdout || '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)

    const found = []
    for (const line of lines) {
      // 常见形态：
      // adb-XXXXX _adb-tls-connect._tcp. 192.168.1.10:37123
      // 或带其它空白分隔
      if (!/_adb-tls-connect\._tcp/i.test(line) && !/_adb\._tcp/i.test(line)) continue
      const m = line.match(/(\d{1,3}(?:\.\d{1,3}){3}):(\d{2,5})/)
      if (!m) continue
      const ip = m[1]
      const port = Number(m[2])
      if (!ip || !port) continue
      found.push({
        ip,
        port,
        target: `${ip}:${port}`,
        service: /_adb-tls-connect/i.test(line) ? 'tls-connect' : 'adb'
      })
    }

    // 去重
    const seen = new Set()
    return found.filter((x) => {
      if (seen.has(x.target)) return false
      seen.add(x.target)
      return true
    })
  } catch {
    return []
  }
}
