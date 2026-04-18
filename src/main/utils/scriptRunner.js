import fs from 'fs'
import { join } from 'path'
import { spawn } from 'child_process'

function getBundledPythonHome() {
  // 为什么加这个函数：
  // - 你在 dev（electron-vite）下运行时，process.resourcesPath 往往指向 electron 自带的 dist/resources，
  //   并不包含我们打包的 python 目录。
  // - 现在日志里 pythonExe 解析到了 WindowsApps\python.exe（商店占位符），最终表现为 9009。
  // - 所以需要：dev 优先用仓库内 resources/python；packaged 再用 process.resourcesPath/python。

  const devHome = join(process.cwd(), 'resources', 'python')
  const packagedHome = process.resourcesPath ? join(process.resourcesPath, 'python') : ''

  if (packagedHome && fs.existsSync(join(packagedHome, process.platform === 'win32' ? 'python.exe' : 'python3'))) {
    return packagedHome
  }
  if (fs.existsSync(join(devHome, process.platform === 'win32' ? 'python.exe' : 'python3'))) {
    return devHome
  }
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
  // 1) 内置 Python（优先 dev resources/python，其次 packaged resources/python）
  try {
    const pyHome = getBundledPythonHome()
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

  // 内置 Python 目录（dev: resources/python；packaged: process.resourcesPath/python）
  const pyHome = getBundledPythonHome()

  const env = {
    ...process.env,
    HCA_ADB_PATH: adbPath,
    HCA_ATX_PORT: process.env.HCA_ATX_PORT || '7912'
  }

  // Windows Embedded Python：需要设置 PYTHONHOME，并确保 python._pth / python311._pth 含 Lib/site-packages 且启用 import site。
  if (process.platform === 'win32' && pyHome) {
    try {
      const pthCandidates = [join(pyHome, 'python._pth'), join(pyHome, 'python311._pth')]
      const pth = pthCandidates.find((p) => fs.existsSync(p))

      if (pth) {
        let content = fs.readFileSync(pth, 'utf-8')
        const lines = content.split(/\r?\n/)

        const hasLib = lines.some((l) => l.trim().toLowerCase() === 'lib')
        const hasSitePackages = lines.some((l) => l.trim().toLowerCase() === 'lib\\site-packages')
        const hasImportSite = lines.some((l) => l.trim() === 'import site')

        const next = [...lines]
        if (!hasLib) next.splice(Math.max(0, next.length - 1), 0, 'Lib')
        if (!hasSitePackages) next.splice(Math.max(0, next.length - 1), 0, 'Lib\\site-packages')

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
    env.PYTHONPATH = [join(pyHome, 'Lib'), join(pyHome, 'Lib', 'site-packages'), env.PYTHONPATH]
      .filter(Boolean)
      .join(';')
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

    const baseEnv = buildBaseEnv()
    const env = {
      ...baseEnv,
      // 关键：把 script.path 加到 PYTHONPATH，保证 `import soul` / `import common` 等本地模块可用
      // - 例如 scripts/codeApp/soul/soul.py 需要能被 `import soul`
      // - 例如 scripts/codeApp/soul/common/* 需要能被 `import common.xxx`
      PYTHONPATH: [script.path, baseEnv.PYTHONPATH].filter(Boolean).join(process.platform === 'win32' ? ';' : ':'),
      // 避免用户环境污染/安全路径导致的 import 异常（尤其在 Windows 上）
      PYTHONNOUSERSITE: '1',
      PYTHONSAFEPATH: '0',
      HCA_SCRIPT_DIR: script.path
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
