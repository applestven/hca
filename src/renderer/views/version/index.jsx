'use client'

import { useEffect, useState } from 'react'
import UpdaterPanel from '@/components/UpdaterPanel'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'

export default function VersionPage() {
  const [appVersion, setAppVersion] = useState('')
  const [themeBg, setThemeBg] = useState('default')
  const [themeGradient, setThemeGradient] = useState(true)

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

  const saveTheme = async (next) => {
    try {
      const saved = await window.api?.theme?.set?.(next)
      const t = saved?.theme
      if (t?.background) setThemeBg(t.background)
      if (typeof t?.gradient === 'boolean') setThemeGradient(t.gradient)
    } catch {}
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
