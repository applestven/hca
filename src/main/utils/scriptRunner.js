import fs from 'fs'
import { join } from 'path'
import { spawn } from 'child_process'
import { createRequire } from 'module'
import { getSubGuestHttpBaseUrl } from './subGuestStore'

const require = createRequire(import.meta.url)

function isPackagedApp() {
  try {
    const { app } = require('electron')
    return Boolean(app?.isPackaged)
  } catch {
    return false
  }
}

function getBundledPythonHome() {
  const exeName = process.platform === 'win32' ? 'python.exe' : 'python3'
  const packagedHome = process.resourcesPath ? join(process.resourcesPath, 'python') : ''

  // 打包后只认 extraResources 带入的内置 Python，避免 cwd 干扰。
  if (isPackagedApp()) {
    if (packagedHome && fs.existsSync(join(packagedHome, exeName))) return packagedHome
    return ''
  }

  // dev：使用仓库内 resources/python（不受 electron 自带 resourcesPath 影响）
  const devHome = join(process.cwd(), 'resources', 'python')
  if (fs.existsSync(join(devHome, exeName))) return devHome
  return ''
}

function getScriptsDir() {
  // 为什么调整：
  // - dev：脚本根目录是 scripts/codeApp
  // - packaged：electron-builder 当前把 scripts/ 整体复制到 resources/scripts
  //   因此真正的脚本根目录应是 resources/scripts/codeApp（如果存在）

  // dev：优先 scripts/codeApp（脚本项目集合）
  const devCodeAppDir = join(process.cwd(), 'scripts', 'codeApp')
  const devDir = join(process.cwd(), 'scripts')

  // packaged：scripts 放在 resources/scripts（需要 electron-builder.yml 配置 extraResources）
  const packagedScriptsDir = process.resourcesPath ? join(process.resourcesPath, 'scripts') : ''
  const packagedCodeAppDir = packagedScriptsDir ? join(packagedScriptsDir, 'codeApp') : ''

  // 优先 packaged/codeApp，其次 packaged/scripts
  if (packagedCodeAppDir && fs.existsSync(packagedCodeAppDir)) return packagedCodeAppDir
  if (packagedScriptsDir && fs.existsSync(packagedScriptsDir)) return packagedScriptsDir

  if (fs.existsSync(devCodeAppDir)) return devCodeAppDir
  return devDir
}

export function listScripts() {
  const base = getScriptsDir()
  if (!fs.existsSync(base)) return []

  const dirs = fs
    .readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)

  const out = []
  for (const dir of dirs) {
    const manifestPath = join(base, dir, 'manifest.json')
    if (!fs.existsSync(manifestPath)) continue
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
      out.push({
        ...manifest,
        dir,
        path: join(base, dir)
      })
    } catch {
      // ignore broken manifest
    }
  }
  return out
}

function isExternalPythonCandidate(p) {
  if (!p || !fs.existsSync(p)) return false
  if (!/\.exe$/i.test(p)) return false
  // Microsoft Store 占位符
  if (/windowsapps/i.test(p)) return false
  // pyenv-win shim，spawn -c 时容易把 bat 语法混入参数
  if (/pyenv-win[\\/]+shims/i.test(p)) return false
  return true
}

