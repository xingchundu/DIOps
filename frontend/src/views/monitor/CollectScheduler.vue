<template>
  <div class="page-container">
    <div class="card mb-16">
      <div class="card-title" style="justify-content:space-between;flex-wrap:wrap;gap:12px">
        <span><el-icon><Timer /></el-icon> 定时采集观测</span>
        <div class="toolbar">
          <el-tag type="info">自动刷新 {{ autoSec }}s</el-tag>
          <el-button size="small" icon="Refresh" :loading="loading" @click="fetchStatus">立即刷新</el-button>
        </div>
      </div>
      <el-descriptions v-if="sched" :column="2" border size="small" class="mb-16">
        <el-descriptions-item label="采集周期">
          每 <strong>{{ sched.intervalSeconds }}</strong> 秒（{{ sched.intervalMs }} ms）
        </el-descriptions-item>
        <el-descriptions-item label="环境变量">{{ sched.envKey }}</el-descriptions-item>
        <el-descriptions-item label="进程启动后首次采集延迟">{{ sched.initialDelayMs }} ms（约 {{ (sched.initialDelayMs / 1000).toFixed(0) }} 秒）</el-descriptions-item>
        <el-descriptions-item label="服务端时间">{{ serverTimeText }}</el-descriptions-item>
      </el-descriptions>
      <el-alert v-if="sampleTableMissing" type="warning" :closable="false" show-icon class="mb-16">
        未检测到 MONITOR_METRIC_SAMPLE 表，请执行平台库迁移脚本；下方「最近样本」列为空时，仍可参考 CMDB「最后采集」时间。
      </el-alert>
      <el-table :data="rows" v-loading="loading" stripe border size="small" max-height="520">
        <el-table-column prop="INSTANCE_ID" label="ID" width="64" />
        <el-table-column prop="INSTANCE_NAME" label="实例名称" min-width="140" show-overflow-tooltip />
        <el-table-column prop="DB_TYPE" label="类型" width="100" />
        <el-table-column label="定时任务" width="100">
          <template #default="{ row }">
            <el-tag v-if="Number(row.IN_SCHEDULER) === 1" type="success" size="small">参与</el-tag>
            <el-tag v-else type="info" size="small">跳过</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="STATUS" label="CMDB状态" width="90" />
        <el-table-column label="CMDB最后采集" min-width="155" show-overflow-tooltip>
          <template #default="{ row }">{{ fmt(row.LAST_CHECK) }}</template>
        </el-table-column>
        <el-table-column label="最近样本时间" min-width="155" show-overflow-tooltip>
          <template #default="{ row }">{{ fmt(row.LAST_SAMPLE_TIME) }}</template>
        </el-table-column>
        <el-table-column label="最近样本" width="100">
          <template #default="{ row }">
            <template v-if="row.LAST_SAMPLE_TIME != null">
              <el-tag v-if="Number(row.LAST_SAMPLE_OK) === 1" type="success" size="small">成功</el-tag>
              <el-tag v-else type="danger" size="small">失败</el-tag>
            </template>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
        <el-table-column prop="LAST_SAMPLE_ERR" label="失败原因" min-width="160" show-overflow-tooltip />
      </el-table>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { monitorApi } from '@/api/index.js'

const loading = ref(false)
const sched = ref(null)
const serverTime = ref('')
const rows = ref([])
const sampleTableMissing = ref(false)
const autoSec = 10

let timer = null

const serverTimeText = computed(() =>
  serverTime.value ? new Date(serverTime.value).toLocaleString('zh-CN') : '—'
)

function fmt(v) {
  return v ? new Date(v).toLocaleString('zh-CN') : '—'
}

async function fetchStatus() {
  loading.value = true
  try {
    const r = await monitorApi.collectSchedulerStatus()
    if (r.code === 200 && r.data) {
      sched.value = r.data.scheduler
      serverTime.value = r.data.serverTime || ''
      rows.value = r.data.instances || []
      sampleTableMissing.value = !!r.data.sampleTableMissing
    }
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  fetchStatus()
  timer = setInterval(fetchStatus, autoSec * 1000)
})

onUnmounted(() => {
  if (timer) clearInterval(timer)
})
</script>

<style scoped>
.page-container { padding: 0; }
.card-title {
  display: flex; align-items: center; gap: 8px;
  font-size: 16px; font-weight: 600; margin-bottom: 16px;
}
.toolbar { display: flex; align-items: center; gap: 10px; }
.muted { color: var(--agent-text-tertiary, #b0b3b8); }
</style>
