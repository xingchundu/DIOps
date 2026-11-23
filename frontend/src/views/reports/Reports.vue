<template>
  <div class="page-container rpt">
    <!-- 条件 -->
    <div class="card bar no-print">
      <el-radio-group v-model="type" @change="onType">
        <el-radio-button value="DAY">日报</el-radio-button>
        <el-radio-button value="WEEK">周报</el-radio-button>
        <el-radio-button value="MONTH">月报</el-radio-button>
        <el-radio-button value="CUSTOM">自定义</el-radio-button>
      </el-radio-group>
      <el-date-picker v-if="type === 'CUSTOM'" v-model="range" type="daterange" value-format="YYYY-MM-DD" range-separator="至"
                      start-placeholder="开始日期" end-placeholder="结束日期" :disabled-date="d => d > new Date()" style="width: 260px" />
      <el-select v-model="env" placeholder="全部环境" clearable style="width: 120px" @change="instanceId = null">
        <el-option v-for="(l, v) in ENVS" :key="v" :label="l" :value="v" />
      </el-select>
      <el-select v-model="instanceId" placeholder="全部实例" clearable filterable style="width: 200px">
        <el-option v-for="i in instOptions" :key="i.INSTANCE_ID" :label="`${i.INSTANCE_NAME}（${i.DB_TYPE}）`" :value="i.INSTANCE_ID" />
      </el-select>
      <el-button type="primary" icon="Document" :loading="loading" @click="build">生成报告</el-button>
      <span class="flex-1" />
      <el-button :disabled="!r" icon="Printer" @click="print">打印 / 导出 PDF</el-button>
    </div>

    <el-alert v-if="error" :title="error" type="error" show-icon :closable="false" class="no-print" />
    <el-empty v-if="!r && !loading && !error" description="选择报告类型与范围后点击“生成报告”" />

    <!-- 报告正文 -->
    <article v-if="r" class="doc" v-loading="loading">
      <header class="doc-head">
        <h1>数据库运行{{ TYPE_LABEL[r.type] }}</h1>
        <div class="doc-meta">
          <span>统计时间：{{ periodText }}</span>
          <span>范围：{{ scopeText }}（{{ r.scope?.instances ?? 0 }} 个实例）</span>
          <span>生成时间：{{ generatedAt }}</span>
        </div>
      </header>

      <!-- 1 摘要 -->
      <section>
        <h2>一、摘要</h2>
        <div class="kpis">
          <div class="kpi"><b :style="{ color: availColor(av.overall) }">{{ av.overall != null ? av.overall + '%' : '-' }}</b><span>整体可用率</span></div>
          <div class="kpi"><b>{{ av.downMinutes ?? 0 }}<small>分钟</small></b><span>估算中断时长（{{ av.outageInstances || 0 }} 个实例）</span></div>
          <div class="kpi"><b>{{ al.summary?.TOTAL ?? 0 }}</b><span>告警 · {{ alertChange }}</span></div>
          <div class="kpi"><b>{{ al.summary?.MTTR_MIN ?? '-' }}<small v-if="al.summary?.MTTR_MIN != null">分钟</small></b><span>平均解决耗时（确认 {{ al.summary?.MTTA_MIN ?? '-' }} 分钟）</span></div>
          <div class="kpi"><b>{{ backupRate }}</b><span>备份成功率（{{ ops.backup?.TOTAL || 0 }} 次）</span></div>
        </div>
        <ul class="findings">
          <li v-for="(f, i) in r.findings" :key="i"><span class="lvl" :class="f.level">{{ LVL[f.level] }}</span>{{ f.text }}</li>
        </ul>
      </section>

      <!-- 2 可用性与健康 -->
      <section>
        <h2>二、可用性与健康<el-button link size="small" class="no-print" @click="csv('可用性与健康', av.rows, AVAIL_COLS)">导出 CSV</el-button></h2>
        <p class="note">可用率 = 可连接的采集次数 / 全部采集次数；中断次数 = 由可连接变为连接失败的次数；中断时长按采集间隔估算。</p>
        <el-table :data="av.rows || []" size="small" border>
          <el-table-column prop="INSTANCE_NAME" label="实例" min-width="140" />
          <el-table-column prop="DB_TYPE" label="类型" width="100" />
          <el-table-column label="环境" width="70"><template #default="{ row }">{{ ENVS[row.ENVIRONMENT] || row.ENVIRONMENT || '-' }}</template></el-table-column>
          <el-table-column label="可用率" width="90" align="right"><template #default="{ row }"><span :style="{ color: availColor(row.AVAILABILITY) }">{{ row.AVAILABILITY != null ? row.AVAILABILITY + '%' : '无数据' }}</span></template></el-table-column>
          <el-table-column prop="OUTAGES" label="中断次数" width="85" align="right" />
          <el-table-column label="中断时长" width="90" align="right"><template #default="{ row }">{{ row.DOWN_MINUTES != null ? row.DOWN_MINUTES + ' 分钟' : '-' }}</template></el-table-column>
          <el-table-column prop="AVG_SCORE" label="平均健康分" width="95" align="right" />
          <el-table-column prop="MIN_SCORE" label="最低分" width="75" align="right" />
          <el-table-column label="当前" width="80"><template #default="{ row }"><span v-if="row.CURRENT_GRADE" :style="{ color: grade(row.CURRENT_GRADE).color }">{{ grade(row.CURRENT_GRADE).label }}</span></template></el-table-column>
          <el-table-column prop="SAMPLES" label="采集次数" width="85" align="right" />
        </el-table>
      </section>

      <!-- 3 告警 -->
      <section>
        <h2>三、告警</h2>
        <div ref="trendRef" class="chart" />
        <div class="cols">
          <div>
            <h3>按规则 Top 10<el-button link size="small" class="no-print" @click="csv('告警规则', al.topRules, RULE_COLS)">导出 CSV</el-button></h3>
            <el-table :data="al.topRules || []" size="small" border>
              <el-table-column prop="RULE_NAME" label="规则" min-width="160" show-overflow-tooltip />
              <el-table-column prop="CNT" label="次数" width="70" align="right" />
              <el-table-column prop="RESOLVED" label="已解决" width="75" align="right" />
            </el-table>
          </div>
          <div>
            <h3>按实例 Top 10<el-button link size="small" class="no-print" @click="csv('告警实例', al.topInstances, INST_COLS)">导出 CSV</el-button></h3>
            <el-table :data="al.topInstances || []" size="small" border>
              <el-table-column prop="INSTANCE_NAME" label="实例" min-width="140" />
              <el-table-column prop="CNT" label="告警数" width="75" align="right" />
              <el-table-column prop="P1" label="其中 P1" width="75" align="right" />
            </el-table>
          </div>
        </div>
      </section>

      <!-- 4 容量 -->
      <section>
        <h2>四、容量<el-button link size="small" class="no-print" @click="csv('容量', r.capacity, CAP_COLS)">导出 CSV</el-button></h2>
        <p class="note">期末值取统计时间内最后一次采集；变化 = 期末 − 期初（百分点）。</p>
        <el-table :data="r.capacity || []" size="small" border empty-text="期间没有容量数据">
          <el-table-column prop="INSTANCE_NAME" label="实例" min-width="140" />
          <el-table-column prop="DB_TYPE" label="类型" width="100" />
          <el-table-column v-for="c in CAP_METRICS" :key="c.key" :label="c.label" width="150" align="right">
            <template #default="{ row }">
              <span :style="{ color: row[c.key] != null ? pctColor(row[c.key], c.warn, 95) : undefined }">{{ pct(row[c.key]) }}</span>
              <span v-if="row[c.key + 'Delta']" class="delta">{{ row[c.key + 'Delta'] > 0 ? '+' : '' }}{{ row[c.key + 'Delta'] }}</span>
            </template>
          </el-table-column>
        </el-table>
      </section>

      <!-- 5 SQL -->
      <section>
        <h2>五、SQL</h2>
        <div class="cols">
          <div>
            <h3>新增问题（按规则）</h3>
            <el-table :data="sql.problemsByRule || []" size="small" border empty-text="期间没有新增 SQL 问题">
              <el-table-column label="规则" min-width="160"><template #default="{ row }">{{ row.RULE_CODE }} {{ row.RULE_NAME || '' }}</template></el-table-column>
              <el-table-column prop="CNT" label="新增" width="70" align="right" />
              <el-table-column prop="OPEN_CNT" label="未关闭" width="75" align="right" />
            </el-table>
          </div>
          <div>
            <h3>性能波动（按原因）</h3>
            <el-table :data="sql.anomaliesByCause || []" size="small" border empty-text="期间没有性能波动">
              <el-table-column label="原因" min-width="160"><template #default="{ row }">{{ CAUSES[row.CAUSE] || row.CAUSE }}</template></el-table-column>
              <el-table-column prop="CNT" label="次数" width="70" align="right" />
            </el-table>
          </div>
        </div>
        <h3>最慢的 SQL Top 10<el-button link size="small" class="no-print" @click="csv('慢SQL', sql.slowTop, SLOW_COLS)">导出 CSV</el-button></h3>
        <el-table :data="sql.slowTop || []" size="small" border empty-text="期间没有慢 SQL 记录">
          <el-table-column prop="SQL_TEXT" label="SQL" min-width="300" show-overflow-tooltip />
          <el-table-column prop="INSTANCE_NAME" label="实例" width="120" />
          <el-table-column prop="AVG_MS" label="平均耗时(ms)" width="110" align="right" />
          <el-table-column prop="EXECS" label="执行次数" width="90" align="right" />
          <el-table-column prop="TIMES" label="出现次数" width="85" align="right" />
        </el-table>
      </section>

      <!-- 6 运维 -->
      <section>
        <h2>六、运维工作</h2>
        <div class="kpis small">
          <div class="kpi"><b>{{ ops.backup?.TOTAL || 0 }}</b><span>备份（成功 {{ ops.backup?.SUCCESS || 0 }} · 失败 {{ ops.backup?.FAILED || 0 }}）</span></div>
          <div class="kpi"><b>{{ ops.inspect?.TOTAL || 0 }}</b><span>巡检（平均 {{ ops.inspect?.AVG_SCORE ?? '-' }} 分 · 严重 {{ ops.inspect?.CRITICAL || 0 }}）</span></div>
          <div class="kpi"><b>{{ ops.sqlReview?.TOTAL || 0 }}</b><span>SQL 审核（通过 {{ ops.sqlReview?.APPROVED || 0 }} · 拒绝 {{ ops.sqlReview?.REJECTED || 0 }} · 待审 {{ ops.sqlReview?.PENDING || 0 }}）</span></div>
          <div v-if="ops.serviceOrders" class="kpi"><b>{{ ops.serviceOrders.TOTAL || 0 }}</b><span>服务工单（完成 {{ ops.serviceOrders.DONE || 0 }} · 处理中 {{ ops.serviceOrders.PENDING || 0 }}）</span></div>
        </div>
      </section>
    </article>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import * as echarts from 'echarts'
