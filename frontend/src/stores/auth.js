import { defineStore } from 'pinia'
import { authApi } from '@/api/index.js'
import { ElMessage } from 'element-plus'
import { clearSession, touchActivity } from '@/utils/session.js'

function routeMatchesMenu(path, menuPath) {
  const p = String(path || '').split('?')[0]
  const m = String(menuPath || '')
  if (!m || !p) return false
  if (p === m) return true
  if (m !== '/' && p.startsWith(`${m}/`)) return true
  return false
}

/** localStorage 中的 user 损坏时不能让整个应用白屏：丢弃坏数据，按未登录处理 */
function readStoredUser() {
  try {
    return JSON.parse(localStorage.getItem('user') || 'null')
  } catch {
    try { localStorage.removeItem('user'); localStorage.removeItem('token') } catch { /* ignore */ }
    return null
  }
}

export const useAuthStore = defineStore('auth', {
  state: () => ({
    user: readStoredUser(),
    token: localStorage.getItem('token') || '',
  }),
  getters: {
    isLoggedIn: s => !!s.token,
    isAdmin: s => s.user?.role === 'ADMIN',
    isDBA: s => ['ADMIN', 'DBA'].includes(s.user?.role),
    /** 是否显示侧栏某菜单 path（与后端 menus 一致） */
    showMenu: s => path => {
      if (!s.user) return false
      if (s.user.role === 'ADMIN') return true
      const menus = s.user.menus
      if (!Array.isArray(menus) || menus.length === 0) return false
      return menus.some(m => routeMatchesMenu(path, m))
    },
  },
  actions: {
    /** 非 ADMIN：路径须在 menus 内；个人设置始终可进 */
    canAccessRoute(path) {
      const p = String(path || '').split('?')[0]
      if (p === '/login') return true
      if (!this.user) return false
      if (this.user.role === 'ADMIN') return true
      if (p === '/settings/profile') return true
      const menus = this.user.menus
      if (!Array.isArray(menus) || menus.length === 0) return false
      return menus.some(m => routeMatchesMenu(p, m))
    },
    async login(credentials) {
      const res = await authApi.login(credentials)
      if (res.code === 200) {
        this.token = res.data.token
        this.user  = res.data.user
        localStorage.setItem('token', this.token)
        localStorage.setItem('user',  JSON.stringify(this.user))
        touchActivity()
        return true
      }
      ElMessage.error(res.msg)
      return false
    },
    async logout() {
      await authApi.logout().catch(() => {})
      this.token = ''
      this.user  = null
      clearSession()
    },
    async refreshProfile() {
      const res = await authApi.profile()
      if (res.code === 200) {
        this.user = { ...this.user, ...res.data }
        localStorage.setItem('user', JSON.stringify(this.user))
      }
    },
  },
})
