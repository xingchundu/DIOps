<template>
  <div class="page-container dash" v-loading="loading && !data">
    <el-alert v-if="error" :title="error" type="error" show-icon :closable="false" />

    <!-- 一句话结论 -->
    <div class="headline card" :class="headline.level">
      <div class="hl-main">
        <span class="hl-icon">{{ headline.level === 'ok' ? '✓' : '!' }}</span>
        <div>
          <div class="hl-title">{{ headline.title }}</div>
          <div class="hl-sub">{{ headline.sub }}</div>
        </div>
      </div>
      <div class="hl-meta muted">更新于 {{ lastAt || '-' }} · 每 60 秒自动刷新 <el-button link size="small" icon="Refresh" :loading="loading" @click="load">刷新</el-button></div>
    </div>

    <!-- 关键数字 -->
    <div class="kpis">
      <div v-for="k in kpis" :key="k.label" class="kpi card" @click="k.to && $router.push(k.to)">
        <div class="kpi-label">{{ k.label }}</div>
        <div class="kpi-num" :style="{ color: k.color }">{{ k.value }}<small v-if="k.unit">{{ k.unit }}</small></div>
        <div class="kpi-sub muted">{{ k.sub }}</div>
      </div>
    </div>

    <div class="row r1">
      <!-- 需要关注的实例 -->
      <div class="card">
        <div class="card-head">
          <h3>需要关注的实例 <span class="muted">{{ data?.attentionTotal || 0 }} 个</span></h3>
          <el-button link type="primary" @click="$router.push('/monitor')">监控中心</el-button>
        </div>
        <el-empty v-if="!(data?.attention || []).length" description="所有实例运行正常" :image-size="70" />
        <div v-for="it in data?.attention || []" :key="it.id" class="att" @click="$router.push(`/monitor/${it.id}`)">
          <span class="grade" :style="{ color: grade(it.grade).color, background: grade(it.grade).bg }">{{ it.status === 'STALE' ? '数据过期' : grade(it.grade).label }}</span>
          <div class="att-main">
            <div class="att-name">{{ it.name }} <span class="muted">{{ it.dbType }}{{ it.env ? ' · ' + (ENVS[it.env] || it.env) : '' }}</span></div>
            <div class="att-issue">
              {{ it.status === 'OFFLINE' ? '连接失败：' + (it.error || '') : it.status === 'STALE' ? `已 ${ago(it.ageSec).replace('前', '')}没有新数据` : it.issue || '-' }}
              <span v-if="it.issueCount > 1" class="muted">等 {{ it.issueCount }} 项</span>
            </div>
          </div>
          <span v-if="it.score != null" class="att-score" :style="{ color: grade(it.grade).color }">{{ it.score }}</span>
          <span v-if="it.alerts?.total" class="chip-red">告警 {{ it.alerts.total }}</span>
        </div>
      </div>

      <!-- 健康分布 + 按库类型 -->
      <div class="card">
        <div class="card-head"><h3>实例健康分布</h3><span class="muted">共 {{ inst.total || 0 }} 个</span></div>
        <div class="stack" v-if="inst.total">
          <i v-for="s in dist" :key="s.key" :style="{ flex: s.value, background: s.color }" :title="`${s.label} ${s.value}`" />
        </div>
        <div class="legend">
          <span v-for="s in dist" :key="s.key" class="lg" @click="$router.push('/monitor')"><i :style="{ background: s.color }" />{{ s.label }} <b>{{ s.value }}</b></span>
        </div>
        <table class="tbl">
          <thead><tr><th>库类型</th><th class="n">实例</th><th class="n">有问题</th></tr></thead>
          <tbody>
            <tr v-for="t in data?.byType || []" :key="t.dbType"><td>{{ t.dbType }}</td><td class="n">{{ t.total }}</td><td class="n" :class="{ bad: t.problem }">{{ t.problem }}</td></tr>
            <tr v-if="!(data?.byType || []).length"><td colspan="3" class="muted center">暂无纳管实例</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="row r2">
      <!-- 告警趋势 -->
      <div class="card card-chart">
        <div class="card-head card-head-stack">
          <div class="card-head-main">
            <h3>近 7 天告警</h3>
            <span class="muted chart-sub">近 24 小时新增 {{ al.last24h?.NEW_CNT ?? 0 }}，已解决 {{ al.last24h?.RESOLVED_CNT ?? 0 }}</span>
          </div>
        </div>
        <div ref="trendRef" class="chart" />
      </div>
      <!-- 最新未处理告警 -->
      <div class="card card-alerts">
        <div class="card-head"><h3>未处理告警</h3><el-button link type="primary" @click="$router.push('/alerts')">告警中心</el-button></div>
        <el-empty v-if="!(al.latest || []).length" description="没有未处理告警" :image-size="70" />
        <div v-else class="alert-list">
          <div v-for="a in al.latest || []" :key="a.ALERT_ID" class="alert-row" @click="$router.push('/alerts')">
            <span class="sev" :class="sevClass(a.SEVERITY)">{{ sevLabel(a.SEVERITY) }}</span>
            <div class="alert-main">
              <div class="alert-text" :title="a.CONTENT">{{ a.CONTENT || a.RULE_NAME }}</div>
              <div class="alert-meta muted">{{ a.INSTANCE_NAME || '平台' }} · {{ hm(a.TRIGGER_TIME) }}{{ a.STATUS === 'ACKNOWLEDGED' ? ' · 已确认' : '' }}</div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div v-if="platHealth.length" class="row" style="margin-bottom:16px">
      <div class="card" style="flex:1">
        <div class="card-head">
          <h3>平台自监控</h3>
        </div>
        <div class="mini-grid">
          <div v-for="m in platHealth" :key="m.key" class="mini">
            <b :class="{ bad: m.status === 'WARN' }">{{ m.value }}{{ m.unit === '%' ? '%' : '' }}</b>
            <span>{{ platLabel(m.key) }}</span>
          </div>
        </div>
      </div>
    </div>

    <div class="row r3">
      <!-- 容量风险 -->
      <div class="card">
        <div class="card-head"><h3>容量风险</h3><span class="muted">表空间 / 文件系统 ≥85%，连接数 ≥80%</span></div>
        <el-empty v-if="!(data?.capacity || []).length" description="没有接近上限的容量项" :image-size="60" />
        <div v-for="c in data?.capacity || []" :key="c.id + c.kind" class="cap" @click="$router.push(`/monitor/${c.id}`)">
          <span class="cap-name">{{ c.name }} <span class="muted">{{ c.kind }}</span></span>
          <div class="cap-bar"><i :style="{ width: Math.min(100, c.value) + '%', background: pctColor(c.value, c.kind === '连接数' ? 80 : 85, 95) }" /></div>
          <b class="cap-val">{{ Math.round(c.value * 10) / 10 }}%</b>
        </div>
      </div>
      <!-- SQL -->
      <div class="card">
        <div class="card-head"><h3>SQL 情况</h3><el-button link type="primary" @click="$router.push('/sql-insight')">SQL 洞察</el-button></div>
        <div class="mini-grid">
          <div class="mini" @click="$router.push('/sql-insight?tab=problems')"><b :class="{ bad: sql.criticalProblems }">{{ sql.problems ?? 0 }}</b><span>未关闭问题<template v-if="sql.criticalProblems">（严重 {{ sql.criticalProblems }}）</template></span></div>
          <div class="mini" @click="$router.push('/sql-insight?tab=anomalies')"><b :class="{ bad: sql.anomalies }">{{ sql.anomalies ?? 0 }}</b><span>性能波动</span></div>
          <div class="mini" @click="$router.push('/sql?tab=slow')"><b>{{ sql.slow24h ?? 0 }}</b><span>近 24 小时慢 SQL</span></div>
        </div>
      </div>
      <!-- 待办 -->
      <div class="card">
        <div class="card-head"><h3>待办</h3></div>
        <div class="mini-grid">
          <div class="mini" @click="$router.push('/sql-review')"><b>{{ todo.sqlReview ?? 0 }}</b><span>待审 SQL 工单</span></div>
          <div class="mini" @click="$router.push('/service-catalog')"><b>{{ todo.serviceOrders ?? 0 }}</b><span>待处理服务工单</span></div>
          <div class="mini" @click="$router.push('/automation')"><b :class="{ bad: todo.backupFailed24h }">{{ todo.backupFailed24h ?? 0 }}</b><span>近 24 小时备份失败</span></div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import * as echarts from 'echarts'
