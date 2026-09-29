import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const configuredBase = mode === 'development' ? '/' : (env.VITE_BASE_PATH || '/erp/')
  const base = configuredBase.endsWith('/') ? configuredBase : `${configuredBase}/`
  return {
    base,
    plugins: [react()],
    server: { port: 5173, proxy: { '/api': 'http://localhost:8000' } },
  }
})
