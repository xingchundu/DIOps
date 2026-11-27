<template>
  <div class="login-bg">
    <div class="login-box">
      <!-- Logo -->
      <div class="login-header">
        <div class="logo-icon">🛡️</div>
        <h1>数据库智能平台</h1>
        <p>Database Intelligent Operations Platform</p>
      </div>

      <!-- 授权：无效 / 到期时不能登录，显示机器码并可导入授权 -->
      <div v-if="lic && !lic.loginAllowed" class="license-box">
        <el-alert :title="lic.message" type="error" show-icon :closable="false" />
        <div class="license-mc">
          机器码 <code>{{ lic.machineCode || '-' }}</code>
          <el-button v-if="lic.machineCode" link type="primary" size="small" @click="copyMc">复制</el-button>
        </div>
        <el-button type="primary" plain size="small" @click="licDlg = true">导入授权</el-button>
      </div>
      <el-alert v-else-if="lic && lic.state === 'EXPIRING'" :title="lic.message" type="warning" show-icon :closable="false" class="reason" />

      <!-- 退出原因 -->
      <el-alert v-if="reasonText && !(lic && !lic.loginAllowed)" :title="reasonText" :type="reason === 'logout' ? 'success' : 'warning'" show-icon :closable="false" class="reason" />

      <!-- Login Form -->
      <el-form ref="formRef" :model="form" :rules="rules" size="large" class="login-form" @submit.prevent="handleLogin">
        <el-form-item prop="username">
          <el-input ref="userRef" v-model.trim="form.username" placeholder="请输入用户名" prefix-icon="User" clearable
            autocomplete="username" maxlength="64" @keyup.enter="focusPassword" />
        </el-form-item>
        <el-form-item prop="password">
          <el-input ref="pwdRef" v-model="form.password" type="password" placeholder="请输入密码" prefix-icon="Lock"
            show-password clearable autocomplete="current-password" maxlength="128"
            @keyup.enter="handleLogin" @keydown="checkCaps" @keyup="checkCaps" @blur="capsOn = false" />
        </el-form-item>
        <div v-if="capsOn" class="caps">大写锁定已打开</div>
        <div class="login-opts">
          <el-link v-if="lic && lic.loginAllowed" type="info" :underline="false" class="lic-link" @click="licDlg = true">授权信息</el-link>
          <el-checkbox v-model="remember">记住用户名</el-checkbox>
          <span class="text-gray">{{ idleMinutes }} 分钟无操作将自动退出</span>
        </div>
        <el-form-item>
          <el-button type="primary" class="login-btn" native-type="submit" :loading="loading" :disabled="!!lic && !lic.loginAllowed" @click.prevent="handleLogin">
            {{ loading ? '登录中...' : '登 录' }}
          </el-button>
        </el-form-item>
        <el-form-item v-if="sso.ldapEnabled">
          <el-button class="login-btn" plain :loading="loadingLdap" :disabled="!!lic && !lic.loginAllowed" @click="handleLdapLogin">
            企业 LDAP 登录
          </el-button>
        </el-form-item>
        <el-form-item v-if="sso.oidcEnabled && oidcClientId">
          <el-button class="login-btn" plain :disabled="!!lic && !lic.loginAllowed" @click="goOidc">
            OIDC 单点登录
          </el-button>
        </el-form-item>
      </el-form>
    </div>
    <LicenseDialog v-model="licDlg" @activated="loadLicense" />
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, nextTick } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useAuthStore } from '@/stores/auth.js'
import { authApi, licenseApi } from '@/api/index.js'
import LicenseDialog from '@/components/license/LicenseDialog.vue'
import { ElMessage } from 'element-plus'
import { touchActivity, clearSession, IDLE_TIMEOUT_MS } from '@/utils/session.js'

