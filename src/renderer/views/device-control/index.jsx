'use client'

import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import ScriptRunnerPanel from '@/components/ScriptRunnerPanel'

const DEVICE_GROUP_UNGROUPED = '未分组'

function nowTime() {
  const d = new Date()
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}

function downloadTextFile(filename, text) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

function serializeLogsToText(items) {
  const logs = items || []
  const header = ['time', 'device', 'action', 'result'].join('\t')
  const lines = logs.map((l) => [l.time, l.device, l.action, String(l.result ?? '')].join('\t'))
  return [header, ...lines].join('\r\n')
}

export default function DeviceControlPage() {
  const [devices, setDevices] = useState([])
  const [selectedIds, setSelectedIds] = useState(() => new Set())
  const [activeDeviceId, setActiveDeviceId] = useState(null)
  const [filterGroup, setFilterGroup] = useState('全部')
  const [keyword, setKeyword] = useState('')

  // WiFi 连接
  const [wifiIp, setWifiIp] = useState('')
  const [wifiPort, setWifiPort] = useState('5555')
  const [busy, setBusy] = useState(false)

  // IP 段扫描
  const [scanRange, setScanRange] = useState('192.168.110.x')
  const [scanPort, setScanPort] = useState('5555')
  const [scanConcurrency, setScanConcurrency] = useState('50')
  const [scanPingFirst, setScanPingFirst] = useState(true)

  const [scanLastResult, setScanLastResult] = useState(null)
  const [scanFilter, setScanFilter] = useState('all') // all | ok | failed | skipped
  const [scanKeyword, setScanKeyword] = useState('')

  const [tab, setTab] = useState('control') // control | batch | script | masterSlave

  // 控制参数
  const [tapX, setTapX] = useState('100')
  const [tapY, setTapY] = useState('200')
  const [swipeX1, setSwipeX1] = useState('100')
  const [swipeY1, setSwipeY1] = useState('400')
  const [swipeX2, setSwipeX2] = useState('800')
  const [swipeY2, setSwipeY2] = useState('400')
  const [swipeDuration, setSwipeDuration] = useState('')
  const [inputText, setInputText] = useState('')
  const [appPkg, setAppPkg] = useState('')
  const [appActivity, setAppActivity] = useState('')

  // 群控：执行对象
  const [batchScope, setBatchScope] = useState('selected') // all | group | selected
  const [batchGroup, setBatchGroup] = useState('全部')

  const [logs, setLogs] = useState([
    { time: nowTime(), device: '系统', action: '进入设备中控', result: 'ok' }
  ])

  // 日志过滤/搜索
  const [logKeyword, setLogKeyword] = useState('')
  const [logOnlyError, setLogOnlyError] = useState(false)
  const [logOpen, setLogOpen] = useState(false)

  // 自动重连
  const [autoReconnect, setAutoReconnect] = useState(true)
  const [reconnecting, setReconnecting] = useState(() => new Set())

  const pushLog = (device, action, result) => {
    setLogs((prev) => [{ time: nowTime(), device, action, result }, ...prev])
  }

  const reconnectOne = async (serial, name) => {
    setBusy(true)
    setReconnecting((prev) => {
      const next = new Set(prev)
      next.add(serial)
      return next
    })

    try {
      const out = await window.api?.device?.reconnect?.(serial)
      pushLog(name || serial, '重连', out || 'ok')
    } catch (e) {
      pushLog(name || serial, '重连', e?.message || String(e))
    } finally {
      setReconnecting((prev) => {
        const next = new Set(prev)
        next.delete(serial)
        return next
      })
      setBusy(false)
      await loadDevices().catch(() => {})
    }
  }

  const loadDevices = async () => {
    setBusy(true)
    try {
      const list = await window.api?.device?.list?.()
      const mapped = (list || []).map((d) => {
        const conn = d.ip ? 'WiFi' : 'USB'
        const status = d.state === 'device' ? 'online' : 'offline'
        const name = d.model || d.serial
        return {
          id: d.serial,
          name,
          sn: d.serial,
          ip: d.ip || '',
          group: DEVICE_GROUP_UNGROUPED,
          status,
          conn
        }
      })
      setDevices(mapped)
      pushLog('系统', '刷新设备列表', `ok(${mapped.length})`)
    } catch (e) {
      pushLog('系统', '刷新设备列表', e?.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  const connectWifi = async () => {
    const ip = wifiIp.trim()
    const port = Number(String(wifiPort).trim() || '5555')
    if (!ip) {
      pushLog('系统', 'WiFi连接', '请输入IP')
      return
    }
    setBusy(true)
    pushLog('系统', `adb connect ${ip}:${port}`, '...')
    try {
      const out = await window.api?.device?.connectWifi?.(ip, port)
      pushLog('系统', `adb connect ${ip}:${port}`, out || 'ok')
      await loadDevices()
    } catch (e) {
      pushLog('系统', `adb connect ${ip}:${port}`, e?.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  const startScrcpy = async (serial) => {
    if (!serial) return
    setBusy(true)
    try {
      const r = await window.api?.device?.scrcpyStart?.(serial)
      pushLog(serial, '启动 scrcpy', `ok(pid=${r?.pid ?? ''})`)
    } catch (e) {
      pushLog(serial, '启动 scrcpy', e?.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    loadDevices()
    // 轮询刷新（先简单实现，后续可改成事件驱动/节流）
    const t = setInterval(() => {
      loadDevices()
    }, 5000)
    return () => clearInterval(t)
  }, [])

  // 选中设备 → 联动控制：
  // - 单选时，自动设置为当前控制设备
  useEffect(() => {
    if (selectedIds.size === 1) {
      const onlyId = Array.from(selectedIds)[0]
      setActiveDeviceId(onlyId)
    }
    if (selectedIds.size === 0) {
      setActiveDeviceId(null)
    }
  }, [selectedIds])

  const groups = useMemo(() => {
    const s = new Set(devices.map((d) => d.group).filter(Boolean))
    return ['全部', ...Array.from(s)]
  }, [devices])

  const filteredDevices = useMemo(() => {
    return devices
      .filter((d) => (filterGroup === '全部' ? true : d.group === filterGroup))
      .filter((d) => {
        if (!keyword.trim()) return true
        const k = keyword.trim().toLowerCase()
        return (
          d.name?.toLowerCase().includes(k) ||
          d.ip?.toLowerCase().includes(k) ||
          d.sn?.toLowerCase().includes(k)
        )
      })
  }, [devices, filterGroup, keyword])

  const selectedDevices = useMemo(() => {
    const set = selectedIds
    return devices.filter((d) => set.has(d.id))
  }, [devices, selectedIds])

  const setAll = (checked) => {
    if (!checked) {
      setSelectedIds(new Set())
      return
    }
    setSelectedIds(new Set(filteredDevices.map((d) => d.id)))
  }

  const runOnTargets = async (targets, actionLabel, fn) => {
    if (!targets.length) {
      pushLog('系统', actionLabel, '请先选择设备')
      return
    }

    setBusy(true)
    try {
      for (const d of targets) {
        if (d.status !== 'online') {
          pushLog(d.name, actionLabel, 'error: device offline')
          continue
        }
        try {
          const r = await fn(d)
          pushLog(d.name, actionLabel, r || 'success')
        } catch (e) {
          pushLog(d.name, actionLabel, e?.message || String(e))
        }
      }
    } finally {
      setBusy(false)
      await loadDevices().catch(() => {})
    }
  }

  const doTap = async ({ x, y, scope }) => {
    const targets = scope === 'single'
      ? devices.filter((d) => d.id === activeDeviceId)
      : selectedDevices
    await runOnTargets(targets, `tap(${x},${y})`, (d) => window.api?.device?.tap?.(d.sn, x, y))
  }

  const doSwipe = async ({ x1, y1, x2, y2, durationMs, scope }) => {
    const targets = scope === 'single'
      ? devices.filter((d) => d.id === activeDeviceId)
      : selectedDevices
    await runOnTargets(
      targets,
      `swipe(${x1},${y1})->(${x2},${y2})${durationMs ? ` ${durationMs}ms` : ''}`,
      (d) => window.api?.device?.swipe?.(d.sn, x1, y1, x2, y2, durationMs)
    )
  }

  const doText = async ({ text, scope }) => {
    const targets = scope === 'single'
      ? devices.filter((d) => d.id === activeDeviceId)
      : selectedDevices
    await runOnTargets(targets, `text(${text})`, (d) => window.api?.device?.text?.(d.sn, text))
  }

  const doStartApp = async ({ pkg, activity, scope }) => {
    const targets = scope === 'single'
      ? devices.filter((d) => d.id === activeDeviceId)
      : selectedDevices
    const label = activity ? `startApp(${pkg}/${activity})` : `startApp(${pkg})`
    await runOnTargets(targets, label, (d) => window.api?.device?.startApp?.(d.sn, pkg, activity))
  }

  const doKeyEvent = async ({ keyCode, label, scope }) => {
    const targets = scope === 'single'
      ? devices.filter((d) => d.id === activeDeviceId)
      : selectedDevices
    await runOnTargets(targets, label, (d) => window.api?.device?.keyevent?.(d.sn, keyCode))
  }

  const scanIpRange = async () => {
    const range = scanRange.trim()
    const port = Number(String(scanPort).trim() || '5555')
    const concurrency = Number(String(scanConcurrency).trim() || '50')

    if (!range) {
      pushLog('系统', 'IP段扫描', '请输入扫描范围')
      return
    }

    setBusy(true)
    try {
      const r = await window.api?.device?.scanRange?.(range, port, {
        concurrency,
        pingFirst: scanPingFirst
      })

      setScanLastResult(r)
      setScanFilter('all')
      setScanKeyword('')

      const ok = (r?.results || []).filter((x) => x.ok).length
      const total = r?.count ?? (r?.results || []).length
      pushLog('系统', `扫描 ${r?.startIp || ''}-${r?.endIp || ''}`, `ok=${ok}/${total}`)

      // 可选：把失败信息也写入日志（避免刷屏，仅写前 10 条）
      ;(r?.results || [])
        .filter((x) => !x.ok && !x.skipped)
        .slice(0, 10)
        .forEach((x) => pushLog(x.target || x.ip, 'adb connect', x.message || 'failed'))

      await loadDevices()
    } catch (e) {
      pushLog('系统', 'IP段扫描', e?.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  const scanRows = useMemo(() => {
    const rows = scanLastResult?.results || []
    const k = scanKeyword.trim().toLowerCase()

    return rows
      .filter((r) => {
        if (scanFilter === 'ok') return Boolean(r.ok)
        if (scanFilter === 'failed') return !r.ok && !r.skipped
        if (scanFilter === 'skipped') return Boolean(r.skipped)
        return true
      })
      .filter((r) => {
        if (!k) return true
        return (
          String(r.ip || '').toLowerCase().includes(k) ||
          String(r.target || '').toLowerCase().includes(k) ||
          String(r.message || '').toLowerCase().includes(k)
        )
      })
  }, [scanLastResult, scanFilter, scanKeyword])

  const retryScanRows = async (rows) => {
    if (!rows?.length) {
      pushLog('系统', '重试扫描', '无可重试项')
      return
    }

    const port = Number(String(scanPort).trim() || '5555')

    setBusy(true)
    try {
      // 复用 connectWifi 能力逐个重试（简单可靠；后续可做批量 IPC）
      for (const r of rows) {
        try {
          const out = await window.api?.device?.connectWifi?.(r.ip, port)
          pushLog(r.target || r.ip, '重试 connect', out || 'ok')
        } catch (e) {
          pushLog(r.target || r.ip, '重试 connect', e?.message || String(e))
        }
      }
      await loadDevices()
    } finally {
      setBusy(false)
    }
  }

  const visibleLogs = useMemo(() => {
    return logs
      .filter((l) => (logOnlyError ? String(l.result).toLowerCase().includes('error') : true))
      .filter((l) => {
        if (!logKeyword.trim()) return true
        const k = logKeyword.trim().toLowerCase()
        return (
          String(l.device || '').toLowerCase().includes(k) ||
          String(l.action || '').toLowerCase().includes(k) ||
          String(l.result || '').toLowerCase().includes(k)
        )
      })
  }, [logs, logOnlyError, logKeyword])

  const copyVisibleLogs = async () => {
    const text = serializeLogsToText(visibleLogs)
    try {
      await navigator.clipboard?.writeText(text)
      pushLog('系统', '复制日志', `ok(${visibleLogs.length})`)
    } catch (e) {
      pushLog('系统', '复制日志', e?.message || 'failed')
    }
  }

  const exportVisibleLogs = () => {
    const text = serializeLogsToText(visibleLogs)
    const ts = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    const name = `hca-device-control-logs-${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}.txt`
    try {
      downloadTextFile(name, text)
      pushLog('系统', '导出日志', `ok(${visibleLogs.length})`)
    } catch (e) {
      pushLog('系统', '导出日志', e?.message || 'failed')
    }
  }

  useEffect(() => {
    if (!window.api?.device) {
      pushLog('系统', '设备中控', 'window.api.device 不存在（preload 未注入或未重启应用）')
    }
  }, [])

  return (
    <div className="h-full w-full p-4">
      <div className="grid grid-cols-12 gap-4 h-full">
        {/* 左侧：设备列表 */}
        <Card className="col-span-3 h-full flex flex-col">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">设备列表</CardTitle>

            {/* 顶部栏：状态 + 全局操作 */}
            <div className="mt-2 grid grid-cols-1 gap-2 rounded-lg border p-2">
              <div className="flex items-center justify-between">
                <div className="text-xs text-muted-foreground">ADB状态</div>
                <div className="text-xs">{busy ? 'loading…' : 'ready'}</div>
              </div>
              <div className="flex items-center justify-between">
                <div className="text-xs text-muted-foreground">设备数量</div>
                <div className="text-xs">
                  {devices.filter((d) => d.status === 'online').length} 在线 / {devices.filter((d) => d.status !== 'online').length} 离线
                </div>
              </div>

              <label className="flex items-center justify-between text-sm">
                <span>自动重连</span>
                <input type="checkbox" checked={autoReconnect} onChange={(e) => setAutoReconnect(e.target.checked)} />
              </label>

              {devices.some((d) => d.status !== 'online') && (
                <div className="text-xs text-rose-600">
                  ⚠ 有设备离线{autoReconnect ? '，自动重连中…' : ''}
                </div>
              )}

              <div className="grid grid-cols-8 gap-2 items-end">
                <div className="col-span-5">
                  <Label className="text-xs">WiFi IP</Label>
                  <Input
                    className="mt-1 h-9"
                    placeholder="192.168.1.100"
                    value={wifiIp}
                    onChange={(e) => setWifiIp(e.target.value)}
                  />
                </div>
                <div className="col-span-3">
                  <Label className="text-xs">端口</Label>
                  <Input
                    className="mt-1 h-9"
                    placeholder="5555"
                    value={wifiPort}
                    onChange={(e) => setWifiPort(e.target.value)}
                  />
                </div>

                <div className="col-span-8 flex gap-2">
                  <Button size="sm" className="flex-1" disabled={busy} onClick={connectWifi}>
                    添加设备(WiFi)
                  </Button>
                  <Button size="sm" variant="outline" disabled={busy} onClick={loadDevices}>
                    刷新
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true)
                      try {
                        const out = await window.api?.adb?.restart?.()
                        pushLog('系统', '重启ADB', out || 'ok')
                        await loadDevices()
                      } catch (e) {
                        pushLog('系统', '重启ADB', e?.message || String(e))
                      } finally {
                        setBusy(false)
                      }
                    }}
                  >
                    重启
                  </Button>
                </div>
              </div>
            </div>

            {/* 扫描局域网（IP 段） */}
            <div className="mt-2 grid grid-cols-1 gap-2 rounded-lg border p-2">
              <div className="text-sm font-medium">IP 段扫描</div>
              <div className="text-xs text-muted-foreground">
                支持：<code>192.168.110.x</code> / <code>192.168.110.0/24</code> / <code>192.168.110.1-255</code> / <code>startIP-endIP</code>
              </div>

              <div>
                <Label className="text-xs">扫描范围</Label>
                <Input
                  className="mt-1 h-9"
                  placeholder="192.168.110.x"
                  value={scanRange}
                  onChange={(e) => setScanRange(e.target.value)}
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label className="text-xs">端口</Label>
                  <Input className="mt-1 h-9" value={scanPort} onChange={(e) => setScanPort(e.target.value)} />
                </div>
                <div>
                  <Label className="text-xs">并发</Label>
                  <Input
                    className="mt-1 h-9"
                    value={scanConcurrency}
                    onChange={(e) => setScanConcurrency(e.target.value)}
                  />
                </div>
              </div>

              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={scanPingFirst} onChange={(e) => setScanPingFirst(e.target.checked)} />
                先 ping 再 connect（更快，但可能漏掉禁 ping 设备）
              </label>

              <Button size="sm" disabled={busy} onClick={scanIpRange}>
                开始扫描
              </Button>

              {scanLastResult && (
                <div className="mt-2 rounded-lg border p-2">
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-medium">扫描结果</div>
                    <div className="text-xs text-muted-foreground">
                      {scanLastResult.startIp}-{scanLastResult.endIp}（{scanLastResult.count}）
                    </div>
                  </div>

                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <select
                      className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                      value={scanFilter}
                      onChange={(e) => setScanFilter(e.target.value)}
                    >
                      <option value="all">全部</option>
                      <option value="ok">成功</option>
                      <option value="failed">失败</option>
                      <option value="skipped">跳过(ping失败)</option>
                    </select>
                    <Input
                      className="h-9"
                      placeholder="搜索 IP/消息"
                      value={scanKeyword}
                      onChange={(e) => setScanKeyword(e.target.value)}
                    />
                  </div>

                  <div className="mt-2 flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => {
                        const failed = (scanLastResult?.results || []).filter((x) => !x.ok && !x.skipped)
                        retryScanRows(failed)
                      }}
                    >
                      重试失败
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => {
                        const text = JSON.stringify(scanLastResult, null, 2)
                        navigator.clipboard?.writeText(text).then(
                          () => pushLog('系统', '复制扫描结果', 'ok'),
                          () => pushLog('系统', '复制扫描结果', 'failed')
                        )
                      }}
                    >
                      复制JSON
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => setScanLastResult(null)}
                    >
                      关闭
                    </Button>
                  </div>

                  <div className="mt-2 max-h-56 overflow-auto rounded-md border">
                    <div className="grid grid-cols-12 gap-2 text-[11px] font-medium px-2 py-2 border-b">
                      <div className="col-span-5">目标</div>
                      <div className="col-span-2">状态</div>
                      <div className="col-span-5">消息</div>
                    </div>
                    <div className="divide-y">
                      {scanRows.map((r, idx) => (
                        <div key={idx} className="grid grid-cols-12 gap-2 text-[11px] px-2 py-2">
                          <div className="col-span-5 font-mono truncate" title={r.target || r.ip}>
                            {r.target || r.ip}
                          </div>
                          <div className="col-span-2">
                            {r.ok ? (
                              <span className="text-emerald-700">OK</span>
                            ) : r.skipped ? (
                              <span className="text-muted-foreground">SKIP</span>
                            ) : (
                              <span className="text-rose-700">FAIL</span>
                            )}
                          </div>
                          <div className="col-span-5 truncate" title={r.message}>
                            {r.message}
                          </div>
                        </div>
                      ))}
                      {scanRows.length === 0 && (
                        <div className="text-xs text-muted-foreground px-2 py-3">无匹配结果</div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="mt-2 grid grid-cols-1 gap-2">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label className="text-xs">分组</Label>
                  <select
                    className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                    value={filterGroup}
                    onChange={(e) => setFilterGroup(e.target.value)}
                  >
                    {groups.map((g) => (
                      <option key={g} value={g}>
                        {g}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label className="text-xs">搜索</Label>
                  <Input
                    className="mt-1"
                    placeholder="设备名/IP/SN"
                    value={keyword}
                    onChange={(e) => setKeyword(e.target.value)}
                  />
                </div>
              </div>
              <div className="flex items-center justify-between">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={filteredDevices.length > 0 && selectedIds.size === filteredDevices.length}
                    onChange={(e) => setAll(e.target.checked)}
                  />
                  全选(当前筛选)
                </label>
                <span className="text-xs text-muted-foreground">
                  在线 {devices.filter((d) => d.status === 'online').length} / 离线 {devices.filter((d) => d.status !== 'online').length}
                </span>
              </div>
            </div>
          </CardHeader>
          <CardContent className="flex-1 overflow-auto space-y-2">
            {filteredDevices.map((d) => {
              const checked = selectedIds.has(d.id)
              const isActive = activeDeviceId === d.id
              return (
                <div
                  key={d.id}
                  className={
                    'rounded-lg border p-2 cursor-pointer ' +
                    (isActive ? 'border-primary' : 'border-border')
                  }
                  onClick={() => toggleSelect(d.id)}
                >
                  <div className="flex items-start justify-between gap-2">
                    <label className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleSelect(d.id)}
                        onClick={(e) => e.stopPropagation()}
                      />
                      <div>
                        <div className="text-sm font-medium">
                          {d.name}{' '}
                          <span className="text-xs text-muted-foreground">({d.conn})</span>
                        </div>
                        <div className="text-xs text-muted-foreground">SN: {d.sn}</div>
                        <div className="text-xs text-muted-foreground">IP: {d.ip}</div>
                        <div className="text-xs text-muted-foreground">分组：{d.group}</div>
                      </div>
                    </label>
                    <span
                      className={
                        'text-xs px-2 py-0.5 rounded-full ' +
                        (d.status === 'online'
                          ? 'bg-emerald-500/15 text-emerald-700'
                          : 'bg-rose-500/15 text-rose-700')
                      }
                    >
                      {d.status === 'online' ? '在线' : '离线'}
                    </span>
                  </div>
                  <div className="mt-2 flex gap-2" onClick={(e) => e.stopPropagation()}>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy}
                      onClick={() => {
                        setActiveDeviceId(d.id)
                        pushLog(d.name, '设为当前控制设备', 'ok')
                      }}
                    >
                      控制
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => startScrcpy(d.sn)}
                      title="使用 bin\\scrcpy\\scrcpy.exe 启动预览窗口"
                    >
                      预览
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || reconnecting.has(d.sn)}
                      onClick={() => reconnectOne(d.sn, d.name)}
                    >
                      {reconnecting.has(d.sn) ? '重连中…' : '重连'}
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={busy}
                      onClick={() => {
                        setDevices((prev) => prev.filter((x) => x.id !== d.id))
                        setSelectedIds((prev) => {
                          const next = new Set(prev)
                          next.delete(d.id)
                          return next
                        })
                        pushLog(d.name, '移除设备(本地UI)', 'ok')
                      }}
                    >
                      移除
                    </Button>
                  </div>
                </div>
              )
            })}

            {filteredDevices.length === 0 && (
              <div className="text-sm text-muted-foreground">暂无设备（当前为 UI 骨架演示数据）</div>
            )}
          </CardContent>
        </Card>

        {/* 中间：预览区 */}
        <Card className="col-span-6 h-full flex flex-col">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">屏幕预览</CardTitle>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => pushLog('系统', '单设备模式(占位)', 'todo')}>
                  单设备
                </Button>
                <Button size="sm" variant="outline" onClick={() => pushLog('系统', '网格模式(占位)', 'todo')}>
                  网格
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="flex-1">
            <div className="h-full w-full rounded-lg border border-dashed flex items-center justify-center text-sm text-muted-foreground">
              {activeDeviceId
                ? `预览占位：${devices.find((d) => d.id === activeDeviceId)?.name ?? activeDeviceId}`
                : '未选择设备（选中 1 台设备会自动联动）'}
              <div className="hidden" />
            </div>
            {/* <div className="mt-3 text-xs text-muted-foreground">
              脚本目录：<code>bin\scrcpy</code>（下一步接入 scrcpy/adb 能力）
            </div> */}
          </CardContent>
        </Card>

        {/* 右侧：控制面板 */}
        <Card className="col-span-3 h-full flex flex-col">
          <CardHeader className="pb-2 space-y-2">
            <CardTitle className="text-base">控制面板</CardTitle>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant={tab === 'control' ? 'default' : 'outline'}
                onClick={() => setTab('control')}
              >
                控制
              </Button>
              <Button
                size="sm"
                variant={tab === 'batch' ? 'default' : 'outline'}
                onClick={() => setTab('batch')}
              >
                群控
              </Button>
              <Button
                size="sm"
                variant={tab === 'script' ? 'default' : 'outline'}
                onClick={() => setTab('script')}
              >
                脚本
              </Button>
              <Button
                size="sm"
                variant={tab === 'masterSlave' ? 'default' : 'outline'}
                onClick={() => setTab('masterSlave')}
              >
                主从
              </Button>

              <div className="flex-1" />

              <Button size="sm" variant="outline" onClick={() => setLogOpen(true)}>
                日志
              </Button>
            </div>
          </CardHeader>
          <CardContent className="flex-1 overflow-auto">
            {tab === 'control' && (
              <div className="space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <Label className="text-xs">Tap 坐标</Label>
                    <div className="grid grid-cols-2 gap-2">
                      <Input
                        className="h-9"
                        placeholder="X"
                        value={tapX}
                        onChange={(e) => setTapX(e.target.value)}
                      />
                      <Input
                        className="h-9"
                        placeholder="Y"
                        value={tapY}
                        onChange={(e) => setTapY(e.target.value)}
                      />
                    </div>
                  </div>
                  <div>
                    <Label className="text-xs">Swipe 参数</Label>
                    <div className="grid grid-cols-2 gap-2">
                      <Input
                        className="h-9"
                        placeholder="X1"
                        value={swipeX1}
                        onChange={(e) => setSwipeX1(e.target.value)}
                      />
                      <Input
                        className="h-9"
                        placeholder="Y1"
                        value={swipeY1}
                        onChange={(e) => setSwipeY1(e.target.value)}
                      />
                      <Input
                        className="h-9"
                        placeholder="X2"
                        value={swipeX2}
                        onChange={(e) => setSwipeX2(e.target.value)}
                      />
                      <Input
                        className="h-9"
                        placeholder="Y2"
                        value={swipeY2}
                        onChange={(e) => setSwipeY2(e.target.value)}
                      />
                      <Input
                        className="h-9"
                        placeholder="时长(ms)"
                        value={swipeDuration}
                        onChange={(e) => setSwipeDuration(e.target.value)}
                      />
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <Label className="text-xs">输入文本</Label>
                    <Input
                      className="mt-1"
                      placeholder="要输入的文本"
                      value={inputText}
                      onChange={(e) => setInputText(e.target.value)}
                    />
                  </div>
                  <div>
                    <Label className="text-xs">启动 App</Label>
                    <div className="grid grid-cols-2 gap-2">
                      <Input
                        className="h-9"
                        placeholder="包名"
                        value={appPkg}
                        onChange={(e) => setAppPkg(e.target.value)}
                      />
                      <Input
                        className="h-9"
                        placeholder="类名（可选）"
                        value={appActivity}
                        onChange={(e) => setAppActivity(e.target.value)}
                      />
                    </div>
                  </div>
                </div>

                <div className="flex gap-2">
                  <Button
                    className="flex-1"
                    disabled={busy || !activeDeviceId}
                    onClick={() => doTap({ x: Number(tapX), y: Number(tapY), scope: 'single' })}
                    title={!activeDeviceId ? '请先选择 1 台设备作为当前控制设备' : ''}
                  >
                    点击(tap)
                  </Button>
                  <Button
                    className="flex-1"
                    variant="secondary"
                    disabled={busy || !activeDeviceId}
                    onClick={() =>
                      doSwipe({
                        x1: Number(swipeX1),
                        y1: Number(swipeY1),
                        x2: Number(swipeX2),
                        y2: Number(swipeY2),
                        durationMs: swipeDuration ? Number(swipeDuration) : undefined,
                        scope: 'single'
                      })
                    }
                    title={!activeDeviceId ? '请先选择 1 台设备作为当前控制设备' : ''}
                  >
                    滑动(swipe)
                  </Button>
                </div>
                <Button
                  className="w-full"
                  variant="secondary"
                  disabled={busy || !activeDeviceId}
                  onClick={() => doText({ text: inputText, scope: 'single' })}
                >
                  输入文字
                </Button>
                <Button
                  className="w-full"
                  variant="secondary"
                  disabled={busy || !activeDeviceId || !appPkg.trim()}
                  onClick={() =>
                    doStartApp({
                      pkg: appPkg.trim(),
                      activity: appActivity.trim() || undefined,
                      scope: 'single'
                    })
                  }
                >
                  启动App
                </Button>

                <div className="grid grid-cols-2 gap-2">
                  <Button
                    variant="outline"
                    disabled={busy || !activeDeviceId}
                    onClick={() => doKeyEvent({ keyCode: 4, label: 'back', scope: 'single' })}
                  >
                    返回
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy || !activeDeviceId}
                    onClick={() => doKeyEvent({ keyCode: 3, label: 'home', scope: 'single' })}
                  >
                    主页
                  </Button>
                </div>
              </div>
            )}

            {tab === 'batch' && (
              <div className="space-y-3">
                <div className="text-sm font-medium">执行对象</div>

                <div className="grid grid-cols-3 gap-2">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="batchScope"
                      checked={batchScope === 'all'}
                      onChange={() => setBatchScope('all')}
                    />
                    全部
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="batchScope"
                      checked={batchScope === 'group'}
                      onChange={() => setBatchScope('group')}
                    />
                    分组
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="batchScope"
                      checked={batchScope === 'selected'}
                      onChange={() => setBatchScope('selected')}
                    />
                    选中设备
                  </label>
                </div>

                {batchScope === 'group' && (
                  <div>
                    <Label className="text-xs">选择分组</Label>
                    <select
                      className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                      value={batchGroup}
                      onChange={(e) => setBatchGroup(e.target.value)}
                    >
                      {groups.map((g) => (
                        <option key={g} value={g}>
                          {g}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                <div className="text-sm font-medium">操作</div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <Label className="text-xs">Tap 坐标</Label>
                    <div className="grid grid-cols-2 gap-2">
                      <Input className="h-9" placeholder="X" value={tapX} onChange={(e) => setTapX(e.target.value)} />
                      <Input className="h-9" placeholder="Y" value={tapY} onChange={(e) => setTapY(e.target.value)} />
                    </div>
                  </div>
                  <div>
                    <Label className="text-xs">输入文本</Label>
                    <Input
                      className="mt-1"
                      placeholder="要输入的文本"
                      value={inputText}
                      onChange={(e) => setInputText(e.target.value)}
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <Label className="text-xs">启动 App（包名）</Label>
                    <Input className="mt-1" placeholder="com.xxx.app" value={appPkg} onChange={(e) => setAppPkg(e.target.value)} />
                  </div>
                  <div>
                    <Label className="text-xs">类名（可选）</Label>
                    <Input className="mt-1" placeholder=".MainActivity" value={appActivity} onChange={(e) => setAppActivity(e.target.value)} />
                  </div>
                </div>

                <div className="space-y-2">
                  <Button
                    className="w-full"
                    disabled={busy}
                    onClick={async () => {
                      const targets =
                        batchScope === 'all'
                          ? devices
                          : batchScope === 'group'
                            ? devices.filter((d) => (batchGroup === '全部' ? true : d.group === batchGroup))
                            : selectedDevices

                      await runOnTargets(
                        targets,
                        `批量 tap(${Number(tapX)},${Number(tapY)})`,
                        (d) => window.api?.device?.tap?.(d.sn, Number(tapX), Number(tapY))
                      )
                    }}
                  >
                    点击某坐标
                  </Button>

                  <Button
                    className="w-full"
                    variant="secondary"
                    disabled={busy || !appPkg.trim()}
                    onClick={async () => {
                      const targets =
                        batchScope === 'all'
                          ? devices
                          : batchScope === 'group'
                            ? devices.filter((d) => (batchGroup === '全部' ? true : d.group === batchGroup))
                            : selectedDevices

                      await runOnTargets(
                        targets,
                        `批量 startApp(${appPkg.trim()})`,
                        (d) => window.api?.device?.startApp?.(d.sn, appPkg.trim(), appActivity.trim() || undefined)
                      )
                    }}
                  >
                    打开App
                  </Button>

                  <Button
                    className="w-full"
                    variant="secondary"
                    disabled={busy || !inputText.trim()}
                    onClick={async () => {
                      const targets =
                        batchScope === 'all'
                          ? devices
                          : batchScope === 'group'
                            ? devices.filter((d) => (batchGroup === '全部' ? true : d.group === batchGroup))
                            : selectedDevices

                      await runOnTargets(
                        targets,
                        `批量 text(${inputText})`,
                        (d) => window.api?.device?.text?.(d.sn, inputText)
                      )
                    }}
                  >
                    批量输入
                  </Button>
                </div>
              </div>
            )}

            {tab === 'script' && (
              <div className="space-y-3">
                <ScriptRunnerPanel
                  deviceSerials={selectedDevices.map((d) => d.sn)}
                  pushLog={pushLog}
                />
              </div>
            )}

            {tab === 'masterSlave' && (
              <div className="space-y-3">
                <div className="text-sm font-medium">主从控制（占位）</div>
                <div className="text-sm text-muted-foreground">
                  下一步：选择主设备 + 多从设备 + 同步模式（实时/延迟）
                </div>
                <Button className="w-full" onClick={() => doActionMock('开始同步(占位)')}>开始同步</Button>
              </div>
            )}
          </CardContent>
        </Card>

        <Dialog open={logOpen} onOpenChange={setLogOpen}>
          <DialogContent className="max-w-5xl">
            <DialogHeader>
              <DialogTitle>日志</DialogTitle>
              <DialogDescription>展示设备中控的操作日志，可搜索、筛选、复制与导出。</DialogDescription>
            </DialogHeader>

            <div className="flex flex-wrap items-center gap-2">
              <Input
                className="h-8 w-64"
                placeholder="搜索：设备/操作/结果"
                value={logKeyword}
                onChange={(e) => setLogKeyword(e.target.value)}
              />
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={logOnlyError} onChange={(e) => setLogOnlyError(e.target.checked)} />
                仅错误
              </label>

              <Button size="sm" variant="outline" onClick={copyVisibleLogs}>
                复制
              </Button>
              <Button size="sm" variant="outline" onClick={exportVisibleLogs}>
                导出
              </Button>
              <Button size="sm" variant="outline" onClick={() => setLogs([])}>
                清空
              </Button>
            </div>

            <div className="max-h-[60vh] overflow-auto rounded border p-2">
              <div className="grid grid-cols-12 gap-2 text-xs font-medium pb-2 border-b">
                <div className="col-span-2">时间</div>
                <div className="col-span-3">设备</div>
                <div className="col-span-5">操作</div>
                <div className="col-span-2">结果</div>
              </div>
              <div className="divide-y">
                {visibleLogs.map((l, idx) => (
                  <div key={idx} className="grid grid-cols-12 gap-2 text-xs py-2">
                    <div className="col-span-2 text-muted-foreground">{l.time}</div>
                    <div className="col-span-3">{l.device}</div>
                    <div className="col-span-5 text-muted-foreground">{l.action}</div>
                    <div className="col-span-2 break-words">{l.result}</div>
                  </div>
                ))}
                {visibleLogs.length === 0 && <div className="text-sm text-muted-foreground py-4">暂无日志</div>}
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  )
}
