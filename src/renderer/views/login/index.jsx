'use client'

import { useState } from 'react'
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Alert, AlertDescription } from "@/components/ui/alert"

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
            <Card className="w-full max-w-md">
                <CardHeader>
                    <CardTitle className="text-2xl font-bold">欢迎登录</CardTitle>
                    <CardDescription>请输入您的账号信息</CardDescription>
                </CardHeader>
                <CardContent>
                    <form onSubmit={handleSubmit} className="space-y-4">
                        <div className="space-y-2">
                            <Label htmlFor="email">邮箱</Label>
                            <Input
                                id="email"
                                type="email"
                                placeholder="请输入您的邮箱"
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                required
                            />
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="password">密码</Label>
                            <Input
                                id="password"
                                type="password"
                                placeholder="请输入您的密码"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                required
                            />
                        </div>
                        {error && (
                            <Alert variant="destructive">
                                <AlertDescription>{error}</AlertDescription>
                            </Alert>
                        )}
                        <Button type="submit" className="w-full">
                            登录
                        </Button>
                    </form>
                </CardContent>
                <CardFooter className="flex justify-center">
                    <a href="#" className="text-sm text-blue-600 hover:underline">
                        忘记密码？
                    </a>
                </CardFooter>
            </Card>
        </div>
    )
}