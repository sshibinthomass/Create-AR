import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// Port 8000 is a common collision on developer machines, so the backend
// defaults to 8080 and both halves read the same override.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const backendPort = env.CONVERTER_PORT || '8080'
  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        '/api': { target: `http://127.0.0.1:${backendPort}`, changeOrigin: true },
      },
    },
    build: { outDir: 'dist', sourcemap: false },
  }
})
