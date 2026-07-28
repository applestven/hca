import { join } from 'path'
import fs from 'fs'
import http from 'http'
import {
  runAdb,
  adbConnect,
  adbMdnsDiscoverConnectServices
} from './adb'

/** ATX / uiautomator2 官方下载页（安装失败时可打开） */
export const ATX_DOWNLOAD_URLS = {
  apk: 'https://github.com/openatx/android-uiautomator-server/releases',
  apkDirect:
    'https://github.com/openatx/android-uiautomator-server/releases/latest/download/app-uiautomator.apk',
  agent: 'https://github.com/openatx/atx-agent/releases'
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
  const names = ['atx-agent', 'atx-agent-armv7', 'atx-agent-arm64']
  const dirs = [
    join(process.cwd(), 'resources'),
    process.resourcesPath ? join(process.resourcesPath) : '',
    process.resourcesPath ? join(process.resourcesPath, 'resources') : ''
  ].filter(Boolean)

  for (const dir of dirs) {
    for (const name of names) {
      const p = join(dir, name)
      try {
        if (fs.existsSync(p)) return p
      } catch {
        // ignore
      }
    }
  }
  return ''
}

/** 从内置/本机 Python 的 uiautomator2/assets 找 apk、jar */
function findU2Assets() {
  const siteNames = ['site-packages-codeapp', 'site-packages']
  const roots = [
    join(process.cwd(), 'resources', 'python', 'Lib'),
    process.resourcesPath ? join(process.resourcesPath, 'python', 'Lib') : '',
    join(process.env.USERPROFILE || '', 'scoop', 'apps', 'python', 'current', 'Lib')
  ].filter(Boolean)

  const candidates = []
  for (const root of roots) {
    for (const site of siteNames) {
      candidates.push(join(root, site, 'uiautomator2', 'assets'))
    }
  }

  for (const dir of candidates) {
    if (!fs.existsSync(dir)) continue
    const apk = join(dir, 'app-uiautomator.apk')
    const jar = join(dir, 'u2.jar')
    if (fs.existsSync(apk) || fs.existsSync(jar)) {
      return {
        dir,
        apk: fs.existsSync(apk) ? apk : '',
        jar: fs.existsSync(jar) ? jar : ''
      }
    }
  }
  return { dir: '', apk: '', jar: '' }
}

/** 主包 com.github.uiautomator；.test 残留不算已装 APK */
async function checkU2Packages(serial) {
  const s = String(serial || '').trim()
  const out = await adbShell(s, [
    'sh',
    '-c',
    'echo MAIN:; pm path com.github.uiautomator 2>/dev/null; echo TEST:; pm path com.github.uiautomator.test 2>/dev/null'
  ]).catch(() => '')
  const text = String(out || '')
  const mainPart = (text.split('TEST:')[0] || '').replace(/^MAIN:\s*/i, '')
  const testPart = text.includes('TEST:') ? text.split('TEST:').slice(1).join('TEST:') : ''
  return {
    hasApk: /package:/i.test(mainPart),
    hasTestApk: /package:/i.test(testPart),
    raw: text.trim()
  }
}

/**
 * 通过 adb push + install 安装 u2 组件（APK 必须用 adb，init 在 3.x 往往只推 jar）
 * @param {string} serial
 * @param {{ force?: boolean }} [opts] force=true 时先卸载再装，确保真正重装
 */
