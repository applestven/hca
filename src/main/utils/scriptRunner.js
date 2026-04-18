import fs from 'fs'
import { join } from 'path'
import { spawn } from 'child_process'

function getScriptsDir() {
  // dev：项目根 scripts/
  const devDir = join(process.cwd(), 'scripts')
  // packaged：scripts 放在 resources/scripts（需要在 electron-builder.yml 配置 extraResources）
  // 注意：打包后 __dirname 在 out/main 下，而 process.resourcesPath 是安装目录的 resources
  const packagedDir = process.resourcesPath ? join(process.resourcesPath, 'scripts') : ''

  if (packagedDir && fs.existsSync(packagedDir)) return packagedDir
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

function whichOnWindows(cmd) {
  if (process.platform !== 'win32') return null
  try {
    const out = require('child_process')
      .execSync(`where.exe ${cmd}`, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)

    // 为什么要改：
    // - pyenv-win 的 shims/python.bat 在某些场景下会把批处理语法混入到 -c 的参数，
    //   导致你看到的 `import importlib || goto :error` 这种 SyntaxError。
    // - 对我们来说最稳的是直接用真实的 python.exe。

    const exes = out.filter((p) => /\.exe$/i.test(p))
    if (exes.length) return exes[0]

    // 兜底再考虑 .bat
    const bats = out.filter((p) => /\.bat$/i.test(p))
    if (bats.length) return bats[0]

    return out[0] || null
  } catch {
    return null
  }
}

function buildPythonCommand() {
  // 1) 内置 Python（打包到 resources/python）
  try {
    const pyHome = process.resourcesPath ? join(process.resourcesPath, 'python') : ''
    const bundled = pyHome ? join(pyHome, process.platform === 'win32' ? 'python.exe' : 'python3') : ''
    if (bundled && fs.existsSync(bundled)) {
      const libDir = join(pyHome, 'Lib')
      if (!fs.existsSync(libDir)) {
        throw new Error(`内置 Python 缺少 Lib 目录：${libDir}`)
      }
      return bundled
    }
  } catch {
    // ignore and fallback
  }

  // 2) 环境变量指定
  const pyFromEnv = process.env.HCA_PYTHON
  if (pyFromEnv) return pyFromEnv

  // 3) 系统 python（Windows 需要 where 解析到 exe 路径）
  if (process.platform === 'win32') {
    const resolved = whichOnWindows('python') || whichOnWindows('python3')
    if (resolved) return resolved
  }

  return 'python'
}

function buildBaseEnv() {
  // 把内置 adb 路径注入给脚本，避免脚本依赖系统 adb
  const adbPath = join(process.cwd(), 'bin', 'scrcpy', process.platform === 'win32' ? 'adb.exe' : 'adb')

  // 内置 Python 目录（打包后在 resources/python）
  const pyHome = process.resourcesPath ? join(process.resourcesPath, 'python') : ''

  const env = {
    ...process.env,
    HCA_ADB_PATH: adbPath,
    HCA_ATX_PORT: process.env.HCA_ATX_PORT || '7912'
  }

  // Windows Embedded Python：需要设置 PYTHONHOME，并确保 python._pth 含 Lib/site-packages 且启用 import site。
  if (process.platform === 'win32' && pyHome) {
    try {
      const pth = join(pyHome, 'python._pth')
      if (fs.existsSync(pth)) {
        let content = fs.readFileSync(pth, 'utf-8')
        const lines = content.split(/\r?\n/)

        const hasLib = lines.some((l) => l.trim().toLowerCase() === 'lib')
        const hasSitePackages = lines.some((l) => l.trim().toLowerCase() === 'lib\\site-packages')
        const hasImportSite = lines.some((l) => l.trim() === 'import site')

        // python._pth 默认禁用 site，这会导致绝大多数第三方包不可用。
        // 这里做“就地修订”（不会影响系统 Python，只影响内置目录）。
        const next = [...lines]
        if (!hasLib) next.splice(Math.max(0, next.length - 1), 0, 'Lib')
        if (!hasSitePackages) next.splice(Math.max(0, next.length - 1), 0, 'Lib\\site-packages')

        // 去掉独立的 "#import site" 注释行（有些版本使用这种格式）
        for (let i = 0; i < next.length; i++) {
          if (next[i].trim() === '#import site') next[i] = 'import site'
        }
        if (!hasImportSite) next.push('import site')

        const nextContent = next.join('\r\n')
        if (nextContent !== content) {
          fs.writeFileSync(pth, nextContent)
        }
      }
    } catch {
      // ignore
    }

    env.PYTHONHOME = pyHome
    // 兜底：显式给出 Lib 路径（有些环境变量组合下仍可能需要）
    env.PYTHONPATH = [join(pyHome, 'Lib'), join(pyHome, 'Lib', 'site-packages'), env.PYTHONPATH]
      .filter(Boolean)
      .join(';')
  }

  return env
}

function makePythonNotFoundError(e) {
  const msg = e?.message || String(e)
  // Windows 常见：CreateProcess error=2 / ENOENT
  if (/enoent/i.test(msg) || /createprocess/i.test(msg) || /not found/i.test(msg)) {
    return new Error(
      '未找到 Python 可执行文件。请确认已配置内置 Python（resources/python/python.exe），或设置环境变量 HCA_PYTHON 指向 python.exe。'
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
    const child = spawn(spec.command, [...spec.argsPrefix, entry, JSON.stringify(merged)], {
      cwd: script.path,
      windowsHide: true,
      env: buildBaseEnv()
    })

    const subId = `${runId}${dev ? `:${dev}` : ''}`
    running.set(subId, child)
    procs.push({ id: subId, child })

    const emit = (payload) => {
      onEvent?.({ runId: subId, key, device: dev || merged.device || '', ...payload })
    }

    child.stdout.on('data', (buf) => {
      const text = buf.toString()
      // Python 可能一次输出多行
      const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
      for (const line of lines) {
        try {
          const obj = JSON.parse(line)
          emit({ type: obj.type || 'log', data: obj })
        } catch {
          emit({ type: 'log', data: { msg: line } })
        }
      }
    })

    child.stderr.on('data', (buf) => {
      emit({ type: 'stderr', data: { msg: buf.toString() } })
    })

    child.on('close', (code) => {
      running.delete(subId)
      emit({ type: 'exit', data: { code } })
    })

    child.on('error', (e) => {
      running.delete(subId)
      const err = makePythonNotFoundError(e)
      emit({ type: 'error', data: { msg: err?.message || String(err) } })
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
