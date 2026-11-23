<template>
  <div class="page-container" style="padding:48px;text-align:center">
    <p>{{ msg }}</p>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useAuthStore } from '@/stores/auth.js'
import { authApi } from '@/api/index.js'
import { ElMessage } from 'element-plus'
import { touchActivity } from '@/utils/session.js'

const router = useRouter()
const route = useRoute()
const auth = useAuthStore()
const msg = ref('OIDC 登录处理中…')

onMounted(async () => {
  const code = route.query.code
  if (!code) {
    msg.value = '缺少授权码'
    return
  }
  try {
    const res = await authApi.oidcCallback({ code, state: route.query.state })
    if (res?.data?.token) {
      localStorage.setItem('token', res.data.token)
      localStorage.setItem('user', JSON.stringify(res.data.user))
      touchActivity()
      auth.$patch({ token: res.data.token, user: res.data.user })
      ElMessage.success('登录成功')
      await router.replace('/dashboard')
    } else {
      msg.value = res?.msg || '登录失败'
    }
  } catch (e) {
    msg.value = e?.message || 'OIDC 登录失败'
  }
})
</script>
