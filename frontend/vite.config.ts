import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// Both ports are moved off the usual defaults, which collide often: 8000 is a
// common backend port and 5173 is Vite's, so any other project already running
// would take them. Override either with an env var.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const backendPort = env.CONVERTER_PORT || '8080'
  const uiPort = Number(env.CONVERTER_UI_PORT || '5180')
  return {
    plugins: [react()],
    server: {
      port: uiPort,
      // Fail loudly instead of silently drifting to another port, so the URL
      // printed on startup is always the one that works.
      strictPort: true,
      proxy: {
        '/api': { target: `http://127.0.0.1:${backendPort}`, changeOrigin: true },
      },
    },
    preview: { port: uiPort },
    build: { outDir: 'dist', sourcemap: false },
  }
})
