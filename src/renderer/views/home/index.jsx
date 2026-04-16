'use client'

import { useState } from 'react'
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Alert, AlertDescription } from "@/components/ui/alert"
// import UpdaterPanel from '@/components/UpdaterPanel'

export default function LoginPage() {
    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    const [error, setError] = useState('')

    const handleSubmit = (e) => {
        e.preventDefault()
        setError('')

        if (!email || !password) {
            setError('请填写所有字段')
            return
        }

        // 这里添加您的登录逻辑
        console.log('登录尝试', { email, password })
    }

    return (
        <div className="min-h-screen flex items-center justify-center w-[100vw] bg-gradient-to-r to-purple-500 from-blue-400">
            
            首页内容
            {/* <UpdaterPanel /> */}
        </div>
    )
}