function listWindowsPythonCandidates() {
  if (process.platform !== 'win32') return []
  const found = []
  const seen = new Set()

  for (const cmd of ['python', 'python3']) {
    try {
      const out = require('child_process')
        .execSync(`where.exe ${cmd}`, { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)

      for (const p of out) {
        const key = p.toLowerCase()
        if (seen.has(key)) continue
        if (!isExternalPythonCandidate(p)) continue
        seen.add(key)
        found.push(p)
      }
    } catch {
      // ignore
    }
  }

  return found
}

function whichOnWindows(cmd) {
  if (process.platform !== 'win32') return null
  try {
    const out = require('child_process')
      .execSync(`where.exe ${cmd}`, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)

    const exes = out.filter((p) => isExternalPythonCandidate(p))
    if (exes.length) return exes[0]

    // 兜底再考虑 .bat（pyenv shim 等）
    const bats = out.filter((p) => /\.bat$/i.test(p) && !/pyenv-win[\\/]+shims/i.test(p))
    if (bats.length) return bats[0]

    return out[0] || null
  } catch {
    return null
  }
}

function resolveExternalPython() {
  const candidates = listWindowsPythonCandidates()
  if (candidates.length) return candidates[0]

  if (process.platform === 'win32') {
    return whichOnWindows('python') || whichOnWindows('python3')
  }

  return null
}

function isBundledPythonReady(pyHome) {
  if (!pyHome) return false
  const exe = join(pyHome, process.platform === 'win32' ? 'python.exe' : 'python3')
  if (!fs.existsSync(exe)) return false

  // Embedded Python 标准库在 python3xx.zip；Lib 目录用于 site-packages，首次 bootstrap 前可能不存在。
  const hasLib = fs.existsSync(join(pyHome, 'Lib'))
  const hasStdlibZip = fs
    .readdirSync(pyHome, { withFileTypes: true })
    .some((d) => d.isFile() && /^python3\d+\.zip$/i.test(d.name))

  return hasLib || hasStdlibZip
}

function makeBundledRuntime(pyHome) {
  return {
    pythonExe: join(pyHome, process.platform === 'win32' ? 'python.exe' : 'python3'),
    pyHome,
    bundled: true
  }
}

function makeExternalRuntime(pythonExe) {
  return { pythonExe, pyHome: '', bundled: false }
}

function isBundledPythonExe(pythonExe, pyHome) {
  if (!pythonExe || !pyHome) return false
  const bundledExe = join(pyHome, process.platform === 'win32' ? 'python.exe' : 'python3')
  try {
    return fs.realpathSync(pythonExe).toLowerCase() === fs.realpathSync(bundledExe).toLowerCase()
  } catch {
    return pythonExe.toLowerCase() === bundledExe.toLowerCase()
  }
}

function runtimeFromExplicitPython(pythonExe, pyHome) {
  if (pyHome && isBundledPythonExe(pythonExe, pyHome)) return makeBundledRuntime(pyHome)
  return makeExternalRuntime(pythonExe)
}

function resolvePythonRuntime() {
  const pyHome = getBundledPythonHome()
  const bundledReady = isBundledPythonReady(pyHome)

  const pyFromEnv = process.env.HCA_PYTHON
  if (pyFromEnv && fs.existsSync(pyFromEnv)) {
    return runtimeFromExplicitPython(pyFromEnv, pyHome)
  }

  // 内置 Python 已就绪时优先使用（依赖已装在 Lib/site-packages），开发/打包行为一致。
  if (bundledReady) return makeBundledRuntime(pyHome)

  // 内置不可用时才回退本机 pyenv/scoop；此时会清理 PYTHONHOME，避免 encodings 错误。
  const external = resolveExternalPython()
  if (external) return makeExternalRuntime(external)

  return makeExternalRuntime('python')
}

/** 供 ATX 安装等主进程任务复用同一套 Python 解析 */
export function getPythonRuntime() {
  return resolvePythonRuntime()
}

export function getScriptPythonEnv() {
  return buildBaseEnv()
}

/**
 * 运行 python -m ...（如 uiautomator2 init）
 * @returns {Promise<{ code:number, stdout:string, stderr:string }>}
 */
export function runPythonModule(moduleArgs = [], { timeoutMs = 180000 } = {}) {
  const runtime = resolvePythonRuntime()
  const env = buildBaseEnv()
  const args = Array.isArray(moduleArgs) ? moduleArgs : []

  return new Promise((resolve, reject) => {
    const child = spawn(runtime.pythonExe, args, {
      env,
      windowsHide: true
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {}
      reject(new Error(`python timeout after ${timeoutMs}ms: ${args.join(' ')}`))
    }, timeoutMs)

    child.stdout.on('data', (d) => {
      stdout += Buffer.isBuffer(d) ? d.toString('utf8') : String(d)
    })
    child.stderr.on('data', (d) => {
      stderr += Buffer.isBuffer(d) ? d.toString('utf8') : String(d)
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? 1, stdout, stderr, pythonExe: runtime.pythonExe })
    })
  })
}

function buildPythonCommand() {
  return resolvePythonRuntime().pythonExe
}

