<template>
  <div class="card">
    <div class="filters">
      <el-select v-model="hours" size="small" style="width: 130px" @change="load">
        <el-option label="最近 6 小时" :value="6" /><el-option label="最近 12 小时" :value="12" /><el-option label="最近 24 小时" :value="24" />
      </el-select>
      <span class="text-gray">对比同一时间段：今日 vs 昨日 vs 30 天前；SQL CPU 时间来自采集的 CPU 计数器，主机 CPU 来自监控采样。</span>
    </div>
    <el-empty v-if="!instanceId" description="请先在上方选择一个实例" :image-size="70" />
    <template v-else>
      <el-alert v-if="data.verdict" :type="alertType" :closable="false" show-icon :title="data.verdict.text" style="margin-bottom: 10px" />
      <div v-if="data.coverage" class="text-gray" style="margin-bottom: 6px">
        样本覆盖（整点小时，不含当前未走完的小时）：
        <span v-for="k in ['today', 'yesterday', 'lastMonth']" :key="k" style="margin-right: 12px">{{ { today: '当前', yesterday: '昨日', lastMonth: '上月' }[k] }} {{ data.coverage[k]?.hours }}/{{ data.coverage[k]?.wanted }}
          <template v-if="data.coverage[k]?.rollupHours">（含小时汇总 {{ data.coverage[k].rollupHours }}）</template></span>
      </div>
      <div class="kpis" v-if="data.summary">
        <div v-for="k in kpis" :key="k.key" class="kpi">
          <div class="kpi-label">{{ k.label }}</div>
          <div class="kpi-num">{{ k.sql }} <small>秒</small></div>
          <div class="text-gray">主机 CPU {{ k.host }}</div>
        </div>
        <div class="kpi">
          <div class="kpi-label">相对倍率（SQL CPU）</div>
          <div class="kpi-num">{{ ratio(data.verdict?.vsYesterday) }} <small>vs 昨日</small></div>
          <div class="text-gray">{{ ratio(data.verdict?.vsLastMonth) }} vs 上月</div>
        </div>
      </div>
      <div ref="chartEl" class="chart" v-loading="loading" />
      <div class="card-title">CPU 增量 Top SQL（当前窗口 vs 昨日同时段）</div>
      <el-table :data="data.topDelta || []" size="small" stripe>
        <el-table-column label="SQL_ID" width="150" show-overflow-tooltip><template #default="{ row }"><span class="mono">{{ shortSqlId(row.NATIVE_SQL_ID) }}</span></template></el-table-column>
        <el-table-column label="SQL" min-width="260" show-overflow-tooltip>
          <template #default="{ row }"><el-button link type="primary" @click="$emit('open-asset', row.ASSET_ID, row.INSTANCE_ID)">#{{ row.ASSET_ID }} {{ (row.SQL_TEXT || '').slice(0, 70) }}</el-button></template>
        </el-table-column>
        <el-table-column label="当前 CPU(s)" width="100"><template #default="{ row }">{{ num(row.CUR_CPU_SEC) }}</template></el-table-column>
        <el-table-column label="昨日 CPU(s)" width="100"><template #default="{ row }">{{ num(row.PREV_CPU_SEC) }}</template></el-table-column>
        <el-table-column label="增量(s)" width="90"><template #default="{ row }"><b :class="{ danger: row.DELTA_CPU_SEC > 0 }">{{ num(row.DELTA_CPU_SEC) }}</b></template></el-table-column>
        <el-table-column label="占当前 SQL CPU" width="120"><template #default="{ row }">{{ row.SHARE == null ? '-' : (row.SHARE * 100).toFixed(1) + '%' }}</template></el-table-column>
        <el-table-column label="执行次数 当前/昨日" width="140"><template #default="{ row }">{{ row.CUR_EXECS }} / {{ row.PREV_EXECS }}</template></el-table-column>
      </el-table>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import * as echarts from 'echarts'