const router = useRouter()
const route = useRoute()
const auth = useAuthStore()
const formRef = ref()
const userRef = ref()
const pwdRef = ref()
const loading = ref(false)
const loadingLdap = ref(false)
const sso = ref({ ldapEnabled: false, oidcEnabled: false })
const oidcClientId = ref('')
const capsOn = ref(false)
const REMEMBER_KEY = 'login.username'
const remember = ref(!!localStorage.getItem(REMEMBER_KEY))
const idleMinutes = Math.round(IDLE_TIMEOUT_MS / 60000)

const form = reactive({ username: localStorage.getItem(REMEMBER_KEY) || '', password: '' })
const rules = {
  username: [{ required: true, message: '请输入用户名', trigger: 'blur' }],
  password: [{ required: true, message: '请输入密码', trigger: 'blur' }],
}

const lic = ref(null)
const licDlg = ref(false)
async function loadSso() {
  try {
    const r = (await authApi.ssoConfig()).data || {}
    sso.value = { ldapEnabled: !!r.ldapEnabled, oidcEnabled: !!r.oidcEnabled }
    oidcClientId.value = r.oidc?.clientId || ''
  } catch {
    sso.value = { ldapEnabled: false, oidcEnabled: false }
  }
}

function goOidc() {
  const redirect = encodeURIComponent(`${window.location.origin}/login/oidc-callback`)
  authApi.ssoConfig().then(res => {
    const o = res.data?.oidc
    if (!o?.authorizationEndpoint || !o.clientId) return ElMessage.warning('OIDC 未配置完整')
    const url = `${o.authorizationEndpoint}?response_type=code&client_id=${encodeURIComponent(o.clientId)}&redirect_uri=${redirect}&scope=${encodeURIComponent(o.scopes || 'openid profile')}&state=dbops`
    window.location.href = url
  }).catch(() => ElMessage.error('无法获取 OIDC 配置'))
}

async function handleLdapLogin() {
  if (loadingLdap.value) return
  try { await formRef.value.validate() } catch { return }
  loadingLdap.value = true
  try {
    const res = await authApi.ldapLogin({ username: form.username, password: form.password })
    if (res?.data?.token) {
      localStorage.setItem('token', res.data.token)
      localStorage.setItem('user', JSON.stringify(res.data.user))
      touchActivity()
      auth.$patch({ token: res.data.token, user: res.data.user })
      if (remember.value) localStorage.setItem(REMEMBER_KEY, form.username)
      ElMessage.success('LDAP 登录成功')
      await router.replace(safeRedirect())
    } else fail(res?.msg || 'LDAP 登录失败')
  } catch (e) {
    fail(e?.message || 'LDAP 登录失败')
  } finally { loadingLdap.value = false }
}

async function loadLicense() {
  try {
    lic.value = (await licenseApi.status()).data
  } catch {
    lic.value = null   // 服务不可用时不挡登录按钮，由登录接口返回具体错误
  }
}
async function copyMc() {
  try {
    await navigator.clipboard.writeText(lic.value.machineCode)
    ElMessage.success('机器码已复制')
  } catch {
    ElMessage.warning('请手动复制')
  }
}

const reason = computed(() => String(route.query.reason || ''))
const reasonText = computed(() => ({
  idle: `${idleMinutes} 分钟内没有操作，已自动退出，请重新登录`,
  expired: '登录已失效，请重新登录',
  logout: '已安全退出',
  license: '授权无效或已到期',
}[reason.value] || ''))

/** 只允许站内路径，防止 ?redirect=https://evil 之类的开放跳转 */
function safeRedirect() {
  const r = String(route.query.redirect || '')
  if (r.startsWith('/') && !r.startsWith('//') && !r.startsWith('/login')) return r
  return '/dashboard'
}

function focusPassword() {
  if (form.username) pwdRef.value?.focus()
}

function checkCaps(e) {
  if (e && typeof e.getModifierState === 'function') capsOn.value = e.getModifierState('CapsLock')
}

