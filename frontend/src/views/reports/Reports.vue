<template>
  <div class="page-container">
    <!-- 统计卡片 -->
    <el-row :gutter="16" class="mb-16">
      <el-col :span="6" v-for="c in statCards" :key="c.label">
        <div class="stat-card" :style="{'--grad-start':c.g1,'--grad-end':c.g2}">
          <div class="stat-value">{{ c.val }}</div>
          <div class="stat-label">{{ c.label }}</div>
          <div class="stat-icon">{{ c.icon }}</div>
        </div>
      </el-col>
    </el-row>

    <!-- 报表 Tabs -->
    <el-tabs v-model="activeTab" type="card" @tab-click="onTabChange">
      <!-- ① 综合概览 -->
      <el-tab-pane label="综合概览" name="overview">
        <el-row :gutter="16">
          <el-col :span="14">
            <div class="card mb-16">
              <div class="card-title"><el-icon><Bell /></el-icon> 未处理告警 Top 5</div>
              <el-table :data="overview.topAlerts" stripe size="small">
                <el-table-column label="级别" width="70">
                  <template #default="{ row }"><span :class="`badge-${row.SEVERITY?.toLowerCase()}`">{{ row.SEVERITY }}</span></template>
                </el-table-column>
                <el-table-column prop="CONTENT" label="告警内容" min-width="240" show-overflow-tooltip />
                <el-table-column prop="INSTANCE_ID" label="实例ID" width="80" />
                <el-table-column prop="TRIGGER_TIME" label="触发时间" width="155" />
              </el-table>
            </div>
          </el-col>
          <el-col :span="10">
            <div class="card">
              <div class="card-title"><el-icon><PieChart /></el-icon> 实例健康分布</div>
              <div ref="healthPieRef" style="height:240px"></div>
            </div>
          </el-col>
        </el-row>
      </el-tab-pane>

      <!-- ② SLA 可用性 -->
      <el-tab-pane label="SLA 可用性" name="sla">
        <div class="card mb-16">
          <div class="card-title" style="justify-content:space-between">
            <span><el-icon><TrendCharts /></el-icon> SLA 可用性报表</span>
            <el-radio-group v-model="slaRange" size="small" @change="loadSla">
              <el-radio-button label="7d">近7天</el-radio-button>
              <el-radio-button label="30d">近30天</el-radio-button>
              <el-radio-button label="90d">近90天</el-radio-button>
            </el-radio-group>
          </div>
          <el-row :gutter="16" class="mb-16">
            <el-col :span="8">
              <div class="metric-card">
                <div class="metric-val primary">{{ slaData.globalSla ?? '-' }}%</div>
                <div class="metric-name">全局 SLA</div>
              </div>
            </el-col>
            <el-col :span="8">
              <div class="metric-card">
                <div class="metric-val" :style="{ color: slaData.mttrHours > 4 ? '#F56C6C' : '#67C23A' }">{{ slaData.mttrHours ?? '-' }}h</div>
                <div class="metric-name">MTTR（平均恢复时间）</div>
              </div>
            </el-col>
            <el-col :span="8">
              <div class="metric-card">
                <div class="metric-val warning">{{ slaData.instances?.length || 0 }}</div>
                <div class="metric-name">监控实例数</div>
              </div>
            </el-col>
          </el-row>
          <el-table :data="slaData.instances" stripe border size="small">
            <el-table-column prop="INSTANCE_NAME" label="实例" min-width="150" />
            <el-table-column prop="DB_TYPE" label="类型" width="90">
              <template #default="{ row }"><el-tag :type="dtColor(row.DB_TYPE)" size="small">{{ row.DB_TYPE }}</el-tag></template>
            </el-table-column>
            <el-table-column label="健康分" width="85">
              <template #default="{ row }"><span :class="scoreClass(row.HEALTH_SCORE)">{{ row.HEALTH_SCORE }}</span></template>
            </el-table-column>
            <el-table-column label="SLA 可用率" width="120">
              <template #default="{ row }">
                <span v-if="row.SLA_PCT != null" :style="{ color: row.SLA_PCT >= 99 ? '#67C23A' : row.SLA_PCT >= 95 ? '#E6A23C' : '#F56C6C', fontWeight: 600 }">
                  {{ row.SLA_PCT }}%
                </span>
                <span v-else class="text-muted">-</span>
              </template>
            </el-table-column>
            <el-table-column prop="ENVIRONMENT" label="环境" width="80" />
            <el-table-column label="未处理告警" width="100">
              <template #default="{ row }">
                <el-badge v-if="row.OPEN_ALERTS > 0" :value="row.OPEN_ALERTS" type="danger" />
                <el-icon v-else color="#52c41a"><Check /></el-icon>
              </template>
            </el-table-column>
            <el-table-column label="采样数" width="100" prop="TOTAL_SAMPLES" />
            <el-table-column label="状态" width="90">
              <template #default="{ row }"><span :class="`status-${row.STATUS?.toLowerCase()}`">{{ slabel(row.STATUS) }}</span></template>
            </el-table-column>
          </el-table>
        </div>
      </el-tab-pane>

      <!-- ③ 告警趋势 -->
      <el-tab-pane label="告警趋势" name="alertTrend">
        <div class="card mb-16">
          <div class="card-title" style="justify-content:space-between">
            <span><el-icon><DataAnalysis /></el-icon> 告警趋势分析</span>
            <el-radio-group v-model="trendDays" size="small" @change="loadAlertTrend">
              <el-radio-button :label="7">近7天</el-radio-button>
              <el-radio-button :label="30">近30天</el-radio-button>
            </el-radio-group>
          </div>
          <el-row :gutter="16" class="mb-16">
            <el-col :span="6">
              <div class="metric-card">
                <div class="metric-val">{{ alertTrend.resolution?.TOTAL || 0 }}</div>
                <div class="metric-name">总告警数</div>
              </div>
            </el-col>
            <el-col :span="6">
              <div class="metric-card">
                <div class="metric-val success">{{ alertTrend.resolution?.RESOLVED || 0 }}</div>
                <div class="metric-name">已解决</div>
              </div>
            </el-col>
            <el-col :span="6">
              <div class="metric-card">
                <div class="metric-val primary">{{ alertTrend.resolution?.RESOLVE_RATE || 0 }}%</div>
                <div class="metric-name">解决率</div>
              </div>
            </el-col>
            <el-col :span="6">
              <div class="metric-card">
                <div class="metric-val warning">{{ alertTrend.bySeverity?.length || 0 }}</div>
                <div class="metric-name">涉及级别</div>
              </div>
            </el-col>
          </el-row>
          <el-row :gutter="16">
            <el-col :span="14">
              <div class="sub-title">每日告警趋势</div>
              <div ref="trendLineRef" style="height:260px"></div>
            </el-col>
            <el-col :span="10">
              <div class="sub-title">告警级别分布</div>
              <div ref="trendPieRef" style="height:260px"></div>
            </el-col>
          </el-row>
        </div>
        <div class="card">
          <div class="sub-title">Top 5 告警实例</div>
          <el-table :data="alertTrend.byInstance" stripe size="small">
            <el-table-column prop="INSTANCE_NAME" label="实例" min-width="200" />
            <el-table-column prop="CNT" label="告警数" width="120" />
            <el-table-column label="占比" min-width="200">
              <template #default="{ row }">
                <el-progress :percentage="Math.round(row.CNT / (alertTrend.resolution?.TOTAL || 1) * 100)" :stroke-width="10" />
              </template>
            </el-table-column>
          </el-table>
        </div>
      </el-tab-pane>

      <!-- ④ 容量分析 -->
      <el-tab-pane label="容量分析" name="capacity">
        <el-row :gutter="16">
          <el-col :span="14">
            <div class="card mb-16">
              <div class="card-title"><el-icon><Coin /></el-icon> 表空间使用情况</div>
              <div ref="capBarRef" style="height:300px"></div>
            </div>
          </el-col>
          <el-col :span="10">
            <div class="card mb-16">
              <div class="card-title"><el-icon><Warning /></el-icon> 高使用率警告 (≥80%)</div>
              <el-table :data="capacityData.highUsage" stripe size="small" max-height="280">
                <el-table-column prop="INSTANCE_NAME" label="实例" width="120" />
                <el-table-column prop="TABLESPACE_NAME" label="表空间" min-width="130" show-overflow-tooltip />
                <el-table-column label="使用率" width="120">
                  <template #default="{ row }">
                    <el-progress :percentage="row.USED_PCT || 0" :color="row.USED_PCT>=90 ? '#ff4d4f' : '#faad14'" :stroke-width="8" />
                  </template>
                </el-table-column>
              </el-table>
            </div>
          </el-col>
        </el-row>
        <div class="card">
          <div class="card-title"><el-icon><Connection /></el-icon> 实例连接数</div>
          <el-table :data="capacityData.connections" stripe size="small">
            <el-table-column prop="INSTANCE_NAME" label="实例" min-width="160" />
            <el-table-column prop="DB_TYPE" label="类型" width="100">
              <template #default="{ row }"><el-tag :type="dtColor(row.DB_TYPE)" size="small">{{ row.DB_TYPE }}</el-tag></template>
            </el-table-column>
            <el-table-column prop="CONNECTIONS" label="当前连接数" width="120" />
          </el-table>
        </div>
      </el-tab-pane>

      <!-- ⑤ SQL 质量 -->
      <el-tab-pane label="SQL 质量" name="sqlQuality">
        <el-row :gutter="16">
          <el-col :span="14">
            <div class="card mb-16">
              <div class="card-title"><el-icon><Document /></el-icon> SQL 评审统计</div>
              <el-row :gutter="16" class="mb-16">
                <el-col :span="6">
                  <div class="metric-card"><div class="metric-val primary">{{ sqlQuality.review?.TOTAL || 0 }}</div><div class="metric-name">总工单</div></div>
                </el-col>
                <el-col :span="6">
                  <div class="metric-card"><div class="metric-val success">{{ sqlQuality.review?.APPROVED || 0 }}</div><div class="metric-name">已通过</div></div>
                </el-col>
                <el-col :span="6">
                  <div class="metric-card"><div class="metric-val danger">{{ sqlQuality.review?.REJECTED || 0 }}</div><div class="metric-name">已拒绝</div></div>
                </el-col>
                <el-col :span="6">
                  <div class="metric-card"><div class="metric-val warning">{{ sqlQuality.review?.AVG_SCORE || '-' }}</div><div class="metric-name">平均评分</div></div>
                </el-col>
              </el-row>
              <div ref="sqlPieRef" style="height:220px"></div>
            </div>
          </el-col>
          <el-col :span="10">
            <div class="card">
              <div class="card-title"><el-icon><Document /></el-icon> 最近优化记录</div>
              <el-table :data="sqlQuality.topSql" stripe size="small" max-height="400">
                <el-table-column prop="SQL_ID" label="SQL_ID" width="110" />
                <el-table-column prop="SQL_TEXT" label="SQL" min-width="200" show-overflow-tooltip />
                <el-table-column prop="EXECUTIONS" label="执行次数" width="90" />
              </el-table>
            </div>
          </el-col>
        </el-row>
      </el-tab-pane>

      <!-- ⑥ 巡检汇总 -->
      <el-tab-pane label="巡检汇总" name="inspect">
        <el-row :gutter="16">
          <el-col :span="14">
            <div class="card">
              <div class="card-title"><el-icon><Notebook /></el-icon> 最近巡检报告</div>
              <el-table :data="inspectData.recentReports" stripe size="small">
                <el-table-column prop="REPORT_ID" label="报告ID" width="80" />
                <el-table-column prop="TASK_ID" label="任务ID" width="80" />
                <el-table-column prop="INSTANCE_ID" label="实例ID" width="80" />
                <el-table-column prop="SCORE" label="评分" width="80">
                  <template #default="{ row }"><span :class="scoreClass(row.SCORE)">{{ row.SCORE }}</span></template>
                </el-table-column>
                <el-table-column prop="RISK_LEVEL" label="风险" width="90">
                  <template #default="{ row }"><el-tag :type="riskColor(row.RISK_LEVEL)" size="small">{{ row.RISK_LEVEL }}</el-tag></template>
                </el-table-column>
                <el-table-column prop="CREATED_AT" label="生成时间" width="155" />
              </el-table>
            </div>
          </el-col>
          <el-col :span="10">
            <div class="card">
              <div class="card-title"><el-icon><SetUp /></el-icon> 巡检任务状态</div>
              <div ref="inspectPieRef" style="height:260px"></div>
            </div>
          </el-col>
        </el-row>
      </el-tab-pane>

      <!-- ⑦ AI 分析统计 -->
      <el-tab-pane label="AI 分析" name="aiStats">
        <el-row :gutter="16" class="mb-16">
          <el-col :span="6">
            <div class="metric-card"><div class="metric-val primary">{{ aiStats.rca?.TOTAL || 0 }}</div><div class="metric-name">RCA 分析次数</div></div>
          </el-col>
          <el-col :span="6">
            <div class="metric-card"><div class="metric-val warning">{{ aiStats.anomaly?.TOTAL || 0 }}</div><div class="metric-name">异常检测记录</div></div>
          </el-col>
          <el-col :span="6">
            <div class="metric-card"><div class="metric-val success">{{ aiStats.cluster?.TOTAL || 0 }}</div><div class="metric-name">告警聚类</div></div>
          </el-col>
          <el-col :span="6">
            <div class="metric-card"><div class="metric-val">{{ aiStats.chat?.SESSIONS || 0 }}</div><div class="metric-name">ChatOps 会话</div></div>
          </el-col>
        </el-row>
        <el-row :gutter="16">
          <el-col :span="12">
            <div class="card">
              <div class="card-title"><el-icon><MagicStick /></el-icon> AI 分析概览</div>
              <el-descriptions :column="2" border size="small">
                <el-descriptions-item label="RCA 平均置信度">{{ aiStats.rca?.AVG_CONFIDENCE ?? '-' }}%</el-descriptions-item>
                <el-descriptions-item label="严重异常数">{{ aiStats.anomaly?.CRITICAL_CNT || 0 }}</el-descriptions-item>
                <el-descriptions-item label="活跃聚类">{{ aiStats.cluster?.ACTIVE_CNT || 0 }}</el-descriptions-item>
                <el-descriptions-item label="ChatOps 消息数">{{ aiStats.chat?.MESSAGES || 0 }}</el-descriptions-item>
              </el-descriptions>
            </div>
          </el-col>
          <el-col :span="12">
            <div class="card">
              <div class="card-title"><el-icon><MagicStick /></el-icon> 最近 RCA 分析</div>
              <el-table :data="aiStats.recentRca" stripe size="small">
                <el-table-column prop="RCA_ID" label="ID" width="60" />
                <el-table-column prop="INSTANCE_ID" label="实例" width="70" />
                <el-table-column prop="ROOT_CAUSE" label="根因" min-width="200" show-overflow-tooltip />
                <el-table-column prop="CONFIDENCE" label="置信度" width="80">
                  <template #default="{ row }"><span :style="{ color: row.CONFIDENCE >= 70 ? '#67C23A' : '#E6A23C' }">{{ row.CONFIDENCE }}%</span></template>
                </el-table-column>
              </el-table>
            </div>
          </el-col>
        </el-row>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, nextTick } from 'vue'
