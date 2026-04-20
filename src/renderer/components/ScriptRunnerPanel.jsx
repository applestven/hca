import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

function ParamField({ p, value, onChange }) {
  const type = p?.type || 'text'
  return (
    <div className="space-y-1">
      <Label>{p?.label || p?.key}</Label>
      <Input
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder={String(p?.default ?? '')}
        inputMode={type === 'number' ? 'numeric' : undefined}
      />
    </div>
  )
}

export default function ScriptRunnerPanel({ deviceSerials = [], pushLog }) {
  const [scripts, setScripts] = useState([])
  const [selectedKey, setSelectedKey] = useState('')
  const [params, setParams] = useState({})
  const [busy, setBusy] = useState(false)
  const [lastRun, setLastRun] = useState(null)

  const selected = useMemo(() => scripts.find((s) => s.key === selectedKey) || null, [scripts, selectedKey])

  const load = async () => {
    setBusy(true)
    try {
      const list = await window.api?.scripts?.list?.()
      setScripts(list || [])
      if (!selectedKey && list?.length) setSelectedKey(list[0].key)
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
    if (!selected) return
    const next = {}
    for (const p of selected.params || []) {
      next[p.key] = p.default
    }
    setParams(next)
  }, [selectedKey])

  const start = async () => {
    if (!selectedKey) return
    if (!deviceSerials?.length) {
      pushLog?.('系统', '启动脚本', '请先选择至少 1 台设备')
      return
    }
    setBusy(true)
    try {
      const r = await window.api?.scripts?.start?.({ key: selectedKey, params, deviceSerials })
      setLastRun(r)
      pushLog?.('系统', '启动脚本', `ok(${selectedKey}) targets=${deviceSerials?.length || 0}`)
    } catch (e) {
      pushLog?.('系统', '启动脚本', e?.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  const stop = async () => {
    const runId = lastRun?.runId
    if (!runId) return
    setBusy(true)
    try {
      const killed = await window.api?.scripts?.stop?.(runId, { group: true })
      pushLog?.('系统', '停止脚本', `ok(killed=${killed})`)
    } catch (e) {
      pushLog?.('系统', '停止脚本', e?.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  const checkRuntime = async () => {
    setBusy(true)
    try {
      const r = await window.api?.scripts?.checkRuntime?.()
      const ok = !!r?.ok

      pushLog?.('系统', '脚本环境自检', ok ? 'OK（uiautomator2 依赖齐全）' : 'FAIL（依赖缺失/内置Python不可用）')
      pushLog?.('系统', 'Python', `exe=${r?.pythonExe || '-'}`)

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
          <Button size="sm" variant="secondary" disabled={busy || !lastRun?.runId} onClick={stop}>
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
            {scripts.map((s) => (
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
                      [p.key]: p.type === 'number' ? Number(v) : v
                    }))
                  }
                />
              ))}
            </div>
          </div>
        )}

        <div className="text-xs text-muted-foreground">
          环境变量：脚本可读取 <code className="px-1 rounded bg-muted">HCA_ADB_PATH</code>（内置 adb 路径）
        </div>
        <div className="text-xs text-muted-foreground">
          Python 优先级：<code className="px-1 rounded bg-muted">resources/python</code>（内置）→
          <code className="px-1 rounded bg-muted">HCA_PYTHON</code> → 系统 <code className="px-1 rounded bg-muted">python</code>
        </div>

        <div className="text-xs text-muted-foreground">
          执行范围：{deviceSerials?.length ? `已选 ${deviceSerials.length} 台设备` : '未选择设备（将以单实例运行）'}
        </div>

        <Button className="w-full" disabled={busy || !selectedKey || !deviceSerials?.length} onClick={start}>
          {busy ? '执行中…' : '开始执行'}
        </Button>

        {!deviceSerials?.length && (
          <div className="text-xs text-rose-600">请先在左侧设备列表勾选至少 1 台设备</div>
        )}

        {lastRun?.runId && <div className="text-xs text-muted-foreground">runId: {lastRun.runId}</div>}
      </CardContent>
    </Card>
  )
}
