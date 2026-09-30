import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const configuredBase = mode === 'development' ? '/' : (env.VITE_BASE_PATH || '/erp/')
  const base = configuredBase.endsWith('/') ? configuredBase : `${configuredBase}/`
  return {
    base,
    plugins: [react()],
    // 登录校验要求 Origin 与 Host 一致，开发代理保留浏览器原始 Host。
    server: { port: 5173, proxy: { '/api': { target: 'http://localhost:8000', changeOrigin: false } } },
  }
})