function normalizePthLine(line) {
  return line.trim().replace(/\\/g, '/').toLowerCase()
}

function ensureEmbeddedPythonPth(pyHome) {
  if (!pyHome) return

  const sitePackagesDirs = [
    join(pyHome, 'Lib', 'site-packages'),
    join(pyHome, 'Lib', 'site-packages-codeapp')
  ]
  for (const dir of sitePackagesDirs) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  }

  const pthCandidates = [join(pyHome, 'python._pth'), join(pyHome, 'python311._pth')]
  const pth = pthCandidates.find((p) => fs.existsSync(p))
  if (!pth) return

  let content = fs.readFileSync(pth, 'utf-8')
  const lines = content.split(/\r?\n/)
  const normalized = lines.map((l) => normalizePthLine(l))

  const hasLib = normalized.includes('lib')
  const hasSitePackages = normalized.includes('lib/site-packages')
  const hasSitePackagesCodeApp = normalized.includes('lib/site-packages-codeapp')
  const hasImportSite = lines.some((l) => l.trim() === 'import site')

  const next = []
  const seen = new Set()
  const pushUnique = (line) => {
    const key = normalizePthLine(line)
    if (!key || key.startsWith('#')) {
      next.push(line)
      return
    }
    if (seen.has(key)) return
    seen.add(key)
    next.push(line)
  }

  for (const line of lines) {
    const trimmed = line.trim()
    if (/^Lib\\\\site-packages(-codeapp)?$/i.test(trimmed)) {
      pushUnique(trimmed.replace(/\\\\/g, '\\'))
      continue
    }
    if (trimmed === '#import site') {
      pushUnique('import site')
      continue
    }
    pushUnique(line)
  }

  if (!seen.has('lib')) pushUnique('Lib')
  if (!seen.has('lib/site-packages')) pushUnique('Lib\\site-packages')
  if (!seen.has('lib/site-packages-codeapp')) pushUnique('Lib\\site-packages-codeapp')
  if (!next.some((l) => l.trim() === 'import site')) pushUnique('import site')

  const nextContent = next.join('\r\n')
  if (nextContent !== content) {
    fs.writeFileSync(pth, nextContent)
  }
}

function stripEmbeddedPythonEnv(env, pyHome = '') {
  delete env.PYTHONHOME

  if (!env.PYTHONPATH) return

  const parts = String(env.PYTHONPATH)
    .split(process.platform === 'win32' ? ';' : ':')
    .map((p) => p.trim())
    .filter(Boolean)
    .filter((p) => {
      if (pyHome && p.toLowerCase().startsWith(pyHome.toLowerCase())) return false
      if (/[\\/]resources[\\/]python([\\/]|$)/i.test(p)) return false
      return true
    })

  if (parts.length) env.PYTHONPATH = parts.join(process.platform === 'win32' ? ';' : ':')
  else delete env.PYTHONPATH
}

function buildBaseEnv() {
  // 把内置 adb 路径注入给脚本，避免脚本依赖系统 adb
  const adbPath = join(process.cwd(), 'bin', 'scrcpy', process.platform === 'win32' ? 'adb.exe' : 'adb')

  const runtime = resolvePythonRuntime()

  const env = {
    ...process.env,
    HCA_ADB_PATH: adbPath,
    HCA_ATX_PORT: process.env.HCA_ATX_PORT || '7912',
    // 强制脚本 stdout/stderr 用 UTF-8，避免中文步骤日志在 Windows 下乱码
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1'
  }

  if (process.platform === 'win32' && runtime.bundled && runtime.pyHome) {
    try {
      ensureEmbeddedPythonPth(runtime.pyHome)
    } catch {
      // ignore
    }

    env.PYTHONHOME = runtime.pyHome
    env.PYTHONPATH = [
      join(runtime.pyHome, 'Lib'),
      join(runtime.pyHome, 'Lib', 'site-packages'),
      join(runtime.pyHome, 'Lib', 'site-packages-codeapp'),
      env.PYTHONPATH
    ]
      .filter(Boolean)
      .join(';')
    env.PYTHONNOUSERSITE = '1'
    env.PYTHONSAFEPATH = '0'
  } else {
    // 使用 pyenv/scoop 等本机 Python 时，必须清掉内置 Python 残留环境变量。
    // 否则 PYTHONHOME 指向 resources/python 会导致 encodings 导入失败。
    stripEmbeddedPythonEnv(env, getBundledPythonHome())
    delete env.PYTHONNOUSERSITE
    delete env.PYTHONSAFEPATH
  }

  return env
}

