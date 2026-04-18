import { spawn } from 'child_process'
import { join } from 'path'
import fs from 'fs'

function getScrcpyDir() {
  // dev：bin/scrcpy 在项目根目录
  const devDir = join(process.cwd(), 'bin', 'scrcpy')

  // packaged：被 electron-builder 作为 extraResources 带入后，位于 process.resourcesPath 下
  const packagedDir = process.resourcesPath ? join(process.resourcesPath, 'bin', 'scrcpy') : ''

  // 先用 packagedDir（若存在），否则回退 devDir
  if (packagedDir && fs.existsSync(packagedDir)) return packagedDir
  return devDir
}

function getAdbPath() {
  return join(getScrcpyDir(), process.platform === 'win32' ? 'adb.exe' : 'adb')
}

function runAdb(args, { timeoutMs = 15000 } = {}) {
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
      reject(new Error(`adb timeout after ${timeoutMs}ms: ${args.join(' ')}`))
    }, timeoutMs)

    child.stdout.on('data', (d) => (stdout += d.toString()))
    child.stderr.on('data', (d) => (stderr += d.toString()))

    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) {
        resolve({ stdout, stderr })
      } else {
        reject(new Error((stderr || stdout || '').trim() || `adb exited with code ${code}`))
      }
    })
  })
}

export async function adbConnect(ip, port = 5555) {
  const target = `${ip}:${port}`
  const { stdout } = await runAdb(['connect', target])
  return stdout.trim()
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

export function spawnScrcpy({ serial, windowTitle } = {}) {
  const scrcpyPath = getScrcpyPath()

  if (!fs.existsSync(scrcpyPath)) {
    throw new Error(`scrcpy not found: ${scrcpyPath}`)
  }

  const args = []
  if (serial) args.push('-s', serial)
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
    const { stdout } = await runAdb(['connect', s])
    return stdout.trim()
  }

  // USB / emulator：使用 adb reconnect（不会影响其他设备）
  // 说明：adb reconnect 只能传 device/offline，不区分 serial；这里退化为“重启 server + 刷新”
  // 更实用：直接 kill/start server
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

function ipv4ToInt(ip) {
  const parts = String(ip).trim().split('.')
  if (parts.length !== 4) throw new Error(`invalid ip: ${ip}`)
  const n = parts.map((p) => Number(p))
  if (n.some((x) => Number.isNaN(x) || x < 0 || x > 255)) throw new Error(`invalid ip: ${ip}`)
  return ((n[0] << 24) >>> 0) + (n[1] << 16) + (n[2] << 8) + n[3]
}

function intToIpv4(v) {
  const n = v >>> 0
  return [
    (n >>> 24) & 255,
    (n >>> 16) & 255,
    (n >>> 8) & 255,
    n & 255
  ].join('.')
}

function parseCidrOrRange(rangeText) {
  const text = String(rangeText || '').trim()
  if (!text) throw new Error('range is required')

  // 支持：
  // - 192.168.110.x（等价 192.168.110.1-254）
  // - 192.168.110.1-255
  // - 192.168.110.10-192.168.110.200
  // - 192.168.110.0/24

  if (text.endsWith('.x')) {
    const base = text.slice(0, -2)
    const start = `${base}.1`
    const end = `${base}.254`
    return { startIp: start, endIp: end }
  }

  if (text.includes('/')) {
    const [ip, maskStr] = text.split('/')
    const mask = Number(maskStr)
    if (Number.isNaN(mask) || mask < 0 || mask > 32) throw new Error(`invalid cidr mask: ${maskStr}`)
    const ipInt = ipv4ToInt(ip)
    const maskInt = mask === 0 ? 0 : ((~0 << (32 - mask)) >>> 0)
    const net = ipInt & maskInt
    const broadcast = (net | (~maskInt >>> 0)) >>> 0
    const start = net + 1
    const end = broadcast - 1
    return { startIp: intToIpv4(start), endIp: intToIpv4(end) }
  }

  if (text.includes('-')) {
    const [a, b] = text.split('-').map((s) => s.trim())
    if (!a || !b) throw new Error(`invalid range: ${text}`)

    // 192.168.110.1-255
    if (/^\d{1,3}$/.test(b)) {
      const parts = a.split('.')
      if (parts.length !== 4) throw new Error(`invalid start ip: ${a}`)
      const endIp = `${parts[0]}.${parts[1]}.${parts[2]}.${b}`
      return { startIp: a, endIp }
    }

    return { startIp: a, endIp: b }
  }

  // 单个 IP：只扫描一个
  return { startIp: text, endIp: text }
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

export async function adbConnectMany(ips, { port = 5555, concurrency = 20, pingFirst = true } = {}) {
  const list = Array.from(new Set((ips || []).map((x) => String(x).trim()).filter(Boolean)))
  const results = []

  await mapLimit(list, concurrency, async (ip) => {
    const target = `${ip}:${port}`
    try {
      if (pingFirst) {
        const ok = await pingOnce(ip, 300)
        if (!ok) {
          results.push({ ip, port, target, ok: false, skipped: true, message: 'ping failed' })
          return
        }
      }

      const out = await adbConnect(ip, port)
      results.push({ ip, port, target, ok: true, message: out })
    } catch (e) {
      results.push({ ip, port, target, ok: false, message: e?.message || String(e) })
    }
  })

  return results
}

export async function adbScanIpRange(rangeText, { port = 5555, concurrency = 50, pingFirst = true } = {}) {
  const { startIp, endIp } = parseCidrOrRange(rangeText)
  const a = ipv4ToInt(startIp)
  const b = ipv4ToInt(endIp)
  const start = Math.min(a, b)
  const end = Math.max(a, b)

  const ips = []
  for (let i = start; i <= end; i++) {
    ips.push(intToIpv4(i))
    // 简单保护：避免误填 /16 一下扫爆
    if (ips.length > 4096) break
  }

  const results = await scanIpList(
    ips,
    {
      port,
      concurrency,
      pingFirst
    },
    async (ip, _idx) => {
      try {
        const out = await adbConnect(ip, port)
        return { ok: true, message: out }
      } catch (e) {
        return { ok: false, message: e?.message || String(e) }
      }
    }
  )

  return results
}