import { monitorApi, platformApi } from '@/api/index.js'
import { GRADE, ENVS, grade, pctColor, ago } from '@/components/monitor/health.js'

const data = ref(null)
const platHealth = ref([])
const PLAT_LABELS = {
  collect_success_pct: '采集成功率',
  notify_outbox_pending: '外发积压',
  backup_fail_24h: '备份失败',
  sqlinsight_open_count: 'SQL OPEN',
}
const platLabel = k => PLAT_LABELS[k] || k
const loading = ref(false)
const error = ref('')
const lastAt = ref('')
const trendRef = ref()
let chart = null
let timer = null
let trendObs = null

function ensureTrendObserver() {
  if (trendObs || !trendRef.value || typeof ResizeObserver === 'undefined') return
  trendObs = new ResizeObserver(() => chart?.resize())
  trendObs.observe(trendRef.value)
}

const inst = computed(() => data.value?.instances || {})
const al = computed(() => data.value?.alerts || {})
const sql = computed(() => data.value?.sql || {})
const todo = computed(() => data.value?.todo || {})

const SEV = { P1: { label: 'P1 严重', cls: 'p1' }, CRITICAL: { label: 'P1 严重', cls: 'p1' }, P2: { label: 'P2 重要', cls: 'p2' }, WARNING: { label: 'P2 重要', cls: 'p2' }, P3: { label: 'P3 一般', cls: 'p3' } }
const sevLabel = s => SEV[s]?.label || s || '-'
const sevClass = s => SEV[s]?.cls || 'p3'
const sevKey = s => (s === 'CRITICAL' ? 'P1' : s === 'WARNING' ? 'P2' : ['P1', 'P2'].includes(s) ? s : 'P3')