async function handleLogin() {
  if (loading.value) return            // 防止回车 + 点击重复提交
  try {
    await formRef.value.validate()
  } catch {
    return
  }
  loading.value = true
  try {
    const res = await authApi.login({ username: form.username, password: form.password })
    if (res && Number(res.code) === 200 && res.data?.token) {
      localStorage.setItem('token', res.data.token)
      localStorage.setItem('user', JSON.stringify(res.data.user))
      touchActivity()
      auth.$patch({ token: res.data.token, user: res.data.user })
      if (remember.value) localStorage.setItem(REMEMBER_KEY, form.username)
      else localStorage.removeItem(REMEMBER_KEY)
      ElMessage.success('登录成功')
      await router.replace(safeRedirect())
    } else {
      fail(res?.msg || '登录失败')
    }
  } catch (e) {
    if (e?.code === 4031) loadLicense()
    fail(e?.message || '登录失败')
  } finally {
    loading.value = false
  }
}

function fail(msg) {
  ElMessage.error(msg)
  form.password = ''
  nextTick(() => pwdRef.value?.focus())
}

/** 本地 token 是否仍在有效期内（只看 exp，真正的校验由服务端做） */
function tokenStillValid(t) {
  try {
    const p = JSON.parse(atob(String(t).split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
    return !p.exp || p.exp * 1000 > Date.now() + 5000
  } catch { return false }
}

onMounted(() => {
  // 原来无条件 clearSession：localStorage 各标签共享，任一标签打开登录页就把所有标签踢下线。
  // 现在只在“被踢回登录页”（带 reason）或 token 已过期/损坏时清理；本标签仍有效登录则直接回原页面。
  const t = localStorage.getItem('token')
  if (!reason.value && t && tokenStillValid(t) && auth.user) {
    router.replace(safeRedirect())
    return
  }
  clearSession()
  auth.$patch({ token: '', user: null })
  // 授权未通过时不要再请求 SSO 配置：该接口会被 4031 拦截，拦截器又会把登录页整页刷一遍
  loadLicense().then(() => {
    if (!lic.value || lic.value.loginAllowed) loadSso()
  })
  nextTick(() => (form.username ? pwdRef.value : userRef.value)?.focus())
})
</script>

<style scoped>
.login-bg {
  min-height: 100vh;
  background: linear-gradient(135deg, #e8ecf1, #dce1e8, #d0d6e0);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
}
.login-box {
  width: 420px;
  max-width: 100%;
  background: rgba(255,255,255,0.97);
  border-radius: 16px;
  padding: 40px 40px 32px;
  box-shadow: 0 20px 60px rgba(0,0,0,0.12);
}
.login-header { text-align: center; margin-bottom: 24px; }
.logo-icon { font-size: 48px; margin-bottom: 12px; }
.login-header h1 { font-size: 22px; font-weight: 700; color: #1f2329; margin-bottom: 6px; }
.login-header p { font-size: 12px; color: #909399; }
.reason { margin-bottom: 18px; }
.license-box { margin-bottom: 18px; display: flex; flex-direction: column; gap: 8px; align-items: flex-start; }
.license-box .el-alert { width: 100%; }
.license-mc { font-size: 13px; color: #606266; }
.license-mc code { font-size: 15px; font-weight: 600; letter-spacing: 1px; color: #1f2329; margin: 0 4px; }
.lic-link { font-size: 12px; }
.login-form .el-form-item { margin-bottom: 20px; }
.caps { margin: -12px 0 10px; font-size: 12px; color: #e6a23c; }
.login-opts { display: flex; justify-content: space-between; align-items: center; margin: -6px 0 16px; font-size: 12px; }
.text-gray { color: #909399; }
.login-btn { width: 100%; height: 44px; font-size: 16px; letter-spacing: 4px; border-radius: 8px; }
@media (max-width: 480px) { .login-box { padding: 28px 20px 20px; } }
</style>
