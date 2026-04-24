'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import UpdaterPanel from '@/components/UpdaterPanel'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import permissionTable from '@/config/permission-table.json'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'

function showCnAlert(message) {
  const msg = String(message || '').trim() || '操作失败，请稍后再试。'
  try {
    window.alert(msg)
  } catch (e) {
    // ignore
  }
}

function formatPermissionValue(p) {
  if (!p || typeof p !== 'object') return '无'
  if (p.type === 'lifetime') return '永久'
  if (p.type === 'monthly' || p.type === 'yearly') return p.expireDate ? `有效期至 ${p.expireDate}` : '订阅'
  if (p.type === 'count') return `剩余 ${Number(p.remaining ?? 0)} 次`
  return '无'
}

function getFeatureByKey(permission, key) {
  if (!key) return null
  const features = permission?.data?.features
  if (!features || typeof features !== 'object') return null
  return features[key] || null
}

export default function VersionPage() {
  const [appVersion, setAppVersion] = useState('')
  const [themeBg, setThemeBg] = useState('default')
  const [themeGradient, setThemeGradient] = useState(true)

  const [machineId, setMachineId] = useState('')
  const [permission, setPermission] = useState(null)
  const [activateOpen, setActivateOpen] = useState(false)
  const [activateCode, setActivateCode] = useState('')
  const [activateBusy, setActivateBusy] = useState(false)

  const [permDialogOpen, setPermDialogOpen] = useState(false)
  const [permRefreshing, setPermRefreshing] = useState(false)
  const permFetchLockRef = useRef(false)

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
    } catch (e) {
      // ignore
    }
  }

  const refreshPermission = useCallback(async () => {
    // 避免并发/重复请求（尤其是弹窗打开触发 + 组件重渲染时）
    if (permFetchLockRef.current) return permission
    permFetchLockRef.current = true

    setPermRefreshing(true)
    try {
      const r = await window.api?.permission?.refresh?.()
      setPermission(r || null)
      return r
    } catch (e) {
      showCnAlert('刷新权限失败，请检查网络后再试。')
      throw e
    } finally {
      setPermRefreshing(false)
      permFetchLockRef.current = false
    }
  }, [permission])

  // 打开权限列表弹窗时自动刷新一次（只触发一次；关闭后重置）
  const permAutoRefreshedRef = useRef(false)
  useEffect(() => {
    if (!permDialogOpen) {
      permAutoRefreshedRef.current = false
      return
    }
    if (permAutoRefreshedRef.current) return
    permAutoRefreshedRef.current = true
    refreshPermission().catch(() => {})
  }, [permDialogOpen, refreshPermission])

  const doActivate = async () => {
    const code = activateCode.trim()
    if (!code) {
      showCnAlert('请输入激活码。')
      return
    }
    setActivateBusy(true)
    try {
      const r = await window.api?.permission?.activate?.(code)
      setPermission(r || null)
      setActivateCode('')
      setActivateOpen(false)
      showCnAlert('激活成功。')
    } catch (e) {
      // 主进程会抛错，这里给用户中文提示（不暴露英文/技术细节）
      showCnAlert('激活失败，请确认激活码正确且未过期。')
      throw e
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
              <Button variant="outline" onClick={() => setPermDialogOpen(true)}>
                权限列表
              </Button>
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

          <Dialog open={permDialogOpen} onOpenChange={setPermDialogOpen}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>权限列表</DialogTitle>
                <DialogDescription>
                  以本地白名单为主展示，按权限Key匹配接口返回的状态；未匹配显示“无”。
                  {permRefreshing ? '（刷新中…）' : ''}
                </DialogDescription>
              </DialogHeader>

              <div className="max-h-[60vh] overflow-auto rounded-md border">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left border-b bg-muted/40">
                      <th className="py-2 px-3">权限</th>
                      <th className="py-2 px-3">状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(permissionTable?.rows || []).map((row) => {
                      const key = row?.key
                      const p = getFeatureByKey(permission, key)
                      return (
                        <tr key={key || row?.name} className="border-b last:border-b-0">
                          <td className="py-2 px-3">{row?.name || key || '-'}</td>
                          <td className="py-2 px-3">{formatPermissionValue(p)}</td>
                        </tr>
                      )
                    })}

                    {(permissionTable?.rows || []).length === 0 && (
                      <tr>
                        <td className="py-3 px-3 text-muted-foreground" colSpan={2}>
                          未配置权限白名单，请维护 `src/renderer/config/permission-table.json`。
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              <DialogFooter>
                <DialogClose asChild>
                  <Button variant="secondary">关闭</Button>
                </DialogClose>
              </DialogFooter>
            </DialogContent>
          </Dialog>

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

          {/* <div className="rounded-lg border p-3">
            <div className="text-sm font-medium mb-2">权限列表</div>
            <div className="overflow-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left border-b">
                    <th className="py-2 pr-2">名称</th>
                    <th className="py-2 pr-2">权限Key</th>
                    <th className="py-2 pr-2">状态</th>
                    <th className="py-2 pr-2">说明</th>
                  </tr>
                </thead>
                <tbody>
                  {(permissionTable?.rows || []).map((row) => {
                    const key = row?.key
                    const p = key ? permission?.data?.features?.[key] : null
                    return (
                      <tr key={key} className="border-b last:border-b-0">
                        <td className="py-2 pr-2">{row?.name || '-'}</td>
                        <td className="py-2 pr-2 font-mono">{key || '-'}</td>
                        <td className="py-2 pr-2">{formatPermissionValue(p)}</td>
                        <td className="py-2 pr-2 text-muted-foreground">{row?.desc || '-'}</td>
                      </tr>
                    )
                  })}
                  {(permissionTable?.rows || []).length === 0 && (
                    <tr>
                      <td className="py-2 text-muted-foreground" colSpan={4}>
                        未配置权限白名单，请维护 `src/renderer/config/permission-table.json`。
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="text-xs text-muted-foreground mt-2">
              仅展示白名单中维护的权限Key；接口返回的其它权限不会在此处显示。
            </div>
          </div> */}
        </CardContent>
      </Card>
    </div>
  )
}