const openBy = computed(() => {
  const m = { P1: 0, P2: 0, P3: 0 }
  for (const r of al.value.open || []) m[sevKey(r.SEVERITY)] += Number(r.CNT || 0)
  return m
})

const dist = computed(() => {
  const g = inst.value.byGrade || {}
  return ['CRITICAL', 'OFFLINE', 'ATTENTION', 'HEALTHY', 'UNKNOWN'].map(k => ({ key: k, label: GRADE[k].label, color: GRADE[k].color, value: g[k] || 0 })).filter(x => x.value > 0)
})

const headline = computed(() => {
  if (!data.value) return { level: 'ok', title: '正在加载…', sub: '' }
  const g = inst.value.byGrade || {}
  const bad = (g.CRITICAL || 0) + (g.OFFLINE || 0)
  const parts = []
  if (g.CRITICAL) parts.push(`${g.CRITICAL} 个严重`)
  if (g.OFFLINE) parts.push(`${g.OFFLINE} 个离线`)
  if (g.ATTENTION) parts.push(`${g.ATTENTION} 个需关注`)
  const p1 = openBy.value.P1
  const openTotal = openBy.value.P1 + openBy.value.P2 + openBy.value.P3
  if (!inst.value.total) return { level: 'ok', title: '还没有纳管实例', sub: '在资产管理中添加数据库实例后，这里会显示整体运行情况' }
  if (bad || p1) {
    return { level: 'bad', title: `${bad ? bad + ' 个实例需要立即处理' : '有 P1 告警需要处理'}`, sub: `${parts.join('、')}；未处理告警 ${openTotal} 条${p1 ? `（P1 ${p1} 条）` : ''}` }
  }
  if (g.ATTENTION || openTotal) return { level: 'warn', title: `${g.ATTENTION || 0} 个实例需要关注`, sub: `没有严重问题；未处理告警 ${openTotal} 条` }
  return { level: 'ok', title: '所有实例运行正常', sub: `${inst.value.total} 个实例均健康，没有未处理告警` }
})

const kpis = computed(() => {
  const g = inst.value.byGrade || {}
  const total = inst.value.total || 0
  const scored = total - (g.UNKNOWN || 0)
  const healthyPct = scored ? Math.round((g.HEALTHY || 0) * 100 / scored) : null
  const openTotal = openBy.value.P1 + openBy.value.P2 + openBy.value.P3
  return [
    { label: '纳管实例', value: total, sub: `在线 ${scored - (g.OFFLINE || 0)} · 离线 ${g.OFFLINE || 0}`, to: '/monitor' },
    { label: '健康率', value: healthyPct ?? '-', unit: healthyPct != null ? '%' : '', sub: `健康 ${g.HEALTHY || 0} / 有数据 ${scored}`, color: healthyPct == null ? undefined : healthyPct >= 90 ? GRADE.HEALTHY.color : healthyPct >= 60 ? GRADE.ATTENTION.color : GRADE.CRITICAL.color, to: '/monitor' },
    { label: '未处理告警', value: openTotal, sub: `P1 ${openBy.value.P1} · P2 ${openBy.value.P2} · P3 ${openBy.value.P3}`, color: openBy.value.P1 ? GRADE.CRITICAL.color : undefined, to: '/alerts' },
    { label: 'SQL 问题', value: sql.value.problems ?? 0, sub: `性能波动 ${sql.value.anomalies ?? 0}`, color: sql.value.criticalProblems ? GRADE.CRITICAL.color : undefined, to: '/sql-insight' },
    { label: '待办', value: (todo.value.sqlReview || 0) + (todo.value.serviceOrders || 0), sub: `SQL 工单 ${todo.value.sqlReview || 0} · 服务工单 ${todo.value.serviceOrders || 0}`, to: '/sql-review' },
  ]
})