function makePythonNotFoundError(e, pythonCmd) {
  const msg = e?.message || String(e)

  // 为什么调整：
  // - Windows 9009 常见于“命令找不到”（cmd 无法解析 python/bat/exe）。
  // - 以前只匹配 ENOENT，用户只能看到“没反应”；这里把 9009 也解释清楚。

  if (/9009/.test(msg) || /not recognized/i.test(msg) || /system cannot find/i.test(msg)) {
    return new Error(
      `Python 启动失败(9009)：命令未找到。请确认已内置 Python（resources/python/python.exe），或设置环境变量 HCA_PYTHON 指向 python.exe。当前命令：${pythonCmd}`
    )
  }

  // Windows 常见：CreateProcess error=2 / ENOENT
  if (/enoent/i.test(msg) || /createprocess/i.test(msg) || /not found/i.test(msg)) {
    return new Error(
      `未找到 Python 可执行文件。请确认已配置内置 Python（resources/python/python.exe），或设置环境变量 HCA_PYTHON 指向 python.exe。当前命令：${pythonCmd}`
    )
  }
  return e
}

// 进程管理：runId -> child（包含子 runId：runId:device）
const running = new Map()

export function startScript({ key, params = {}, deviceSerials = [] } = {}, onEvent) {
  const list = listScripts()
  const script = list.find((s) => s.key === key)
  if (!script) throw new Error(`script not found: ${key}`)

  const entry = join(script.path, script.entry || 'main.py')
  if (!fs.existsSync(entry)) throw new Error(`script entry not found: ${entry}`)

  const runId = `${key}-${Date.now()}-${Math.random().toString(16).slice(2)}`

  // 单设备/多设备：由 runner 在 params 中注入 device
  const targets = deviceSerials.length ? deviceSerials : [undefined]

  const procs = []
  for (const dev of targets) {
    const merged = { ...params }
    if (dev) merged.device = dev

    const spec = buildPythonSpawnSpec()
    const pythonCmdForDisplay = [spec.command, ...spec.argsPrefix].join(' ')

    const runtime = resolvePythonRuntime()
    const baseEnv = buildBaseEnv()
    const env = {
      ...baseEnv,
      // 关键：把 script.path 加到 PYTHONPATH，保证 `import soul` / `import common` 等本地模块可用
      PYTHONPATH: [script.path, baseEnv.PYTHONPATH].filter(Boolean).join(process.platform === 'win32' ? ';' : ':'),
      HCA_SCRIPT_DIR: script.path
    }
    // Sub 获客 CRM HTTP（主进程本机服务）
    try {
      const api = getSubGuestHttpBaseUrl()
      if (api) env.HCA_SUB_GUEST_API = api
    } catch {
      // ignore
    }
    if (dev) {
      // 兼容旧脚本/第三方库读取环境变量选择目标设备，避免多设备时误连到其它 ADB target。
      env.HCA_DEVICE_SERIAL = dev
      env.ANDROID_SERIAL = dev
      env.device = dev
    }

    const child = spawn(spec.command, [...spec.argsPrefix, entry, JSON.stringify(merged)], {
      cwd: script.path,
      windowsHide: true,
      env
    })

    const subId = `${runId}${dev ? `:${dev}` : ''}`
    running.set(subId, child)
    procs.push({ id: subId, child })

    const emit = (payload) => {
      onEvent?.({ runId: subId, key, device: dev || merged.device || '', ...payload })
    }

    child.stdout.on('data', (buf) => {
      const text = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf)
      // Python 可能一次输出多行
      const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
      for (const line of lines) {
        try {
          const obj = JSON.parse(line)
          const step = obj.step ? `[${obj.step}] ` : ''
          const msg = obj.msg != null ? String(obj.msg) : JSON.stringify(obj)
          emit({ type: obj.type || 'log', data: { ...obj, msg: `${step}${msg}` } })
        } catch {
          emit({ type: 'log', data: { msg: line } })
        }
      }
    })

    child.stderr.on('data', (buf) => {
      const text = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf)
      emit({ type: 'stderr', data: { msg: text } })
    })

    child.on('close', (code) => {
      running.delete(subId)

      if (process.platform === 'win32' && Number(code) === 9009) {
        emit({
          type: 'error',
          data: {
            msg: 'Python 启动失败(9009)：命令未找到。请确认 resources/python/python.exe 已随包存在，或设置 HCA_PYTHON。',
            code,
            hint: '建议先点“环境自检”查看 pythonExe 解析结果。'
          }
        })
        return
      }

      emit({ type: 'exit', data: { code } })
    })

    child.on('error', (e) => {
      running.delete(subId)
      const err = makePythonNotFoundError(e, pythonCmdForDisplay)
      emit({ type: 'error', data: { msg: err?.message || String(err), command: pythonCmdForDisplay, entry } })
    })
  }

  return { runId, key, script, processes: procs.map((p) => ({ id: p.id })) }
}

