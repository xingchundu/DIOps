<template>
  <div class="page-container">
    <div class="card">
      <div style="display:flex;justify-content:space-between;margin-bottom:16px;align-items:center">
        <span class="card-title-inline">角色与权限</span>
        <el-button type="primary" icon="Plus" @click="openCreate">新增角色</el-button>
      </div>
      <p class="hint-text">为角色勾选可访问的菜单；超级管理员固定拥有全部菜单。用户分配角色请在「用户管理」中操作。</p>

      <el-table :data="list" v-loading="loading" stripe border>
        <el-table-column prop="ROLE_CODE" label="角色代码" width="120" />
        <el-table-column prop="ROLE_NAME" label="角色名称" min-width="140" />
        <el-table-column label="类型" width="90">
          <template #default="{ row }">
            <el-tag v-if="Number(row.IS_SYSTEM) === 1" type="info" size="small">内置</el-tag>
            <el-tag v-else type="success" size="small">自定义</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-tag :type="Number(row.STATUS) === 1 ? 'success' : 'danger'" size="small">
              {{ Number(row.STATUS) === 1 ? '启用' : '禁用' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="200" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openAssign(row)">分配权限</el-button>
            <el-button v-if="Number(row.IS_SYSTEM) !== 1" link type="primary" @click="openEdit(row)">编辑</el-button>
            <el-button v-if="Number(row.IS_SYSTEM) !== 1" link type="danger" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <el-dialog v-model="createVisible" title="新增角色" width="440px" @close="resetCreate">
      <el-form :model="createForm" :rules="createRules" ref="createRef" label-width="90px">
        <el-form-item label="角色代码" prop="roleCode">
          <el-input v-model="createForm.roleCode" placeholder="字母数字下划线，如 ANALYST" maxlength="32" />
        </el-form-item>
        <el-form-item label="角色名称" prop="roleName">
          <el-input v-model="createForm.roleName" placeholder="显示名称" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="submitCreate">创建</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="editVisible" title="编辑角色" width="440px">
      <el-form v-if="editRow" label-width="90px">
        <el-form-item label="角色代码"><el-input :value="editRow.ROLE_CODE" disabled /></el-form-item>
        <el-form-item label="角色名称">
          <el-input v-model="editForm.roleName" />
        </el-form-item>
        <el-form-item label="状态">
          <el-switch v-model="editForm.status" :active-value="1" :inactive-value="0" :disabled="editRow.ROLE_CODE === 'ADMIN'" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="editVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="submitEdit">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="assignVisible" title="分配菜单权限" width="520px" @open="onAssignOpen">
      <el-alert v-if="assignRow?.ROLE_CODE === 'ADMIN'" type="info" :closable="false" style="margin-bottom:12px">
        超级管理员固定拥有全部菜单，无需分配。
      </el-alert>
      <div v-else v-loading="assignLoading" class="assign-menu">
        <el-checkbox-group v-model="checkedMenuIds">
          <div v-for="m in menuList" :key="m.MENU_ID" class="menu-row">
            <el-checkbox :label="m.MENU_ID">{{ m.MENU_NAME }} <span class="path-muted">{{ m.MENU_PATH }}</span></el-checkbox>
          </div>
        </el-checkbox-group>
      </div>
      <template #footer>
        <el-button @click="assignVisible = false">取消</el-button>
        <el-button type="primary" :loading="assignSaving" :disabled="assignRow?.ROLE_CODE === 'ADMIN'" @click="submitAssign">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import { rbacApi } from '@/api/index.js'
import { ElMessage, ElMessageBox } from 'element-plus'

const list = ref([])
const loading = ref(false)
const menuList = ref([])

const createVisible = ref(false)
const createRef = ref()
const saving = ref(false)
const createForm = reactive({ roleCode: '', roleName: '' })
const createRules = {
  roleCode: [{ required: true, message: '请输入角色代码' }],
  roleName: [{ required: true, message: '请输入角色名称' }],
}

const editVisible = ref(false)
const editRow = ref(null)
const editForm = reactive({ roleName: '', status: 1 })

const assignVisible = ref(false)
const assignRow = ref(null)
const assignLoading = ref(false)
const assignSaving = ref(false)
const checkedMenuIds = ref([])

async function loadMenus() {
  try {
    const r = await rbacApi.menus()
    if (r.code === 200) menuList.value = r.data || []
  } catch {
    menuList.value = []
  }
}

async function load() {
  loading.value = true
  try {
    const r = await rbacApi.roles()
    if (r.code === 200) list.value = r.data || []
  } finally {
    loading.value = false
  }
}

function openCreate() {
  resetCreate()
  createVisible.value = true
}

function resetCreate() {
  createForm.roleCode = ''
  createForm.roleName = ''
  createRef.value?.resetFields?.()
}

async function submitCreate() {
  try {
    await createRef.value.validate()
  } catch {
    return
  }
  saving.value = true
  try {
    const r = await rbacApi.createRole({
      roleCode: createForm.roleCode.trim(),
      roleName: createForm.roleName.trim(),
      status: 1,
    })
    if (r.code === 200) {
      ElMessage.success(r.msg || '创建成功')
      createVisible.value = false
      await load()
    }
  } finally {
    saving.value = false
  }
}

function openEdit(row) {
  editRow.value = row
  editForm.roleName = row.ROLE_NAME
  editForm.status = Number(row.STATUS) === 1 ? 1 : 0
  editVisible.value = true
}

async function submitEdit() {
  if (!editRow.value) return
  saving.value = true
  try {
    const r = await rbacApi.updateRole(editRow.value.ROLE_ID, {
      roleName: editForm.roleName,
      status: editForm.status,
    })
    if (r.code === 200) {
      ElMessage.success(r.msg || '已保存')
      editVisible.value = false
      await load()
    }
  } finally {
    saving.value = false
  }
}

function openAssign(row) {
  assignRow.value = row
  checkedMenuIds.value = []
  assignVisible.value = true
}

async function onAssignOpen() {
  if (!assignRow.value || assignRow.value.ROLE_CODE === 'ADMIN') return
  assignLoading.value = true
  try {
    const r = await rbacApi.roleMenus(assignRow.value.ROLE_ID)
    if (r.code === 200) checkedMenuIds.value = [...(r.data?.menuIds || [])]
  } finally {
    assignLoading.value = false
  }
}

async function submitAssign() {
  if (!assignRow.value || assignRow.value.ROLE_CODE === 'ADMIN') return
  assignSaving.value = true
  try {
    const r = await rbacApi.saveRoleMenus(assignRow.value.ROLE_ID, { menuIds: checkedMenuIds.value })
    if (r.code === 200) {
      ElMessage.success(r.msg || '已保存')
      assignVisible.value = false
    }
  } finally {
    assignSaving.value = false
  }
}

async function remove(row) {
  try {
    await ElMessageBox.confirm(`确定删除角色「${row.ROLE_NAME}」吗？`, '提示', { type: 'warning' })
  } catch {
    return
  }
  const r = await rbacApi.deleteRole(row.ROLE_ID)
  if (r.code === 200) {
    ElMessage.success(r.msg || '已删除')
    await load()
  }
}

onMounted(async () => {
  await loadMenus()
  await load()
})
</script>

<style scoped>
.hint-text { color: var(--el-text-color-secondary); font-size: 13px; margin: -8px 0 16px; line-height: 1.5; }
.card-title-inline { font-weight: 600; font-size: 16px; }
.assign-menu { max-height: 420px; overflow-y: auto; }
.menu-row { padding: 4px 0; }
.path-muted { color: var(--el-text-color-placeholder); font-size: 12px; margin-left: 6px; }
</style>