async function installU2ComponentsViaAdb(serial, { force = false } = {}) {
  const s = String(serial)
  const assets = findU2Assets()
  const steps = []
  const tips = []

  if (assets.jar) {
    try {
      await runAdb(['-s', s, 'push', assets.jar, '/data/local/tmp/u2.jar'], { timeoutMs: 120000 })
      steps.push('jar:ok')
    } catch (e) {
      steps.push(`jar:fail:${e?.message || e}`)
    }
  } else {
    steps.push('jar:missing-local')
  }

  if (assets.apk) {
    if (force) {
      // 强制：先卸主包/测试包，避免残留导致误判「已安装」却未真正重装
      await runAdb(['-s', s, 'uninstall', 'com.github.uiautomator'], { timeoutMs: 60000 }).catch(
        () => null
      )
      await runAdb(
        ['-s', s, 'uninstall', 'com.github.uiautomator.test'],
        { timeoutMs: 60000 }
      ).catch(() => null)
      steps.push('apk:uninstalled')
    }

    let installOut = ''
    try {
      // 优先 adb install（比 shell pm install 更稳）
      const r = await runAdb(['-s', s, 'install', '-r', '-t', '-g', assets.apk], {
        timeoutMs: 120000
      })
      installOut = `${r.stdout || ''}\n${r.stderr || ''}`.trim()
    } catch (e) {
      installOut = `${e?.stdout || ''}\n${e?.stderr || ''}\n${e?.message || e}`.trim()
      // 回退：push + pm install
      try {
        await runAdb(['-s', s, 'push', assets.apk, '/data/local/tmp/app-uiautomator.apk'], {
          timeoutMs: 120000
        })
        try {
          const r2 = await runAdb(
            [
              '-s',
              s,
              'shell',
              'pm',
              'install',
              '-r',
              '-t',
              '-g',
              '/data/local/tmp/app-uiautomator.apk'
            ],
            { timeoutMs: 120000 }
          )
          installOut = `${r2.stdout || ''}\n${r2.stderr || ''}`.trim()
        } catch (e2) {
          const r3 = await runAdb(
            ['-s', s, 'shell', 'pm', 'install', '-r', '-t', '/data/local/tmp/app-uiautomator.apk'],
            { timeoutMs: 120000 }
          ).catch((e3) => e3)
          installOut = `${installOut}\n${r3?.stdout || ''}\n${r3?.stderr || ''}\n${r3?.message || r3 || e2?.message || e2}`.trim()
        }
      } catch (ePush) {
        installOut = `${installOut}\n${ePush?.message || ePush}`
      }
    }

    if (/Success/i.test(installOut)) {
      steps.push('apk:ok')
    } else {
      steps.push(`apk:fail:${installOut.slice(0, 240)}`)
      tips.push(
        '可通过 adb 安装，但手机需开启：开发者选项 → USB安装 / USB调试（安全设置）。小米/红米常需关闭 MIUI 优化并允许 USB 安装。'
      )
    }
  } else {
    steps.push('apk:missing-local')
    tips.push(
      '本地未找到 app-uiautomator.apk（请确认 resources/python/Lib/site-packages-codeapp 已包含 uiautomator2）'
    )
  }

  const pkgs = await checkU2Packages(s)
  const hasApk = pkgs.hasApk
  const jarOut = await adbShell(s, [
    'sh',
    '-c',
    'ls -l /data/local/tmp/u2.jar 2>/dev/null || echo missing'
  ]).catch(() => 'missing')
  const hasJar = steps.includes('jar:ok') || !String(jarOut).includes('missing')

  return {
    ok: steps.includes('apk:ok') && hasApk,
    hasApk,
    hasTestApk: pkgs.hasTestApk,
    hasJar,
    steps,
    tips,
    assetsDir: assets.dir,
    assetsApk: assets.apk || '',
    detail: steps.join(' | ')
  }
}

function formatAdbError(e, commands) {
  const msg = e?.message || String(e)
  const stdout = (e?.stdout || '').trim()
  const stderr = (e?.stderr || '').trim()

  const cmdList = []
  if (Array.isArray(commands)) {
    for (const c of commands) {
      if (c && !cmdList.includes(c)) cmdList.push(c)
    }
  }
  if (e?.command && !cmdList.includes(e.command)) cmdList.push(e.command)
  const cmdBlock = cmdList.length ? `\n执行命令:\n${cmdList.map((c) => `  ${c}`).join('\n')}` : ''

  // 避免与 cmdBlock 重复（adbConnect 等可能已把命令写进 message）
  const msgClean = cmdBlock
    ? String(msg).replace(/\n?执行命令[:：][\s\S]*$/, '').trim()
    : String(msg)

  const raw = [msgClean, stdout && `stdout: ${stdout}`, stderr && `stderr: ${stderr}`]
    .filter(Boolean)
    .join('\n')

  // Windows adb 常输出 GBK，被当成 UTF-8 后乱码；用错误码兜底
  if (/10061/.test(raw) || /鐢变簬|积极拒绝|actively refused|connection refused/i.test(raw)) {
    return [
      '连接被拒绝(10061)。',
      '请确认无线调试已开启，且 IP/端口正确；端口变更后需重新填写再连接。'
    ].join('\n') + cmdBlock
  }

  const lower = raw.toLowerCase()
  const hint = []

  if (
    lower.includes('protocol fault') ||
    lower.includes("couldn't read status message") ||
    lower.includes('failed to authenticate') ||
    lower.includes('authentication failed') ||
    lower.includes('wrong password') ||
    lower.includes('pairing')
  ) {
    hint.push('可能原因：配对码错误/已过期，或配对 IP/端口不正确。')
    hint.push('请在手机「无线调试 → 使用配对码配对设备」重新生成后再试。')
  }

  if (
    lower.includes('no route') ||
    lower.includes('timed out') ||
    lower.includes('timeout') ||
    lower.includes('failed to connect') ||
    lower.includes('unable to connect')
  ) {
    hint.push('可能原因：手机与电脑不在同一 WiFi/网段，或端口未开放。')
  }

  if (hint.length === 0) return raw + cmdBlock
  return `${hint.join('\n')}\n\n--- adb 原始输出 ---\n${raw}${cmdBlock}`
}