import { reportApi, monitorApi } from '@/api/index.js'
import { ENVS, grade, pctColor } from '@/components/monitor/health.js'

const TYPE_LABEL = { DAY: '日报', WEEK: '周报', MONTH: '月报', CUSTOM: '报告' }
const LVL = { CRIT: '严重', WARN: '注意', INFO: '说明', OK: '正常' }
const CAUSES = { PLAN_REGRESSION: '执行计划退化', LOCK_WAIT: '锁等待', DATA_GROWTH_OR_SKEW: '数据增长 / 倾斜', CACHE_OR_IO: '缓存 / IO', RESOURCE_CONTENTION: '资源争用', TRAFFIC_SURGE: '调用量突增', ERROR_SURGE: '错误率升高', UNKNOWN: '原因未明', 未诊断: '未诊断' }
const CAP_METRICS = [{ key: 'tsMax', label: '表空间最大使用率', warn: 85 }, { key: 'fsMax', label: '文件系统最大使用率', warn: 85 }, { key: 'connPct', label: '连接数占上限', warn: 80 }]
const AVAIL_COLS = [['INSTANCE_NAME', '实例'], ['DB_TYPE', '类型'], ['ENVIRONMENT', '环境'], ['AVAILABILITY', '可用率%'], ['OUTAGES', '中断次数'], ['DOWN_MINUTES', '中断分钟'], ['AVG_SCORE', '平均健康分'], ['MIN_SCORE', '最低分'], ['SAMPLES', '采集次数']]
const RULE_COLS = [['RULE_NAME', '规则'], ['CNT', '次数'], ['RESOLVED', '已解决']]
const INST_COLS = [['INSTANCE_NAME', '实例'], ['CNT', '告警数'], ['P1', 'P1']]
const CAP_COLS = [['INSTANCE_NAME', '实例'], ['DB_TYPE', '类型'], ['tsMax', '表空间%'], ['tsMaxDelta', '表空间变化'], ['fsMax', '文件系统%'], ['fsMaxDelta', '文件系统变化'], ['connPct', '连接数%'], ['connPctDelta', '连接数变化']]
const SLOW_COLS = [['SQL_TEXT', 'SQL'], ['INSTANCE_NAME', '实例'], ['AVG_MS', '平均耗时ms'], ['EXECS', '执行次数'], ['TIMES', '出现次数']]

