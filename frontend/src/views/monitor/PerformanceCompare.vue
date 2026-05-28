<template>
  <div class="page-wrap">
    <!-- 选择区域 -->
    <el-card shadow="never" class="select-card">
      <div class="select-header">
        <div class="select-title">
          <el-icon><DataAnalysis /></el-icon> 跨实例性能对比
        </div>
        <div class="select-actions">
          <el-select
            v-model="selectedIds" multiple filterable clearable collapse-tags
            placeholder="选择要对比的实例（至少2个）" style="width: 420px" size="large"
          >
            <el-option
              v-for="i in instances" :key="i.INSTANCE_ID"
              :label="`${i.INSTANCE_NAME} (${i.DB_TYPE})`" :value="i.INSTANCE_ID"
            />
          </el-select>
          <el-button type="primary" size="large" :loading="compareLoading" :disabled="selectedIds.length < 2" @click="runCompare">
            <el-icon><TrendCharts /></el-icon> 开始对比
          </el-button>
        </div>
      </div>
    </el-card>

    <!-- 对比结果 -->
    <template v-if="compared.length">
      <!-- 概览卡片 -->
      <el-row :gutter="16" class="stat-row">
        <el-col :span="6" v-for="inst in compared" :key="inst.id">
          <el-card shadow="never" class="inst-card">
            <div class="inst-card-header">
              <el-tag :type="dbTypeColor(inst.dbType)" size="small">{{ inst.dbType }}</el-tag>
              <span class="inst-card-name">{{ inst.name }}</span>
            </div>
            <div class="inst-card-metrics">
              <div class="inst-metric" v-for="m in inst.summaryMetrics" :key="m.label">
                <span class="inst-metric-label">{{ m.label }}</span>
                <span class="inst-metric-value" :style="{ color: m.color || '' }">{{ m.value }}</span>
              </div>
            </div>
          </el-card>
        </el-col>
      </el-row>

      <!-- 图表对比 -->
      <el-card shadow="never" class="chart-card">
        <div class="card-title" style="margin-bottom: 16px">
          <el-icon><Histogram /></el-icon> 指标横向对比
        </div>
        <el-row :gutter="16">
          <el-col :span="12" v-for="chartDef in chartDefs" :key="chartDef.key">
            <div class="chart-wrap">
              <div class="chart-label">{{ chartDef.label }}</div>
              <div :ref="el => setChartRef(chartDef.key, el)" style="height: 220px"></div>
            </div>
          </el-col>
        </el-row>
      </el-card>

      <!-- 明细表格 -->
      <el-card shadow="never" class="table-card">
        <div class="card-title" style="margin-bottom: 16px">
          <el-icon><Grid /></el-icon> 指标明细对比
        </div>
        <el-table :data="tableRows" stripe border size="small">
          <el-table-column prop="metric" label="指标" min-width="200" fixed />
          <el-table-column v-for="inst in compared" :key="inst.id" :label="inst.name" min-width="140" align="center">
            <template #default="{ row }">
              <span :style="{ color: cellColor(row, inst.id), fontWeight: 600 }">{{ cellValue(row, inst.id) }}</span>
            </template>
          </el-table-column>
        </el-table>
      </el-card>
    </template>

    <el-empty v-else-if="!compareLoading" description="选择至少 2 个实例后点击「开始对比」" />
  </div>
</template>

<script setup>
import { ref, computed, onMounted, nextTick, shallowRef } from 'vue'
import { monitorApi, cmdbApi } from '@/api/index.js'
import { ElMessage } from 'element-plus'
import * as echarts from 'echarts'

const instances = ref([])
const selectedIds = ref([])
const compared = ref([])
const compareLoading = ref(false)
const chartRefs = {}
const chartInstances = {}

function setChartRef(key, el) {
  if (el) chartRefs[key] = el
}

// DB type to color
function dbTypeColor(t) { return { ORACLE: 'danger', MYSQL: 'primary', POSTGRESQL: 'success', DAMENG: 'warning' }[t] || 'info' }

// Color palette for instances
const palette = ['#5470c6', '#91cc75', '#fac858', '#ee6666', '#73c0de', '#3ba272', '#fc8452', '#9a60b4', '#ea7ccc']

