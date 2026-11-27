<template>
  <div v-loading="loading">
    <el-alert v-if="!instanceId" type="info" :closable="false" show-icon title="请选择实例后查看该 SQL 的运行画像" />
    <template v-else-if="data.asset">
      <el-descriptions :column="4" size="small" border>
        <el-descriptions-item label="近 N 天">{{ data.days }} 天</el-descriptions-item>
        <el-descriptions-item label="执行次数">{{ data.totals?.EXECS ?? 0 }}</el-descriptions-item>
        <el-descriptions-item label="DB Time(s)">{{ num(data.totals?.DB_TIME_SEC) }}</el-descriptions-item>
        <el-descriptions-item label="P95 / 窗口最大(ms)">{{ num(data.totals?.P95_MS) }} / {{ num(data.totals?.MAX_WINDOW_AVG_MS) }}</el-descriptions-item>
        <el-descriptions-item label="计划数">{{ data.quality?.planCount }}</el-descriptions-item>
        <el-descriptions-item label="绑定变量">
          <el-tag size="small" :type="{ GOOD: 'success', FAIR: 'warning', POOR: 'danger' }[data.quality?.bindQuality]">{{ { GOOD: '良好', FAIR: '一般', POOR: '较差' }[data.quality?.bindQuality] }}</el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="原生 SQL ID 数">{{ data.quality?.nativeIdsOnInstance }}（全部实例 {{ data.quality?.nativeIdsTotal }}）</el-descriptions-item>
        <el-descriptions-item label="解析">{{ data.asset.PARSE_STATUS }}</el-descriptions-item>
      </el-descriptions>
      <div class="text-gray" style="margin: 6px 0">{{ data.quality?.bindText }}；{{ data.quality?.parseText }}</div>
      <div ref="el" class="chart" />
      <div class="card-title">等待事件分布（活动会话采样，累计）</div>
      <el-table :data="data.waits || []" size="small" empty-text="暂无采样（该 SQL 尚未在活动会话中被采到）">
        <el-table-column prop="WAIT_EVENT" label="等待事件" min-width="200" show-overflow-tooltip />
        <el-table-column prop="SAMPLES" label="命中采样" width="90" />
        <el-table-column label="占比" width="80"><template #default="{ row }">{{ row.SHARE == null ? '-' : (row.SHARE * 100).toFixed(0) + '%' }}</template></el-table-column>
        <el-table-column label="累计等待(s)" width="100"><template #default="{ row }">{{ num(row.WAIT_SEC) }}</template></el-table-column>
        <el-table-column label="最近" width="120"><template #default="{ row }">{{ fmtTime(row.LAST_SEEN) }}</template></el-table-column>
      </el-table>
      <div class="card-title" style="margin-top: 10px">执行计划</div>
      <el-table :data="data.plans || []" size="small">
        <el-table-column prop="PLAN_HASH" label="计划" min-width="160" show-overflow-tooltip />
        <el-table-column prop="EXECS" label="执行次数" width="90" />
        <el-table-column label="平均(ms)" width="90"><template #default="{ row }">{{ num(row.AVG_MS) }}</template></el-table-column>
        <el-table-column label="单次逻辑读" width="100"><template #default="{ row }">{{ num(row.LR_PER_EXEC) }}</template></el-table-column>
        <el-table-column label="首次 / 最近" width="180"><template #default="{ row }">{{ fmtTime(row.FIRST_SEEN) }} / {{ fmtTime(row.LAST_SEEN) }}</template></el-table-column>
      </el-table>
    </template>
  </div>
</template>

<script setup>
import { ref, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import * as echarts from 'echarts'
import { sqlInsightApi } from '@/api/index.js'
import { num, fmtTime, hh } from './sqlInsightUtil.js'

const props = defineProps({ assetId: { type: Number, required: true }, instanceId: { type: [Number, String], default: null } })
const data = ref({})
const loading = ref(false)
const el = ref(null)
let chart = null

async function load() {
  if (!props.instanceId) return
  loading.value = true
  try {
    data.value = (await sqlInsightApi.profile(props.assetId, { instanceId: props.instanceId, days: 7 })).data || {}
    await nextTick()
    draw()
  } catch { data.value = {} } finally { loading.value = false }
}

function draw() {
  if (!el.value) return
  if (!chart) chart = echarts.init(el.value)
  const hrs = Array.from({ length: 24 }, (_, i) => i)
  const pick = (rows, f) => hrs.map((h) => { const r = (rows || []).find((x) => Number(x.HR) === h); return r ? r[f] : null })
  chart.setOption({
    tooltip: { trigger: 'axis' },
    legend: { top: 0, type: 'scroll' },
    grid: { left: 50, right: 60, top: 40, bottom: 30 },
    xAxis: { type: 'category', data: hrs.map(hh) },
    yAxis: [{ type: 'value', name: '执行次数 / 耗时(ms)', scale: true }, { type: 'value', name: '主机CPU% / 连接数', scale: true }],
    series: [
      { name: '执行次数', type: 'bar', data: pick(data.value.hourly, 'EXECS'), barMaxWidth: 14, itemStyle: { opacity: 0.55 } },
      { name: '平均耗时(ms)', type: 'line', showSymbol: false, data: pick(data.value.hourly, 'AVG_MS') },
      { name: '单次CPU(ms)', type: 'line', showSymbol: false, data: pick(data.value.hourly, 'CPU_PER_EXEC_MS') },
      { name: '单次物理读', type: 'line', showSymbol: false, data: pick(data.value.hourly, 'PR_PER_EXEC') },
      { name: '实例主机CPU%', type: 'line', yAxisIndex: 1, showSymbol: false, lineStyle: { type: 'dashed' }, data: pick(data.value.instanceHourly, 'HOST_CPU_PCT') },
      { name: '实例连接数', type: 'line', yAxisIndex: 1, showSymbol: false, lineStyle: { type: 'dotted' }, data: pick(data.value.instanceHourly, 'CONNECTIONS') },
    ],
  }, true)
}

const onResize = () => chart && chart.resize()
watch(() => [props.assetId, props.instanceId], load)
onMounted(() => { window.addEventListener('resize', onResize); load() })
onBeforeUnmount(() => { window.removeEventListener('resize', onResize); chart && chart.dispose() })
</script>

<style scoped>
.chart { height: 280px; width: 100%; margin-top: 8px; }
</style>
