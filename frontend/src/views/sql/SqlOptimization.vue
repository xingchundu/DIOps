<template>
  <div class="sql-opt-layout">
    <div class="sql-opt-agent-wrap">
      <iframe
        :key="iframeKey"
        :src="iframeSrc"
        title="SQL 优化 Agent"
        class="sql-agent-iframe"
        referrerpolicy="strict-origin-when-cross-origin"
      />
    </div>
    <aside class="sql-opt-rail" aria-label="平台慢 SQL">
      <div class="card">
        <div class="card-title rail-title">
          <span><el-icon><Clock /></el-icon> 慢SQL列表</span>
          <div class="rail-toolbar">
            <el-select v-model="slowInstId" placeholder="实例" clearable size="small" style="width: 140px" @change="loadSlow">
              <el-option
                v-for="i in instances"
                :key="i.INSTANCE_ID"
                :label="i.INSTANCE_NAME"
                :value="i.INSTANCE_ID"
              />
            </el-select>
            <el-button size="small" icon="Refresh" @click="loadSlow">刷新</el-button>
          </div>
        </div>
        <el-table :data="slowSqls" v-loading="slowLoading" stripe size="small" class="rail-table" max-height="360">
          <el-table-column prop="INSTANCE_NAME" label="实例" width="100" show-overflow-tooltip />
          <el-table-column prop="SQL_TEXT" label="SQL" min-width="120" show-overflow-tooltip>
            <template #default="{ row }">
              <el-button link type="primary" @click="sendSqlToAgent(row.SQL_TEXT)">
                {{ row.SQL_TEXT?.slice(0, 36) }}{{ (row.SQL_TEXT?.length || 0) > 36 ? '…' : '' }}
              </el-button>
            </template>
          </el-table-column>
          <el-table-column prop="AVG_ELAPSED" label="均耗时(ms)" width="96" />
          <el-table-column prop="EXEC_COUNT" label="执行次数" width="88" />
        </el-table>
        <div class="rail-pagination">
          <el-pagination
            v-model:current-page="slowPage"
            :page-size="10"
            :total="slowTotal"
            layout="prev, pager, next"
            small
            @current-change="loadSlow"
          />
        </div>
      </div>

      <div class="card rail-capture">
        <div class="card-title"><el-icon><Download /></el-icon> 慢SQL采集</div>
        <p class="text-gray rail-hint">从被管 Oracle 实例采集 AWR/ASH 慢 SQL 到平台库</p>
        <el-select v-model="captureInstId" placeholder="选择 Oracle 实例" class="rail-select">
          <el-option
            v-for="i in oracleInstances"
            :key="i.INSTANCE_ID"
            :label="i.INSTANCE_NAME"
            :value="i.INSTANCE_ID"
          />
        </el-select>
        <el-button type="primary" :loading="capturing" class="rail-capture-btn" @click="capture">
          立即采集慢SQL
        </el-button>
      </div>
    </aside>
  </div>
</template>

<script setup>
import { computed, ref, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Clock, Download } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { sqlApi, monitorApi } from '@/api/index.js'

const route = useRoute()
const router = useRouter()

/**
 * 默认嵌入本前端同源 `/sql-agent`（Vite 代理至 Python Agent），不再单独打开 :8000。
 * 若需直连独立 Agent，设置 VITE_SQL_AGENT_ORIGIN=http://127.0.0.1:8000
 */
const iframeSrc = computed(() => {
  const envOrigin = import.meta.env.VITE_SQL_AGENT_ORIGIN
  const u = envOrigin && String(envOrigin).trim()
    ? new URL(`${String(envOrigin).replace(/\/$/, '')}/`)
    : new URL('/api/sql-agent/', typeof window !== 'undefined' ? window.location.origin : 'http://127.0.0.1:5173')
  const sql = route.query.sql
  if (sql != null && String(sql).trim()) {
    u.searchParams.set('presetSql', String(sql))
  }
  return u.toString()
})

const iframeKey = computed(() => route.fullPath)

const instances = ref([])
const oracleInstances = computed(() => instances.value.filter((x) => x.DB_TYPE === 'ORACLE'))

const slowSqls = ref([])
const slowLoading = ref(false)
const slowPage = ref(1)
const slowTotal = ref(0)
const slowInstId = ref(null)

const captureInstId = ref(null)
const capturing = ref(false)

async function loadInstances() {
  try {
    const r = await monitorApi.instances()
    instances.value = r.data || []
  } catch {
    instances.value = []
  }
}

async function loadSlow() {
  slowLoading.value = true
  try {
    const r = await sqlApi.slow({ instanceId: slowInstId.value, page: slowPage.value, size: 10 })
    slowSqls.value = r.data?.list || []
    slowTotal.value = r.data?.total || 0
  } finally {
    slowLoading.value = false
  }
}

function sendSqlToAgent(text) {
  if (!text) return
  const sql = String(text).slice(0, 500)
  router.replace({ path: '/sql', query: { ...route.query, sql } })
}

async function capture() {
  if (!captureInstId.value) return ElMessage.warning('请选择实例')
  capturing.value = true
  try {
    const r = await sqlApi.capture(captureInstId.value)
    ElMessage.success(r.msg || '采集完成')
    await loadSlow()
  } finally {
    capturing.value = false
  }
}

onMounted(async () => {
  await loadInstances()
  await loadSlow()
})
</script>

<style scoped>
.sql-opt-layout {
  display: flex;
  width: 100%;
  min-height: calc(100vh - var(--header-height));
  height: calc(100vh - var(--header-height));
  overflow: hidden;
  margin: 0;
  background: var(--app-page-bg, #f0f2f5);
}

.sql-opt-agent-wrap {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  height: 100%;
}

.sql-agent-iframe {
  display: block;
  width: 100%;
  flex: 1;
  min-height: 0;
  border: 0;
}

.sql-opt-rail {
  width: 380px;
  flex-shrink: 0;
  height: 100%;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 12px;
  border-left: 1px solid var(--agent-border, #e4e7ed);
  background: var(--app-page-bg, #f0f2f5);
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.rail-title {
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
}

.rail-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
}

.rail-table {
  width: 100%;
}

.rail-pagination {
  padding: 12px 0 0;
  display: flex;
  justify-content: flex-end;
}

.rail-capture {
  margin-bottom: 0;
}

.rail-hint {
  margin-bottom: 12px;
  line-height: 1.5;
}

.rail-select {
  width: 100%;
  margin-bottom: 12px;
}

.rail-capture-btn {
  width: 100%;
}
</style>