export function stopScript(runId) {
  // 精确停止一个
  const child = running.get(runId)
  if (!child) return false
  try {
    child.kill('SIGTERM')
  } catch {}
  return true
}

export function stopScriptGroup(runIdPrefix) {
  // 停同一批（runId-xxxx:*）
  let killed = 0
  for (const [id, child] of running.entries()) {
    if (!String(id).startsWith(String(runIdPrefix))) continue
    try {
      child.kill('SIGTERM')
      killed++
    } catch {}
  }
  return killed
}

function buildPythonSpawnSpec() {
  // 返回 { command, argsPrefix }，用于兼容 .bat
  const python = buildPythonCommand()

  if (process.platform === 'win32' && /\.bat$/i.test(python)) {
    // Windows 下 .bat 需要通过 cmd /c 执行
    return { command: 'cmd.exe', argsPrefix: ['/c', python], pythonExeForDisplay: python }
  }

  return { command: python, argsPrefix: [], pythonExeForDisplay: python }
}

function runPythonCheck(pythonExe, env, code, timeoutMs = 10000) {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''

    const spec = process.platform === 'win32' && /\.bat$/i.test(pythonExe)
      ? { command: 'cmd.exe', argsPrefix: ['/c', pythonExe] }
      : { command: pythonExe, argsPrefix: [] }

    // 注意：这里的 code 必须是“纯 Python”，不能夹杂 cmd 的语法
    const child = spawn(spec.command, [...spec.argsPrefix, '-c', code], {
      windowsHide: true,
      env
    })

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {}
      resolve({ ok: false, exitCode: -1, stdout, stderr: stderr || 'timeout' })
    }, timeoutMs)

    child.stdout.on('data', (b) => (stdout += b.toString()))
    child.stderr.on('data', (b) => (stderr += b.toString()))

    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, exitCode: code ?? 0, stdout, stderr })
    })

    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ ok: false, exitCode: -2, stdout, stderr: e?.message || String(e) })
    })
  })
}

export async function checkPythonRuntime() {
  const runtime = resolvePythonRuntime()
  const spec = buildPythonSpawnSpec()
  const pythonExe = spec.pythonExeForDisplay
  const env = buildBaseEnv()

  // 1) 基础信息
  const version = await runPythonCheck(pythonExe, env, 'import sys; print(sys.version)')

  // 2) 强依赖 import 检查（纯 Python）
  const imports = await runPythonCheck(
    pythonExe,
    env,
    [
      'import importlib',
      'mods = ["uiautomator2","adbutils","requests","lxml","PIL","retry"]',
      'for m in mods:',
      '    importlib.import_module(m)',
      'print("ok")'
    ].join('\n')
  )

  return {
    pythonExe,
    bundled: runtime.bundled,
    packaged: isPackagedApp(),
    env: {
      PYTHONHOME: env.PYTHONHOME,
      PYTHONPATH: env.PYTHONPATH,
      HCA_PYTHON: process.env.HCA_PYTHON
    },
    version,
    imports,
    ok: Boolean(version.ok && imports.ok)
  }
}
