<template>
  <div class="page-container">
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
        <el-input v-model="q.keyword" placeholder="实例名/IP" clearable style="width:180px" @input="load" prefix-icon="Search" />
        <el-select v-model="q.dbType" placeholder="类型" clearable style="width:130px" @change="load">
          <el-option label="Oracle" value="ORACLE" /><el-option label="MySQL" value="MYSQL" />
          <el-option label="PostgreSQL" value="POSTGRESQL" />
          <el-option label="达梦 DM" value="DAMENG" /><el-option label="GoldenDB" value="GOLDENDB" />
        </el-select>
        <el-select v-model="q.status" placeholder="状态" clearable style="width:110px" @change="load">
          <el-option label="运行中" value="RUNNING" /><el-option label="异常" value="ERROR" />
          <el-option label="已停止" value="STOPPED" />
          <el-option label="未监控" value="UNMONITORED" />
          <el-option label="未知" value="UNKNOWN" />
        </el-select>
        <el-select v-model="q.env" placeholder="环境" clearable style="width:100px" @change="load">
          <el-option label="生产" value="PROD" /><el-option label="UAT" value="UAT" />
          <el-option label="开发" value="DEV" />
        </el-select>
        <el-button icon="Refresh" :loading="loading" @click="onToolbarRefresh">刷新</el-button>
        <el-button type="primary" icon="Plus" @click="openForm()">添加实例</el-button>
        <el-button @click="downloadCmdbImportTemplate">下载导入模板</el-button>
        <el-button v-if="canMutate" type="warning" @click="triggerCmdbBulkImport">批量导入</el-button>
        <input ref="cmdbImportInputRef" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" class="hidden-file-input" @change="onCmdbImportPicked" />
      </div>

      <el-table :data="list" v-loading="loading" stripe border @row-dblclick="r => openForm(r)">
        <el-table-column prop="INSTANCE_ID"   label="ID" width="60" />
        <el-table-column label="实例名称" min-width="150">
          <template #default="{ row }">
            <el-link type="primary" @click="goMonitor(row.INSTANCE_ID)">{{ row.INSTANCE_NAME }}</el-link>
          </template>
        </el-table-column>
        <el-table-column label="类型" width="100">
          <template #default="{ row }">
            <el-tag :type="dtColor(row.DB_TYPE)" size="small">{{ row.DB_TYPE }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="DB_VERSION"  label="版本" width="130" />
        <el-table-column label="主机" min-width="150">
          <template #default="{ row }">{{ row.HOST_IP }} : {{ row.PORT }}</template>
        </el-table-column>
        <el-table-column prop="ENVIRONMENT" label="环境"  width="80" />
        <el-table-column prop="BIZ_LINE"    label="业务线" width="120" show-overflow-tooltip />
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <span :class="`status-${row.STATUS?.toLowerCase()}`">● {{ slabel(row.STATUS) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="健康分" width="85">
          <template #default="{ row }">
            <span :class="scoreClass(row.HEALTH_SCORE)">{{ row.HEALTH_SCORE }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="ROLE"         label="角色"  width="90" />
        <el-table-column label="最后采集" width="155" show-overflow-tooltip>
          <template #default="{ row }">
            {{ row.LAST_CHECK ? new Date(row.LAST_CHECK).toLocaleString('zh-CN') : '—' }}
          </template>
        </el-table-column>
        <el-table-column label="操作" width="140" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="goMonitor(row.INSTANCE_ID)">监控</el-button>
            <el-button link @click="openForm(row)">编辑</el-button>
            <el-popconfirm :title="`确定删除实例 ${row.INSTANCE_NAME}?`" @confirm="del(row.INSTANCE_ID)">
              <template #reference>
                <el-button link type="danger">删除</el-button>
              </template>
            </el-popconfirm>
          </template>
        </el-table-column>
      </el-table>
      <div style="padding:12px 0;text-align:right">
        <el-pagination v-model:current-page="page" :page-size="20" :total="total"
          layout="total,prev,pager,next" @current-change="load" small />
      </div>
    </div>

    <!-- 新增/编辑对话框（单个新增 / 编辑） -->
    <el-dialog v-model="formVisible" :title="formData.INSTANCE_ID ? '编辑实例' : '添加实例'" width="600px">
      <el-form :model="formData" label-width="100px" :rules="formRules" ref="formRef">
        <el-row :gutter="16">
          <el-col :span="12">
            <el-form-item label="实例名称" prop="instanceName">
              <el-input v-model="formData.instanceName" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="数据库类型" prop="dbType">
              <el-select v-model="formData.dbType" style="width:100%" placeholder="请选择类型" @change="onDbTypeChange">
                <el-option label="Oracle" value="ORACLE" />
                <el-option label="MySQL" value="MYSQL" />
                <el-option label="PG (PostgreSQL)" value="POSTGRESQL" />
                <el-option label="达梦 (DAMENG)" value="DAMENG" />
                <el-option label="GoldenDB" value="GOLDENDB" />
                <el-option label="其他" value="OTHER" />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>
        <el-row v-if="formData.dbType === 'OTHER'" :gutter="16">
          <el-col :span="24">
            <el-form-item label="类型名称" prop="dbTypeOther" :rules="dbTypeOtherRules">
              <el-input v-model="formData.dbTypeOther" placeholder="如 SQLSERVER、MONGODB（大写英文，与 CMDB 一致）" maxlength="32" show-word-limit />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="16">
          <el-col :span="12">
            <el-form-item label="主机IP" prop="hostIp">
              <el-input v-model="formData.hostIp" placeholder="192.168.x.x" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="端口">
              <el-input-number v-model="formData.port" :min="1" :max="65535" style="width:100%" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="16">
          <el-col :span="12">
            <el-form-item label="SID">
              <el-input v-model="formData.sid" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="Service名">
              <el-input v-model="formData.serviceName" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="16">
          <el-col :span="12">
            <el-form-item label="DB用户名">
              <el-input v-model="formData.dbUser" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="DB密码">
              <el-input v-model="formData.dbPassword" type="password" show-password
                :placeholder="formData.INSTANCE_ID ? '不修改留空' : ''" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="16">
          <el-col :span="12">
            <el-form-item label="版本">
              <el-input v-model="formData.dbVersion" placeholder="如: Oracle 19c" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="字符集">
              <el-input v-model="formData.charset" placeholder="AL32UTF8" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="16">
          <el-col :span="12">
            <el-form-item label="环境">
              <el-select v-model="formData.environment" style="width:100%">
                <el-option label="生产(PROD)"  value="PROD" />
                <el-option label="UAT"         value="UAT" />
                <el-option label="开发(DEV)"   value="DEV" />
                <el-option label="测试(TEST)"  value="TEST" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="实例角色">
              <el-select v-model="formData.role" style="width:100%">
                <el-option label="主库(PRIMARY)"  value="PRIMARY" />
                <el-option label="备库(STANDBY)"  value="STANDBY" />
                <el-option label="只读(READONLY)" value="READONLY" />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item label="业务线">
          <el-input v-model="formData.bizLine" />
        </el-form-item>
        <el-form-item label="标签">
          <el-input v-model="formData.tags" placeholder="多个标签用逗号分隔" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="formVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth.js'
import { cmdbApi, monitorApi } from '@/api/index.js'
import { ElMessage, ElMessageBox } from 'element-plus'

const router = useRouter()
const auth = useAuthStore()
const canMutate = computed(() => auth.isDBA)
const cmdbImportInputRef = ref(null)
const loading = ref(false); const saving = ref(false)
const list = ref([]); const page = ref(1); const total = ref(0)
const q = reactive({ keyword:'', dbType:'', status:'', env:'' })
const formVisible = ref(false); const formRef = ref()
const cmdbStats = ref({})
const KNOWN_DB_TYPES = ['ORACLE', 'MYSQL', 'POSTGRESQL', 'DAMENG', 'GOLDENDB']

const formData = reactive({
  instanceName: '', dbType: 'ORACLE', dbTypeOther: '', hostIp: '', port: 1521, sid: '',
  serviceName: '', dbUser: '', dbPassword: '', dbVersion: '', charset: 'AL32UTF8',
  environment: 'PROD', bizLine: '', tags: '', role: 'PRIMARY', INSTANCE_ID: null,
})

const dbTypeOtherRules = [
  {
    validator: (_r, v, cb) => {
      if (formData.dbType !== 'OTHER') return cb()
      const s = String(v || '').trim()
      if (!s) return cb(new Error('请填写数据库类型名称'))
      if (!/^[A-Za-z0-9_]+$/.test(s)) return cb(new Error('仅允许字母、数字、下划线'))
      cb()
    },
    trigger: 'blur',
  },
]

const formRules = {
  instanceName: [{ required: true, message: '请输入实例名称' }],
  dbType: [{ required: true, message: '请选择数据库类型' }],
  hostIp: [{ required: true, message: '请输入主机IP' }],
}

const statCards = computed(() => [
  { label:'实例总数', val: cmdbStats.value.total||0, icon:'🗄️', g1:'#1890ff', g2:'#096dd9' },
  { label:'运行中',  val: cmdbStats.value.running||0, icon:'✅', g1:'#52c41a', g2:'#389e0d' },
  { label:'异常实例', val: cmdbStats.value.error||0,  icon:'⚠️', g1:'#ff4d4f', g2:'#cf1322' },
  { label:'类型数量', val: (cmdbStats.value.byType||[]).length, icon:'📊', g1:'#722ed1', g2:'#531dab' },
])

function dtColor(t) {
  return (
    {
      ORACLE: 'danger',
      MYSQL: 'primary',
      POSTGRESQL: 'success',
      DAMENG: 'warning',
      GOLDENDB: 'primary',
    }[t] || 'info'
  )
}
function slabel(s) {
  return (
    {
      RUNNING: '运行中',
      STOPPED: '已停止',
      ERROR: '异常',
      UNKNOWN: '未知',
      UNMONITORED: '未监控',
    }[s] || s
  )
}
function scoreClass(s) { return s >= 80 ? 'score-high' : s >= 60 ? 'score-medium' : 'score-low' }

async function goMonitor(instanceId) {
  try {
    await monitorApi.collectNow(instanceId)
  } catch {
    /* 仍进入监控页，由页内展示错误 */
  }
  router.push(`/monitor/${instanceId}`)
}

async function load() {
  loading.value = true
  try {
    const r = await cmdbApi.list({ ...q, page: page.value, size: 20 })
    if (r.code === 200) { list.value = r.data.list || []; total.value = r.data.total || 0 }
  } finally { loading.value = false }
}

async function loadStats() {
  try { const r = await cmdbApi.stats(); cmdbStats.value = r.data || {} } catch {}
}

/** 列表与顶部统计一并刷新（删除/保存/挂载等使用，不弹「刷新成功」） */
async function refreshAll() {
  await load()
  await loadStats()
}

/** 仅工具栏「刷新」按钮：刷新后提示 */
async function onToolbarRefresh() {
  await refreshAll()
  ElMessage.success('刷新成功')
}

function mapRowDbTypeToForm(dbType) {
  const u = String(dbType || '').toUpperCase()
  if (KNOWN_DB_TYPES.includes(u)) return { dbType: u, dbTypeOther: '' }
  return { dbType: 'OTHER', dbTypeOther: u }
}

function onDbTypeChange() {
  if (formData.INSTANCE_ID) return
  const d = formData.dbType
  if (d === 'ORACLE') formData.port = 1521
  else if (d === 'MYSQL' || d === 'GOLDENDB') formData.port = 3306
  else if (d === 'POSTGRESQL') formData.port = 5432
  else if (d === 'DAMENG') formData.port = 5236
}

function openForm(row = null) {
  if (row) {
    const { dbType, dbTypeOther } = mapRowDbTypeToForm(row.DB_TYPE)
    Object.assign(formData, {
      INSTANCE_ID: row.INSTANCE_ID,
      instanceName: row.INSTANCE_NAME,
      dbType,
      dbTypeOther,
      hostIp: row.HOST_IP,
      port: row.PORT,
      sid: row.SID,
      serviceName: row.SERVICE_NAME,
      dbUser: row.DB_USER,
      dbPassword: '',
      dbVersion: row.DB_VERSION,
      charset: row.CHARSET,
      environment: row.ENVIRONMENT,
      bizLine: row.BIZ_LINE,
      tags: row.TAGS,
      role: row.ROLE,
    })
  } else {
    Object.assign(formData, {
      INSTANCE_ID: null,
      instanceName: '',
      dbType: 'ORACLE',
      dbTypeOther: '',
      hostIp: '',
      port: 1521,
      sid: '',
      serviceName: '',
      dbUser: '',
      dbPassword: '',
      dbVersion: '',
      charset: 'AL32UTF8',
      environment: 'PROD',
      bizLine: '',
      tags: '',
      role: 'PRIMARY',
    })
  }
  formVisible.value = true
}

function buildSavePayload() {
  const p = { ...formData }
  if (p.dbType === 'OTHER') {
    p.dbType = String(p.dbTypeOther || '').trim().toUpperCase()
  }
  delete p.dbTypeOther
  return p
}

async function save() {
  if (!formRef.value || saving.value) return
  try {
    await formRef.value.validate()
  } catch {
    return
  }
  saving.value = true
  try {
    const payload = buildSavePayload()
    let res
    if (formData.INSTANCE_ID) {
      res = await cmdbApi.update(formData.INSTANCE_ID, payload)
    } else {
      res = await cmdbApi.create(payload)
    }
    const msg =
      res?.msg ||
      (formData.INSTANCE_ID ? '保存成功，实例信息已更新。' : '保存成功，新实例已添加。')
    ElMessage.success(msg)
    await ElMessageBox.alert(msg, '操作成功', {
      type: 'success',
      confirmButtonText: '确定',
    })
    formVisible.value = false
    await refreshAll()
  } catch (e) {
    ElMessage.error(e?.message || '保存失败')
  } finally {
    saving.value = false
  }
}

async function del(id) {
  try {
    await cmdbApi.del(id)
    ElMessage.success('删除成功')
    await refreshAll()
  } catch (e) {
    ElMessage.error(e?.message || '删除失败')
  }
}

async function downloadCmdbImportTemplate() {
  try {
    const token = localStorage.getItem('token')
    const r = await fetch('/api/cmdb/instances/import-template', { headers: { Authorization: `Bearer ${token}` } })
    if (!r.ok) throw new Error('下载失败')
    const blob = await r.blob()
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'cmdb_instance_import_template.xlsx'
    a.click()
    URL.revokeObjectURL(a.href)
    ElMessage.success('已下载模板（含 Oracle、MySQL、PostgreSQL、达梦、GoldenDB、其他）')
  } catch (e) {
    ElMessage.error(e.message || '下载失败')
  }
}

function triggerCmdbBulkImport() {
  cmdbImportInputRef.value?.click()
}

async function onCmdbImportPicked(ev) {
  const input = ev.target
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  const fd = new FormData()
  fd.append('file', file)
  try {
    const res = await cmdbApi.bulkImportInstances(fd)
    if (res.code === 200) {
      ElMessage.success(res.msg || '导入完成')
      const fail = res.data?.fail || []
      if (fail.length) {
        const lines = fail.slice(0, 30).map((f) => `${f.sheet || '-'} 第${f.line ?? '-'}行: ${f.msg}`)
        const more = fail.length > 30 ? `\n… 共 ${fail.length} 条失败` : ''
        await ElMessageBox.alert(`${lines.join('\n')}${more}`, '部分行失败', { type: 'warning' })
      }
      load()
      loadStats()
    }
  } catch (e) {
    ElMessage.error(e.message || '导入失败')
  }
}

onMounted(() => { refreshAll() })
</script>

<style scoped>
.hidden-file-input { position: absolute; width: 0; height: 0; opacity: 0; pointer-events: none; }
.status-unmonitored { color: #909399; }
</style>
