import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    resolve: {
      alias: {
        '@m': resolve('src'),
        '@': resolve('src/renderer')
      }
    },
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    resolve: {
      alias: {
        '@m': resolve('src'),
        '@': resolve('src/renderer')
      }
    },
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        '@m': resolve('src'),
        '@': resolve('src/renderer')
      }
    },
    plugins: [react()]
  }
})
