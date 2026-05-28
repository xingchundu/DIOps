<template>
  <div class="page-container">
    <!-- 概览卡片 -->
    <el-row :gutter="16" class="mb-16">
      <el-col :span="6" v-for="card in statCards" :key="card.label">
        <div class="stat-card" :style="{ '--grad-start': card.g1, '--grad-end': card.g2 }">
          <div class="stat-value">{{ stats[card.key] ?? '-' }}</div>
          <div class="stat-label">{{ card.label }}</div>
          <div class="stat-icon">{{ card.icon }}</div>
        </div>
      </el-col>
    </el-row>

    <el-row :gutter="16">
      <!-- 告警趋势 -->
      <el-col :span="14">
        <div class="card">
          <div class="card-title"><el-icon><TrendCharts /></el-icon> 近7天告警趋势</div>
          <div ref="alertChartRef" style="height:260px"></div>
        </div>
      </el-col>
      <!-- 实例状态分布 -->
      <el-col :span="10">
        <div class="card">
          <div class="card-title"><el-icon><PieChart /></el-icon> 实例类型分布</div>
          <div ref="typeChartRef" style="height:260px"></div>
        </div>
      </el-col>
    </el-row>

    <el-row :gutter="16">
      <!-- 最新告警 -->
      <el-col :span="14">
        <div class="card">
          <div class="card-title" style="justify-content:space-between">
            <span><el-icon><Bell /></el-icon> 未处理告警</span>
            <el-button link type="primary" @click="$router.push('/alerts')">查看全部</el-button>
          </div>
          <el-table :data="openAlerts" size="small" :show-header="true" height="240">
            <el-table-column label="严重级别" width="90">
              <template #default="{ row }">
                <span :class="`badge-${row.SEVERITY?.toLowerCase()}`">{{ row.SEVERITY }}</span>
              </template>
            </el-table-column>
            <el-table-column prop="INSTANCE_NAME" label="实例" width="130" />
            <el-table-column prop="CONTENT" label="告警内容" show-overflow-tooltip />
            <el-table-column prop="TRIGGER_TIME" label="触发时间" width="140"
              :formatter="(r,c,v) => v ? new Date(v).toLocaleString('zh-CN') : '-'" />
          </el-table>
        </div>
      </el-col>
      <!-- 实例健康排行 -->
      <el-col :span="10">
        <div class="card">
          <div class="card-title"><el-icon><Trophy /></el-icon> 实例健康排行</div>
          <div v-for="inst in healthRank" :key="inst.INSTANCE_ID" class="health-row"
               @click="$router.push(`/monitor/${inst.INSTANCE_ID}`)">
            <div class="health-name">
              <el-tag size="small" type="info">{{ inst.DB_TYPE }}</el-tag>
              {{ inst.INSTANCE_NAME }}
            </div>
            <div class="health-bar">
              <el-progress :percentage="inst.HEALTH_SCORE || 0"
                :color="inst.HEALTH_SCORE >= 80 ? '#52c41a' : inst.HEALTH_SCORE >= 60 ? '#faad14' : '#ff4d4f'"
                :stroke-width="8" />
            </div>
          </div>
        </div>
      </el-col>
    </el-row>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, nextTick } from 'vue'
import * as echarts from 'echarts'
import { monitorApi, alertApi } from '@/api/index.js'

const stats       = ref({})
const openAlerts  = ref([])
const healthRank  = ref([])
/** 实例类型分布饼图数据（按 CMDB DB_TYPE 汇总） */
const pieTypeData = ref([])
const alertChartRef = ref()
const typeChartRef  = ref()

const _charts = []
const _resizeHandlers = []

const statCards = [
  { key: 'totalInstances',   label: '纳管实例总数', icon: '🗄️', g1: '#1890ff', g2: '#096dd9' },
  { key: 'runningInstances', label: '运行中实例',   icon: '✅', g1: '#52c41a', g2: '#389e0d' },
  { key: 'openAlerts',       label: '未处理告警',   icon: '🔔', g1: '#ff4d4f', g2: '#cf1322' },
  { key: 'healthyInstances', label: '健康实例',     icon: '💪', g1: '#722ed1', g2: '#531dab' },
]

onMounted(async () => {
  await Promise.all([loadOverview(), loadAlerts(), loadInstances()])
  await nextTick()
  initCharts()
})

async function loadOverview() {
  try { const r = await monitorApi.overview(); stats.value = r.data } catch {}
}

