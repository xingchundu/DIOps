<template>
  <div class="page-container">
    <div class="card">
      <div style="display:flex;justify-content:space-between;margin-bottom:16px">
        <div class="flex-center gap-8">
          <el-input v-model="q.keyword" placeholder="用户名/姓名" clearable style="width:160px" @input="load" prefix-icon="Search" />
          <el-select v-model="q.role" placeholder="角色" clearable style="width:120px" @change="load">
            <el-option v-for="r in roleOpts" :key="r.value" :label="r.label" :value="r.value" />
          </el-select>
          <el-select v-model="q.status" placeholder="状态" clearable style="width:100px" @change="load">
            <el-option label="启用" :value="1" /><el-option label="禁用" :value="0" />
          </el-select>
          <el-button icon="Refresh" @click="load">刷新</el-button>
        </div>
        <el-button type="primary" icon="Plus" @click="openForm()">新增用户</el-button>
      </div>

      <el-table :data="list" v-loading="loading" stripe border>
        <el-table-column prop="USER_ID"   label="ID"    width="70" />
        <el-table-column prop="USERNAME"  label="用户名" width="120" />
        <el-table-column prop="REAL_NAME" label="姓名"  width="110" />
        <el-table-column prop="EMAIL"     label="邮箱"  min-width="180" show-overflow-tooltip />
        <el-table-column prop="PHONE"     label="手机"  width="130" />
        <el-table-column label="角色" width="120">
          <template #default="{ row }">
            <el-tag :type="roleColor(row.ROLE)" size="small">{{ row.ROLE_NAME || roleLabel(row.ROLE) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="80">
          <template #default="{ row }">
            <el-tag :type="row.STATUS===1 ? 'success' : 'danger'" size="small">
              {{ row.STATUS === 1 ? '启用' : '禁用' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="创建时间" width="165" prop="CREATED_AT" :formatter="(r,c,v)=>fmt(v)" />
        <el-table-column label="最后登录" width="165" prop="LAST_LOGIN" :formatter="(r,c,v)=>fmt(v)" />
        <el-table-column label="操作" width="200" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openForm(row)">编辑</el-button>
            <el-button link type="warning" @click="resetPwd(row)">重置密码</el-button>
            <el-button v-if="row.STATUS===1" link type="danger" @click="toggleStatus(row, 0)">禁用</el-button>
            <el-button v-else link type="success" @click="toggleStatus(row, 1)">启用</el-button>
          </template>
        </el-table-column>
      </el-table>
      <div style="padding:12px 0;text-align:right">
        <el-pagination v-model:current-page="page" :page-size="20" :total="total"
          layout="total,prev,pager,next" @current-change="load" small />
      </div>
    </div>

    <!-- 新增/编辑 -->
    <el-dialog v-model="formVisible" :title="formData.USER_ID ? '编辑用户' : '新增用户'" width="460px">
      <el-form :model="formData" :rules="formRules" ref="formRef" label-width="80px">
        <el-form-item label="用户名" prop="username">
          <el-input v-model="formData.username" :disabled="!!formData.USER_ID" />
        </el-form-item>
        <el-form-item v-if="!formData.USER_ID" label="初始密码" prop="password">
          <el-input v-model="formData.password" type="password" show-password placeholder="≥8位，含大小写字母+数字" />
        </el-form-item>
        <el-form-item label="姓名">
          <el-input v-model="formData.realName" />
        </el-form-item>
        <el-form-item label="邮箱">
          <el-input v-model="formData.email" />
        </el-form-item>
        <el-form-item label="手机">
          <el-input v-model="formData.phone" />
        </el-form-item>
        <el-form-item label="角色" prop="role">
          <el-select v-model="formData.role" style="width:100%">
            <el-option v-for="r in roleOpts" :key="r.value" :label="r.label" :value="r.value" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="formVisible=false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存</el-button>
      </template>
    </el-dialog>

    <!-- 重置密码 -->
    <el-dialog v-model="resetVisible" title="重置密码" width="380px">
      <el-form label-width="90px">
        <el-form-item label="目标用户"><el-input :value="resetTarget?.USERNAME" disabled /></el-form-item>
        <el-form-item label="新密码">
          <el-input v-model="newPwd" type="password" show-password placeholder="≥8位，含大小写字母+数字" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="resetVisible=false">取消</el-button>
        <el-button type="warning" :loading="resetting" @click="doReset">确认重置</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import { userApi, authApi, rbacApi } from '@/api/index.js'
import { ElMessage } from 'element-plus'

const list = ref([]); const loading = ref(false)
const page = ref(1);  const total   = ref(0)
const q = reactive({ keyword:'', role:'', status:'' })
const formVisible = ref(false); const formRef = ref(); const saving = ref(false)
const resetVisible = ref(false); const resetTarget = ref(null); const newPwd = ref(''); const resetting = ref(false)
const formData = reactive({ USER_ID:null, username:'', password:'', realName:'', email:'', phone:'', role:'VIEWER', status:1 })

const roleOpts = ref([
  { label: '超级管理员', value: 'ADMIN' },
  { label: 'DBA', value: 'DBA' },
  { label: '运维工程师', value: 'OPS' },
  { label: '审核员', value: 'REVIEWER' },
  { label: '只读用户', value: 'VIEWER' },
  { label: '开发人员', value: 'DEV' },
])
async function loadRoleOpts() {
  try {
    const r = await rbacApi.roles()
    if (r.code === 200 && Array.isArray(r.data) && r.data.length) {
      roleOpts.value = r.data.map(x => ({ label: x.ROLE_NAME, value: x.ROLE_CODE }))
    }
  } catch {
    /* 使用默认枚举 */
  }
}
const formRules = {
  username: [{ required:true, message:'请输入用户名' }],
  password: [{ required:true, message:'请输入初始密码' }, { min:8, message:'至少8位' }],
  role:     [{ required:true, message:'请选择角色' }],
}
function roleLabel(r) { return roleOpts.value.find(o => o.value === r)?.label || r }
function roleColor(r) { return { ADMIN:'danger', DBA:'warning', OPS:'primary', REVIEWER:'success', VIEWER:'info' }[r] || '' }
function fmt(v) { return v ? new Date(v).toLocaleString('zh-CN') : '-' }

async function load() {
  loading.value = true
  try {
    const r = await userApi.list({ ...q, page: page.value, size: 20 })
    if (r.code === 200) { list.value = r.data.list || []; total.value = r.data.total || 0 }
  } finally { loading.value = false }
}

function openForm(row = null) {
  if (row) Object.assign(formData, { USER_ID: row.USER_ID, username: row.USERNAME, password:'',
    realName: row.REAL_NAME, email: row.EMAIL, phone: row.PHONE, role: row.ROLE, status: row.STATUS })
  else Object.assign(formData, { USER_ID:null, username:'', password:'', realName:'', email:'', phone:'', role:'VIEWER', status:1 })
  formVisible.value = true
}

async function save() {
  await formRef.value.validate(async valid => {
    if (!valid) return
    saving.value = true
    try {
      if (formData.USER_ID) await userApi.update(formData.USER_ID, formData)
      else await userApi.create(formData)
      ElMessage.success(formData.USER_ID ? '更新成功' : '用户创建成功')
      formVisible.value = false; load()
    } finally { saving.value = false }
  })
}

async function toggleStatus(row, status) {
  if (status === 0) await userApi.disable(row.USER_ID)
  else await userApi.enable(row.USER_ID)
  ElMessage.success(status === 1 ? '已启用' : '已禁用'); load()
}

function resetPwd(row) { resetTarget.value = row; newPwd.value = ''; resetVisible.value = true }

async function doReset() {
  if (!newPwd.value || newPwd.value.length < 8) return ElMessage.warning('密码至少8位')
  resetting.value = true
  try {
    await authApi.resetPwd({ userId: resetTarget.value.USER_ID, newPassword: newPwd.value })
    ElMessage.success('密码重置成功'); resetVisible.value = false
  } finally { resetting.value = false }
}

onMounted(async () => {
  await loadRoleOpts()
  await load()
})
</script>
