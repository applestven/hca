import { spawn } from 'child_process'
import { join } from 'path'
import fs from 'fs'

function getScrcpyDir() {
  return join(process.cwd(), 'bin', 'scrcpy')
}

function getAdbPath() {
  return join(getScrcpyDir(), process.platform === 'win32' ? 'adb.exe' : 'adb')
}

function runAdb(args, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const adbPath = getAdbPath()
    const child = spawn(adbPath, args, { windowsHide: true })

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

    child.stdout.on('data', (d) => (stdout += d.toString()))
    child.stderr.on('data', (d) => (stderr += d.toString()))

    child.on('error', (e) => {
      clearTimeout(timer)
      e.stdout = stdout
      e.stderr = stderr
      reject(e)
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve({ stdout, stderr })
      else {
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

  return ''
}

export async function enableWifiTcpip(serial, port = 5555) {
  await runAdb(['-s', serial, 'tcpip', String(port)])
  const ip = await adbGetDeviceIp(serial)
  if (!ip) throw new Error('无法自动获取设备 IP（请确认已连接 WiFi）')

  const { stdout } = await runAdb(['connect', `${ip}:${port}`])
  return { ip, port, message: stdout.trim() }
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
    hint.push('可能原因：配对码错误/已过期，或填错了“配对端口”。')
    hint.push('请在手机「无线调试」页重新生成配对码，并使用页面中显示的“使用配对码配对设备”的 IP:端口。')
  }

  if (lower.includes('connection refused') || lower.includes('no route') || lower.includes('timed out')) {
    hint.push('可能原因：手机与电脑不在同一 WiFi/网段，或系统/防火墙拦截了端口。')
  }

  if (hint.length === 0) return raw
  return `${hint.join('\n')}\n\n--- adb 原始输出 ---\n${raw}`
}

async function guessWifiConnectTargetFromPairIp(pairIp) {
  // Android 11+：配对使用一个随机端口（pairing port），连接常用另一个端口（connect port）。
  // 这里做保守探测：优先尝试常见端口集合。
  const ports = [5555, 37099, 37123, 37173, 37231]
  for (const p of ports) {
    try {
      const { stdout } = await runAdb(['connect', `${pairIp}:${p}`], { timeoutMs: 8000 })
      const s = stdout.trim()
      // 成功形态：connected to ... / already connected to ...
      if (/connected to|already connected to/i.test(s)) {
        return { target: `${pairIp}:${p}`, message: s }
      }
    } catch {
      // ignore
    }
  }
  return { target: '', message: '' }
}

export async function pairAndConnect(ip, port, code) {
  const target = `${ip}:${port}`
  try {
    const { stdout: pairOut } = await runAdb(['pair', target, code], { timeoutMs: 20000 })

    // 尝试 1：直接 connect 到同一个 ip:port（部分机型可用）
    let connOut = ''
    try {
      const { stdout } = await runAdb(['connect', target], { timeoutMs: 15000 })
      connOut = stdout.trim()
    } catch (e) {
      connOut = ''
    }

    // 尝试 2：探测常见 connect 端口（很多机型 connect port != pairing port）
    let guessed = null
    if (!/connected to|already connected to/i.test(connOut)) {
      guessed = await guessWifiConnectTargetFromPairIp(ip)
      if (guessed?.target) {
        connOut = guessed.message
      }
    }

    // 返回更多信息，方便 UI 提示用户“需要用 IP 地址和端口再连一次”
    const result = {
      target,
      pair: pairOut.trim(),
      connect: connOut,
      connectTarget: guessed?.target || (/connected to|already connected to/i.test(connOut) ? target : '')
    }

    // 若仍然没连上，将原因显式返回（不抛错，让 UI 能提示用户去填手机的“IP 地址和端口”）
    if (!/connected to|already connected to/i.test(connOut)) {
      return {
        ...result,
        warnings: [
          '已完成配对，但未能自动连接到设备。',
          '请在手机「无线调试」页查看“IP 地址和端口”，并到本页“手动连接”中填写该端口进行 connect。'
        ]
      }
    }

    return result
  } catch (e) {
    const err = new Error(formatAdbError(e))
    throw err
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
