<template>
  <div ref="rootEl" class="screen">
    <header class="head">
      <div class="title">
        <el-button link class="back" icon="ArrowLeft" @click="$router.push('/sql-insight')">返回</el-button>
        <h1>SQL 监控大屏</h1>
        <span class="muted">{{ now }}</span>
      </div>
      <div class="ctrl">
        <el-select v-model="instId" placeholder="全部实例" clearable filterable size="small" style="width: 200px" @change="load">
          <el-option v-for="i in instances" :key="i.INSTANCE_ID" :label="`${i.INSTANCE_NAME}（${i.DB_TYPE}）`" :value="i.INSTANCE_ID" />
        </el-select>
        <el-radio-group v-model="minutes" size="small" @change="load">
          <el-radio-button :value="60">1 小时</el-radio-button>
          <el-radio-button :value="360">6 小时</el-radio-button>
          <el-radio-button :value="1440">24 小时</el-radio-button>
        </el-radio-group>
        <span class="muted">每 30 秒刷新 · 上次 {{ lastAt || '-' }}</span>
        <el-button size="small" :loading="loading" icon="Refresh" @click="load">刷新</el-button>
        <el-button size="small" icon="FullScreen" @click="toggleFull">全屏</el-button>
      </div>
    </header>

    <el-alert v-if="error" type="error" :closable="false" show-icon :title="error" class="err" />

    <!-- KPI -->
    <section class="kpis">
      <div v-for="k in kpis" :key="k.label" class="kpi" :class="k.status" @click="k.go && $router.push(k.go)">
        <div class="kpi-num">
          <span v-if="k.status" class="dot" :title="k.statusLabel" />{{ k.value }}<small v-if="k.unit">{{ k.unit }}</small>
        </div>
        <div class="kpi-label">{{ k.label }}<span v-if="k.status" class="status-text">· {{ k.statusLabel }}</span></div>
      </div>
    </section>

    <section class="row r2">
      <div class="panel">
        <div class="panel-title">每分钟执行次数</div>
        <div ref="execEl" class="chart" />
      </div>
      <div class="panel">
        <div class="panel-title">平均耗时（ms / 次）</div>
        <div ref="avgEl" class="chart" />
      </div>
      <div class="panel feed">
        <div class="panel-title">波动事件（近 24 小时）</div>
        <div v-if="!(data.anomalyFeed || []).length" class="empty">没有波动事件</div>
        <ul>
          <li v-for="a in data.anomalyFeed || []" :key="a.ANOMALY_ID" @click="$router.push({ path: '/sql-insight', query: { tab: 'anomalies', anomalyId: a.ANOMALY_ID } })">
            <span class="sev" :class="a.SEVERITY === 'CRITICAL' ? 'critical' : 'warning'">{{ a.SEVERITY === 'CRITICAL' ? '严重' : '警告' }}</span>
            <span class="feed-main">
              <b>{{ a.INSTANCE_NAME || a.INSTANCE_ID }}</b>
              {{ a.SCOPE === 'INSTANCE' ? '实例级' : 'SQL#' + a.ASSET_ID }} · {{ metric(a.METRIC) }}
              <template v-if="a.RATIO">×{{ a.RATIO }}</template>
              <span v-if="a.PRIMARY_CAUSE" class="cause">{{ CAUSES[a.PRIMARY_CAUSE] || a.PRIMARY_CAUSE }}</span>
              <span class="muted"> {{ hm(a.LAST_TIME) }}{{ a.STATUS !== 'OPEN' ? ' · 已' + (a.STATUS === 'ACCEPTED' ? '接受' : '恢复') : '' }}</span>
            </span>
          </li>
        </ul>
      </div>
    </section>

    <section class="row r3">
      <div class="panel">
        <div class="panel-title">未关闭问题 · 按规则</div>
        <div ref="ruleEl" class="chart" />
      </div>
      <div class="panel wide">
        <div class="panel-title">Top SQL · 按 DB Time</div>
        <table class="tbl">
          <thead><tr><th>SQL</th><th>实例</th><th class="n">DB Time(s)</th><th class="n">执行</th><th class="n">平均ms</th><th class="n">逻辑读/次</th></tr></thead>
          <tbody>
            <tr v-for="r in data.topSql || []" :key="r.ASSET_ID + '-' + r.INSTANCE_ID" @click="$router.push({ path: '/sql-insight', query: { assetId: r.ASSET_ID, instanceId: r.INSTANCE_ID } })">
              <td class="sql" :title="r.SQL_TEXT">#{{ r.ASSET_ID }} {{ r.SQL_TEXT }}</td>
              <td>{{ r.INSTANCE_NAME }}</td><td class="n">{{ r.DB_TIME_SEC }}</td><td class="n">{{ r.EXECS }}</td>
              <td class="n">{{ r.AVG_MS }}</td><td class="n">{{ r.LR_PER_EXEC ?? '-' }}</td>
            </tr>
            <tr v-if="!(data.topSql || []).length"><td colspan="6" class="empty">窗口内没有采集数据</td></tr>
          </tbody>
        </table>
      </div>
      <div class="panel">
        <div class="panel-title">实例排行</div>
        <table class="tbl">
          <thead><tr><th>实例</th><th class="n">问题</th><th class="n">波动</th><th class="n">DB Time(s)</th></tr></thead>
          <tbody>
            <tr v-for="r in data.instanceRank || []" :key="r.INSTANCE_ID" @click="instId = r.INSTANCE_ID; load()">
              <td :title="r.DB_TYPE">{{ r.INSTANCE_NAME }} <span class="muted">{{ r.DB_TYPE }}</span></td>
              <td class="n" :class="{ hot: r.PROBLEMS > 0 }">{{ r.PROBLEMS }}</td>
              <td class="n" :class="{ hot: r.ANOMALIES > 0 }">{{ r.ANOMALIES }}</td>
              <td class="n">{{ r.DB_TIME_SEC }}</td>
            </tr>
            <tr v-if="!(data.instanceRank || []).length"><td colspan="4" class="empty">-</td></tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="row r4">
      <div class="panel wide">
        <div class="panel-title">慢 SQL 快照 · 近 24 小时最慢</div>
        <table class="tbl">
          <thead><tr><th>SQL</th><th>实例</th><th class="n">平均ms</th><th class="n">最大ms</th><th class="n">执行</th><th>全表扫描</th><th>采集</th></tr></thead>
          <tbody>
            <tr v-for="r in data.slowTop || []" :key="r.ROW_ID" @click="$router.push({ path: '/sql', query: { tab: 'slow', instanceId: r.INSTANCE_ID } })">
              <td class="sql" :title="r.SQL_TEXT">{{ r.SQL_TEXT }}</td><td>{{ r.INSTANCE_NAME }}</td>
              <td class="n">{{ r.AVG_ELAPSED }}</td><td class="n">{{ r.MAX_ELAPSED ?? '-' }}</td><td class="n">{{ r.EXEC_COUNT }}</td>
              <td>{{ r.FULL_SCAN == 1 || r.FULL_SCAN === 'Y' ? '是' : '' }}</td><td>{{ hm(r.CAPTURE_TIME) }}</td>
            </tr>
            <tr v-if="!(data.slowTop || []).length"><td colspan="7" class="empty">近 24 小时没有慢 SQL 快照</td></tr>
          </tbody>
        </table>
      </div>
      <div class="panel">
        <div class="panel-title">波动事件数 · 每小时</div>
        <div ref="anoEl" class="chart" />
      </div>
      <div class="panel">
        <div class="panel-title">在采集的实例 · 按库类型</div>
        <div ref="typeEl" class="chart" />
      </div>
    </section>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import * as echarts from 'echarts'