import { sqlInsightApi } from '@/api/index.js'
import { shortSqlId, num, hh } from './sqlInsightUtil.js'

const props = defineProps({ instanceId: { type: [Number, String], default: null } })
defineEmits(['open-asset'])
const hours = ref(24)
const data = ref({})
const loading = ref(false)
const chartEl = ref(null)
let chart = null

const alertType = computed(() => ({ ABNORMAL: 'error', LOW: 'info', NORMAL: 'success', UNKNOWN: 'warning' }[data.value.verdict?.level] || 'info'))
const ratio = (v) => (v == null ? '-' : v + 'x')
const kpis = computed(() => {
  const s = data.value.summary || {}
  const name = { today: '当前窗口', yesterday: '昨日同期', lastMonth: '上月同期' }
  return ['today', 'yesterday', 'lastMonth'].map((k) => ({
    key: k, label: name[k], sql: num(s.sqlCpuSec?.[k]), host: s.hostCpuAvg?.[k] == null ? '-' : s.hostCpuAvg[k] + '%',
  }))
})

async function load() {
  if (!props.instanceId) return
  loading.value = true
  try {
    data.value = (await sqlInsightApi.cpuCompare({ instanceId: props.instanceId, hours: hours.value })).data || {}
    await nextTick()
    draw()
  } catch { data.value = {} } finally { loading.value = false }
}

function draw() {
  if (!chartEl.value) return
  if (!chart) chart = echarts.init(chartEl.value)
  const h = data.value.hours || hours.value
  const nowHour = new Date().getHours()
  const labels = Array.from({ length: h }, (_, i) => hh((nowHour - h + i + 48) % 24))
  const col = (key, f) => {
    const arr = Array(h).fill(null)
    ;(data.value.periods?.[key] || []).forEach((p) => { if (p.idx >= 0 && p.idx < h) arr[p.idx] = p[f] })
    return arr
  }
  const names = { today: '今日', yesterday: '昨日', lastMonth: '上月' }
  chart.setOption({
    tooltip: { trigger: 'axis' },
    legend: { top: 0 },
    grid: { left: 50, right: 50, top: 36, bottom: 30 },
    xAxis: { type: 'category', data: labels },
    yAxis: [{ type: 'value', name: 'SQL CPU(秒)' }, { type: 'value', name: '主机 CPU(%)', max: 100 }],
    series: [
      ...['today', 'yesterday', 'lastMonth'].map((k) => ({ name: `SQL CPU ${names[k]}`, type: 'line', showSymbol: false, data: col(k, 'sqlCpuSec'), lineStyle: k === 'today' ? { width: 3 } : { type: 'dashed' } })),
      ...['today', 'yesterday'].map((k) => ({ name: `主机 CPU ${names[k]}`, type: 'bar', yAxisIndex: 1, barMaxWidth: 10, data: col(k, 'hostCpuPct'), itemStyle: { opacity: k === 'today' ? 0.55 : 0.25 } })),
    ],
  }, true)
}

const onResize = () => chart && chart.resize()
watch(() => props.instanceId, load)
onMounted(() => { window.addEventListener('resize', onResize); load() })
onBeforeUnmount(() => { window.removeEventListener('resize', onResize); chart && chart.dispose() })
defineExpose({ load })
</script>

<style scoped>
.filters { display: flex; gap: 8px; align-items: center; margin-bottom: 10px; flex-wrap: wrap; }
.kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 10px; }
.kpi { border: 1px solid var(--el-border-color-lighter, #ebeef5); border-radius: 6px; padding: 10px 14px; }
.kpi-label { font-size: 12px; color: #909399; }
.kpi-num { font-size: 24px; font-weight: 600; }
.kpi-num small { font-size: 12px; font-weight: 400; color: #909399; }
.chart { height: 280px; width: 100%; margin-bottom: 12px; }
.danger { color: #f56c6c; }
.mono { font-family: Consolas, Menlo, monospace; font-size: 12px; }
</style>
