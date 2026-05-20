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

    <el-row :gutter="16">
      <el-col :span="14">
        <!-- SLA 报表 -->
        <div class="card mb-16">
          <div class="card-title" style="justify-content:space-between">
            <span><el-icon><TrendCharts /></el-icon> SLA 可用性报表</span>
            <el-radio-group v-model="slaRange" size="small">
              <el-radio-button label="7d">近7天</el-radio-button>
              <el-radio-button label="30d">近30天</el-radio-button>
              <el-radio-button label="90d">近90天</el-radio-button>
            </el-radio-group>
          </div>
          <el-table :data="slaData" stripe border size="small">
            <el-table-column prop="INSTANCE_NAME" label="实例" min-width="150" />
            <el-table-column prop="DB_TYPE" label="类型" width="90">
              <template #default="{ row }">
                <el-tag :type="dtColor(row.DB_TYPE)" size="small">{{ row.DB_TYPE }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="健康分" width="85">
              <template #default="{ row }">
                <span :class="scoreClass(row.HEALTH_SCORE)">{{ row.HEALTH_SCORE }}</span>
              </template>
            </el-table-column>
            <el-table-column prop="ENVIRONMENT" label="环境" width="80" />
            <el-table-column label="未处理告警" width="100">
              <template #default="{ row }">
                <el-badge v-if="row.OPEN_ALERTS > 0" :value="row.OPEN_ALERTS" type="danger" />
                <el-icon v-else color="#52c41a"><Check /></el-icon>
              </template>
            </el-table-column>
            <el-table-column label="状态" width="90">
              <template #default="{ row }">
                <span :class="`status-${row.STATUS?.toLowerCase()}`">{{ slabel(row.STATUS) }}</span>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="80">
              <template #default="{ row }">
                <el-button link type="primary" size="small" @click="$router.push(`/monitor/${row.INSTANCE_ID}`)">详情</el-button>
              </template>
            </el-table-column>
          </el-table>
        </div>

        <!-- 告警趋势 -->
        <div class="card">
          <div class="card-title"><el-icon><DataAnalysis /></el-icon> 告警趋势（近7天）</div>
          <div ref="trendChartRef" style="height:240px"></div>
        </div>
      </el-col>

      <el-col :span="10">
        <!-- 巡检报告 -->
        <div class="card mb-16">
          <div class="card-title" style="justify-content:space-between">
            <span><el-icon><Document /></el-icon> 自动巡检报告</span>
            <el-button type="primary" size="small" icon="RefreshRight" @click="genReport" :loading="genLoading">
              生成报告
            </el-button>
          </div>
          <el-alert type="info" :closable="false" class="mb-16" show-icon>
            选择目标实例生成综合巡检报告，包含健康评分、告警汇总、Top SQL、表空间状态
          </el-alert>
          <el-select v-model="reportInstId" placeholder="选择实例" style="width:100%;margin-bottom:12px" clearable>
            <el-option v-for="i in instances" :key="i.INSTANCE_ID"
              :label="`${i.INSTANCE_NAME} (${i.DB_TYPE})`" :value="i.INSTANCE_ID" />
          </el-select>
          <div v-if="reportContent" class="report-box">
            <pre>{{ reportContent }}</pre>
          </div>
        </div>

        <!-- 告警分布饼图 -->
        <div class="card">
          <div class="card-title"><el-icon><PieChart /></el-icon> 告警级别分布</div>
          <div ref="pieChartRef" style="height:220px"></div>
          <el-table :data="alertStats" size="small" :show-header="false" style="margin-top:8px">
            <el-table-column>
              <template #default="{ row }">
                <span :class="`badge-${row.SEVERITY?.toLowerCase()}`">{{ row.SEVERITY }}</span>
              </template>
            </el-table-column>
            <el-table-column prop="SEVERITY" label="级别" width="80" />
            <el-table-column prop="CNT" label="数量" width="80" />
            <el-table-column label="说明" min-width="120">
              <template #default="{ row }">
                <span class="text-gray">{{ sevDesc(row.SEVERITY) }}</span>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </el-col>
    </el-row>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import { monitorApi, alertApi } from '@/api/index.js'
import { ElMessage } from 'element-plus'
import * as echarts from 'echarts'

const router = useRouter()
const instances     = ref([])
const slaData       = ref([])
const alertStats    = ref([])
const trendData     = ref([])
const slaRange      = ref('7d')
const reportInstId  = ref(null)
const reportContent = ref('')
const genLoading    = ref(false)
const trendChartRef = ref()
const pieChartRef   = ref()

const statCards = computed(() => {
  const total   = slaData.value.length
  const running = slaData.value.filter(r => r.STATUS === 'RUNNING').length
  const healthy = slaData.value.filter(r => r.HEALTH_SCORE >= 80).length
  const openA   = slaData.value.reduce((acc, r) => acc + (r.OPEN_ALERTS || 0), 0)
  return [
    { label:'实例总数',   val: total,   icon:'🗄️', g1:'#1890ff', g2:'#096dd9' },
    { label:'正常运行',   val: running, icon:'✅', g1:'#52c41a', g2:'#389e0d' },
    { label:'健康实例',   val: healthy, icon:'💪', g1:'#722ed1', g2:'#531dab' },
    { label:'未处理告警', val: openA,   icon:'🔔', g1:'#ff4d4f', g2:'#cf1322' },
  ]
})

function dtColor(t) { return { ORACLE:'danger', MYSQL:'primary', POSTGRESQL:'success' }[t] || 'info' }
function slabel(s) { return { RUNNING:'运行中', STOPPED:'已停止', ERROR:'异常', UNKNOWN:'未知' }[s] || s }
function scoreClass(s) { return s >= 80 ? 'score-high' : s >= 60 ? 'score-medium' : 'score-low' }
function sevDesc(s) { return { P1:'紧急，需立即处理', P2:'严重，尽快处理', P3:'警告，关注', P4:'提示' }[s] || '' }

async function load() {
  try {
    const [instRes, alertRes] = await Promise.all([
      monitorApi.instances(),
      alertApi.stats(),
    ])
    slaData.value     = instRes.data || []
    instances.value   = slaData.value
    alertStats.value  = alertRes.data?.bySeverity || []
    trendData.value   = alertRes.data?.trend || []
    await nextTick()
    initCharts()
  } catch (e) { console.error(e) }
}

function initCharts() {
  // Trend chart
  if (trendChartRef.value) {
    const c = echarts.getInstanceByDom(trendChartRef.value) || echarts.init(trendChartRef.value)
    c.setOption({
      backgroundColor: 'transparent',
      textStyle: { color: '#909399' },
      tooltip: { trigger: 'axis' },
      grid: { left: 40, right: 20, top: 20, bottom: 30 },
      xAxis: {
        type: 'category',
        data: trendData.value.map(d => d.DT),
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
        name: '告警数', type: 'line', smooth: true,
        data: trendData.value.map(d => d.CNT),
        areaStyle: { opacity: 0.15 },
        itemStyle: { color: '#ff7a45' }, lineStyle: { color: '#ff7a45' },
        markPoint: { data: [{ type: 'max', name: '最大值' }] },
      }],
    })
    window.addEventListener('resize', () => c.resize())
  }

  // Pie chart
  if (pieChartRef.value) {
    const c = echarts.getInstanceByDom(pieChartRef.value) || echarts.init(pieChartRef.value)
    const colors = { P1: '#ff4d4f', P2: '#fa541c', P3: '#faad14', P4: '#52c41a' }
    c.setOption({
      backgroundColor: 'transparent',
      textStyle: { color: '#909399' },
      tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
      series: [{
        type: 'pie', radius: ['35%', '65%'], center: ['50%', '50%'],
        data: alertStats.value.map(r => ({
          name: r.SEVERITY, value: r.CNT,
          itemStyle: { color: colors[r.SEVERITY] || '#aaa' },
        })),
        label: { formatter: '{b}\n{c}个' },
      }],
    })
    window.addEventListener('resize', () => c.resize())
  }
}