import { reportApi } from '@/api/index.js'
import * as echarts from 'echarts'

const activeTab = ref('overview')

// ── 统计卡片 ──
const overview = reactive({ instance: {}, alert: {}, topAlerts: [], healthDist: [] })
const statCards = computed(() => {
  const inst = overview.instance, alrt = overview.alert
  return [
    { label: '实例总数', val: inst.TOTAL || 0, icon: '🗄️', g1: '#1890ff', g2: '#096dd9' },
    { label: '正常运行', val: inst.RUNNING || 0, icon: '✅', g1: '#52c41a', g2: '#389e0d' },
    { label: '未处理告警', val: alrt.OPEN_CNT || 0, icon: '🔔', g1: '#ff4d4f', g2: '#cf1322' },
    { label: '平均健康分', val: inst.AVG_SCORE || '-', icon: '💪', g1: '#722ed1', g2: '#531dab' },
  ]
})

// ── SLA ──
const slaRange = ref('7d')
const slaData = reactive({ globalSla: null, mttrHours: null, instances: [] })

// ── 告警趋势 ──
const trendDays = ref(7)
const alertTrend = reactive({ byDay: [], bySeverity: [], byInstance: [], resolution: {} })

// ── 容量 ──
const capacityData = reactive({ tablespaces: [], connections: [], highUsage: [] })