/** WiFi pair/connect 超时（毫秒） */
const WIFI_ADB_TIMEOUT_MS = 8000

/**
 * Android 11+ 无线调试：adb pair → adb connect
 * UI 只填一个端口：配对与连接共用；若同端口 connect 失败再尝试 mdns 发现其它端口。
 * @param {string} ip
 * @param {number|string} pairPort 端口（配对/连接共用）
 * @param {string} code 配对码
 * @param {number|string} [connectPort] 可选；不填则与 pairPort 相同
 */
export async function pairAndConnect(ip, pairPort, code, connectPort) {
  const pPair = Number(pairPort)
  if (!Number.isFinite(pPair) || pPair <= 0) throw new Error('端口无效')
  const pairTarget = `${String(ip).trim()}:${pPair}`
  const pairCode = String(code || '').trim()
  if (!pairCode) throw new Error('配对码不能为空')

  const pairCmd = `adb pair ${pairTarget} ${pairCode}`
  const triedCmds = [pairCmd]

  try {
    const { stdout: pairOut } = await runAdb(['pair', pairTarget, pairCode], {
      timeoutMs: WIFI_ADB_TIMEOUT_MS
    })

    let cPort = Number(connectPort) || pPair
    if (!Number.isFinite(cPort) || cPort <= 0) cPort = pPair

    const warnings = []
    let connectOut
    try {
      triedCmds.push(`adb connect ${String(ip).trim()}:${cPort}`)
      connectOut = await adbConnect(ip, cPort)
    } catch (connectErr) {
      // 同端口连不上时，尝试 mdns 找其它 connect 端口
      let altPort = 0
      try {
        const services = await adbMdnsDiscoverConnectServices()
        const hit = services.find(
          (s) => s.ip === String(ip).trim() && Number(s.port) > 0 && Number(s.port) !== cPort
        )
        if (hit) altPort = Number(hit.port)
      } catch {
        // ignore
      }
      if (altPort) {
        warnings.push(`端口 ${cPort} 连接失败，已改用发现到的端口 ${altPort}`)
        cPort = altPort
        triedCmds.push(`adb connect ${String(ip).trim()}:${cPort}`)
        connectOut = await adbConnect(ip, cPort)
      } else {
        throw connectErr
      }
    }

    const connectTarget = `${String(ip).trim()}:${cPort}`

    return {
      target: pairTarget,
      pair: String(pairOut || '').trim(),
      connect: connectOut,
      connectTarget,
      ip: String(ip).trim(),
      port: cPort,
      pairPort: pPair,
      connectPort: cPort,
      warnings
    }
  } catch (e) {
    if (e?.paired) throw e
    throw new Error(formatAdbError(e, triedCmds))
  }
}

