'use client'

import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

function StepPill({ active, children }) {
  return (
    <div
      className={
        'px-2 py-1 rounded-md text-xs border ' +
        (active ? 'bg-primary text-primary-foreground border-primary' : 'text-muted-foreground')
      }
    >
      {children}
    </div>
  )
}

export default function OnboardingPage() {
  const [step, setStep] = useState(1)
  const [busy, setBusy] = useState(false)

  const [connMode, setConnMode] = useState('usb') // usb | wifi | emulator

  // Step2/3 需要
  const [devices, setDevices] = useState([])
  const [selectedSerial, setSelectedSerial] = useState('')

  // Step3: WiFi
  const [wifiPort, setWifiPort] = useState('5555')
  const [wifiIp, setWifiIp] = useState('')

  // 手动 WiFi connect（直接填手机地址）
  const [manualWifiIp, setManualWifiIp] = useState('')
  const [manualWifiPort, setManualWifiPort] = useState('5555')

  // Android 11+ pairing
  const [pairIp, setPairIp] = useState('')
  const [pairPort, setPairPort] = useState('')
  const [pairCode, setPairCode] = useState('')

  const [result, setResult] = useState({
    usb: null,
    wifi: null,
    atx: null,
    permissions: null
  })

  const summaryReady = useMemo(() => {
    return Boolean(result.usb || result.wifi)
  }, [result])

  const refreshDevices = async () => {
    setBusy(true)
    try {
      const list = await window.api?.device?.list?.()
      const mapped = (list || []).map((d) => ({
        serial: d.serial,
        state: d.state,
        model: d.model,
        ip: d.ip
      }))
      setDevices(mapped)
      if (!selectedSerial) {
        const firstOnline = mapped.find((x) => x.state === 'device')
        if (firstOnline) setSelectedSerial(firstOnline.serial)
      }
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    refreshDevices().catch(() => {})
  }, [])

  const selectedDevice = useMemo(() => {
    return devices.find((d) => d.serial === selectedSerial) || null
  }, [devices, selectedSerial])

  const oneClickWifi = async () => {
    if (!selectedSerial) return
    const port = Number(String(wifiPort).trim() || '5555')

    setBusy(true)
    try {
      const r = await window.api?.onboarding?.enableWifiTcpip?.(selectedSerial, port)
      const ip = r?.ip || ''
      const p = r?.port ?? port

      if (ip) setWifiIp(ip)
      setWifiPort(String(p))

      // 同步到“手动连接”区，方便用户复制/修改
      if (ip) setManualWifiIp(ip)
      setManualWifiPort(String(p))

      setResult((prev) => ({ ...prev, wifi: { mode: 'tcpip', ...r } }))
    } catch (e) {
      setResult((prev) => ({
        ...prev,
        wifi: {
          mode: 'tcpip',
          error: e?.message || String(e),
          tips: ['请确认手机和电脑在同一 WiFi/网段', '检查手机是否已连接 WiFi', '如是 Android 11+，请改用下方“配对模式”']
        }
      }))
    } finally {
      setBusy(false)
      await refreshDevices().catch(() => {})
    }
  }

  const manualConnectWifi = async () => {
    const ip = manualWifiIp.trim()
    const port = Number(String(manualWifiPort).trim() || '5555')
    if (!ip || !port) return

    setBusy(true)
    try {
      const r = await window.api?.device?.connectWifi?.(ip, port)
      setResult((prev) => ({
        ...prev,
        wifi: {
          mode: 'manual',
          ip,
          port,
          message: typeof r === 'string' ? r : JSON.stringify(r)
        }
      }))
    } catch (e) {
      setResult((prev) => ({
        ...prev,
        wifi: {
          mode: 'manual',
          ip,
          port,
          error: e?.message || String(e),
          tips: ['请确认手机无线调试已开启', '确认端口是否为手机“IP 地址和端口”中的端口（可能不是配对端口）', '检查防火墙是否拦截 ADB 端口']
        }
      }))
    } finally {
      setBusy(false)
      await refreshDevices().catch(() => {})
    }
  }

  const doPairAndConnect = async () => {
    const ip = pairIp.trim()
    const port = Number(String(pairPort).trim())
    const code = pairCode.trim()
    if (!ip || !port || !code) return

    setBusy(true)
    try {
      const r = await window.api?.onboarding?.pairAndConnect?.(ip, port, code)
      setResult((prev) => ({ ...prev, wifi: { mode: 'pair', ...r } }))

      // 方便用户后续手动 connect 到“IP 地址和端口”
      if (ip) setManualWifiIp(ip)

      // 若后端已探测到 connectTarget，则回填端口
      if (r?.connectTarget && String(r.connectTarget).includes(':')) {
        const p2 = String(r.connectTarget).split(':')[1]
        if (p2) setManualWifiPort(String(p2))
      }
    } catch (e) {
      setResult((prev) => ({
        ...prev,
        wifi: {
          mode: 'pair',
          error: e?.message || String(e),
          tips: ['请确认“无线调试”页显示的 IP:端口 与配对码未过期', '部分手机配对端口与连接端口不同：配对成功后仍需在手机页查看“IP 地址和端口”并 connect']
        }
      }))
    } finally {
      setBusy(false)
      await refreshDevices().catch(() => {})
    }
  }

  const checkAtx = async () => {
    if (!selectedSerial) return
    setBusy(true)
    try {
      const r = await window.api?.onboarding?.atxCheck?.(selectedSerial)
      setResult((prev) => ({ ...prev, atx: r }))
    } catch (e) {
      setResult((prev) => ({ ...prev, atx: { ok: false, error: e?.message || String(e) } }))
    } finally {
      setBusy(false)
    }
  }

  const installAtx = async () => {
    if (!selectedSerial) return
    setBusy(true)
    try {
      const r = await window.api?.onboarding?.atxInstall?.(selectedSerial)
      setResult((prev) => ({ ...prev, atx: r }))

      // 安装成功后，顺手再检测一次，刷新状态显示
      if (r?.ok) {
        const ch = await window.api?.onboarding?.atxCheck?.(selectedSerial).catch(() => null)
        if (ch) setResult((prev) => ({ ...prev, atx: ch }))
      }
    } catch (e) {
      setResult((prev) => ({ ...prev, atx: { ok: false, error: e?.message || String(e) } }))
    } finally {
      setBusy(false)
    }
  }

  const checkPermissions = async () => {
    if (!selectedSerial) return
    setBusy(true)
    try {
      const r = await window.api?.onboarding?.permissionCheck?.(selectedSerial)
      setResult((prev) => ({ ...prev, permissions: r }))
    } catch (e) {
      setResult((prev) => ({ ...prev, permissions: { ok: false, error: e?.message || String(e) } }))
    } finally {
      setBusy(false)
    }
  }

  const openDevSettingsTip = () => {
    // 这里只做 UI 指引；真正“打开手机设置”属于设备端能力，不同 ROM 差异很大
    setResult((prev) => ({
      ...prev,
      permissions: {
        ok: false,
        tips: [
          '请在手机上打开：设置 -> 开发者选项 -> USB 调试',
          '首次连接请允许 USB 调试授权弹窗',
          '如需 WiFi 调试，请在开发者选项中开启 无线调试'
        ]
      }
    }))
  }

  const nextDisabled =
    busy ||
    // 仅当走 USB 初始化步骤时，要求必须选中设备
    (step === 2 && connMode === 'usb' && (!devices.length || !selectedDevice))

  return (
    <div className="w-full min-h-[calc(100vh-3rem)] p-4">
      <div className="max-w-4xl mx-auto space-y-3">
        <Card>
          <CardHeader>
            <CardTitle>设备接入向导</CardTitle>
            <CardDescription>按步骤完成 USB/WiFi 接入与自动化环境检测</CardDescription>
            <div className="mt-3 flex flex-wrap gap-2">
              <StepPill active={step === 1}>Step 1 连接方式</StepPill>
              <StepPill active={step === 2}>Step 2 USB 初始化</StepPill>
              <StepPill active={step === 3}>Step 3 WiFi 调试</StepPill>
              <StepPill active={step === 4}>Step 4 自动化环境</StepPill>
              <StepPill active={step === 5}>Step 5 权限检测</StepPill>
              <StepPill active={step === 6}>完成</StepPill>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {step === 1 && (
              <div className="space-y-3">
                <div className="text-sm">请选择连接方式：</div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                  <label className="rounded-lg border p-3 cursor-pointer">
                    <div className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="connMode"
                        checked={connMode === 'usb'}
                        onChange={() => setConnMode('usb')}
                      />
                      <div>
                        <div className="font-medium">USB 连接（推荐）</div>
                        <div className="text-xs text-muted-foreground">稳定、兼容性最好</div>
                      </div>
                    </div>
                  </label>
                  <label className="rounded-lg border p-3 cursor-pointer">
                    <div className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="connMode"
                        checked={connMode === 'wifi'}
                        onChange={() => setConnMode('wifi')}
                      />
                      <div>
                        <div className="font-medium">WiFi 连接（无线调试）</div>
                        <div className="text-xs text-muted-foreground">同网段下更方便</div>
                      </div>
                    </div>
                  </label>
                  <label className="rounded-lg border p-3 cursor-pointer">
                    <div className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="connMode"
                        checked={connMode === 'emulator'}
                        onChange={() => setConnMode('emulator')}
                      />
                      <div>
                        <div className="font-medium">模拟器（自动识别）</div>
                        <div className="text-xs text-muted-foreground">如 emulator-5554</div>
                      </div>
                    </div>
                  </label>
                </div>
              </div>
            )}

            {step === 2 && (
              <div className="space-y-3">
                <div className="text-sm font-medium">USB 初始化（关键）</div>
                <ol className="list-decimal pl-6 text-sm text-muted-foreground space-y-1">
                  <li>打开手机开发者模式</li>
                  <li>打开 USB 调试</li>
                  <li>插入数据线</li>
                  <li>点击【检测设备】</li>
                </ol>

                <div className="flex gap-2">
                  <Button disabled={busy} variant="outline" onClick={refreshDevices}>
                    检测设备
                  </Button>
                  <div className="text-xs text-muted-foreground self-center">
                    {busy ? '检测中…' : ''}
                  </div>
                </div>

                <div className="rounded-lg border p-3">
                  <div className="text-sm font-medium">已识别设备</div>
                  <div className="mt-2 grid grid-cols-1 gap-2">
                    <select
                      className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                      value={selectedSerial}
                      onChange={(e) => setSelectedSerial(e.target.value)}
                    >
                      <option value="">请选择设备</option>
                      {devices.map((d) => (
                        <option key={d.serial} value={d.serial}>
                          {d.model || d.serial} ({d.state})
                        </option>
                      ))}
                    </select>

                    {selectedDevice && (
                      <div className="text-sm">
                        ✔ 设备已识别：{selectedDevice.model || selectedDevice.serial}
                        <div className="text-xs text-muted-foreground">SN: {selectedDevice.serial}</div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {step === 3 && (
              <div className="space-y-4">
                <div className="text-sm font-medium">一键开启 WiFi 调试</div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-base">方案 1（推荐）USB → tcpip → 自动 connect</CardTitle>
                      <CardDescription>
                        需先用 USB 连接并选中设备，然后一键开启无线连接（会自动获取 IP 并回填）
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <div className="grid grid-cols-2 gap-2">
                        <div className="space-y-1">
                          <Label>自动获取到的 IP</Label>
                          <Input value={wifiIp} onChange={(e) => setWifiIp(e.target.value)} placeholder="192.168.x.x" />
                        </div>
                        <div className="space-y-1">
                          <Label>端口</Label>
                          <Input value={wifiPort} onChange={(e) => setWifiPort(e.target.value)} placeholder="5555" />
                        </div>
                      </div>
                      <Button disabled={busy || !selectedSerial} onClick={oneClickWifi}>
                        {busy ? '执行中…' : '一键开启无线连接'}
                      </Button>
                      {result?.wifi?.mode === 'tcpip' && result?.wifi?.message && (
                        <div className="text-xs text-muted-foreground whitespace-pre-wrap">{result.wifi.message}</div>
                      )}
                      {result?.wifi?.mode === 'tcpip' && result?.wifi?.error && (
                        <div className="text-xs text-red-500 whitespace-pre-wrap">
                          {result.wifi.error}
                        </div>
                      )}
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader>
                      <CardTitle className="text-base">方案 2（Android 11+）无线调试配对</CardTitle>
                      <CardDescription>
                        在手机：设置 → 开发者选项 → 无线调试 → 使用配对码配对设备
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                        <div className="space-y-1">
                          <Label>IP</Label>
                          <Input value={pairIp} onChange={(e) => setPairIp(e.target.value)} placeholder="192.168.1.10" />
                        </div>
                        <div className="space-y-1">
                          <Label>端口</Label>
                          <Input value={pairPort} onChange={(e) => setPairPort(e.target.value)} placeholder="37123" />
                        </div>
                        <div className="space-y-1">
                          <Label>配对码</Label>
                          <Input value={pairCode} onChange={(e) => setPairCode(e.target.value)} placeholder="6 位配对码" />
                        </div>
                      </div>
                      <Button disabled={busy || !pairIp || !pairPort || !pairCode} onClick={doPairAndConnect}>
                        {busy ? '配对中…' : '配对并连接'}
                      </Button>

                      {result?.wifi?.mode === 'pair' && result?.wifi?.error && (
                        <div className="text-xs text-red-500 whitespace-pre-wrap">{result.wifi.error}</div>
                      )}
                    </CardContent>
                  </Card>

                  <Card className="md:col-span-2">
                    <CardHeader>
                      <CardTitle className="text-base">手动连接（直接填写手机地址）</CardTitle>
                      <CardDescription>
                        适用于：你已在手机上开启“无线调试”，并已知手机显示的“IP 地址和端口”
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                        <div className="space-y-1">
                          <Label>手机 IP</Label>
                          <Input value={manualWifiIp} onChange={(e) => setManualWifiIp(e.target.value)} placeholder="192.168.1.10" />
                        </div>
                        <div className="space-y-1">
                          <Label>端口</Label>
                          <Input value={manualWifiPort} onChange={(e) => setManualWifiPort(e.target.value)} placeholder="5555 或手机显示端口" />
                        </div>
                      </div>
                      <Button disabled={busy || !manualWifiIp || !manualWifiPort} onClick={manualConnectWifi}>
                        {busy ? '连接中…' : '连接'}
                      </Button>

                      {result?.wifi?.mode === 'manual' && result?.wifi?.message && (
                        <div className="text-xs text-muted-foreground whitespace-pre-wrap">{result.wifi.message}</div>
                      )}
                      {result?.wifi?.mode === 'manual' && result?.wifi?.error && (
                        <div className="text-xs text-red-500 whitespace-pre-wrap">
                          {result.wifi.error}
                          {Array.isArray(result.wifi.tips) && result.wifi.tips.length > 0 && (
                            <div className="mt-2 text-muted-foreground">
                              <div className="font-medium">排查建议：</div>
                              <ul className="list-disc pl-5">
                                {result.wifi.tips.map((t) => (
                                  <li key={t}>{t}</li>
                                ))}
                              </ul>
                            </div>
                          )}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </div>
              </div>
            )}

            {step === 4 && (
              <div className="space-y-3">
                <div className="text-sm font-medium">ATX / uiautomator2 自动安装</div>
                <div className="text-xs text-muted-foreground">
                  安装包位置：请将 <code className="px-1 rounded bg-muted">atx-agent</code> 或{' '}
                  <code className="px-1 rounded bg-muted">atx-agent.exe</code> 放到项目目录 <code className="px-1 rounded bg-muted">resources/</code>
                </div>

                <div className="flex gap-2">
                  <Button disabled={busy || !selectedSerial} variant="outline" onClick={checkAtx}>
                    检测设备环境
                  </Button>
                  <Button disabled={busy || !selectedSerial} onClick={installAtx}>
                    一键安装运行环境
                  </Button>
                </div>

                {result.atx?.ok === true && (
                  <div className="space-y-1">
                    <div className="text-sm text-emerald-700">🟢 自动化环境：已就绪</div>
                    {result.atx?.detail && (
                      <div className="text-xs text-muted-foreground whitespace-pre-wrap">{result.atx.detail}</div>
                    )}
                  </div>
                )}
                {result.atx?.ok === false && (
                  <div className="space-y-1">
                    <div className="text-sm text-rose-600">
                      🔴 自动化环境：未就绪 {result.atx?.error ? `(${result.atx.error})` : ''}
                    </div>
                    {result.atx?.detail && (
                      <div className="text-xs text-muted-foreground whitespace-pre-wrap">{result.atx.detail}</div>
                    )}
                  </div>
                )}
              </div>
            )}

            {step === 5 && (
              <div className="space-y-3">
                <div className="text-sm font-medium">权限检测</div>
                <div className="flex gap-2">
                  <Button disabled={busy || !selectedSerial} variant="outline" onClick={checkPermissions}>
                    权限检测
                  </Button>
                  <Button disabled={busy} variant="secondary" onClick={openDevSettingsTip}>
                    打开设置（提示）
                  </Button>
                </div>

                {result.permissions?.ok === true && (
                  <div className="text-sm text-emerald-700">✔ 权限检测：通过</div>
                )}
                {result.permissions?.ok === false && (
                  <div className="text-sm text-rose-600">❌ 权限检测：未通过 {result.permissions?.error ? `(${result.permissions.error})` : ''}</div>
                )}

                {Array.isArray(result.permissions?.tips) && result.permissions.tips.length > 0 && (
                  <ul className="list-disc pl-6 text-sm text-muted-foreground space-y-1">
                    {result.permissions.tips.map((t, i) => (
                      <li key={i}>{t}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {step === 6 && (
              <div className="space-y-3">
                <div className="text-lg font-semibold">🎉 设备接入完成！</div>
                <div className="rounded-lg border p-3 text-sm">
                  <div>✔ USB：{result.usb ? 'OK' : '待完成'}</div>
                  <div>✔ WiFi：{result.wifi?.ip ? 'OK' : '待完成'}</div>
                  <div>✔ 自动化环境：{result.atx?.ok ? 'OK' : '待完成'}</div>
                </div>

                <div className="flex gap-2">
                  <Button
                    disabled={!summaryReady}
                    onClick={() => {
                      window.location.hash = '#/device-control'
                    }}
                  >
                    进入控制台
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
          <CardFooter className="justify-between">
            <Button variant="outline" disabled={busy || step === 1} onClick={() => setStep((s) => Math.max(1, s - 1))}>
              上一步
            </Button>
            <div className="flex items-center gap-2">
              <Button variant="outline" disabled={busy} onClick={() => refreshDevices()}>
                刷新设备
              </Button>
              <Button
                disabled={nextDisabled || step === 6}
                onClick={() => {
                  setStep((s) => {
                    // WiFi 模式：Step1 -> Step3（跳过 USB 初始化）
                    if (s === 1 && connMode === 'wifi') return 3
                    // 模拟器：也直接进入 WiFi/配对页更合理（后续可单独加模拟器提示）
                    if (s === 1 && connMode === 'emulator') return 3
                    return Math.min(6, s + 1)
                  })
                }}
              >
                下一步
              </Button>
            </div>
          </CardFooter>
        </Card>
      </div>
    </div>
  )
}