async function genReport() {
  if (!reportInstId.value) return ElMessage.warning('请选择实例')
  genLoading.value = true
  try {
    const inst = instances.value.find(i => i.INSTANCE_ID === reportInstId.value)
    const alertRes = await alertApi.list({ instanceId: reportInstId.value, size: 5 }).catch(() => ({ data: { list: [] } }))
    const openAlerts = alertRes.data?.list?.filter(a => a.STATUS === 'OPEN') || []

    const now = new Date().toLocaleString('zh-CN')
    reportContent.value = `
========================================
  数据库智能平台 - 自动巡检报告
  生成时间：${now}
========================================

【实例基本信息】
  实例名称：${inst?.INSTANCE_NAME || '-'}
  数据库类型：${inst?.DB_TYPE || '-'}
  主机地址：${inst?.HOST_IP}:${inst?.PORT}
  环境：${inst?.ENVIRONMENT || '-'}
  当前状态：${slabel(inst?.STATUS)}

【健康评分】
  当前健康分：${inst?.HEALTH_SCORE ?? '-'} / 100
  评价：${inst?.HEALTH_SCORE >= 80 ? '✅ 健康' : inst?.HEALTH_SCORE >= 60 ? '⚠️ 需关注' : '❌ 异常'}

【未处理告警（前5条）】
${openAlerts.length === 0 ? '  ✅ 无未处理告警' :
  openAlerts.map((a, i) => `  ${i+1}. [${a.SEVERITY}] ${a.CONTENT}`).join('\n')}

【巡检结论】
  ${inst?.HEALTH_SCORE >= 80 ? '整体运行正常，建议持续监控。' :
    inst?.HEALTH_SCORE >= 60 ? '存在轻微问题，请关注告警并处理。' :
    '存在严重问题，请立即处理告警！'}

========================================
  报告由平台自动生成  |  仅供参考
========================================`.trim()
    ElMessage.success('报告生成完成')
  } finally { genLoading.value = false }
}

onMounted(load)
</script>

<style scoped>
.report-box {
  background: #f5f7fa; color: #303133; border-radius: 8px; padding: 16px;
  font-family: 'Consolas', monospace; font-size: 12px; line-height: 1.7;
  white-space: pre-wrap; max-height: 300px; overflow-y: auto;
}
</style>