let alertTrend = []
async function loadAlerts() {
  try {
    const r = await alertApi.stats()
    if (r.code === 200) {
      alertTrend = r.data.trend || []
      openAlerts.value = []
      // get open alerts
      const a = await alertApi.list({ status: 'OPEN', size: 10 })
      if (a.code === 200) openAlerts.value = a.data.list || []
    }
  } catch {}
}

function buildPieTypeData(list) {
  const c = { ORACLE: 0, MYSQL: 0, POSTGRESQL: 0 }
  let other = 0
  for (const row of list) {
    const t = String(row.DB_TYPE || '').toUpperCase()
    if (t === 'ORACLE') c.ORACLE += 1
    else if (t === 'MYSQL') c.MYSQL += 1
    else if (t === 'POSTGRESQL') c.POSTGRESQL += 1
    else other += 1
  }
  const parts = [
    { name: 'Oracle', value: c.ORACLE, itemStyle: { color: '#f5222d' } },
    { name: 'MySQL', value: c.MYSQL, itemStyle: { color: '#1890ff' } },
    { name: 'PostgreSQL', value: c.POSTGRESQL, itemStyle: { color: '#52c41a' } },
  ]
  if (other > 0) parts.push({ name: '其他', value: other, itemStyle: { color: '#722ed1' } })
  const withVal = parts.filter((p) => p.value > 0)
  return withVal.length ? withVal : [{ name: '暂无纳管实例', value: 1, itemStyle: { color: '#d9d9d9' } }]
}

async function loadInstances() {
  try {
    const r = await monitorApi.instances()
    if (r.code === 200) {
      const list = r.data || []
      healthRank.value = [...list].sort((a, b) => (a.HEALTH_SCORE || 0) - (b.HEALTH_SCORE || 0)).slice(0, 6)
      pieTypeData.value = buildPieTypeData(list)
    }
  } catch {}
}

function initCharts() {
  // Alert trend chart
  if (alertChartRef.value) {
    const chart = echarts.init(alertChartRef.value)
    _charts.push(chart)
    const days  = alertTrend.map(d => d.DT)
    const cnts  = alertTrend.map(d => d.CNT)
    chart.setOption({
      backgroundColor: 'transparent',
      textStyle: { color: '#909399' },
      tooltip: { trigger: 'axis' },
      grid: { left: 40, right: 20, top: 20, bottom: 30 },
      xAxis: {
        type: 'category',
        data: days,
        axisLabel: { fontSize: 11, color: '#909399' },
        axisLine: { lineStyle: { color: '#e4e7ed' } },
      },
      yAxis: {
        type: 'value',
        minInterval: 1,
        axisLabel: { color: '#909399' },
        splitLine: { lineStyle: { color: '#e4e7ed' } },
      },
      series: [{
        name: '告警数', type: 'bar', data: cnts, barMaxWidth: 40,
        itemStyle: { color: new echarts.graphic.LinearGradient(0,0,0,1,
          [{ offset:0, color:'#ff7a45' },{ offset:1, color:'#ff4d4f' }]) },
      }],
    })
    const h1 = () => chart.resize(); window.addEventListener('resize', h1); _resizeHandlers.push(h1)
  }
  // 实例类型分布（真实按 DB_TYPE 统计）
  if (typeChartRef.value) {
    const chart = echarts.init(typeChartRef.value)
    _charts.push(chart)
    chart.setOption({
      backgroundColor: 'transparent',
      textStyle: { color: '#909399' },
      tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
      legend: { bottom: 0, textStyle: { fontSize: 12, color: '#909399' } },
      series: [{
        type: 'pie', radius: ['40%', '70%'], center: ['50%', '45%'],
        data: pieTypeData.value.length ? pieTypeData.value : [{ name: '暂无数据', value: 1, itemStyle: { color: '#d9d9d9' } }],
        label: { show: true, formatter: '{b}\n{d}%' },
      }],
    })
    const h2 = () => chart.resize(); window.addEventListener('resize', h2); _resizeHandlers.push(h2)
  }
}

onUnmounted(() => {
  _resizeHandlers.forEach(h => window.removeEventListener('resize', h))
  _charts.forEach(c => c.dispose())
  _charts.length = 0; _resizeHandlers.length = 0
})
</script>

<style scoped>
.health-row {
  display: flex; align-items: center; gap: 12px; padding: 8px 0;
  border-bottom: 1px solid var(--agent-border, #e4e7ed);
  cursor: pointer;
  transition: background .2s;
}
.health-row:hover {
  background: rgba(24, 144, 255, 0.06);
  border-radius: 6px;
  padding-left: 4px;
}
.health-name { min-width: 160px; font-size: 13px; display: flex; align-items: center; gap: 6px; color: var(--agent-text, #303133); }
.health-bar { flex: 1; }
</style>
