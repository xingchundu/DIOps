<template>
  <div class="page-container" style="max-width:760px;margin:0 auto">
    <el-row :gutter="16">
      <!-- 个人信息 -->
      <el-col :span="24">
        <div class="card">
          <div class="card-title"><el-icon><User /></el-icon> 个人信息</div>
          <div style="display:flex;gap:32px;align-items:flex-start">
            <div style="text-align:center">
              <el-avatar :size="80" :style="{background:'#1890ff',fontSize:'32px'}">
                {{ auth.user?.username?.[0]?.toUpperCase() }}
              </el-avatar>
              <div style="margin-top:8px;font-weight:600">{{ auth.user?.username }}</div>
              <el-tag size="small" :type="roleColor">{{ roleLabel }}</el-tag>
            </div>
            <el-form :model="profile" :rules="profileRules" label-width="80px" style="flex:1" ref="profileRef">
              <el-row :gutter="16">
                <el-col :span="12">
                  <el-form-item label="姓名">
                    <el-input v-model="profile.realName" :disabled="!editing" />
                  </el-form-item>
                </el-col>
                <el-col :span="12">
                  <el-form-item label="邮箱">
                    <el-input v-model="profile.email" :disabled="!editing" />
                  </el-form-item>
                </el-col>
                <el-col :span="12">
                  <el-form-item label="手机">
                    <el-input v-model="profile.phone" :disabled="!editing" />
                  </el-form-item>
                </el-col>
                <el-col :span="12">
                  <el-form-item label="角色">
                    <el-input :value="roleLabel" disabled />
                  </el-form-item>
                </el-col>
              </el-row>
              <el-form-item>
                <el-button v-if="!editing" type="primary" icon="Edit" @click="editing=true">编辑信息</el-button>
                <template v-else>
                  <el-button type="primary" :loading="saving" @click="saveProfile">保存</el-button>
                  <el-button @click="editing=false">取消</el-button>
                </template>
              </el-form-item>
            </el-form>
          </div>
        </div>
      </el-col>

      <!-- 修改密码 -->
      <el-col :span="24">
        <div class="card">
          <div class="card-title"><el-icon><Lock /></el-icon> 修改密码</div>
          <el-form :model="pwdForm" :rules="pwdRules" ref="pwdRef" label-width="100px" style="max-width:420px">
            <el-form-item label="当前密码" prop="oldPassword">
              <el-input v-model="pwdForm.oldPassword" type="password" show-password />
            </el-form-item>
            <el-form-item label="新密码" prop="newPassword">
              <el-input v-model="pwdForm.newPassword" type="password" show-password placeholder="≥8位，含大小写字母+数字" />
              <div class="pwd-strength">
                <span v-for="i in 4" :key="i" class="strength-bar"
                  :class="{ active: pwdStrength >= i, [`level-${pwdStrength}`]: pwdStrength >= i }" />
                <span class="strength-label">{{ strengthLabel }}</span>
              </div>
            </el-form-item>
            <el-form-item label="确认新密码" prop="confirmPassword">
              <el-input v-model="pwdForm.confirmPassword" type="password" show-password />
            </el-form-item>
            <el-form-item>
              <el-button type="primary" :loading="changingPwd" @click="changePwd">确认修改</el-button>
              <el-button @click="pwdRef.resetFields()">重置</el-button>
            </el-form-item>
          </el-form>
        </div>
      </el-col>

      <!-- 登录记录 -->
      <el-col :span="24">
        <div class="card">
          <div class="card-title"><el-icon><Clock /></el-icon> 账号信息</div>
          <el-descriptions :column="2" border>
            <el-descriptions-item label="用户ID">{{ auth.user?.userId }}</el-descriptions-item>
            <el-descriptions-item label="用户名">{{ auth.user?.username }}</el-descriptions-item>
            <el-descriptions-item label="角色权限">{{ roleLabel }}</el-descriptions-item>
            <el-descriptions-item label="最后登录">
              {{ auth.user?.lastLogin ? new Date(auth.user.lastLogin).toLocaleString('zh-CN') : '-' }}
            </el-descriptions-item>
          </el-descriptions>
        </div>
      </el-col>
    </el-row>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth.js'
import { authApi } from '@/api/index.js'
import { ElMessage } from 'element-plus'

const auth    = useAuthStore()
const router  = useRouter()
const editing = ref(false)
const saving  = ref(false)
const changingPwd = ref(false)
const pwdRef  = ref()

const profile = reactive({
  realName: auth.user?.realName || '',
  email:    auth.user?.email    || '',
  phone:    auth.user?.phone    || '',
})

const profileRules = {
  email: [{ type: 'email', message: '请输入正确的邮箱格式', trigger: 'blur' }],
  phone: [{ pattern: /^1[3-9]\d{9}$/, message: '请输入正确的手机号', trigger: 'blur' }],
}
const pwdForm = reactive({ oldPassword:'', newPassword:'', confirmPassword:'' })
const pwdRules = {
  oldPassword:     [{ required:true, message:'请输入当前密码' }],
  newPassword:     [{ required:true, message:'请输入新密码' }, { min:8, message:'至少8位' }],
  confirmPassword: [{ required:true, message:'请确认新密码' },
    { validator: (r,v,cb) => v===pwdForm.newPassword ? cb() : cb(new Error('两次密码不一致')) }],
}

const roleMap = { ADMIN:['超级管理员','danger'], DBA:['DBA','warning'], OPS:['运维工程师','primary'],
                  REVIEWER:['审核员','success'], VIEWER:['只读用户','info'], DEV:['开发人员',''] }
const roleLabel = computed(() => roleMap[auth.user?.role]?.[0] || auth.user?.role || '-')
const roleColor = computed(() => roleMap[auth.user?.role]?.[1] || 'info')

const pwdStrength = computed(() => {
  const p = pwdForm.newPassword
  if (!p) return 0
  let s = 0
  if (p.length >= 8)   s++
  if (/[A-Z]/.test(p)) s++
  if (/[0-9]/.test(p)) s++
  if (/[^A-Za-z0-9]/.test(p)) s++
  return s
})
const strengthLabel = computed(() => ['','弱','中','强','极强'][pwdStrength.value] || '')

async function saveProfile() {
  try { await profileRef.value.validate() } catch { return }
  saving.value = true
  try {
    await authApi.updateProfile(profile)
    await auth.refreshProfile()
    ElMessage.success('个人信息更新成功')
    editing.value = false
  } catch (e) { ElMessage.error(e.message || '保存失败') }
  finally { saving.value = false }
}

async function changePwd() {
  await pwdRef.value.validate(async valid => {
    if (!valid) return
    changingPwd.value = true
    try {
      const r = await authApi.changePwd(pwdForm)
      if (r.code === 200) {
        ElMessage.success('密码修改成功，请重新登录')
        await auth.logout()
        router.push('/login')
      } else { ElMessage.error(r.msg) }
    } finally { changingPwd.value = false }
  })
}

onMounted(() => auth.refreshProfile().catch(() => {}))
</script>

<style scoped>
.pwd-strength { display:flex; align-items:center; gap:4px; margin-top:6px; }
.strength-bar {
  height: 4px; flex: 1; background: #e8e8e8; border-radius: 2px; transition: all .3s;
}
.strength-bar.active.level-1 { background: #ff4d4f; }
.strength-bar.active.level-2 { background: #faad14; }
.strength-bar.active.level-3 { background: #1890ff; }
.strength-bar.active.level-4 { background: #52c41a; }
.strength-label { font-size: 12px; color: #909399; min-width: 32px; }
</style>
