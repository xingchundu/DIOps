/**
 * 登录会话：统一的清理 / 跳转登录 / 无操作超时退出。
 *
 * - 无操作超时：默认 10 分钟（VITE_IDLE_TIMEOUT_MIN 可改）。鼠标、键盘、点击、滚动、触摸都算“操作”；
 *   后台定时刷新（告警角标、仪表盘轮询）不算，所以不会因轮询而永不过期。
 * - 多标签页共享最近操作时间（localStorage），任一标签页有操作，其他标签页都不会退出；任一标签页退出，其它标签页同步回到登录页。
 * - 关闭浏览器超过超时时间后再打开：路由守卫发现已超时，直接要求重新登录。
 * - 到期前 60 秒弹出提醒，有任何操作即续期。
 */
import { ElNotification } from 'element-plus'

export const IDLE_TIMEOUT_MS = Math.max(1, Number(import.meta.env.VITE_IDLE_TIMEOUT_MIN || 10)) * 60 * 1000
const WARN_BEFORE_MS = 60 * 1000
const KEY_ACTIVITY = 'lastActivity'
const SESSION_KEYS = ['token', 'user', KEY_ACTIVITY]
const EVENTS = ['mousedown', 'mousemove', 'keydown', 'wheel', 'scroll', 'touchstart', 'click']

let redirecting = false

export function touchActivity() {
  try { localStorage.setItem(KEY_ACTIVITY, String(Date.now())) } catch { /* 隐私模式等 */ }
}

export function lastActivity() {
  const v = Number(localStorage.getItem(KEY_ACTIVITY) || 0)
  return Number.isFinite(v) ? v : 0
}

export function isIdleExpired() {
  const t = lastActivity()
  return t > 0 && Date.now() - t > IDLE_TIMEOUT_MS
}

/** 只清登录相关的键（原来 localStorage.clear() 会把用户的界面偏好、记住的用户名一起清掉） */
export function clearSession() {
  for (const k of SESSION_KEYS) localStorage.removeItem(k)
}

/**
 * 回到登录页并带上原页面与原因（idle：无操作超时；expired：登录失效；logout：主动退出）。
 * 用整页跳转，确保内存中的 store、定时器全部清掉。
 */
export function redirectToLogin(reason = 'expired') {
  if (redirecting) return
  redirecting = true
  clearSession()
  const here = window.location.pathname + window.location.search
  const q = new URLSearchParams()
  if (reason) q.set('reason', reason)
  if (here && !here.startsWith('/login')) q.set('redirect', here)
  window.location.replace(`/login${q.toString() ? `?${q}` : ''}`)
}

let timer = null
let warned = null
let lastWrite = 0

function onActivity() {
  const now = Date.now()
  // 节流：mousemove 很频繁，2 秒写一次即可
  if (now - lastWrite > 2000) {
    lastWrite = now
    touchActivity()
  }
  if (warned) { warned.close(); warned = null }
}

function onStorage(e) {
  // 其它标签页退出 / 登录态被清
  if (e.key === 'token' && !e.newValue) redirectToLogin('')
}

/**
 * 启动无操作检测（在主布局挂载时调用）。onTimeout 负责调用后端退出接口等收尾。
 * @returns 停止函数
 */
export function startIdleWatch(onTimeout) {
  stopIdleWatch()
  touchActivity()
  EVENTS.forEach((e) => window.addEventListener(e, onActivity, { passive: true, capture: true }))
  window.addEventListener('storage', onStorage)
  timer = setInterval(async () => {
    if (!localStorage.getItem('token')) return redirectToLogin('')
    const idle = Date.now() - lastActivity()
    if (idle >= IDLE_TIMEOUT_MS) {
      stopIdleWatch()
      try { await onTimeout?.() } catch { /* 退出接口失败不影响回到登录页 */ }
      redirectToLogin('idle')
    } else if (idle >= IDLE_TIMEOUT_MS - WARN_BEFORE_MS && !warned) {
      warned = ElNotification({
        title: '即将自动退出',
        message: `已 ${Math.round(idle / 60000)} 分钟没有操作，1 分钟内无操作将退出登录。移动鼠标或按任意键即可继续使用。`,
        type: 'warning',
        duration: 0,
      })
    }
  }, 5000)
  return stopIdleWatch
}

export function stopIdleWatch() {
  if (timer) { clearInterval(timer); timer = null }
  EVENTS.forEach((e) => window.removeEventListener(e, onActivity, { capture: true }))
  window.removeEventListener('storage', onStorage)
  if (warned) { warned.close(); warned = null }
}
