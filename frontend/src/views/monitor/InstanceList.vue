<template>
  <div class="page-container">
    <!-- 搜索栏 -->
    <div class="card mb-16">
      <el-row :gutter="12" align="middle">
        <el-col :span="6">
          <el-input v-model="q.keyword" placeholder="搜索实例名/IP" clearable @change="load" prefix-icon="Search" />
        </el-col>
        <el-col :span="4">
          <el-select v-model="q.status" placeholder="运行状态" clearable @change="load">
            <el-option v-for="s in statusOpts" :key="s.value" :label="s.label" :value="s.value" />
          </el-select>
        </el-col>
        <el-col :span="4">
          <el-select v-model="q.dbType" placeholder="数据库类型" clearable @change="load">
            <el-option label="Oracle"     value="ORACLE" />
            <el-option label="MySQL"      value="MYSQL" />
            <el-option label="PostgreSQL" value="POSTGRESQL" />
          </el-select>
        </el-col>
        <el-col :span="4">
          <el-select v-model="q.env" placeholder="环境" clearable @change="load">
            <el-option label="生产" value="PROD" />
            <el-option label="UAT"  value="UAT" />
            <el-option label="开发" value="DEV" />
            <el-option label="测试" value="TEST" />
          </el-select>
        </el-col>
        <el-col :span="6" style="text-align:right">
          <el-button type="primary" icon="Refresh" @click="load">刷新</el-button>
          <el-button icon="View" @click="view = view === 'card' ? 'table' : 'card'">
            {{ view === 'card' ? '表格视图' : '卡片视图' }}
          </el-button>
        </el-col>
      </el-row>
    </div>

    <!-- 卡片视图 -->
    <el-row v-if="view === 'card'" :gutter="16" v-loading="loading">
      <el-col :span="8" v-for="inst in list" :key="inst.INSTANCE_ID" class="mb-16">
        <div class="inst-card" @click="goDetail(inst.INSTANCE_ID)">
          <div class="inst-card-header">
            <div class="inst-name">
              <el-tag :type="dbTypeColor(inst.DB_TYPE)" size="small">{{ inst.DB_TYPE }}</el-tag>
              <span>{{ inst.INSTANCE_NAME }}</span>
            </div>
            <div class="inst-status" :class="`status-${inst.STATUS?.toLowerCase()}`">
              <span class="status-dot"></span> {{ statusLabel(inst.STATUS) }}
            </div>
          </div>
          <div class="inst-card-body">
            <div class="inst-info-row">
              <el-icon><Location /></el-icon> {{ inst.HOST_IP }}:{{ inst.PORT }}
            </div>
            <div class="inst-info-row">
              <el-icon><OfficeBuilding /></el-icon> {{ inst.BIZ_LINE || '-' }}
              <el-tag size="small" style="margin-left:8px">{{ inst.ENVIRONMENT }}</el-tag>
            </div>
          </div>
          <div class="inst-card-footer">
            <div class="health-score-wrap">
              <span class="health-label">健康分</span>
              <span :class="scoreClass(inst.HEALTH_SCORE)">{{ inst.HEALTH_SCORE }}</span>
            </div>
            <el-badge v-if="inst.OPEN_ALERTS > 0" :value="inst.OPEN_ALERTS" type="danger">
              <el-tag size="small" type="danger">未处理告警</el-tag>
            </el-badge>
            <el-tag v-else size="small" type="success">无告警</el-tag>
          </div>
        </div>
      </el-col>
    </el-row>

    <!-- 表格视图 -->
    <div v-else class="card" v-loading="loading">
      <el-table :data="list" stripe border @row-click="row => goDetail(row.INSTANCE_ID)">
        <el-table-column label="实例名称" min-width="160">
          <template #default="{ row }">
            <el-link type="primary">{{ row.INSTANCE_NAME }}</el-link>
          </template>
        </el-table-column>
        <el-table-column label="类型" width="100">
          <template #default="{ row }">
            <el-tag :type="dbTypeColor(row.DB_TYPE)" size="small">{{ row.DB_TYPE }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="HOST_IP"    label="主机IP"  width="140" />
        <el-table-column prop="PORT"       label="端口"    width="80" />
        <el-table-column prop="ENVIRONMENT" label="环境"   width="80" />
        <el-table-column prop="BIZ_LINE"   label="业务线" min-width="100" show-overflow-tooltip />
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <span :class="`status-${row.STATUS?.toLowerCase()}`">
              {{ statusLabel(row.STATUS) }}
            </span>
          </template>
        </el-table-column>
        <el-table-column label="健康分" width="90">
          <template #default="{ row }">
            <span :class="scoreClass(row.HEALTH_SCORE)">{{ row.HEALTH_SCORE }}</span>
          </template>
        </el-table-column>
        <el-table-column label="告警" width="80">
          <template #default="{ row }">
            <el-badge v-if="row.OPEN_ALERTS > 0" :value="row.OPEN_ALERTS" type="danger" />
            <el-icon v-else color="#52c41a"><Check /></el-icon>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="100">
          <template #default="{ row }">
            <el-button link type="primary" @click.stop="goDetail(row.INSTANCE_ID)">详情</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { monitorApi } from '@/api/index.js'
import { ElMessage } from 'element-plus'

const router  = useRouter()
const loading = ref(false)
const list    = ref([])
const view    = ref('card')
const q       = reactive({ keyword: '', status: '', dbType: '', env: '' })

const statusOpts = [
  { label: '运行中', value: 'RUNNING' }, { label: '已停止', value: 'STOPPED' },
  { label: '异常', value: 'ERROR' },     { label: '未知', value: 'UNKNOWN' },
]

function statusLabel(s) {
  return { RUNNING: '运行中', STOPPED: '已停止', ERROR: '异常', UNKNOWN: '未知' }[s] || s
}
function dbTypeColor(t) {
  return { ORACLE: 'danger', MYSQL: 'primary', POSTGRESQL: 'success' }[t] || 'info'
}
function scoreClass(s) {
  return s >= 80 ? 'score-high' : s >= 60 ? 'score-medium' : 'score-low'
}

async function load() {
  loading.value = true
  try {
    const res = await monitorApi.instances()
    if (res.code !== 200) { ElMessage.error(res.msg || '加载失败'); return }
    let data = res.data || []
    if (q.keyword) data = data.filter(r => r.INSTANCE_NAME?.includes(q.keyword) || r.HOST_IP?.includes(q.keyword))
    if (q.status)  data = data.filter(r => r.STATUS === q.status)
    if (q.dbType)  data = data.filter(r => r.DB_TYPE === q.dbType)
    if (q.env)     data = data.filter(r => r.ENVIRONMENT === q.env)
    list.value = data
    ElMessage.success(`已刷新，共 ${data.length} 个实例`)
  } catch (e) { ElMessage.error(e?.message || '加载失败') }
  finally { loading.value = false }
}

function goDetail(id) { router.push(`/monitor/${id}`) }

onMounted(load)
</script>

<style scoped>
.inst-card {
  background: var(--agent-panel-bg, #ffffff);
  border: 1px solid var(--agent-border, #e4e7ed);
  border-radius: 10px;
  padding: 16px;
  cursor: pointer;
  box-shadow: none;
  transition: all .2s;
}
.inst-card:hover {
  border-color: #1890ff;
  box-shadow: 0 0 0 1px rgba(24, 144, 255, 0.35);
  transform: translateY(-2px);
}
.inst-card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
.inst-name { display: flex; align-items: center; gap: 8px; font-size: 15px; font-weight: 600; color: var(--agent-text, #303133); }
.inst-status { font-size: 13px; display: flex; align-items: center; gap: 4px; }
.status-dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; display: inline-block; }
.inst-card-body { margin-bottom: 12px; }
.inst-info-row { display: flex; align-items: center; gap: 6px; color: var(--agent-text-muted, #909399); font-size: 13px; margin-bottom: 6px; }
.inst-card-footer { display: flex; align-items: center; justify-content: space-between; border-top: 1px solid var(--agent-border, #e4e7ed); padding-top: 10px; }
.health-score-wrap { display: flex; align-items: center; gap: 6px; }
.health-label { color: var(--agent-text-muted, #909399); font-size: 12px; }
</style>