// Normalize metrics from different DB types to common keys
function normalizeMetrics(perfData, dbType) {
  const metrics = perfData?.metrics || []
  const sessions = perfData?.sessions || []
  const get = (name) => metrics.find(m => m.METRIC_NAME === name)?.VALUE

  const active = sessions.find(s => String(s.STATUS).toUpperCase() === 'ACTIVE')?.CNT || 0
  const inactive = sessions.find(s => String(s.STATUS).toUpperCase() === 'INACTIVE')?.CNT || 0

  const engine = (dbType || '').toUpperCase()
  if (engine === 'ORACLE') {
    return {
      bufferHit: get('Buffer Cache Hit Ratio'),
      activeSessions: get('Active Sessions') ?? active,
      connections: get('Current Logons Count') ?? (active + inactive),
      userCalls: get('User Calls Per Sec'),
      sharedPoolFree: get('Shared Pool Free %'),
      cpuPerSec: get('CPU Usage Per Sec'),
      hostCpu: get('Host CPU Usage Per Sec'),
      redoPerSec: get('Redo Generated Per Sec'),
      logonsPerSec: get('Logons Per Sec'),
    }
  }
  if (engine === 'MYSQL' || engine === 'GOLDENDB') {
    return {
      bufferHit: get('mysql_innodb_buffer_pool_hit_ratio'),
      activeSessions: get('mysql_global_status_threads_running') ?? active,
      connections: get('mysql_global_status_threads_connected') ?? (active + inactive),
      userCalls: get('mysql_global_status_questions_total'),
      sharedPoolFree: null,
      cpuPerSec: null,
      hostCpu: null,
      redoPerSec: null,
      logonsPerSec: get('mysql_global_status_connections'),
    }
  }
  if (engine === 'POSTGRESQL') {
    return {
      bufferHit: get('pg_buffer_cache_hit_ratio'),
      activeSessions: active,
      connections: get('pg_stat_database_numbackends') ?? (active + inactive),
      userCalls: get('pg_stat_database_xact_commit'),
      sharedPoolFree: null,
      cpuPerSec: null,
      hostCpu: null,
      redoPerSec: null,
      logonsPerSec: null,
    }
  }
  // Dameng
  return {
    bufferHit: get('Buffer Cache Hit Ratio'),
    activeSessions: get('Active Sessions') ?? active,
    connections: get('Current Logons Count') ?? (active + inactive),
    userCalls: get('User Calls Per Sec'),
    sharedPoolFree: get('Shared Pool Free %'),
    cpuPerSec: get('CPU Usage Per Sec'),
    hostCpu: get('Host CPU Usage Per Sec'),
    redoPerSec: get('Redo Generated Per Sec'),
    logonsPerSec: get('Logons Per Sec'),
  }
}

// Metric definitions for display
const metricDefs = [
  { key: 'bufferHit', label: '缓冲命中率(%)', unit: '%', higher: true },
  { key: 'activeSessions', label: '活跃会话数', unit: '', higher: false },
  { key: 'connections', label: '连接数', unit: '', higher: false },
  { key: 'userCalls', label: '用户调用(累计)', unit: '', higher: null },
  { key: 'sharedPoolFree', label: 'Shared Pool空闲(%)', unit: '%', higher: true },
  { key: 'cpuPerSec', label: 'CPU使用(/s)', unit: '', higher: false },
  { key: 'hostCpu', label: '主机CPU(%)', unit: '%', higher: false },
  { key: 'redoPerSec', label: 'Redo生成(/s)', unit: '', higher: null },
  { key: 'logonsPerSec', label: '登录(/s)', unit: '', higher: null },
]

const chartDefs = [
  { key: 'bufferHit', label: '缓冲命中率 (%)' },
  { key: 'activeSessions', label: '活跃会话数' },
  { key: 'connections', label: '连接数' },
  { key: 'cpuPerSec', label: 'CPU 使用' },
]

async function loadInstances() {
  try {
    const res = await cmdbApi.list({ size: 999 })
    instances.value = (res.data?.rows || res.data || []).filter(i => i.STATUS === 'RUNNING')
  } catch {}
}