// ── SQL 质量 ──
const sqlQuality = reactive({ topSql: [], review: {}, reviewByStatus: [] })

// ── 巡检 ──
const inspectData = reactive({ recentReports: [], taskByStatus: [] })

// ── AI ──
const aiStats = reactive({ rca: {}, anomaly: {}, cluster: {}, chat: {}, recentRca: [] })

// Chart refs
const healthPieRef = ref()
const trendLineRef = ref()
const trendPieRef = ref()
const capBarRef = ref()
const sqlPieRef = ref()
const inspectPieRef = ref()

// ── Helpers ──
function dtColor(t) { return { ORACLE: 'danger', MYSQL: 'primary', POSTGRESQL: 'success', DAMENG: 'warning' }[t] || 'info' }
function slabel(s) { return { RUNNING: '运行中', STOPPED: '已停止', ERROR: '异常', UNKNOWN: '未知' }[s] || s }
function scoreClass(s) { return s >= 80 ? 'score-high' : s >= 60 ? 'score-medium' : 'score-low' }
function riskColor(r) { return { LOW: 'success', MEDIUM: 'warning', HIGH: 'danger', CRITICAL: 'danger' }[r] || 'info' }
function sevColor(s) { return { P1: '#ff4d4f', P2: '#fa541c', P3: '#faad14', P4: '#52c41a' }[s] || '#aaa' }

