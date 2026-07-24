'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
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
const AUTO_RECONNECT_COOLDOWN_MS = 20000

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

function mapAdbDevices(list) {
  return (list || []).map((d) => {
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
}

export default function DeviceControlPage() {
  const [devices, setDevices] = useState([])
  const [selectedIds, setSelectedIds] = useState(() => new Set())
  const [activeDeviceId, setActiveDeviceId] = useState(null)
  const [filterGroup, setFilterGroup] = useState('全部')
  const [keyword, setKeyword] = useState('')

  // WiFi 连接（输入 IP 即存本地；有配对码走 pair，无则直接 connect；端口共用）
  const [wifiIp, setWifiIp] = useState('')
  const [wifiPort, setWifiPort] = useState('5555')
  const [pairCode, setPairCode] = useState('')
  const [busy, setBusy] = useState(false)

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
  const [autoReconnectBusy, setAutoReconnectBusy] = useState(false)
  const [reconnecting, setReconnecting] = useState(() => new Set())
  const reconnectCooldownRef = useRef(new Map()) // target -> lastAttemptMs
  const autoReconnectInFlightRef = useRef(false)
  const devicesRef = useRef([])
  const autoReconnectRef = useRef(true)

  const pushLog = (device, action, result) => {
    setLogs((prev) => [{ time: nowTime(), device, action, result }, ...prev].slice(0, 500))
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
      await loadDevices({ silent: true }).catch(() => {})
    }
  }

  const loadDevices = async ({ silent = false } = {}) => {
    if (!silent) setBusy(true)
    try {
      const list = await window.api?.device?.list?.()
      const mapped = mapAdbDevices(list)
      devicesRef.current = mapped
      setDevices(mapped)
      if (!silent) pushLog('系统', '刷新设备列表', `ok(${mapped.length})`)
      return mapped
    } catch (e) {
      if (!silent) pushLog('系统', '刷新设备列表', e?.message || String(e))
      throw e
    } finally {
      if (!silent) setBusy(false)
    }
  }

  const tryAutoReconnect = async (mappedDevices) => {
    if (!autoReconnectRef.current) return
    if (autoReconnectInFlightRef.current) return
    if (!window.api?.device) return

    const now = Date.now()
    const cooldown = reconnectCooldownRef.current

    const offlineWifi = (mappedDevices || [])
      .filter((d) => d.status !== 'online' && String(d.sn || '').includes(':'))
      .map((d) => d.sn)

    let knownTargets = []
    try {
      const known = (await window.api.device.listKnownWifi?.()) || []
      const onlineSet = new Set(
        (mappedDevices || []).filter((d) => d.status === 'online').map((d) => d.sn)
      )
      knownTargets = known
        .map((x) => x?.target)
        .filter((t) => t && t.includes(':') && !onlineSet.has(t))
    } catch {
      // ignore
    }

    const targets = Array.from(new Set([...offlineWifi, ...knownTargets])).filter((t) => {
      const last = cooldown.get(t) || 0
      return now - last >= AUTO_RECONNECT_COOLDOWN_MS
    })

    if (!targets.length) return

    autoReconnectInFlightRef.current = true
    setAutoReconnectBusy(true)
    for (const t of targets) cooldown.set(t, now)

    try {
      const results = await window.api.device.connectMany?.(targets, { concurrency: 4 })
      const ok = (results || []).filter((x) => x.ok).length
      if ((results || []).length > 0) {
        pushLog('系统', '自动重连', `ok=${ok}/${(results || []).length}`)
      }
      await loadDevices({ silent: true }).catch(() => {})
    } catch (e) {
      pushLog('系统', '自动重连', e?.message || String(e))
    } finally {
      autoReconnectInFlightRef.current = false
      setAutoReconnectBusy(false)
    }
  }

  const connectWifi = async () => {
    const ip = wifiIp.trim()
    const port = Number(String(wifiPort).trim() || '5555')
    const code = pairCode.trim()

    if (!ip) {
      pushLog('系统', '添加WiFi设备', '请输入IP')
      return
    }
    if (!Number.isFinite(port) || port <= 0) {
      pushLog('系统', '添加WiFi设备', '请输入有效端口')
      return
    }

    setBusy(true)
    const action = code
      ? `adb pair ${ip}:${port} **** → adb connect ${ip}:${port}`
      : `adb connect ${ip}:${port}`
    pushLog('系统', action, '...')

    try {
      const r = await window.api?.device?.addWifi?.({
        ip,
        port,
        pairCode: code || undefined
      })

      if (r?.mode === 'pair') {
        const target = r.connectTarget || `${ip}:${port}`
        const msg = [
          r.pair ? `pair: ${r.pair}` : '',
          r.connect || r.message || '',
          Array.isArray(r.warnings) ? r.warnings.join(' ') : ''
        ]
          .filter(Boolean)
          .join('\n')
        pushLog('系统', `配对并连接 ${target}`, msg || 'ok')
      } else {
        pushLog('系统', `adb connect ${ip}:${port}`, r?.message || 'ok')
      }

      await loadDevices({ silent: true })
    } catch (e) {
      pushLog('系统', action, e?.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  const onToggleAutoReconnect = async (checked) => {
    setAutoReconnect(checked)
    autoReconnectRef.current = checked
    try {
      await window.api?.device?.setAutoReconnect?.(checked)
      pushLog('系统', '自动重连', checked ? '已开启' : '已关闭')
      if (checked) {
        const mapped = devicesRef.current.length
          ? devicesRef.current
          : await loadDevices({ silent: true })
        await tryAutoReconnect(mapped)
      }
    } catch (e) {
      pushLog('系统', '自动重连设置', e?.message || String(e))
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
    // 进入设备中控时刷新一次权限，避免权限状态滞后
    Promise.resolve(window.api?.permission?.refresh?.())
      .then(() => {
        pushLog('系统', '刷新权限', 'ok')
      })
      .catch((e) => {
        pushLog('系统', '刷新权限', e?.message || String(e))
      })

    let cancelled = false

    ;(async () => {
      try {
        const form = await window.api?.device?.getWifiForm?.()
        if (!cancelled && form) {
          if (form.ip) setWifiIp(form.ip)
          if (form.port) setWifiPort(String(form.port))
          if (form.pairCode != null) setPairCode(String(form.pairCode))
        }
      } catch {
        // ignore
      }

      try {
        const enabled = await window.api?.device?.getAutoReconnect?.()
        if (!cancelled && typeof enabled === 'boolean') {
          setAutoReconnect(enabled)
          autoReconnectRef.current = enabled
        }
      } catch {
        // ignore
      }

      try {
        const boot = await window.api?.device?.autoConnectKnown?.({ concurrency: 4 })
        if (!cancelled && boot && !boot.skipped) {
          const ok = (boot.results || []).filter((x) => x.ok).length
          pushLog('系统', '启动自动连接', `ok=${ok}/${(boot.results || []).length}`)
        }
      } catch (e) {
        if (!cancelled) pushLog('系统', '启动自动连接', e?.message || String(e))
      }

      if (cancelled) return
      const mapped = await loadDevices().catch(() => [])
      if (!cancelled) await tryAutoReconnect(mapped || [])
    })()

    // 轮询刷新：静默，不闪 loading；顺带触发自动重连
    const t = setInterval(async () => {
      try {
        const mapped = await loadDevices({ silent: true })
        await tryAutoReconnect(mapped)
      } catch {
        // ignore
      }
    }, 5000)

    return () => {
      cancelled = true
      clearInterval(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    devicesRef.current = devices
  }, [devices])

  useEffect(() => {
    autoReconnectRef.current = autoReconnect
  }, [autoReconnect])

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

  // 单个设备勾选/取消（修复：之前缺失导致只能全选/无法单选）
  const toggleSelect = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

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
      await loadDevices({ silent: true }).catch(() => {})
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

  const removeDevice = async (d) => {
    setBusy(true)
    try {
      if (String(d.sn || '').includes(':')) {
        await window.api?.device?.disconnect?.(d.sn, { forget: true })
        pushLog(d.name, '断开并遗忘 WiFi', 'ok')
      } else {
        pushLog(d.name, '移除设备(本地UI)', 'ok')
      }
      setDevices((prev) => prev.filter((x) => x.id !== d.id))
      setSelectedIds((prev) => {
        const next = new Set(prev)
        next.delete(d.id)
        return next
      })
      await loadDevices({ silent: true }).catch(() => {})
    } catch (e) {
      pushLog(d.name, '移除设备', e?.message || String(e))
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
      {/* 响应式布局：
          - <sm：单列（避免过窄挤压）
          - sm~lg：两列（设备列表 + 控制面板），隐藏预览
          - >=lg：三列（设备列表 + 预览 + 控制面板）
      */}
      <div className="grid h-full gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-12 auto-rows-fr">
        {/* 左侧：设备列表 */}
        <Card className="h-full flex flex-col min-w-0 sm:col-span-1 lg:col-span-3">
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
                <input
                  type="checkbox"
                  checked={autoReconnect}
                  onChange={(e) => onToggleAutoReconnect(e.target.checked)}
                />
              </label>

              {(() => {
                const offlineWifi = devices.some(
                  (d) => d.status !== 'online' && String(d.sn || '').includes(':')
                )
                const anyOffline = devices.some((d) => d.status !== 'online')
                if (!autoReconnectBusy && !anyOffline) return null
                return (
                  <div className="text-xs text-rose-600">
                    {autoReconnectBusy
                      ? '🔄 自动重连中…'
                      : anyOffline
                        ? `⚠ 有设备离线${autoReconnect && offlineWifi ? '，将按冷却自动重连 WiFi 设备' : ''}`
                        : null}
                  </div>
                )
              })()}

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

                <div className="col-span-8">
                  <Label className="text-xs">配对码（可选）</Label>
                  <Input
                    className="mt-1 h-9"
                    placeholder="不填则直接 connect；填写则先 pair 再 connect"
                    value={pairCode}
                    onChange={(e) => setPairCode(e.target.value)}
                  />
                </div>

                <div className="col-span-8 text-[11px] text-muted-foreground leading-snug">
                  填配对码：<code>adb pair IP:端口</code> → <code>adb connect IP:端口</code>；不填：直接{' '}
                  <code>adb connect</code>。IP 提交后立即写入本地。
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
                      onClick={() => removeDevice(d)}
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

        {/* 中间：预览区（小窗口隐藏，避免挤压导致错乱） */}
        <Card className="hidden lg:flex lg:col-span-6 h-full flex-col min-w-0">
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
        <Card className="h-full flex flex-col min-w-0 sm:col-span-1 lg:col-span-3">
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
                {selectedDevices.length === 0 && (
                  <div className="text-xs text-rose-600">
                    请先在左侧勾选至少 1 台在线设备后再执行脚本。
                  </div>
                )}
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