const type = ref('WEEK')
const range = ref(null)
const env = ref('')
const instanceId = ref(null)
const instances = ref([])
const r = ref(null)
const loading = ref(false)
const error = ref('')
const generatedAt = ref('')
const trendRef = ref()
let chart = null

const instOptions = computed(() => instances.value.filter(i => !env.value || i.ENVIRONMENT === env.value))
const av = computed(() => r.value?.availability || {})
const al = computed(() => r.value?.alerts || {})
const sql = computed(() => r.value?.sql || {})
const ops = computed(() => r.value?.ops || {})

const fmtDay = s => String(s || '').slice(0, 10)
const periodText = computed(() => {
  if (!r.value?.scope) return ''
  const to = new Date(new Date(r.value.scope.to).getTime() - 1000)
  const toDay = `${to.getFullYear()}-${String(to.getMonth() + 1).padStart(2, '0')}-${String(to.getDate()).padStart(2, '0')}`
  const fromDay = fmtDay(r.value.scope.from)
  return fromDay === toDay ? fromDay : `${fromDay} 至 ${toDay}`
})
const scopeText = computed(() => {
  const s = r.value?.scope || {}
  if (s.instanceId) return instances.value.find(i => i.INSTANCE_ID === Number(s.instanceId))?.INSTANCE_NAME || `实例 #${s.instanceId}`
  if (s.env) return `${ENVS[s.env] || s.env}环境`
  return '全部实例'
})
const alertChange = computed(() => {
  const cur = Number(al.value.summary?.TOTAL || 0)
  const prev = Number(al.value.previousTotal || 0)
  if (!prev) return cur ? '上一周期 0 条' : '与上一周期持平'
  const d = Math.round(Math.abs(cur - prev) * 100 / prev)
  return cur === prev ? '与上一周期持平' : `较上一周期${cur > prev ? '增加' : '减少'} ${d}%`
})
const backupRate = computed(() => {
  const t = Number(ops.value.backup?.TOTAL || 0)
  return t ? `${Math.round(Number(ops.value.backup.SUCCESS || 0) * 1000 / t) / 10}%` : '-'
})

