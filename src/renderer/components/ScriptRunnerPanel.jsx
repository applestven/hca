import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import SubGuestScriptsDialog from '@/components/SubGuestScriptsDialog'

function showFriendlyError(message) {
  const raw = String(message || '')

  // 常见错误做中文兜底映射，避免英文/技术细节直接暴露给用户
  let msg = raw
  if (!msg) msg = '操作失败，请稍后再试。'

  if (/no script permission|permission|expire|expired|remaining|count/i.test(msg)) {
    msg = '您没有权限使用该脚本，或权限已过期/次数不足。请前往“版本”页面激活后再试。'
  }
  if (/key is required/i.test(msg)) {
    msg = '请选择要运行的脚本。'
  }
  if (/script not found/i.test(msg)) {
    msg = '脚本不存在或已损坏，请刷新脚本列表后再试。'
  }
  if (/python/i.test(msg) && (/not found|9009|enoent|createprocess/i.test(msg))) {
    msg = '脚本运行环境异常：未找到可用的 Python。请先在“环境自检”中修复后再试。'
  }

  // 兜底用原生弹窗，保证“必须弹窗提示”
  try {
    window.alert(msg)
  } catch {
    // ignore
  }
}

function ParamField({ p, value, onChange }) {
  const type = p?.type || 'text'
  const required = !!p?.required
  const isNumber = type === 'number'
  return (
    <div className="space-y-1">
      <Label>
        {p?.label || p?.key}
        {required ? <span className="text-rose-600"> *</span> : null}
      </Label>
      <Input
        value={value ?? ''}
        onChange={(e) => {
          const raw = e.target.value
          if (isNumber) {
            // 允许输入 0.1 / 0.2 等小数中间态
            if (raw !== '' && !/^\d*\.?\d*$/.test(raw)) return
          }
          onChange(raw)
        }}
        placeholder={String(p?.placeholder ?? p?.default ?? '')}
        inputMode={isNumber ? 'decimal' : undefined}
        required={required}
      />
    </div>
  )
}

function coerceParams(scriptParams, rawParams) {
  const out = { ...(rawParams || {}) }
  for (const p of scriptParams || []) {
    const key = p?.key
    if (!key) continue
    const raw = out[key]
    if (p.type === 'number') {
      if (raw === undefined || raw === null || String(raw).trim() === '') {
        out[key] = p.default
        continue
      }
      const n = Number(raw)
      out[key] = Number.isFinite(n) ? n : raw
    }
  }
  return out
}

