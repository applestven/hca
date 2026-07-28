import { lazy } from 'react'
import { createHashRouter, Navigate } from 'react-router-dom'
import AppLayout from '@/layouts/AppLayout'

const Login = lazy(() => import('@/views/login'))
const Home = lazy(() => import('@/views/home'))
const Version = lazy(() => import('@/views/version'))
const DeviceControl = lazy(() => import('@/views/device-control'))
const Onboarding = lazy(() => import('@/views/onboarding'))

const router = createHashRouter([
    {
        path: '/',
        element: <AppLayout />,
        children: [
            {
                index: true,
                element: <Navigate to="/device-control" replace />
            },
            {
                path: 'device-control',
                element: <DeviceControl />
            },
            {
                path: 'home',
                element: <Home />
            },
            {
                path: 'onboarding',
                element: <Onboarding />
            },
            {
                path: 'login',
                element: <Login />
            },
            {
                path: 'version',
                element: <Version />
            }
        ]
    }
])

export default router
