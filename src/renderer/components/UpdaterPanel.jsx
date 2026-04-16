import React, { useEffect, useMemo, useState } from 'react'
import { Button } from './ui/button'
import { Card, CardContent, CardHeader, CardTitle } from './ui/card'

const humanBytes = (bytes) => {
    if (!Number.isFinite(bytes)) return ''
    const units = ['B', 'KB', 'MB', 'GB']
    let v = bytes
    let i = 0
    while (v >= 1024 && i < units.length - 1) {
        v /= 1024
        i++
    }
    return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

export default function UpdaterPanel() {
    const hasUpdater = useMemo(() => typeof window !== 'undefined' && window.api?.updater, [])
    const [mode, setMode] = useState('ui')
    const [policy, setPolicy] = useState(null)
    const [status, setStatus] = useState('idle')
    const [message, setMessage] = useState('')
    const [info, setInfo] = useState(null)
    const [progress, setProgress] = useState(null)

    useEffect(() => {
        if (!hasUpdater) return
        Promise.resolve(window.api.updater.mode?.()).then((m) => m && setMode(m)).catch(() => { })
        Promise.resolve(window.api.updater.policy?.()).then((p) => p && setPolicy(p)).catch(() => { })
    }, [hasUpdater])

    useEffect(() => {
        if (!hasUpdater) return

        const unsub = [
            window.api.updater.on('update:checking', () => {
                setStatus('checking')
                setMessage('正在检查更新…')
            }),
            window.api.updater.on('update:available', (i) => {
                setStatus('available')
                setInfo(i)
                setMessage(`发现新版本：${i?.version ?? ''}`)
            }),
            window.api.updater.on('update:not-available', () => {
                setStatus('not-available')
                setMessage('当前已是最新版本')
            }),
            window.api.updater.on('update:error', (err) => {
                setStatus('error')
                setMessage(String(err || 'unknown error'))
            }),
            window.api.updater.on('update:download-progress', (p) => {
                setStatus('downloading')
                setProgress(p)
                const percent = Number.isFinite(p?.percent) ? `${p.percent.toFixed(1)}%` : ''
                const spd = humanBytes(p?.bytesPerSecond)
                setMessage(`下载中 ${percent} ${spd ? `(${spd}/s)` : ''}`)
            }),
            window.api.updater.on('update:downloaded', (i) => {
                setStatus('downloaded')
                setInfo(i)
                setMessage('更新已下载，点击安装重启')
            })
        ]

        return () => unsub.forEach((fn) => fn && fn())
    }, [hasUpdater])

    if (!hasUpdater) return null
    if (mode === 'force') return null

    const onCheck = async () => {
        try {
            await window.api.updater.check()
        } catch (e) {
            setStatus('error')
            setMessage(String(e))
        }
    }

    const onDownload = async () => {
        try {
            await window.api.updater.download()
        } catch (e) {
            setStatus('error')
            setMessage(String(e))
        }
    }

    const onInstall = async () => {
        try {
            await window.api.updater.install()
        } catch (e) {
            setStatus('error')
            setMessage(String(e))
        }
    }

    return (
        <Card className="mt-4">
            <CardHeader>
                <CardTitle>应用更新（{mode}）</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
                {policy?.message ? <div className="text-sm">{String(policy.message)}</div> : null}
                <div className="text-sm text-muted-foreground">状态：{status}</div>
                {message ? <div className="text-sm">{message}</div> : null}
                {info?.releaseNotes ? (
                    <pre className="max-h-40 overflow-auto rounded bg-muted p-2 text-xs">{String(info.releaseNotes)}</pre>
                ) : null}
                {progress ? (
                    <div className="text-xs text-muted-foreground">
                        已下载：{humanBytes(progress?.transferred)} / {humanBytes(progress?.total)}
                    </div>
                ) : null}
                <div className="flex flex-wrap gap-2">
                    <Button variant="outline" onClick={onCheck}>
                        检查更新
                    </Button>
                    <Button onClick={onDownload} disabled={status !== 'available'}>
                        下载更新
                    </Button>
                    <Button variant="destructive" onClick={onInstall} disabled={status !== 'downloaded'}>
                        安装并重启
                    </Button>
                </div>
            </CardContent>
        </Card>
    )
}
