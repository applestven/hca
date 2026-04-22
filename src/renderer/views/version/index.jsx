'use client'

import { useEffect, useState } from 'react'
import UpdaterPanel from '@/components/UpdaterPanel'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export default function VersionPage() {
  const [appVersion, setAppVersion] = useState('')
  const [themeBg, setThemeBg] = useState('default')
  const [themeGradient, setThemeGradient] = useState(true)

  const [machineId, setMachineId] = useState('')
  const [permission, setPermission] = useState(null)
  const [activateOpen, setActivateOpen] = useState(false)
  const [activateCode, setActivateCode] = useState('')
  const [activateBusy, setActivateBusy] = useState(false)

  useEffect(() => {
    let mounted = true
    Promise.resolve(window.api?.app?.getVersion?.())
      .then((v) => {
        if (!mounted) return
        if (v) setAppVersion(String(v))
      })
      .catch(() => {})
    return () => {
      mounted = false
    }
  }, [])

  // 读取持久化主题
  useEffect(() => {
    let mounted = true
    Promise.resolve(window.api?.theme?.get?.())
      .then((r) => {
        if (!mounted) return
        const bg = r?.theme?.background || 'default'
        const gradient = typeof r?.theme?.gradient === 'boolean' ? r.theme.gradient : true
        setThemeBg(bg)
        setThemeGradient(gradient)
      })
      .catch(() => {})
    return () => {
      mounted = false
    }
  }, [])

  // 应用到 DOM（驱动全局样式）
  useEffect(() => {
    document.documentElement.dataset.themeBg = themeBg || 'default'
    document.documentElement.dataset.themeGradient = themeGradient ? 'on' : 'off'
  }, [themeBg, themeGradient])

  // 拉 machineId + 权限（用于展示）
  useEffect(() => {
    let mounted = true
    Promise.resolve(window.api?.permission?.getMachineId?.())
      .then((r) => {
        if (!mounted) return
        setMachineId(r?.machineId || '')
      })
      .catch(() => {})

    Promise.resolve(window.api?.permission?.refresh?.())
      .then((r) => {
        if (!mounted) return
        setPermission(r || null)
      })
      .catch(() => {})

    return () => {
      mounted = false
    }
  }, [])

  const saveTheme = async (next) => {
    try {
      const saved = await window.api?.theme?.set?.(next)
      const t = saved?.theme
      if (t?.background) setThemeBg(t.background)
      if (typeof t?.gradient === 'boolean') setThemeGradient(t.gradient)
    } catch {}
  }

  const refreshPermission = async () => {
    const r = await window.api?.permission?.refresh?.()
    setPermission(r || null)
    return r
  }

  const doActivate = async () => {
    const code = activateCode.trim()
    if (!code) return
    setActivateBusy(true)
    try {
      const r = await window.api?.permission?.activate?.(code)
      setPermission(r || null)
      setActivateCode('')
      setActivateOpen(false)
    } finally {
      setActivateBusy(false)
    }
  }

  const copyMachineId = async () => {
    if (!machineId) return
    try {
      await navigator.clipboard.writeText(machineId)
    } catch {
      // ignore
    }
  }

  return (
    <div className="w-full p-4">
      <Card className="max-w-3xl">
        <CardHeader>
          <CardTitle>版本</CardTitle>
          <CardDescription>软件版本：{appVersion ? `v${appVersion}` : '—'}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <UpdaterPanel showShell={false} />

          <div className="rounded-lg border p-4 space-y-3">
            <div className="text-sm font-medium">机器码/授权</div>

            <div className="space-y-1">
              <div className="flex gap-2">
                <Input readOnly value={machineId || '—'} className="font-mono" />
                <Button variant="outline" onClick={copyMachineId} disabled={!machineId}>
                  复制
                </Button>
              </div>
              <div className="text-xs text-muted-foreground">用于购买/绑定激活码（当前仅对“脚本”功能做权限校验）。</div>
            </div>

            <div className="flex items-center gap-2">
              <Button variant="secondary" onClick={() => setActivateOpen((v) => !v)}>
                激活码
              </Button>
              <Button variant="outline" onClick={refreshPermission}>
                刷新权限
              </Button>
              <div className="text-xs text-muted-foreground">
                脚本权限：
                <code className="px-1 rounded bg-muted">
                  {(() => {
                    // 当前按“脚本 key”做权限控制；这里展示示例脚本 soul 的权限摘要
                    const f = permission?.data?.features?.soul
                    if (!f) return '无'
                    if (f.type === 'lifetime') return '买断'
                    if (f.type === 'monthly' || f.type === 'yearly') return `${f.type}:${f.expireDate || '-'}`
                    if (f.type === 'count') return `count:${f.remaining ?? 0}`
                    return f.type
                  })()}
                </code>
              </div>
            </div>

            {activateOpen && (
              <div className="grid grid-cols-1 md:grid-cols-4 gap-2 items-end">
                <div className="md:col-span-3 space-y-1">
                  <Label>输入激活码</Label>
                  <Input value={activateCode} onChange={(e) => setActivateCode(e.target.value)} placeholder="请输入激活码" />
                </div>
                <Button className="md:col-span-1" disabled={activateBusy || !activateCode.trim()} onClick={doActivate}>
                  {activateBusy ? '激活中…' : '激活'}
                </Button>
              </div>
            )}
          </div>

          <div className="rounded-lg border p-4 space-y-3">
            <div className="text-sm font-medium">主题（背景）</div>

            <div className="space-y-1">
              <Label>背景色</Label>
              <select
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-slate-900 dark:text-slate-800 shadow-sm"
                value={themeBg}
                onChange={(e) => saveTheme({ background: e.target.value })}
              >
                <option value="default">默认</option>
                <option value="slate">深灰</option>
                <option value="grape">葡萄紫</option>
                <option value="sea">海蓝</option>
                <option value="sunset">落日橙</option>
                <option value="graphite">石墨灰(#1F1F1F)</option>
              </select>
            </div>

            <label className="flex items-center justify-between text-sm">
              <span>启用渐变</span>
              <input
                type="checkbox"
                checked={themeGradient}
                onChange={(e) => saveTheme({ gradient: e.target.checked })}
              />
            </label>

            <div className="text-xs text-muted-foreground">
              勾选后使用渐变背景；取消勾选则使用纯色背景（仍会保留纹理）。
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