async function runCompare() {
  if (selectedIds.value.length < 2) return ElMessage.warning('请至少选择 2 个实例')
  compareLoading.value = true
  try {
    const results = await Promise.allSettled(
      selectedIds.value.map(async id => {
        const inst = instances.value.find(i => i.INSTANCE_ID === id)
        const [perfRes, waitsRes] = await Promise.all([
          monitorApi.performance(id),
          monitorApi.waits(id).catch(() => ({ data: [] })),
        ])
        const norm = normalizeMetrics(perfRes.data, inst?.DB_TYPE)
        return { id, name: inst?.INSTANCE_NAME || `#${id}`, dbType: inst?.DB_TYPE, norm, waits: waitsRes.data || [] }
      })
    )
    const success = results.filter(r => r.status === 'fulfilled').map(r => r.value)
    if (!success.length) { ElMessage.error('所有实例采集失败'); compareLoading.value = false; return }

    // Build summary metrics for each instance
    compared.value = success.map(inst => {
      const n = inst.norm
      const summaryMetrics = [
        { label: '命中率', value: n.bufferHit != null ? n.bufferHit.toFixed(1) + '%' : '-', color: n.bufferHit != null && n.bufferHit < 95 ? '#E6A23C' : '#67C23A' },
        { label: '活跃会话', value: n.activeSessions ?? '-', color: n.activeSessions > 50 ? '#F56C6C' : '' },
        { label: '连接数', value: n.connections ?? '-', color: '' },
        { label: '主机CPU', value: n.hostCpu != null ? n.hostCpu.toFixed(1) + '%' : '-', color: n.hostCpu != null && n.hostCpu > 80 ? '#F56C6C' : '' },
      ]
      return { ...inst, summaryMetrics }
    })

    await nextTick()
    renderCharts()
  } catch (e) { ElMessage.error(e.message) }
  compareLoading.value = false
}

function renderCharts() {
  const names = compared.value.map(i => i.name.length > 10 ? i.name.slice(0, 10) + '…' : i.name)
  chartDefs.forEach(def => {
    const el = chartRefs[def.key]
    if (!el) return
    const c = chartInstances[def.key] || echarts.init(el)
    chartInstances[def.key] = c
    const data = compared.value.map((inst, idx) => ({
      value: inst.norm[def.key] ?? 0,
      itemStyle: { color: palette[idx % palette.length], borderRadius: [4, 4, 0, 0] },
    }))
    c.setOption({
      backgroundColor: 'transparent',
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      grid: { left: 48, right: 16, top: 24, bottom: 32 },
      xAxis: { type: 'category', data: names, axisLabel: { color: '#606266', fontSize: 11, rotate: names.some(n => n.length > 6) ? 20 : 0 } },
      yAxis: { type: 'value', scale: true, axisLabel: { color: '#909399' }, splitLine: { lineStyle: { color: '#e4e7ed' } } },
      series: [{ type: 'bar', barWidth: 32, data, label: { show: true, position: 'top', fontSize: 11, color: '#606266' } }],
    }, true)
  })
}

// Table rows
const tableRows = computed(() => {
  return metricDefs.map(def => {
    const row = { key: def.key, metric: def.label, unit: def.unit, higher: def.higher, values: {} }
    compared.value.forEach(inst => {
      row.values[inst.id] = inst.norm[def.key]
    })
    return row
  })
})

function cellValue(row, instId) {
  const v = row.values[instId]
  if (v == null) return '-'
  return typeof v === 'number' ? (Number.isInteger(v) ? v.toLocaleString() : v.toFixed(2)) : v
}

function cellColor(row, instId) {
  const v = row.values[instId]
  if (v == null) return ''
  const vals = Object.values(row.values).filter(x => x != null)
  if (vals.length < 2) return ''
  const max = Math.max(...vals)
  const min = Math.min(...vals)
  if (max === min) return ''
  if (row.higher === true) return v === max ? '#67C23A' : v === min ? '#F56C6C' : ''
  if (row.higher === false) return v === max ? '#F56C6C' : v === min ? '#67C23A' : ''
  return ''
}

onMounted(loadInstances)
</script>

<style scoped>
.page-wrap { padding: 16px; }
.select-card { margin-bottom: 16px; }
.select-header { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; }
.select-title { font-size: 18px; font-weight: 700; display: flex; align-items: center; gap: 8px; color: var(--agent-text, #303133); }
.select-actions { display: flex; gap: 12px; align-items: center; }

.stat-row { margin-bottom: 16px; }
.inst-card { text-align: center; }
.inst-card-header { display: flex; align-items: center; justify-content: center; gap: 8px; margin-bottom: 12px; }
.inst-card-name { font-size: 15px; font-weight: 600; color: var(--agent-text, #303133); }
.inst-card-metrics { display: flex; flex-direction: column; gap: 8px; }
.inst-metric { display: flex; justify-content: space-between; align-items: center; font-size: 13px; }
.inst-metric-label { color: var(--agent-text-muted, #909399); }
.inst-metric-value { font-weight: 700; font-size: 16px; }

.chart-card { margin-bottom: 16px; }
.chart-wrap { margin-bottom: 12px; }
.chart-label { font-size: 13px; font-weight: 600; color: var(--agent-text, #303133); margin-bottom: 4px; }
.card-title { font-size: 15px; font-weight: 600; display: flex; align-items: center; gap: 6px; color: var(--agent-text, #303133); }
</style>
