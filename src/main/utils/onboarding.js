import { join } from 'path'
import fs from 'fs'
import {
  runAdb,
  adbConnect
} from './adb'

async function adbShell(serial, cmd) {
  const { stdout } = await runAdb(['-s', serial, 'shell', ...cmd])
  return stdout.trim()
}

export async function adbGetDeviceIp(serial) {
  // 尝试：ip route 解析 src
  const out = await adbShell(serial, ['ip', 'route'])
  // 例：default via 192.168.110.1 dev wlan0 proto dhcp src 192.168.110.23 metric 303
  const m = out.match(/\bsrc\s+(\d+\.\d+\.\d+\.\d+)/)
  if (m?.[1]) return m[1]

  // 兜底：ifconfig wlan0 / ip addr show wlan0
  const out2 = await adbShell(serial, ['ip', 'addr', 'show', 'wlan0']).catch(() => '')
  const m2 = out2.match(/inet\s+(\d+\.\d+\.\d+\.\d+)/)
  if (m2?.[1]) return m2[1]

  // 再兜底：其它无线网卡名
  const out3 = await adbShell(serial, ['sh', '-c', 'ip -o -4 addr show | awk \'{print $2,$4}\'']).catch(() => '')
  for (const line of String(out3).split(/\r?\n/)) {
    if (!/wlan|wifi|rmnet_data|ap/i.test(line)) continue
    const m3 = line.match(/(\d+\.\d+\.\d+\.\d+)/)
    if (m3?.[1] && !m3[1].startsWith('127.')) return m3[1]
  }

  return ''
}

export async function enableWifiTcpip(serial, port = 5555) {
  await runAdb(['-s', serial, 'tcpip', String(port)])
  const ip = await adbGetDeviceIp(serial)
  if (!ip) throw new Error('无法自动获取设备 IP（请确认已连接 WiFi）')

  // 稍等设备切到 tcpip 模式
  await new Promise((r) => setTimeout(r, 800))

  const message = await adbConnect(ip, port)
  return { ip, port, target: `${ip}:${port}`, message }
}

function findAtxAgentPath() {
  const candidates = [
    join(process.cwd(), 'resources', process.platform === 'win32' ? 'atx-agent.exe' : 'atx-agent'),
    join(process.cwd(), 'resources', 'atx-agent')
  ]
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p
    } catch {}
  }
  return ''
}

function formatAdbError(e) {
  const msg = e?.message || String(e)
  const stdout = (e?.stdout || '').trim()
  const stderr = (e?.stderr || '').trim()

  const raw = [msg, stdout && `stdout: ${stdout}`, stderr && `stderr: ${stderr}`]
    .filter(Boolean)
    .join('\n')

  // 友好化：Android 11+ 无线配对常见报错很“玄学”，给明确行动建议
  const lower = raw.toLowerCase()
  const hint = []

  // 常见：配对码错误/过期/端口不对
  if (
    lower.includes('protocol fault') ||
    lower.includes('couldn\'t read status message') ||
    lower.includes('failed to authenticate') ||
    lower.includes('authentication failed') ||
    lower.includes('wrong password') ||
    lower.includes('pairing')
  ) {
    hint.push('可能原因：配对码错误/已过期，或 IP/端口不正确。')
    hint.push('请在手机「无线调试」页重新生成配对码后重试。')
  }

  if (
    lower.includes('connection refused') ||
    lower.includes('no route') ||
    lower.includes('timed out') ||
    lower.includes('timeout') ||
    lower.includes('failed to connect') ||
    lower.includes('unable to connect')
  ) {
    hint.push('可能原因：手机与电脑不在同一 WiFi/网段，端口未开放，或 3 秒内未能连通。')
  }

  if (hint.length === 0) return raw
  return `${hint.join('\n')}\n\n--- adb 原始输出 ---\n${raw}`
}

/** WiFi pair/connect 超时（毫秒） */
const WIFI_ADB_TIMEOUT_MS = 3000

/**
 * Android 11+ 无线调试：先 adb pair，再 adb connect（同一 IP:端口）
 * 任一步 3 秒内失败即抛错，不做端口探测/重试。
 * @param {string} ip
 * @param {number|string} port
 * @param {string} code 配对码
 */
export async function pairAndConnect(ip, port, code) {
  const p = Number(port)
  if (!Number.isFinite(p) || p <= 0) throw new Error('端口无效')
  const target = `${String(ip).trim()}:${p}`
  const pairCode = String(code || '').trim()
  if (!pairCode) throw new Error('配对码不能为空')

  try {
    // adb pair IP:PORT CODE
    const { stdout: pairOut } = await runAdb(['pair', target, pairCode], {
      timeoutMs: WIFI_ADB_TIMEOUT_MS
    })

    // adb connect IP:PORT（同一端口，3 秒超时）
    const connectOut = await adbConnect(ip, p)

    return {
      target,
      pair: String(pairOut || '').trim(),
      connect: connectOut,
      connectTarget: target,
      ip: String(ip).trim(),
      port: p
    }
  } catch (e) {
    throw new Error(formatAdbError(e))
  }
}

export async function atxCheck(serial) {
  // 骨架实现：仅检查 /data/local/tmp/atx-agent 是否存在
  const out = await adbShell(serial, ['sh', '-c', 'ls -l /data/local/tmp/atx-agent 2>/dev/null || echo missing'])
  const ok = !out.includes('missing')
  return { ok, detail: out }
}

export async function atxInstall(serial) {
  // 目标：
  // adb push atx-agent /data/local/tmp
  // adb shell chmod +x /data/local/tmp/atx-agent
  // adb shell /data/local/tmp/atx-agent server -d
  const atxPath = findAtxAgentPath()
  if (!atxPath) {
    return {
      ok: false,
      error:
        '未找到 atx-agent 资源包：请将 atx-agent 放入 resources/（建议命名 atx-agent 或 atx-agent.exe）'
    }
  }

  try {
    // push
    await runAdb(['-s', serial, 'push', atxPath, '/data/local/tmp/atx-agent'], { timeoutMs: 60000 })
    // chmod
    await runAdb(['-s', serial, 'shell', 'chmod', '+x', '/data/local/tmp/atx-agent'])
    // start server
    await runAdb(['-s', serial, 'shell', '/data/local/tmp/atx-agent', 'server', '-d'], { timeoutMs: 60000 })

    const check = await adbShell(serial, ['sh', '-c', 'ps -A 2>/dev/null | grep atx-agent || ps 2>/dev/null | grep atx-agent || echo started'])

    return {
      ok: true,
      atxPath: atxPath,
      detail: check
    }
  } catch (e) {
    return { ok: false, error: formatAdbError(e) }
  }
}

export async function permissionCheck(serial) {
  // 骨架：检测 USB 调试是否可执行 shell（能执行即代表授权/调试 ok）
  try {
    const out = await adbShell(serial, ['getprop', 'ro.build.version.release'])
    return { ok: Boolean(out), android: out }
  } catch (e) {
    return { ok: false, error: e?.message || String(e) }
  }
}
