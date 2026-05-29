<template>
  <div class="page-container">
    <!-- 概览卡片 -->
    <el-row :gutter="16" class="mb-16">
      <el-col :span="6" v-for="c in statCards" :key="c.label">
        <div class="stat-card" :style="{'--grad-start':c.g1,'--grad-end':c.g2}">
          <div class="stat-value">{{ c.val }}</div>
          <div class="stat-label">{{ c.label }}</div>
          <div class="stat-icon">{{ c.icon }}</div>
        </div>
      </el-col>
    </el-row>

    <div class="card">
      <!-- 工具栏 -->
      <div style="display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap">
        <el-input v-model="q.keyword" placeholder="主机名/IP" clearable style="width:180px" @input="load" prefix-icon="Search" />
        <el-select v-model="q.status" placeholder="状态" clearable style="width:110px" @change="load">
          <el-option label="在线" value="ONLINE" /><el-option label="离线" value="OFFLINE" />
          <el-option label="维护中" value="MAINTENANCE" />
        </el-select>
        <el-select v-model="q.datacenter" placeholder="数据中心" clearable style="width:130px" @change="load">
          <el-option v-for="dc in datacenters" :key="dc" :label="dc" :value="dc" />
        </el-select>
        <el-button icon="Refresh" :loading="loading" @click="load">刷新</el-button>
        <el-button icon="Connection" :loading="checkingAll" @click="checkAll">全量检测</el-button>
        <el-button v-if="canMutate" type="primary" icon="Plus" @click="openForm()">添加主机</el-button>
      </div>

      <el-table :data="list" v-loading="loading" stripe border @row-dblclick="r => canMutate && openForm(r)">
        <el-table-column prop="HOST_ID" label="ID" width="60" />
        <el-table-column prop="HOSTNAME" label="主机名" min-width="140" show-overflow-tooltip />
        <el-table-column prop="IP_ADDR" label="IP地址" width="140" />
        <el-table-column label="操作系统" width="140">
          <template #default="{ row }">
            <span>{{ row.OS_TYPE || '-' }} {{ row.OS_VERSION || '' }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="CPU_CORES" label="CPU核数" width="90" align="center" />
        <el-table-column prop="MEMORY_GB" label="内存(GB)" width="90" align="center" />
        <el-table-column prop="DATACENTER" label="数据中心" width="120" show-overflow-tooltip />
        <el-table-column label="状态" width="120">
          <template #default="{ row }">
            <el-tag :type="statusType(row.STATUS)" size="small">{{ statusLabel(row.STATUS) }}</el-tag>
            <span v-if="row._latency != null" style="font-size:11px;color:#909399;margin-left:4px">{{ row._latency }}ms</span>
          </template>
        </el-table-column>
        <el-table-column label="创建时间" width="165" prop="CREATED_AT" :formatter="(r,c,v) => fmt(v)" />
        <el-table-column label="操作" :width="canMutate ? 200 : 80" fixed="right">
          <template #default="{ row }">
            <el-button link type="success" :loading="row._checking" @click="checkOne(row)">检测</el-button>
            <template v-if="canMutate">
              <el-button link type="primary" @click="openForm(row)">编辑</el-button>
              <el-popconfirm title="确定删除该主机吗？" @confirm="del(row.HOST_ID)">
                <template #reference>
                  <el-button link type="danger">删除</el-button>
                </template>
              </el-popconfirm>
            </template>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <!-- 新增/编辑弹窗 -->
    <el-dialog v-model="formVisible" :title="formTitle" width="540px" :close-on-click-modal="false">
      <el-form :model="formData" :rules="formRules" ref="formRef" label-width="100px">
        <el-row :gutter="16">
          <el-col :span="12">
            <el-form-item label="主机名" prop="hostname">
              <el-input v-model="formData.hostname" placeholder="如 db-server-01" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="IP地址" prop="ipAddr">
              <el-input v-model="formData.ipAddr" placeholder="如 192.168.1.100" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="操作系统">
              <el-input v-model="formData.osType" placeholder="如 Linux/Windows" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="系统版本">
              <el-input v-model="formData.osVersion" placeholder="如 CentOS 7.9" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="CPU核数">
              <el-input-number v-model="formData.cpuCores" :min="0" :max="1024" style="width:100%" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="内存(GB)">
              <el-input-number v-model="formData.memoryGb" :min="0" :max="65536" style="width:100%" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="数据中心">
              <el-input v-model="formData.datacenter" placeholder="如 机房A" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="状态">
              <el-select v-model="formData.status" style="width:100%">
                <el-option label="在线" value="ONLINE" /><el-option label="离线" value="OFFLINE" />
                <el-option label="维护中" value="MAINTENANCE" />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>
      </el-form>
      <template #footer>
        <el-button @click="formVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { useAuthStore } from '@/stores/auth.js'
import { cmdbApi } from '@/api/index.js'
import { ElMessage } from 'element-plus'

const auth = useAuthStore()
const canMutate = computed(() => auth.isDBA)

const list = ref([])
const loading = ref(false)
const q = reactive({ keyword: '', status: '', datacenter: '' })

const formVisible = ref(false)
const formRef = ref()
const saving = ref(false)
const formData = reactive({
  HOST_ID: null, hostname: '', ipAddr: '', osType: '', osVersion: '',
  cpuCores: null, memoryGb: null, datacenter: '', status: 'ONLINE',
})

const formTitle = computed(() => formData.HOST_ID ? '编辑主机' : '添加主机')
const formRules = {
  hostname: [{ required: true, message: '请输入主机名', trigger: 'blur' }],
  ipAddr:   [{ required: true, message: '请输入IP地址', trigger: 'blur' }],
}

const statCards = computed(() => {
  const total = list.value.length
  const online = list.value.filter(h => h.STATUS === 'ONLINE').length
  const offline = list.value.filter(h => h.STATUS === 'OFFLINE').length
  const dcSet = new Set(list.value.map(h => h.DATACENTER).filter(Boolean))
  return [
    { label: '主机总数', val: total, icon: '🖥️', g1: '#1890ff', g2: '#096dd9' },
    { label: '在线主机', val: online, icon: '✅', g1: '#52c41a', g2: '#389e0d' },
    { label: '离线主机', val: offline, icon: '⛔', g1: '#ff4d4f', g2: '#cf1322' },
    { label: '数据中心', val: dcSet.size, icon: '🏢', g1: '#722ed1', g2: '#531dab' },
  ]
})

const datacenters = computed(() => {
  const set = new Set(list.value.map(h => h.DATACENTER).filter(Boolean))
  return [...set].sort()
})

function statusType(s) { return { ONLINE: 'success', OFFLINE: 'danger', MAINTENANCE: 'warning' }[s] || 'info' }
function statusLabel(s) { return { ONLINE: '在线', OFFLINE: '离线', MAINTENANCE: '维护中' }[s] || s }
function fmt(v) { return v ? new Date(v).toLocaleString('zh-CN') : '-' }

async function load() {
  loading.value = true
  try {
    const r = await cmdbApi.hosts(q)
    if (r.code === 200) list.value = r.data || []
  } finally { loading.value = false }
}

function openForm(row = null) {
  if (row) {
    Object.assign(formData, {
      HOST_ID: row.HOST_ID, hostname: row.HOSTNAME, ipAddr: row.IP_ADDR,
      osType: row.OS_TYPE || '', osVersion: row.OS_VERSION || '',
      cpuCores: row.CPU_CORES, memoryGb: row.MEMORY_GB,
      datacenter: row.DATACENTER || '', status: row.STATUS || 'ONLINE',
    })
  } else {
    Object.assign(formData, {
      HOST_ID: null, hostname: '', ipAddr: '', osType: '', osVersion: '',
      cpuCores: null, memoryGb: null, datacenter: '', status: 'ONLINE',
    })
  }
  formVisible.value = true
}

async function save() {
  try { await formRef.value.validate() } catch { return }
  saving.value = true
  try {
    const payload = { ...formData }
    let r
    if (payload.HOST_ID) r = await cmdbApi.updateHost(payload.HOST_ID, payload)
    else r = await cmdbApi.createHost(payload)
    if (r.code === 200) {
      ElMessage.success(r.msg || '操作成功')
      formVisible.value = false
      load()
    } else { ElMessage.error(r.msg || '操作失败') }
  } finally { saving.value = false }
}

async function del(id) {
  try {
    const r = await cmdbApi.deleteHost(id)
    if (r.code === 200) { ElMessage.success(r.msg || '删除成功'); load() }
    else { ElMessage.error(r.msg || '删除失败') }
  } catch (e) { ElMessage.error(e.message || '删除失败') }
}

const checkingAll = ref(false)

async function checkOne(row) {
  row._checking = true
  try {
    const r = await cmdbApi.checkHost(row.HOST_ID)
    if (r.code === 200) {
      const d = r.data
      row.STATUS = d.newStatus
      row._latency = d.reachable ? d.latencyMs : null
      ElMessage.success(`${row.HOSTNAME}: ${d.reachable ? '可达' : '不可达'}${d.port ? ' (port ' + d.port + ')' : ''}`)
    } else { ElMessage.error(r.msg || '检测失败') }
  } catch (e) { ElMessage.error(e?.message || '检测失败') }
  finally { row._checking = false }
}

async function checkAll() {
  checkingAll.value = true
  try {
    const r = await cmdbApi.checkAllHosts()
    if (r.code === 200) {
      const { results, updated } = r.data
      // 更新列表中的状态和延迟
      for (const item of results) {
        const row = list.value.find(h => h.HOST_ID === item.hostId)
        if (row) {
          row.STATUS = item.newStatus === 'MAINTENANCE' ? row.STATUS : item.newStatus
          row._latency = item.reachable ? item.latencyMs : null
        }
      }
      const online = results.filter(r => r.reachable).length
      ElMessage.success(`检测完成: ${online}/${results.length} 在线，${updated} 个状态已更新`)
    } else { ElMessage.error(r.msg || '批量检测失败') }
  } catch (e) { ElMessage.error(e?.message || '批量检测失败') }
  finally { checkingAll.value = false }
}

onMounted(() => load())
</script>