function hm(v) {
  if (!v) return '-'
  const d = new Date(v)
  const p = n => String(n).padStart(2, '0')
  return isNaN(d) ? String(v) : `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function drawTrend() {
  if (!trendRef.value) return
  const days = []
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400e3)
    days.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`)
  }
  const by = { P1: days.map(() => 0), P2: days.map(() => 0), P3: days.map(() => 0) }
  for (const r of al.value.trend || []) {
    const i = days.indexOf(r.DT)
    if (i >= 0) by[sevKey(r.SEVERITY)][i] += Number(r.CNT || 0)
  }
  chart = chart || echarts.init(trendRef.value)
  const series = [['P1', 'P1 严重', '#cf1322'], ['P2', 'P2 重要', '#fa8c16'], ['P3', 'P3 一般', '#faad14']].map(([k, n, c], idx) => ({
    name: n, type: 'bar', stack: 'a', data: by[k], barMaxWidth: 28,
    itemStyle: { color: c, borderRadius: idx === 2 ? [4, 4, 0, 0] : 0, borderColor: '#fff', borderWidth: 1 },
  }))
  chart.setOption({
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    legend: {
      type: 'scroll',
      bottom: 0,
      left: 'center',
      itemWidth: 10,
      itemHeight: 10,
      itemGap: 16,
      textStyle: { color: '#595959', fontSize: 12 },
    },
    grid: { left: 44, right: 12, top: 12, bottom: 48, containLabel: true },
    xAxis: { type: 'category', data: days.map(d => d.slice(5)), axisTick: { show: false }, axisLine: { lineStyle: { color: '#d9d9d9' } }, axisLabel: { color: '#8c8c8c', interval: 0 } },
    yAxis: { type: 'value', minInterval: 1, splitLine: { lineStyle: { color: '#f0f0f0' } }, axisLabel: { color: '#8c8c8c', width: 36, overflow: 'truncate' } },
    series,
  }, true)
  chart.resize()
  ensureTrendObserver()
}