export async function atxCheck(serial) {
  const s = String(serial || '').trim()
  if (!s) return { ok: false, error: 'serial is required' }

  try {
    const fileOut = await adbShell(s, [
      'sh',
      '-c',
      'ls -l /data/local/tmp/atx-agent 2>/dev/null || echo missing'
    ])
    const hasFile = !String(fileOut).includes('missing')

    const pkgs = await checkU2Packages(s)
    const hasApk = pkgs.hasApk
    const hasTestApk = pkgs.hasTestApk

    const jarOut = await adbShell(s, [
      'sh',
      '-c',
      'ls -l /data/local/tmp/u2.jar 2>/dev/null || echo missing'
    ]).catch(() => 'missing')
    const hasJar = !String(jarOut).includes('missing')

    const psOut = await adbShell(s, [
      'sh',
      '-c',
      'ps -A 2>/dev/null | grep "[a]tx-agent" || ps 2>/dev/null | grep "[a]tx-agent" || true'
    ]).catch(() => '')
    const running = /atx-agent/i.test(String(psOut || ''))

    // 本机 forward 后探测 7912（不依赖手机上的 curl）
    let httpOk = false
    let version = ''
    const localPort = 18000 + ([...String(s)].reduce((a, c) => a + c.charCodeAt(0), 0) % 2000)
    try {
      await runAdb(['-s', s, 'forward', `tcp:${localPort}`, 'tcp:7912'], { timeoutMs: 5000 })
      version = await new Promise((resolve) => {
        const req = http.get(
          { host: '127.0.0.1', port: localPort, path: '/version', timeout: 2500 },
          (res) => {
            let body = ''
            res.on('data', (c) => {
              body += c
            })
            res.on('end', () => resolve(String(body || '').trim()))
          }
        )
        req.on('error', () => resolve(''))
        req.on('timeout', () => {
          try {
            req.destroy()
          } catch {}
          resolve('')
        })
      })
      httpOk = Boolean(version) && version.length < 80 && !/fail|error|html/i.test(version)
    } catch {
      httpOk = false
    }

    // 自动化可用：主包 APK 已装（推荐），或 jar+agent 可用（u2 3.x）
    const ok = hasApk || (hasJar && (httpOk || (hasFile && running)))
    return {
      ok,
      ready: ok,
      hasFile,
      hasApk,
      hasTestApk,
      hasJar,
      running,
      httpOk,
      version: version || null,
      detail: `file=${hasFile} apk=${hasApk} testApk=${hasTestApk} jar=${hasJar} running=${running} http=${httpOk} ver=${version || '-'}`
    }
  } catch (e) {
    return { ok: false, error: formatAdbError(e) }
  }
}

async function installAtxViaU2Init(serial) {
  const { runPythonModule } = await import('./scriptRunner.js')
  const r = await runPythonModule(['-m', 'uiautomator2', 'init', '--serial', String(serial)], {
    timeoutMs: 240000
  })
  const out = `${r.stdout || ''}\n${r.stderr || ''}`.trim()
  if (r.code !== 0) {
    return { ok: false, method: 'u2-init', error: out || `uiautomator2 init exited ${r.code}` }
  }
  return { ok: true, method: 'u2-init', detail: out, pythonExe: r.pythonExe }
}

async function installAtxViaPush(serial) {
  const atxPath = findAtxAgentPath()
  if (!atxPath) {
    return {
      ok: false,
      method: 'push',
      error:
        '未找到 atx-agent 资源包：请将 Android 版 atx-agent 放到 resources/，或确保 Python 已安装 uiautomator2'
    }
  }

  await runAdb(['-s', serial, 'push', atxPath, '/data/local/tmp/atx-agent'], { timeoutMs: 120000 })
  await runAdb(['-s', serial, 'shell', 'chmod', '755', '/data/local/tmp/atx-agent'])
  await runAdb(
    ['-s', serial, 'shell', '/data/local/tmp/atx-agent', 'server', '-d', '--stop'],
    { timeoutMs: 60000 }
  ).catch(() => null)
  await runAdb(['-s', serial, 'shell', '/data/local/tmp/atx-agent', 'server', '-d'], {
    timeoutMs: 60000
  })

  const check = await adbShell(serial, [
    'sh',
    '-c',
    'ps -A 2>/dev/null | grep atx-agent || ps 2>/dev/null | grep atx-agent || echo started'
  ])
  return { ok: true, method: 'push', atxPath, detail: check }
}

