import { lazy } from 'react'
import { createHashRouter } from 'react-router-dom'
import AppLayout from '@/layouts/AppLayout'

const Login = lazy(() => import('@/views/login'))
const Home = lazy(() => import('@/views/home'))

const router = createHashRouter([
    {
        path: '/',
        element: <AppLayout />,
        children: [
            {
                index: true,
                element: <Home />
            },
            {
                path: 'login',
                element: <Login />
            }
        ]
    }
])

export default router
