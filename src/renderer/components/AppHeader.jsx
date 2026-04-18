import { useEffect, useState, memo, startTransition } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'

const IconMinimize = memo(function IconMinimize(props) {
    return (
        <svg viewBox="0 0 12 12" width="12" height="12" fill="none" {...props}>
            <path d="M2.2 8.2h7.6" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
        </svg>
    )
})

const IconMaximize = memo(function IconMaximize(props) {
    return (
        <svg viewBox="0 0 12 12" width="12" height="12" fill="none" {...props}>
            <rect x="2.3" y="2.3" width="7.4" height="7.4" rx="1" stroke="currentColor" strokeWidth="1" />
        </svg>
    )
})

const IconRestore = memo(function IconRestore(props) {
    return (
        <svg viewBox="0 0 12 12" width="12" height="12" fill="none" {...props}>
            <path d="M4.2 2.8h5v5" stroke="currentColor" strokeWidth="1" />
            <rect x="2.3" y="4.2" width="6.2" height="6.2" rx="1" stroke="currentColor" strokeWidth="1" />
        </svg>
    )
})

const IconClose = memo(function IconClose(props) {
    return (
        <svg viewBox="0 0 12 12" width="12" height="12" fill="none" {...props}>
            <path d="M3 3l6 6M9 3L3 9" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
        </svg>
    )
})

/**
 * 通用标题栏/页眉：
 * - 左侧：业务导航（首页/登录...）
 * - 右侧：窗口控制（三键）
 * - 中间区域可拖动窗口（-webkit-app-region: drag）
 */
export default function AppHeader({ title = 'Electron App', hideHeaderPaths = ['/login'] }) {
    const location = useLocation()
    const navigate = useNavigate()
    const [isMaximized, setIsMaximized] = useState(false)

    const hidden = hideHeaderPaths.includes(location.pathname)

    const refreshMaximized = async () => {
        try {
            const v = await window.api?.window?.isMaximized?.()
            setIsMaximized(Boolean(v))
        } catch {
            // ignore
        }
    }

    useEffect(() => {
        refreshMaximized()
        const onResize = () => refreshMaximized()
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
    }, [])

    const navBtn =
        'h-8 px-3 text-[13px] text-white/90 hover:text-white hover:bg-white/10 active:bg-white/15'

    const winBtn =
        'h-9 w-11 rounded-none text-white/85 hover:text-white hover:bg-white/10 active:bg-white/15 transition-colors'

    const go = (to) => {
        startTransition(() => {
            navigate(to)
        })
    }

    return (
        <header
            className="h-12 w-full flex items-stretch border-b border-white/10 bg-black/10 backdrop-blur"
            style={hidden ? { visibility: 'hidden', pointerEvents: 'none' } : undefined}
            aria-hidden={hidden}
        >
            {/* 左侧：导航（no-drag） */}
            <div className="flex items-center gap-1 pl-2" style={{ WebkitAppRegion: 'no-drag' }}>
                <Button variant="ghost" className={navBtn} onClick={() => go('/')}>首页</Button>
                <Button variant="ghost" className={navBtn} onClick={() => go('/device-control')}>设备中控</Button>
                <Button variant="ghost" className={navBtn} onClick={() => go('/onboarding')}>快速接入向导</Button>
                <Button variant="ghost" className={navBtn} onClick={() => go('/version')}>版本</Button>
                <Button variant="ghost" className={navBtn} onClick={() => go('/login')}>登录</Button>
                <div className="mx-1 h-5 w-px bg-white/15" />
            </div>

            {/* 中间：拖拽区 */}
            <div
                className="flex-1 flex items-center justify-center px-2 text-[12px] text-white/70 select-none"
                style={{ WebkitAppRegion: 'drag' }}
                title={title}
            >
                <span className="truncate max-w-[60%]">{title}</span>
            </div>

            {/* 右侧：窗口控制（no-drag / 贴右） */}
            <div className="flex items-stretch" style={{ WebkitAppRegion: 'no-drag' }}>
                <Button
                    variant="ghost"
                    className={winBtn}
                    onClick={() => window.api?.window?.minimize?.()}
                    aria-label="最小化"
                    title="最小化"
                >
                    <IconMinimize />
                </Button>
                <Button
                    variant="ghost"
                    className={winBtn}
                    onClick={async () => {
                        await window.api?.window?.maximizeToggle?.()
                        refreshMaximized()
                    }}
                    aria-label={isMaximized ? '还原' : '最大化'}
                    title={isMaximized ? '还原' : '最大化'}
                >
                    {isMaximized ? <IconRestore /> : <IconMaximize />}
                </Button>
                <Button
                    variant="ghost"
                    className={
                        winBtn +
                        ' hover:bg-red-500 hover:text-white active:bg-red-600'
                    }
                    onClick={() => window.api?.window?.close?.()}
                    aria-label="关闭"
                    title="关闭"
                >
                    <IconClose />
                </Button>
            </div>
        </header>
    )
}
