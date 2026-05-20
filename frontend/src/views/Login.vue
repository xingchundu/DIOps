<template>
  <div class="login-bg">
    <div class="login-box">
      <!-- Logo -->
      <div class="login-header">
        <div class="logo-icon">🛡️</div>
        <h1>数据库智能平台</h1>
        <p>Database Intelligent Operations Platform</p>
      </div>

      <!-- Login Form -->
      <el-form ref="formRef" :model="form" :rules="rules" size="large" class="login-form" @keyup.enter="handleLogin">
        <el-form-item prop="username">
          <el-input v-model="form.username" placeholder="请输入用户名" prefix-icon="User" clearable />
        </el-form-item>
        <el-form-item prop="password">
          <el-input v-model="form.password" type="password" placeholder="请输入密码" prefix-icon="Lock"
            show-password clearable />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" class="login-btn" :loading="loading" @click="handleLogin">
            {{ loading ? '登录中...' : '登 录' }}
          </el-button>
        </el-form-item>
      </el-form>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth.js'
import { authApi } from '@/api/index.js'
import { ElMessage } from 'element-plus'

const router = useRouter()
const auth = useAuthStore()
const formRef = ref()
const loading = ref(false)

const form = reactive({ username: '', password: '' })
const rules = {
  username: [{ required: true, message: '请输入用户名', trigger: 'blur' }],
  password: [{ required: true, message: '请输入密码', trigger: 'blur' }],
}

function isApiSuccess(res) {
  if (!res || res.code === undefined || res.code === null) return false
  return Number(res.code) === 200
}

async function handleLogin() {
  try {
    await formRef.value.validate()
  } catch {
    return
  }
  loading.value = true
  try {
    const res = await authApi.login({ username: form.username, password: form.password })
    if (isApiSuccess(res) && res.data?.token) {
      localStorage.setItem('token', res.data.token)
      localStorage.setItem('user', JSON.stringify(res.data.user))
      auth.$patch({
        token: res.data.token,
        user: res.data.user,
      })
      ElMessage.success('登录成功')
      await router.replace('/dashboard')
    } else {
      ElMessage.error(res?.msg || '登录失败')
    }
  } catch (e) {
    const msg = e?.response?.data?.msg || e?.message || '登录失败'
    ElMessage.error(msg)
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
.login-bg {
  min-height: 100vh;
  background: linear-gradient(135deg, #e8ecf1, #dce1e8, #d0d6e0);
  display: flex;
  align-items: center;
  justify-content: center;
}
.login-box {
  width: 420px;
  background: rgba(255,255,255,0.97);
  border-radius: 16px;
  padding: 40px 40px 32px;
  box-shadow: 0 20px 60px rgba(0,0,0,0.12);
}
.login-header { text-align: center; margin-bottom: 32px; }
.logo-icon { font-size: 48px; margin-bottom: 12px; }
.login-header h1 { font-size: 22px; font-weight: 700; color: #1f2329; margin-bottom: 6px; }
.login-header p { font-size: 12px; color: #909399; }
.login-form .el-form-item { margin-bottom: 20px; }
.login-btn { width: 100%; height: 44px; font-size: 16px; letter-spacing: 4px; border-radius: 8px; }
</style>