async function load() {
  loading.value = true
  try {
    const r = await monitorApi.dashboard()
    data.value = r.data || {}
    try {
      platHealth.value = (await platformApi.health.healthLatest()).data || []
    } catch {
      platHealth.value = []
    }
    error.value = ''
    const t = new Date()
    lastAt.value = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`
    await nextTick()
    drawTrend()
  } catch (e) {
    error.value = `控制台数据加载失败：${e.message || e}`
  } finally {
    loading.value = false
  }
}

const onResize = () => chart?.resize()
onMounted(() => {
  load()
  timer = setInterval(() => { if (!document.hidden) load() }, 60000)
  window.addEventListener('resize', onResize)
})
onBeforeUnmount(() => {
  clearInterval(timer)
  window.removeEventListener('resize', onResize)
  trendObs?.disconnect()
  chart?.dispose()
})
</script>

<style scoped>
.dash { display: flex; flex-direction: column; gap: 14px; }
.card { background: #fff; border: 1px solid #ebeef5; border-radius: 10px; padding: 14px 16px; margin: 0; }
.muted { color: #8c8c8c; font-size: 12px; }
.center { text-align: center; }
.headline { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; border-left: 4px solid #52c41a; }
.headline.warn { border-left-color: #faad14; }
.headline.bad { border-left-color: #cf1322; }
.hl-main { display: flex; align-items: center; gap: 12px; }
.hl-icon { width: 34px; height: 34px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-weight: 700; font-size: 18px; background: #f6ffed; color: #389e0d; flex-shrink: 0; }
.headline.warn .hl-icon { background: #fffbe6; color: #d48806; }
.headline.bad .hl-icon { background: #fff1f0; color: #cf1322; }
.hl-title { font-size: 17px; font-weight: 600; color: #1f2329; }
.hl-sub { font-size: 13px; color: #595959; margin-top: 2px; }
.kpis { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 14px; }
.kpi { cursor: pointer; }
.kpi:hover { border-color: #91caff; }
.kpi-label { font-size: 13px; color: #595959; }
.kpi-num { font-size: 28px; font-weight: 600; color: #1f2329; margin: 4px 0 2px; font-variant-numeric: tabular-nums; }
.kpi-num small { font-size: 14px; margin-left: 2px; }
.row { display: grid; gap: 14px; }
.row > .card { min-width: 0; }
.r1 { grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); }
.r2 { grid-template-columns: minmax(300px, 3fr) minmax(320px, 2fr); align-items: stretch; }
.r3 { grid-template-columns: minmax(0, 2fr) minmax(0, 1.5fr) minmax(0, 1.5fr); }
.card-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; gap: 8px; flex-wrap: wrap; }
.card-head h3 { margin: 0; font-size: 15px; font-weight: 600; color: #1f2329; flex-shrink: 0; }
.card-head-stack { align-items: flex-start; }
.card-head-main { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.chart-sub { line-height: 1.4; word-break: keep-all; white-space: normal; }
.att { display: flex; align-items: center; gap: 10px; padding: 8px 6px; border-bottom: 1px solid #f5f5f5; cursor: pointer; border-radius: 6px; }
.att:hover { background: #fafafa; }
.grade { font-size: 12px; padding: 1px 8px; border-radius: 10px; white-space: nowrap; flex-shrink: 0; min-width: 44px; text-align: center; }
.att-main { flex: 1; min-width: 0; }
.att-name { font-size: 14px; font-weight: 500; color: #262626; }
.att-issue { font-size: 12px; color: #595959; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.att-score { font-size: 18px; font-weight: 700; font-variant-numeric: tabular-nums; }
.chip-red { font-size: 12px; color: #cf1322; background: #fff1f0; border-radius: 10px; padding: 0 8px; white-space: nowrap; }
.stack { display: flex; height: 14px; border-radius: 7px; overflow: hidden; gap: 2px; margin: 4px 0 10px; }
.stack i { display: block; min-width: 4px; }
.legend { display: flex; flex-wrap: wrap; gap: 6px 14px; font-size: 13px; color: #595959; margin-bottom: 12px; }
.lg { display: inline-flex; align-items: center; gap: 5px; cursor: pointer; }
.lg i { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
.lg b { color: #262626; }
.tbl { width: 100%; border-collapse: collapse; font-size: 13px; }
.tbl th { text-align: left; color: #8c8c8c; font-weight: 400; padding: 6px 4px; border-bottom: 1px solid #f0f0f0; }
.tbl td { padding: 6px 4px; border-bottom: 1px solid #f5f5f5; color: #262626; }
.tbl .n { text-align: right; font-variant-numeric: tabular-nums; }
.bad { color: #cf1322 !important; font-weight: 600; }
.card-chart .chart { height: 260px; min-height: 220px; width: 100%; }
.alert-list { max-height: 320px; overflow-y: auto; margin: 0 -4px; padding: 0 4px; }
.alert-row { display: flex; gap: 12px; padding: 10px 6px; border-bottom: 1px solid #f5f5f5; cursor: pointer; align-items: flex-start; }
.alert-row:last-child { border-bottom: none; }
.alert-row:hover { background: #fafafa; border-radius: 6px; }
.sev { font-size: 11px; padding: 2px 8px; border-radius: 4px; white-space: nowrap; flex: 0 0 auto; min-width: 62px; text-align: center; line-height: 1.35; }
.sev.p1 { background: #fff1f0; color: #cf1322; border: 1px solid #ffa39e; }
.sev.p2 { background: #fff7e6; color: #d46b08; border: 1px solid #ffd591; }
.sev.p3 { background: #fffbe6; color: #ad8b00; border: 1px solid #ffe58f; }
.alert-main { min-width: 0; flex: 1 1 auto; overflow: hidden; }
.alert-text { font-size: 13px; color: #262626; line-height: 1.45; word-break: break-word; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
.alert-meta { margin-top: 4px; line-height: 1.35; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cap { display: flex; align-items: center; gap: 10px; padding: 6px 0; cursor: pointer; font-size: 13px; }
.cap-name { width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #262626; }
.cap-bar { flex: 1; height: 8px; background: #f0f0f0; border-radius: 4px; overflow: hidden; }
.cap-bar i { display: block; height: 100%; border-radius: 4px; }
.cap-val { width: 52px; text-align: right; font-variant-numeric: tabular-nums; }
.mini-grid { display: grid; grid-template-columns: 1fr; gap: 8px; }
.mini { display: flex; align-items: baseline; gap: 10px; padding: 8px 10px; background: #fafafa; border-radius: 8px; cursor: pointer; }
.mini:hover { background: #f0f5ff; }
.mini b { font-size: 22px; font-variant-numeric: tabular-nums; color: #1f2329; min-width: 36px; }
.mini span { font-size: 13px; color: #595959; }
@media (max-width: 1280px) {
  .r2 { grid-template-columns: 1fr; }
  .card-chart .chart { height: 280px; }
}
@media (max-width: 1200px) {
  .kpis { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .r1, .r3 { grid-template-columns: 1fr; }
}
</style>