import { sqlInsightApi, monitorApi } from '@/api/index.js'

/** 深色大屏：取参考调色板的深色阶（同一组色相按深色表面重新取阶），状态色固定且始终带文字 */
const C = {
  surface: '#1a1a19', ink: '#f0efec', ink2: '#c3c2b7', muted: '#898781', grid: '#2c2c2a', axis: '#383835',
  s1: '#3987e5', s2: '#d95926', critical: '#d03b3b', warning: '#fab219',
}
const CAUSES = { PLAN_REGRESSION: '计划退化', LOCK_WAIT: '锁等待', DATA_GROWTH_OR_SKEW: '数据增长/倾斜', CACHE_OR_IO: '缓存/IO', RESOURCE_CONTENTION: '资源争用', TRAFFIC_SURGE: '调用量突增', ERROR_SURGE: '错误率升高', UNKNOWN: '未明' }
const METRICS = { avg_elapsed_ms: '平均耗时', cpu_per_exec_ms: '单次CPU', logical_reads_per_exec: '单次逻辑读', physical_reads_per_exec: '单次物理读', rows_examined_per_exec: '扫描行数', exec_per_min: '执行次数', db_time_share: 'DB Time 占比', error_rate: '错误率', scan_ratio: '扫描/返回比' }

const rootEl = ref()
const execEl = ref(); const avgEl = ref(); const ruleEl = ref(); const anoEl = ref(); const typeEl = ref()
const charts = {}
const instances = ref([])
const instId = ref(null)
const minutes = ref(60)
const data = ref({})
const loading = ref(false)
const error = ref('')
const lastAt = ref('')
const now = ref('')
let timer = null
let clock = null