// ── 加载函数 ──
async function loadOverview() {
  try {
    const res = await reportApi.overview()
    if (res.code === 200) Object.assign(overview, res.data)
    await nextTick(); renderHealthPie()
  } catch {}
}

async function loadSla() {
  try {
    const res = await reportApi.sla({ range: slaRange.value })
    if (res.code === 200) Object.assign(slaData, res.data)
  } catch {}
}

async function loadAlertTrend() {
  try {
    const res = await reportApi.alertTrend({ days: trendDays.value })
    if (res.code === 200) Object.assign(alertTrend, res.data)
    await nextTick(); renderTrendCharts()
  } catch {}
}

async function loadCapacity() {
  try {
    const res = await reportApi.capacity()
    if (res.code === 200) Object.assign(capacityData, res.data)
    await nextTick(); renderCapBar()
  } catch {}
}

async function loadSqlQuality() {
  try {
    const res = await reportApi.sqlQuality()
    if (res.code === 200) Object.assign(sqlQuality, res.data)
    await nextTick(); renderSqlPie()
  } catch {}
}

async function loadInspect() {
  try {
    const res = await reportApi.inspectSummary()
    if (res.code === 200) Object.assign(inspectData, res.data)
    await nextTick(); renderInspectPie()
  } catch {}
}

