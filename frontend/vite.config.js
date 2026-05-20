import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'

// 开发时后端：frontend/.env.development 可选
// VITE_DEV_PROXY_TARGET — Node API（默认 http://127.0.0.1:3000）
// VITE_SQL_AGENT_DEV_TARGET — SQL 优化 iframe 所用的 Python Agent（默认 http://127.0.0.1:8000）
// 「/api/sql-agent」必须由 Agent 接管；若与同级的「/api」一起打到 Node 而 Node 未启动，会得到 proxy 127.0.0.1:3000 错误。
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const apiTarget = env.VITE_DEV_PROXY_TARGET || 'http://127.0.0.1:3000'
  const sqlAgentTarget =
    env.VITE_SQL_AGENT_DEV_TARGET || env.VITE_SQL_AGENT_URL || 'http://127.0.0.1:8000'

  return {
    plugins: [vue()],
    resolve: { alias: { '@': resolve(__dirname, 'src') } },
    server: {
      port: 5173,
      host: true,
      proxy: {
        '/api/sql-agent': {
          target: sqlAgentTarget,
          changeOrigin: true,
          rewrite: (path) => {
            const s = path.replace(/^\/api\/sql-agent(?=\/|$)/, '')
            return s === '' ? '/' : s
          },
        },
        '/api': { target: apiTarget, changeOrigin: true },
      },
    },
    build: {
      outDir: 'dist',
      chunkSizeWarningLimit: 2000,
      rollupOptions: {
        output: {
          manualChunks: {
            'element-plus': ['element-plus'],
            'echarts': ['echarts'],
            'vendor': ['vue', 'vue-router', 'pinia', 'axios'],
          },
        },
      },
    },
  }
})