const pct = v => (v == null ? '-' : `${Math.round(v * 10) / 10}%`)
const availColor = v => (v == null ? undefined : v >= 99.9 ? '#389e0d' : v >= 99 ? '#d48806' : '#cf1322')

function onType() {
  if (type.value !== 'CUSTOM') build()
}

async function build() {
  if (type.value === 'CUSTOM' && !(range.value && range.value[0])) {
    error.value = '请选择自定义报告的开始和结束日期'
    return
  }
  loading.value = true
  error.value = ''
  try {
    const p = { type: type.value, env: env.value || undefined, instanceId: instanceId.value || undefined }
    if (type.value === 'CUSTOM') Object.assign(p, { from: range.value[0], to: range.value[1] })
    const res = await reportApi.build(p)
    r.value = res.data
    const t = new Date()
    generatedAt.value = t.toLocaleString('zh-CN', { hour12: false })
    await nextTick()
    drawTrend()
  } catch (e) {
    error.value = `报告生成失败：${e.message || e}`
  } finally {
    loading.value = false
  }
}

function drawTrend() {
  if (!trendRef.value || !r.value?.scope) return
  const start = new Date(r.value.scope.from)
  const end = new Date(r.value.scope.to)
  const days = []
  for (let d = new Date(start); d < end; d = new Date(d.getTime() + 86400e3)) {
    days.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`)
  }
  const key = s => (s === 'CRITICAL' || s === 'P1' ? 'P1' : s === 'WARNING' || s === 'P2' ? 'P2' : 'P3')
  const by = { P1: days.map(() => 0), P2: days.map(() => 0), P3: days.map(() => 0) }
  for (const x of al.value.trend || []) {
    const i = days.indexOf(x.DT)
    if (i >= 0) by[key(x.SEVERITY)][i] += Number(x.CNT || 0)
  }
  chart = chart || echarts.init(trendRef.value)
  chart.setOption({
    animation: false,
    title: { text: '每日告警数', left: 0, top: 0, textStyle: { fontSize: 13, fontWeight: 500, color: '#262626' } },
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    legend: { top: 0, right: 0, itemWidth: 10, itemHeight: 10 },
    grid: { left: 36, right: 8, top: 34, bottom: 24 },
    xAxis: { type: 'category', data: days.map(d => d.slice(5)), axisTick: { show: false }, axisLabel: { color: '#8c8c8c' } },
    yAxis: { type: 'value', minInterval: 1, splitLine: { lineStyle: { color: '#f0f0f0' } }, axisLabel: { color: '#8c8c8c' } },
    series: [['P1', 'P1 严重', '#cf1322'], ['P2', 'P2 重要', '#fa8c16'], ['P3', 'P3 一般', '#faad14']].map(([k, n, c], idx) => ({
      name: n, type: 'bar', stack: 'a', data: by[k], barMaxWidth: 24, itemStyle: { color: c, borderColor: '#fff', borderWidth: 1, borderRadius: idx === 2 ? [3, 3, 0, 0] : 0 },
    })),
  }, true)
}

/** 导出 CSV（带 BOM，Excel 直接打开不乱码） */
function csv(name, rows, cols) {
  const esc = v => {
    const s = v == null ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const lines = [cols.map(c => c[1]).join(','), ...(rows || []).map(row => cols.map(c => esc(row[c[0]])).join(','))]
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `${name}_${periodText.value.replace(/\s/g, '')}.csv`
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

function print() {
  chart?.resize()
  window.print()
}

const onResize = () => chart?.resize()
onMounted(async () => {
  try { instances.value = (await monitorApi.instances()).data || [] } catch { instances.value = [] }
  build()
  window.addEventListener('resize', onResize)
})
onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize)
  chart?.dispose()
})
</script>

<style scoped>
.rpt { display: flex; flex-direction: column; gap: 14px; }
.bar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 12px 16px; margin: 0; }
.flex-1 { flex: 1; }
.doc { background: #fff; border: 1px solid #ebeef5; border-radius: 10px; padding: 28px 36px; max-width: 1200px; width: 100%; margin: 0 auto; box-sizing: border-box; }
.doc-head { border-bottom: 2px solid #1f2329; padding-bottom: 12px; margin-bottom: 8px; }
.doc-head h1 { font-size: 22px; margin: 0 0 8px; color: #1f2329; }
.doc-meta { display: flex; flex-wrap: wrap; gap: 6px 24px; font-size: 13px; color: #595959; }
section { margin-top: 22px; }
h2 { font-size: 16px; color: #1f2329; margin: 0 0 10px; display: flex; align-items: center; gap: 10px; }
h3 { font-size: 13px; color: #262626; margin: 14px 0 8px; display: flex; align-items: center; gap: 8px; }
.note { font-size: 12px; color: #8c8c8c; margin: -4px 0 8px; }
.kpis { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 10px; margin-bottom: 12px; }
.kpis.small { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.kpi { background: #fafafa; border-radius: 8px; padding: 12px; display: flex; flex-direction: column; gap: 4px; }
.kpi b { font-size: 22px; color: #1f2329; font-variant-numeric: tabular-nums; }
.kpi b small { font-size: 12px; font-weight: 400; margin-left: 2px; }
.kpi span { font-size: 12px; color: #595959; }
.findings { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 6px; }
.findings li { font-size: 14px; color: #262626; display: flex; gap: 8px; align-items: flex-start; line-height: 1.6; }
.lvl { font-size: 11px; padding: 0 6px; border-radius: 3px; flex-shrink: 0; margin-top: 3px; border: 1px solid transparent; }
.lvl.CRIT { background: #fff1f0; color: #cf1322; border-color: #ffa39e; }
.lvl.WARN { background: #fffbe6; color: #d48806; border-color: #ffe58f; }
.lvl.INFO { background: #f0f5ff; color: #1d39c4; border-color: #adc6ff; }
.lvl.OK { background: #f6ffed; color: #389e0d; border-color: #b7eb8f; }
.chart { height: 240px; width: 100%; }
.cols { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.delta { font-size: 11px; color: #8c8c8c; margin-left: 4px; }
@media (max-width: 900px) { .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); } .cols { grid-template-columns: 1fr; } .doc { padding: 16px; } }
</style>

<style>
/* 打印 / 另存为 PDF：只保留报告正文 */
@media print {
  .sidebar, .top-header, .license-banner, .no-print { display: none !important; }
  .layout-wrap, .main-wrap, .main-content { display: block !important; height: auto !important; overflow: visible !important; padding: 0 !important; margin: 0 !important; }
  .doc { border: none !important; padding: 0 !important; max-width: none !important; }
  .doc section { break-inside: avoid-page; }
  body { background: #fff !important; }
}
</style>