async function loadAiStats() {
  try {
    const res = await reportApi.aiStats()
    if (res.code === 200) Object.assign(aiStats, res.data)
  } catch {}
}

// ── Charts ──
function renderHealthPie() {
  if (!healthPieRef.value || !overview.healthDist.length) return
  const c = echarts.getInstanceByDom(healthPieRef.value) || echarts.init(healthPieRef.value)
  const colors = { '健康(≥80)': '#52c41a', '关注(60-79)': '#faad14', '异常(<60)': '#ff4d4f' }
  c.setOption({
    backgroundColor: 'transparent', tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
    series: [{ type: 'pie', radius: ['35%', '65%'], center: ['50%', '50%'],
      data: overview.healthDist.map(r => ({ name: r.GRADE, value: r.CNT, itemStyle: { color: colors[r.GRADE] || '#aaa' } })),
      label: { formatter: '{b}\n{c}台' },
    }],
  })
}

function renderTrendCharts() {
  // Line
  if (trendLineRef.value && alertTrend.byDay.length) {
    const c = echarts.getInstanceByDom(trendLineRef.value) || echarts.init(trendLineRef.value)
    c.setOption({
      backgroundColor: 'transparent', tooltip: { trigger: 'axis' },
      grid: { left: 40, right: 20, top: 20, bottom: 30 },
      xAxis: { type: 'category', data: alertTrend.byDay.map(d => d.DT), axisLabel: { fontSize: 11, color: '#909399' } },
      yAxis: { type: 'value', minInterval: 1, axisLabel: { color: '#909399' }, splitLine: { lineStyle: { color: '#e4e7ed' } } },
      series: [{ name: '告警数', type: 'line', smooth: true, data: alertTrend.byDay.map(d => d.CNT),
        areaStyle: { opacity: 0.15 }, itemStyle: { color: '#ff7a45' }, lineStyle: { color: '#ff7a45' },
        markPoint: { data: [{ type: 'max', name: '最大值' }] },
      }],
    })
  }
  // Pie
  if (trendPieRef.value && alertTrend.bySeverity.length) {
    const c = echarts.getInstanceByDom(trendPieRef.value) || echarts.init(trendPieRef.value)
    c.setOption({
      backgroundColor: 'transparent', tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
      series: [{ type: 'pie', radius: ['35%', '65%'],
        data: alertTrend.bySeverity.map(r => ({ name: r.SEVERITY, value: r.CNT, itemStyle: { color: sevColor(r.SEVERITY) } })),
        label: { formatter: '{b}\n{c}个' },
      }],
    })
  }
}