export default function ScriptRunnerPanel({ deviceSerials = [], pushLog }) {
  const [scripts, setScripts] = useState([])
  const [selectedKey, setSelectedKey] = useState('sub_guest')
  const [params, setParams] = useState({})
  const [busy, setBusy] = useState(false)
  const [lastRun, setLastRun] = useState(null)
  const [subGuestOpen, setSubGuestOpen] = useState(false)
  const [subSelectedCount, setSubSelectedCount] = useState(0)

  // 仅展示 Sub 脚本；完整 scripts 仍保留，启动/权限校验走原逻辑
  const visibleScripts = useMemo(() => (scripts || []).filter((s) => s.key === 'sub_guest'), [scripts])
  const selected = useMemo(() => scripts.find((s) => s.key === selectedKey) || null, [scripts, selectedKey])
  const isSubGuest = selectedKey === 'sub_guest'

  const refreshSubSelection = async () => {
    try {
      const ids = await window.api?.subGuest?.getSelectedIds?.()
      setSubSelectedCount(Array.isArray(ids) ? ids.length : 0)
    } catch {
      setSubSelectedCount(0)
    }
  }

  const load = async () => {
    setBusy(true)
    try {
      const list = await window.api?.scripts?.list?.()
      setScripts(list || [])
      const visible = (list || []).filter((s) => s.key === 'sub_guest')
      if (!selectedKey && visible.length) setSelectedKey(visible[0].key)
    } catch (e) {
      pushLog?.('系统', '脚本列表', e?.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    load().catch(() => {})
    const off = window.api?.scripts?.onEvent?.((evt) => {
      const device = evt?.device || evt?.runId || '脚本'
      const type = evt?.type || 'log'
      const msg = evt?.data?.msg || JSON.stringify(evt?.data || evt)
      pushLog?.(device, `脚本(${type})`, msg)
    })
    return () => off?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (isSubGuest) refreshSubSelection().catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSubGuest, selectedKey])

  useEffect(() => {
    if (!selected) return
    const next = {}
    for (const p of selected.params || []) {
      // 数字也先存字符串，避免输入过程 Number('')→0 / NaN
      next[p.key] = p.default === undefined || p.default === null ? '' : String(p.default)
    }
    setParams(next)
  }, [selectedKey])

  const start = async () => {
    if (!selectedKey) return
    if (!deviceSerials?.length) {
      pushLog?.('系统', '启动脚本', '请先选择至少 1 台设备')
      showFriendlyError('请先选择至少 1 台设备')
      return
    }

    if (selectedKey === 'sub_guest') {
      const ids = (await window.api?.subGuest?.getSelectedIds?.()) || []
      setSubSelectedCount(ids.length)
      if (!ids.length) {
        const msg = '请先在「话术管理」中勾选至少一个话术，再执行 Sub 获客。'
        pushLog?.('系统', '启动脚本', msg)
        showFriendlyError(msg)
        setSubGuestOpen(true)
        return
      }
    }

    const finalParams = coerceParams(selected?.params, params)

    // 校验必填参数
    for (const p of selected?.params || []) {
      if (!p?.required) continue
      const v = finalParams?.[p.key]
      if (v === undefined || v === null || String(v).trim() === '') {
        const label = p.label || p.key
        showFriendlyError(`请填写必填参数：${label}`)
        return
      }
      if (p.type === 'number') {
        const n = Number(v)
        if (!Number.isFinite(n) || n < 1 || !Number.isInteger(n)) {
          showFriendlyError(`${p.label || p.key} 必须为大于等于 1 的整数`)
          return
        }
      }
    }

    setBusy(true)
    try {
      const r = await window.api?.scripts?.start?.({ key: selectedKey, params: finalParams, deviceSerials })
      setLastRun(r)
      pushLog?.('系统', '启动脚本', `ok(${selectedKey}) loop=${finalParams?.loop ?? '-'} targets=${deviceSerials?.length || 0}`)
    } catch (e) {
      const msg = e?.message || String(e)
      pushLog?.('系统', '启动脚本', msg)
      // 权限类错误/以及其它显式错误：弹窗提示
      showFriendlyError(msg)
    } finally {
      setBusy(false)
    }
  }

  const stop = async () => {
    const runId = lastRun?.runId
    if (!runId) return
    try {
      const killed = await window.api?.scripts?.stop?.(runId, { group: true })
      if (killed > 0) {
        pushLog?.('系统', '停止脚本', `ok(killed=${killed})，已强制结束进程树`)
      } else {
        pushLog?.('系统', '停止脚本', `未找到运行中的进程(runId=${runId})，可能已退出`)
      }
    } catch (e) {
      pushLog?.('系统', '停止脚本', e?.message || String(e))
    }
  }

  const checkRuntime = async () => {
    setBusy(true)
    try {
      const r = await window.api?.scripts?.checkRuntime?.()
      const ok = !!r?.ok

      pushLog?.('系统', '脚本环境自检', ok ? 'OK（uiautomator2 依赖齐全）' : 'FAIL（依赖缺失/内置Python不可用）')
      pushLog?.('系统', 'Python', `exe=${r?.pythonExe || '-'}`)
      pushLog?.(
        '系统',
        'Python来源',
        r?.packaged
          ? r?.bundled
            ? '打包版·内置'
            : '打包版·外部(异常)'
          : r?.bundled
            ? '开发版·内置'
            : '开发版·本机(pyenv/scoop)'
      )

      if (r?.version) {
        pushLog?.('系统', 'Python版本', (r?.version?.stdout || '').trim() || JSON.stringify(r.version))
      }
      if (r?.imports && !r?.imports?.ok) {
        pushLog?.('系统', '依赖导入失败(stderr)', (r?.imports?.stderr || '').trim() || '-')
        pushLog?.('系统', '依赖导入失败(stdout)', (r?.imports?.stdout || '').trim() || '-')
      }

      if (r?.env) {
        pushLog?.('系统', 'PYTHONHOME', r.env.PYTHONHOME || '-')
        pushLog?.('系统', 'PYTHONPATH', r.env.PYTHONPATH || '-')
      }
    } catch (e) {
      pushLog?.('系统', '脚本环境自检', e?.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">脚本</CardTitle>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" disabled={busy} onClick={checkRuntime}>
            环境自检
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={load}>
            刷新
          </Button>
          <Button size="sm" variant="secondary" disabled={!lastRun?.runId} onClick={stop}>
            停止
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1">
          <Label>脚本选择</Label>
          <select
            className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-slate-900 dark:text-slate-800 shadow-sm"
            style={{ color: selectedKey ? undefined : 'hsl(var(--muted-foreground))' }}
            value={selectedKey}
            onChange={(e) => setSelectedKey(e.target.value)}
          >
            <option value="" className="text-slate-800 dark:text-slate-800">
              请选择脚本
            </option>
            {visibleScripts.map((s) => (
              <option
                key={s.key}
                value={s.key}
                className="text-slate-900 dark:text-slate-800 bg-white dark:bg-slate-100"
              >
                {s.category ? `[${s.category}] ` : ''}
                {s.name} ({s.key})
              </option>
            ))}
          </select>
        </div>

        {selected && (
          <div className="rounded-md border p-3 space-y-2">
            <div className="text-sm font-medium">{selected.name}</div>
            <div className="text-xs text-muted-foreground">
              key: {selected.key} · version: {selected.version || '-'} · entry: {selected.entry}
            </div>
            {selected.description && <div className="text-xs text-muted-foreground">{selected.description}</div>}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {(selected.params || []).map((p) => (
                <ParamField
                  key={p.key}
                  p={p}
                  value={params?.[p.key]}
                  onChange={(v) =>
                    setParams((prev) => ({
                      ...prev,
                      // 输入过程保持字符串，启动时再 coerce 成 number
                      [p.key]: v
                    }))
                  }
                />
              ))}
            </div>

            {isSubGuest && (
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <Button size="sm" variant="outline" disabled={busy} onClick={() => setSubGuestOpen(true)}>
                  话术管理
                </Button>
                <span className="text-xs text-muted-foreground">
                  已选话术 {subSelectedCount} 条（新用户从此集合随机）
                </span>
              </div>
            )}
          </div>
        )}

        <div className="text-xs text-muted-foreground">
          环境变量：脚本可读取 <code className="px-1 rounded bg-muted">HCA_ADB_PATH</code>（内置 adb 路径）
        </div>
        <div className="text-xs text-muted-foreground">
          Python 优先级：<code className="px-1 rounded bg-muted">HCA_PYTHON</code> →{' '}
          <code className="px-1 rounded bg-muted">resources/python</code>（内置，含脚本依赖）→ 本机 pyenv/scoop
        </div>

        <div className="text-xs text-muted-foreground">
          执行范围：{deviceSerials?.length ? `已选 ${deviceSerials.length} 台设备` : '未选择设备（将以单实例运行）'}
        </div>

        <Button className="w-full" variant="outline" disabled={busy || !selectedKey || !deviceSerials?.length} onClick={start}>
          {busy ? '执行中…' : '开始执行'}
        </Button>

        {!deviceSerials?.length && (
          <div className="text-xs text-rose-600">请先在左侧设备列表勾选至少 1 台设备</div>
        )}

        {lastRun?.runId && <div className="text-xs text-muted-foreground">runId: {lastRun.runId}</div>}
      </CardContent>

      <SubGuestScriptsDialog
        open={subGuestOpen}
        onOpenChange={(v) => {
          setSubGuestOpen(v)
          if (!v) refreshSubSelection().catch(() => {})
        }}
        pushLog={pushLog}
      />
    </Card>
  )
}