export async function atxInstall(serial, { force = false } = {}) {
  const s = String(serial || '').trim()
  if (!s) return { ok: false, error: 'serial is required' }

  const parts = []
  let u2Init = null
  let pushAgent = null

  // 1) u2 init（3.x 主要推 jar / 拉起服务）
  try {
    u2Init = await installAtxViaU2Init(s)
    parts.push(u2Init)
  } catch (e) {
    u2Init = { ok: false, method: 'u2-init', error: formatAdbError(e) }
    parts.push(u2Init)
  }

  // 2) 必要时再推 atx-agent
  const pre = await atxCheck(s)
  if (!pre.hasFile || !pre.running) {
    try {
      pushAgent = await installAtxViaPush(s)
      parts.push(pushAgent)
    } catch (e) {
      pushAgent = { ok: false, method: 'push', error: formatAdbError(e) }
      parts.push(pushAgent)
    }
  }

  // 3) 关键：adb 安装 app-uiautomator.apk + 推送 u2.jar
  //    （u2 3.x 的 init 往往不会装 APK；自动化点击依赖这个包）
  //    force 时先卸载再装，避免残留误判
  const adbComp = await installU2ComponentsViaAdb(s, { force })
  parts.push({ method: 'adb-apk-jar', ...adbComp })

  const after = await atxCheck(s)
  const apkStepOk = Array.isArray(adbComp.steps) && adbComp.steps.includes('apk:ok')
  const ok = Boolean(after.hasApk) && apkStepOk
  const tips = [
    ...(adbComp.tips || []),
    !after.hasApk
      ? 'APK 未安装成功时：手机开发者选项打开「USB安装」「USB调试（安全设置）」后重试；也可点「下载ATX」手动下载安装'
      : '',
    !apkStepOk && adbComp.detail ? `安装步骤: ${adbComp.detail}` : ''
  ].filter(Boolean)

  return {
    ok: ok && (u2Init?.ok || pushAgent?.ok || adbComp.ok),
    method: apkStepOk && after.hasApk ? 'adb-apk' : u2Init?.ok ? 'u2-init+adb' : 'mixed',
    detail: parts.map((p) => `${p.method}:${p.ok ? 'ok' : p.error || p.detail || 'fail'}`).join(' || '),
    parts,
    adbComp,
    after,
    tips,
    downloadUrls: ATX_DOWNLOAD_URLS,
    error: ok
      ? undefined
      : tips[0] || adbComp.detail || u2Init?.error || 'ATX 组件安装不完整'
  }
}

const atxReadyCache = new Map()

/**
 * 强制安装 ATX（按钮用）：不做「已就绪跳过」，始终执行 init/push，再复检。
 */
export async function atxForceInstall(serial) {
  const s = String(serial || '').trim()
  if (!s) return { ok: false, error: 'serial is required' }
  atxReadyCache.delete(s)

  const before = await atxCheck(s)
  const install = await atxInstall(s, { force: true })
  await new Promise((r) => setTimeout(r, 1500))
  const after = await atxCheck(s)
  const apkStepOk =
    Array.isArray(install?.adbComp?.steps) && install.adbComp.steps.includes('apk:ok')
  // 强制安装：必须本轮 apk 安装成功，且设备上存在主包
  const ok = Boolean(after?.hasApk) && apkStepOk
  if (ok) atxReadyCache.set(s, Date.now())
  return {
    ok,
    forced: true,
    serial: s,
    before,
    install,
    after,
    tips: install?.tips || [],
    downloadUrls: ATX_DOWNLOAD_URLS,
    /** 安装失败时建议打开下载页 */
    openDownloadsOnFail: !ok,
    error: ok
      ? undefined
      : [
          install?.error,
          apkStepOk ? '' : `APK 安装步骤未成功(${install?.adbComp?.detail || 'no-step'})`,
          after?.hasApk ? '' : 'APK 仍未安装(com.github.uiautomator)',
          ...(install?.tips || [])
        ]
          .filter(Boolean)
          .join('；')
  }
}

/**
 * 检查设备 ATX/uiautomator2；未就绪则自动安装。
 * WiFi 连接成功后应调用。
 */
export async function ensureAtx(serial, { force = false } = {}) {
  const s = String(serial || '').trim()
  if (!s) return { ok: false, error: 'serial is required' }

  if (force) return atxForceInstall(s)

  if (atxReadyCache.has(s)) {
    const ts = atxReadyCache.get(s)
    if (Date.now() - ts < 10 * 60 * 1000) {
      return { ok: true, skipped: true, cached: true, serial: s }
    }
  }

  const before = await atxCheck(s)
  if (before.ok) {
    atxReadyCache.set(s, Date.now())
    return { ok: true, skipped: true, serial: s, check: before }
  }

  // 有二进制但没跑起来：先尝试拉起
  if (before.hasFile && !before.httpOk) {
    try {
      await runAdb(['-s', s, 'shell', '/data/local/tmp/atx-agent', 'server', '-d', '--stop'], {
        timeoutMs: 20000
      }).catch(() => null)
      await runAdb(['-s', s, 'shell', '/data/local/tmp/atx-agent', 'server', '-d'], {
        timeoutMs: 30000
      })
      await new Promise((r) => setTimeout(r, 800))
      const again = await atxCheck(s)
      if (again.ok) {
        atxReadyCache.set(s, Date.now())
        return { ok: true, skipped: true, restarted: true, serial: s, check: again }
      }
    } catch {
      // fallthrough to install
    }
  }

  return atxForceInstall(s)
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