function renderCapBar() {
  if (!capBarRef.value || !capacityData.tablespaces.length) return
  const c = echarts.getInstanceByDom(capBarRef.value) || echarts.init(capBarRef.value)
  const top10 = capacityData.tablespaces.slice(0, 10)
  c.setOption({
    backgroundColor: 'transparent', tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    grid: { left: 16, right: 30, top: 20, bottom: 30, containLabel: true },
    xAxis: { type: 'value', name: 'GB', axisLabel: { color: '#909399' } },
    yAxis: { type: 'category', data: top10.map(t => `${t.INSTANCE_NAME}/${t.TABLESPACE_NAME}`).reverse(),
      axisLabel: { color: '#606266', fontSize: 11 } },
    series: [
      { name: '已用', type: 'bar', stack: 'total', data: top10.map(t => t.USED_GB || 0).reverse(),
        itemStyle: { color: '#ff4d4f', borderRadius: [0, 0, 0, 0] } },
      { name: '剩余', type: 'bar', stack: 'total', data: top10.map(t => t.FREE_GB || 0).reverse(),
        itemStyle: { color: '#52c41a', borderRadius: [0, 4, 4, 0] } },
    ],
  })
}

function renderSqlPie() {
  if (!sqlPieRef.value || !sqlQuality.reviewByStatus.length) return
  const c = echarts.getInstanceByDom(sqlPieRef.value) || echarts.init(sqlPieRef.value)
  const statusColors = { PENDING: '#E6A23C', IN_REVIEW: '#409EFF', APPROVED: '#67C23A', REJECTED: '#F56C6C', CHANGES_REQUESTED: '#faad14', CANCELLED: '#909399' }
  c.setOption({
    backgroundColor: 'transparent', tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
    series: [{ type: 'pie', radius: ['35%', '65%'],
      data: sqlQuality.reviewByStatus.map(r => ({ name: r.STATUS, value: r.CNT, itemStyle: { color: statusColors[r.STATUS] || '#aaa' } })),
      label: { formatter: '{b}\n{c}' },
    }],
  })
}

function renderInspectPie() {
  if (!inspectPieRef.value || !inspectData.taskByStatus.length) return
  const c = echarts.getInstanceByDom(inspectPieRef.value) || echarts.init(inspectPieRef.value)
  const statusColors = { ACTIVE: '#67C23A', DISABLED: '#909399', RUNNING: '#409EFF' }
  c.setOption({
    backgroundColor: 'transparent', tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
    series: [{ type: 'pie', radius: ['35%', '65%'],
      data: inspectData.taskByStatus.map(r => ({ name: r.STATUS, value: r.CNT, itemStyle: { color: statusColors[r.STATUS] || '#aaa' } })),
      label: { formatter: '{b}\n{c}' },
    }],
  })
}

// ── Tab 切换 ──
function onTabChange({ paneName }) {
  const loaders = { overview: loadOverview, sla: loadSla, alertTrend: loadAlertTrend, capacity: loadCapacity,
    sqlQuality: loadSqlQuality, inspect: loadInspect, aiStats: loadAiStats }
  loaders[paneName]?.()
}

onMounted(loadOverview)
</script>

<style scoped>
.metric-card {
  background: var(--agent-panel-deep, #f5f7fa); border-radius: 8px; padding: 16px;
  text-align: center; border: 1px solid var(--agent-border, #e4e7ed);
}
.metric-val { font-size: 28px; font-weight: 700; color: var(--agent-text, #303133); }
.metric-val.primary { color: var(--el-color-primary); }
.metric-val.success { color: var(--el-color-success); }
.metric-val.warning { color: var(--el-color-warning); }
.metric-val.danger { color: var(--el-color-danger); }
.metric-name { font-size: 13px; color: var(--agent-text-muted, #909399); margin-top: 4px; }
.sub-title { font-size: 14px; font-weight: 600; margin-bottom: 8px; color: var(--agent-text, #303133); }
</style>