const metric = m => METRICS[m] || m || '-'
const pad = n => String(n).padStart(2, '0')
function hm(v) {
  if (!v) return '-'
  const d = new Date(v)
  return isNaN(d) ? String(v) : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const fmtNum = v => (v == null || v === '' ? '-' : Number(v) >= 10000 ? (Number(v) / 10000).toFixed(1) + '万' : String(v))

const kpis = computed(() => {
  const k = data.value.kpi || {}
  const crit = Number(k.criticalProblems || 0)
  const anomalies = Number(k.openAnomalies || 0)
  return [
    { label: '采集中实例（10 分钟）', value: k.INSTANCES ?? 0 },
    { label: '活跃 SQL（10 分钟）', value: fmtNum(k.ASSETS ?? 0) },
    { label: '每分钟执行', value: fmtNum(k.EXEC_PER_MIN) },
    { label: '平均耗时', value: k.AVG_MS ?? '-', unit: 'ms' },
    { label: '错误率', value: k.ERROR_RATE == null ? '-' : (Number(k.ERROR_RATE) * 100).toFixed(2), unit: '%' },
    { label: '未关闭问题', value: k.openProblems ?? 0, go: '/sql-insight?tab=problems', ...(crit > 0 ? { status: 'critical', statusLabel: `${crit} 条严重` } : {}) },
    { label: '未恢复波动', value: anomalies, go: '/sql-insight?tab=anomalies', ...(anomalies > 0 ? { status: 'warning', statusLabel: '需关注' } : {}) },
    { label: '慢 SQL（24 小时）', value: k.slow24h ?? 0, go: '/sql?tab=slow' },
    { label: '新执行计划（24 小时）', value: k.planChanges24h ?? 0, go: '/sql-insight?tab=plans' },
  ]
})

const baseAxis = {
  axisLine: { lineStyle: { color: C.axis } }, axisTick: { show: false },
  axisLabel: { color: C.muted, fontSize: 11 }, splitLine: { lineStyle: { color: C.grid } },
}
const tooltip = { backgroundColor: '#262624', borderColor: C.axis, textStyle: { color: C.ink, fontSize: 12 } }

function chart(key, el) {
  if (!el) return null
  if (!charts[key]) charts[key] = echarts.init(el, null, { renderer: 'canvas' })
  return charts[key]
}

function line(key, el, rows, field, unit) {
  const c = chart(key, el)
  if (!c) return
  c.setOption({
    grid: { left: 52, right: 16, top: 16, bottom: 28 },
    tooltip: { ...tooltip, trigger: 'axis', axisPointer: { type: 'line', lineStyle: { color: C.muted } }, valueFormatter: v => (v == null ? '-' : `${v} ${unit}`) },
    xAxis: { type: 'category', data: rows.map(r => hm(r.T).slice(6)), ...baseAxis, splitLine: { show: false } },
    yAxis: { type: 'value', ...baseAxis },
    series: [{ type: 'line', data: rows.map(r => r[field]), showSymbol: false, symbolSize: 8, lineStyle: { width: 2, color: C.s1 }, itemStyle: { color: C.s1 },
      areaStyle: { color: 'rgba(57,135,229,0.12)' } }],
  }, true)
}

function hbar(key, el, labels, values, unit) {
  const c = chart(key, el)
  if (!c) return
  c.setOption({
    grid: { left: 8, right: 36, top: 8, bottom: 8, containLabel: true },
    tooltip: { ...tooltip, trigger: 'item', valueFormatter: v => `${v} ${unit}` },
    xAxis: { type: 'value', ...baseAxis, axisLabel: { show: false }, splitLine: { show: false } },
    yAxis: { type: 'category', data: labels, inverse: true, ...baseAxis, axisLabel: { color: C.ink2, fontSize: 11, width: 130, overflow: 'truncate' } },
    series: [{ type: 'bar', data: values, barMaxWidth: 14, itemStyle: { color: C.s1, borderRadius: [0, 4, 4, 0] },
      label: { show: true, position: 'right', color: C.ink2, fontSize: 11 } }],
  }, true)
}

function vbar(key, el, labels, values, unit) {
  const c = chart(key, el)
  if (!c) return
  c.setOption({
    grid: { left: 36, right: 12, top: 16, bottom: 28 },
    tooltip: { ...tooltip, trigger: 'item', valueFormatter: v => `${v} ${unit}` },
    xAxis: { type: 'category', data: labels, ...baseAxis, splitLine: { show: false } },
    yAxis: { type: 'value', minInterval: 1, ...baseAxis },
    series: [{ type: 'bar', data: values, barMaxWidth: 12, itemStyle: { color: C.s1, borderRadius: [4, 4, 0, 0] } }],
  }, true)
}

function render() {
  const d = data.value
  const trend = d.trend || []
  line('exec', execEl.value, trend, 'EXECS', '次')
  line('avg', avgEl.value, trend, 'AVG_MS', 'ms')
  const rules = d.problemsByRule || []
  hbar('rule', ruleEl.value, rules.map(r => `${r.RULE_CODE} ${r.RULE_NAME || ''}`), rules.map(r => r.CNT), '条')
  const ano = d.anomalyTrend || []
  vbar('ano', anoEl.value, ano.map(r => hm(r.T).slice(6, 8) + '时'), ano.map(r => r.CNT), '个')
  const types = d.dbTypes || []
  hbar('type', typeEl.value, types.map(r => r.DB_TYPE), types.map(r => r.INSTANCES), '个实例')
}

async function load() {
  loading.value = true
  try {
    const r = await sqlInsightApi.screen({ instanceId: instId.value || undefined, minutes: minutes.value })
    data.value = r.data || {}
    error.value = ''
    const t = new Date()
    lastAt.value = `${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`
    await nextTick()
    render()
  } catch (e) {
    error.value = `大屏数据加载失败：${e?.response?.data?.msg || e?.message || e}`
  } finally {
    loading.value = false
  }
}

function toggleFull() {
  if (document.fullscreenElement) document.exitFullscreen()
  else rootEl.value?.requestFullscreen?.()
}
const onResize = () => Object.values(charts).forEach(c => c.resize())

onMounted(async () => {
  try { instances.value = (await monitorApi.instances()).data || [] } catch { instances.value = [] }
  load()
  timer = setInterval(load, 30000)
  const tick = () => { const t = new Date(); now.value = `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}` }
  tick()
  clock = setInterval(tick, 1000)
  window.addEventListener('resize', onResize)
  document.addEventListener('fullscreenchange', onResize)
})
onBeforeUnmount(() => {
  clearInterval(timer)
  clearInterval(clock)
  window.removeEventListener('resize', onResize)
  document.removeEventListener('fullscreenchange', onResize)
  Object.values(charts).forEach(c => c.dispose())
})
</script>

<style scoped>
.screen {
  --surface: #1a1a19; --plane: #0d0d0d; --ink: #f0efec; --ink2: #c3c2b7; --muted: #898781; --grid: #2c2c2a; --axis: #383835;
  --critical: #d03b3b; --warning: #fab219;
  min-height: 100vh; background: var(--plane); color: var(--ink); padding: 14px 16px 20px; box-sizing: border-box;
  display: flex; flex-direction: column; gap: 12px; font-variant-numeric: tabular-nums;
}
.head { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px; }
.title { display: flex; align-items: baseline; gap: 12px; }
.title h1 { margin: 0; font-size: 22px; font-weight: 600; letter-spacing: 1px; }
.back { color: var(--ink2) !important; }
.ctrl { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.muted { color: var(--muted); font-size: 12px; }
.err { margin: 0; }
.kpis { display: grid; grid-template-columns: repeat(9, minmax(0, 1fr)); gap: 10px; }
.kpi { background: var(--surface); border: 1px solid var(--grid); border-radius: 8px; padding: 12px 14px; cursor: default; }
.kpi[class*='critical'], .kpi[class*='warning'] { cursor: pointer; }
.kpi-num { font-size: 26px; font-weight: 600; line-height: 1.2; display: flex; align-items: center; gap: 6px; }
.kpi-num small { font-size: 13px; color: var(--ink2); font-weight: 400; margin-left: 2px; }
.kpi-label { color: var(--ink2); font-size: 12px; margin-top: 4px; }
.status-text { margin-left: 4px; }
.dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
.kpi.critical .dot { background: var(--critical); }
.kpi.warning .dot { background: var(--warning); }
.row { display: grid; gap: 12px; }
.r2 { grid-template-columns: 1fr 1fr 1fr; }
.r3, .r4 { grid-template-columns: 1fr 2fr 1fr; }
.r4 { grid-template-columns: 2fr 1fr 1fr; }
.panel { background: var(--surface); border: 1px solid var(--grid); border-radius: 8px; padding: 10px 12px; min-width: 0; display: flex; flex-direction: column; }
.panel-title { font-size: 13px; color: var(--ink2); margin-bottom: 6px; font-weight: 600; }
.chart { height: 230px; width: 100%; }
.feed ul { list-style: none; margin: 0; padding: 0; overflow: auto; max-height: 232px; }
.feed li { display: flex; gap: 8px; padding: 6px 2px; border-bottom: 1px solid var(--grid); font-size: 12px; cursor: pointer; line-height: 1.5; }
.feed li:hover { background: #222220; }
.sev { flex-shrink: 0; padding: 0 6px; border-radius: 4px; font-size: 11px; height: 18px; line-height: 18px; }
.sev.critical { background: var(--critical); color: #fff; }
.sev.warning { background: var(--warning); color: #0b0b0b; }
.feed-main { min-width: 0; color: var(--ink); }
.cause { margin-left: 6px; color: var(--ink2); border: 1px solid var(--axis); border-radius: 4px; padding: 0 4px; }
.tbl { width: 100%; border-collapse: collapse; font-size: 12px; table-layout: fixed; }
.tbl th { color: var(--muted); font-weight: 400; text-align: left; padding: 5px 6px; border-bottom: 1px solid var(--axis); }
.tbl td { padding: 6px; border-bottom: 1px solid var(--grid); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--ink); }
.tbl tbody tr { cursor: pointer; }
.tbl tbody tr:hover td { background: #222220; }
.tbl .n { text-align: right; width: 72px; }
.tbl .sql { width: 42%; font-family: ui-monospace, Menlo, Consolas, monospace; color: var(--ink2); }
.tbl .hot { color: var(--ink); font-weight: 700; }
.empty { color: var(--muted); text-align: center; padding: 18px 0; font-size: 12px; }
@media (max-width: 1400px) {
  .kpis { grid-template-columns: repeat(5, minmax(0, 1fr)); }
  .r2, .r3, .r4 { grid-template-columns: 1fr 1fr; }
  .r3 .wide, .r4 .wide { grid-column: 1 / -1; }
}
@media (max-width: 800px) {
  .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .r2, .r3, .r4 { grid-template-columns: 1fr; }
}
</style>
