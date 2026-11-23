import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import fs from 'fs'
import { resolve } from 'path'

// 开发时后端：frontend/.env.development 可选
// VITE_DEV_PROXY_TARGET — Node API（默认 http://127.0.0.1:3000）
// VITE_HTTPS=0 — 关闭开发环境 HTTPS（默认启用，需 ../certs/server.key 与 server.crt）
// 「/api/sql-agent」与线上一致：经 Java:3000 → Node:3001 代理到 Python Agent（鉴权 + 内部令牌），勿在 dev 直连 :8000。

function loadHttpsOptions(env) {
  if (env.VITE_HTTPS === '0') return undefined
  const certDir = resolve(__dirname, '../certs')
  const keyPath = resolve(certDir, 'server.key')
  const certPath = resolve(certDir, 'server.crt')
  if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
    console.warn('[vite] HTTPS certs missing — run scripts/gen-ssl-cert.ps1 or gen-ssl-cert.sh first')
    return undefined
  }
  return {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath),
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const apiTarget = env.VITE_DEV_PROXY_TARGET || 'http://127.0.0.1:3000'
  const https = loadHttpsOptions(env)

  return {
    plugins: [vue()],
    resolve: { alias: { '@': resolve(__dirname, 'src') } },
    server: {
      port: 5173,
      host: true,
      https,
      proxy: {
        '/api': { target: apiTarget, changeOrigin: true },
      },
    },
    preview: {
      port: 4173,
      host: true,
      https,
      proxy: {
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
