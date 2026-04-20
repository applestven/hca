import './assets/main.css'

import React from 'react'
import ReactDOM from 'react-dom/client'
import { RouterProvider } from 'react-router-dom'
import router from './router'
import { ConfigProvider } from 'antd'
import zhCN from 'antd/es/locale/zh_CN'
import { MessageContextHolder, ModalContextHolder } from '@/components/common'

// 应用持久化主题（无需进入“版本”页）
;(async () => {
  try {
    const r = await window.api?.theme?.get?.()
    const bg = r?.theme?.background || 'default'
    const gradient = typeof r?.theme?.gradient === 'boolean' ? r.theme.gradient : true
    document.documentElement.dataset.themeBg = bg
    document.documentElement.dataset.themeGradient = gradient ? 'on' : 'off'
  } catch {
    document.documentElement.dataset.themeBg = document.documentElement.dataset.themeBg || 'default'
    document.documentElement.dataset.themeGradient = document.documentElement.dataset.themeGradient || 'on'
  }
})()

ReactDOM.createRoot(document.getElementById('root')).render(
  // <React.StrictMode>
  //   <App />
  // </React.StrictMode>
  <ConfigProvider
    locale={zhCN}
    form={{ colon: false }}
    // autoInsertSpaceInButton={false}
    input={{
      autoComplete: 'off'
    }}
    theme={{
      token: {
        controlHeight: 34
      },
      components: {
        Menu: {
          padding: 28
        },
        Descriptions: {
          fontSize: 22,
          colorTextTertiary: '#333'
        },
        Layout: {
          colorBgHeader: '#fff'
        },
        Breadcrumb: {
          colorBgTextHover: '#fff'
        }
      }
    }}
  >
    <RouterProvider router={router} />
    <MessageContextHolder />
    <ModalContextHolder />
  </ConfigProvider>
)
