import { Outlet } from 'react-router-dom'
import AppHeader from '@/components/AppHeader'

export default function AppLayout() {
    return (
        <div className="min-h-screen w-full flex flex-col bg-gradient-to-r from-blue-400 to-purple-500">
            <AppHeader title="硬控盒子" hideHeaderPaths={['/login']} />
            <main className="flex-1 w-full overflow-auto">
                <Outlet />
            </main>
        </div>
    )
}
