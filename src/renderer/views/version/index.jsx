'use client'

import { useEffect, useState } from 'react'
import UpdaterPanel from '@/components/UpdaterPanel'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

export default function VersionPage() {
    const [appVersion, setAppVersion] = useState('')

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

    return (
        <div className="w-full p-4">
            <Card className="max-w-3xl">
                <CardHeader>
                    <CardTitle>版本</CardTitle>
                    <CardDescription>
                        软件版本：{appVersion ? `v${appVersion}` : '—'}
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    <UpdaterPanel showShell={false} />
                </CardContent>
            </Card>
        </div>
    )
}
