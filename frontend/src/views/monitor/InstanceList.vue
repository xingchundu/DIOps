<template>
  <div class="page-container mon">
    <!-- 概况：点击即筛选 -->
    <div class="summary">
      <button v-for="t in tiles" :key="t.key" class="tile" :class="{ active: gradeFilter === t.key }" @click="gradeFilter = gradeFilter === t.key ? '' : t.key">
        <span class="tile-num" :style="{ color: t.color }">{{ t.value }}</span>
        <span class="tile-label"><i v-if="t.key" class="dot" :style="{ background: t.color }" />{{ t.label }}</span>
      </button>
      <div class="tile alerts" @click="$router.push('/alerts')">
        <span class="tile-num" :style="{ color: summary.alerts?.p1 ? '#cf1322' : undefined }">{{ summary.alerts?.total ?? 0 }}</span>
        <span class="tile-label">未处理告警<template v-if="summary.alerts?.p1"> · P1 {{ summary.alerts.p1 }}</template></span>
      </div>
    </div>

    <!-- 筛选 -->
    <div class="card bar">
      <el-input v-model="kw" placeholder="实例名 / IP / 业务线" clearable prefix-icon="Search" style="width: 220px" />
      <el-select v-model="dbType" placeholder="数据库类型" clearable style="width: 140px">
        <el-option v-for="t in DB_TYPES" :key="t.value" :label="t.label" :value="t.value" />
      </el-select>
      <el-select v-model="env" placeholder="环境" clearable style="width: 110px">
        <el-option v-for="(l, v) in ENVS" :key="v" :label="l" :value="v" />
      </el-select>
      <el-select v-model="groupBy" style="width: 130px">
        <el-option label="不分组" value="none" /><el-option label="按环境分组" value="env" /><el-option label="按业务线分组" value="bizLine" /><el-option label="按库类型分组" value="dbType" />
      </el-select>
      <span class="flex-1" />
      <el-popover placement="bottom-end" :width="420" trigger="click">
        <template #reference><el-button link type="info" icon="QuestionFilled">评分规则</el-button></template>
        <ol class="rules"><li v-for="r in RULE_TEXT" :key="r">{{ r }}</li></ol>
      </el-popover>
      <span class="muted">{{ lastAt ? `更新于 ${lastAt}` : '' }} · 每 60 秒自动刷新</span>
      <el-button icon="Refresh" :loading="loading" @click="load">刷新</el-button>
      <el-radio-group v-model="view">
        <el-radio-button value="card">卡片</el-radio-button>
        <el-radio-button value="table">列表</el-radio-button>
      </el-radio-group>
    </div>

    <el-alert v-if="error" :title="error" type="error" show-icon :closable="false" class="mb-16" />
    <el-empty v-if="!loading && !error && !filtered.length" :description="items.length ? '没有符合条件的实例' : '还没有纳管实例，请先在资产管理中添加'" />

    <!-- 卡片 -->
    <template v-if="view === 'card'">
      <section v-for="g in groups" :key="g.key" class="group">
        <h3 v-if="groupBy !== 'none'" class="group-title">{{ g.label }} <span class="muted">{{ g.items.length }} 个</span></h3>
        <div class="grid" v-loading="loading && !items.length">
          <article v-for="it in g.items" :key="it.id" class="inst" :style="{ borderTopColor: grade(it.grade).color }" @click="goDetail(it.id)">
            <header class="inst-head">
              <div class="inst-title">
                <span class="name" :title="it.name">{{ it.name }}</span>
                <el-tag size="small" effect="plain">{{ it.dbType }}</el-tag>
                <el-tag v-if="it.env" size="small" type="info" effect="plain">{{ ENVS[it.env] || it.env }}</el-tag>
              </div>
              <div class="inst-score">
                <span class="grade" :style="{ color: grade(it.grade).color, background: grade(it.grade).bg }">{{ grade(it.grade).label }}</span>
                <span v-if="it.score != null" class="score" :style="{ color: grade(it.grade).color }">{{ it.score }}</span>
              </div>
            </header>
            <div class="sub muted">{{ it.host }}:{{ it.port }}<template v-if="it.role"> · {{ it.role }}</template><template v-if="it.bizLine"> · {{ it.bizLine }}</template></div>

            <!-- 在线：关键指标 + 走势 -->
            <template v-if="it.status === 'ONLINE' || it.status === 'STALE'">
              <div class="kpis">
                <div class="kpi" v-for="k in kpis(it)" :key="k.label" :title="k.title">
                  <div class="kpi-label">{{ k.label }}</div>
                  <div class="kpi-val">{{ k.text }}</div>
                  <div v-if="k.pct != null" class="bar"><i :style="{ width: Math.min(100, k.pct) + '%', background: k.color }" /></div>
                </div>
              </div>
              <div class="trend">
                <span class="muted">CPU 近 2 小时</span>
                <Sparkline :values="it.spark?.cpu || []" :max="100" :width="150" :height="26" label="CPU 近 2 小时走势" />
              </div>
              <div v-if="it.status === 'STALE'" class="notice warn">数据已 {{ ago(it.ageSec).replace('前', '') }}未更新，请检查采集</div>
              <ul v-else-if="(it.issues || []).length" class="issues">
                <li v-for="x in it.issues.slice(0, 2)" :key="x.item">
                  <span class="lvl" :class="x.level">{{ x.level === 'CRIT' ? '严重' : '警告' }}</span>{{ x.text }}
                </li>
                <li v-if="it.issueCount > 2" class="muted more">还有 {{ it.issueCount - 2 }} 项</li>
              </ul>
              <div v-else class="notice ok">已检查 {{ it.checked ?? 0 }} 项，未发现问题</div>
            </template>
            <div v-else-if="it.status === 'OFFLINE'" class="notice err">
              <b>{{ it.error || '连接失败' }}</b>
              <span class="muted">检测于 {{ ago(it.ageSec) }}</span>
            </div>
            <div v-else-if="it.status === 'NEVER'" class="notice muted-box">尚未采集，点击右下角“采集”立即检查</div>
            <div v-else class="notice muted-box">实例已停用，不再采集</div>

            <footer class="inst-foot">
              <span v-if="it.alerts?.total" class="alert-chip" @click.stop="$router.push({ path: '/alerts', query: { instanceId: it.id } })">
                未处理告警 {{ it.alerts.total }}<template v-if="it.alerts.p1"> · P1 {{ it.alerts.p1 }}</template>
              </span>
              <span v-else class="muted">无未处理告警</span>
              <span class="flex-1" />
              <span class="muted">{{ it.collectedAt ? ago(it.ageSec) : '' }}</span>
              <el-button link type="primary" size="small" :loading="collecting[it.id]" :disabled="it.status === 'STOPPED'" @click.stop="collectNow(it)">采集</el-button>
            </footer>
          </article>
        </div>
      </section>
    </template>

    <!-- 列表 -->
    <div v-else class="card" v-loading="loading">
      <el-table :data="filtered" stripe @row-click="row => goDetail(row.id)" :default-sort="{ prop: 'score', order: 'ascending' }">
        <el-table-column label="实例" min-width="150" fixed>
          <template #default="{ row }"><el-link type="primary">{{ row.name }}</el-link><div class="muted small">{{ row.host }}:{{ row.port }}</div></template>
        </el-table-column>
        <el-table-column prop="dbType" label="类型" width="120" />
        <el-table-column label="环境" width="70"><template #default="{ row }">{{ ENVS[row.env] || row.env || '-' }}</template></el-table-column>
        <el-table-column label="健康" width="110" sortable :sort-method="(a, b) => (a.score ?? -1) - (b.score ?? -1)" prop="score">
          <template #default="{ row }">
            <span class="grade" :style="{ color: grade(row.grade).color, background: grade(row.grade).bg }">{{ grade(row.grade).label }}</span>
            <b v-if="row.score != null" :style="{ color: grade(row.grade).color, marginLeft: '6px' }">{{ row.score }}</b>
          </template>
        </el-table-column>
        <el-table-column label="CPU" width="80"><template #default="{ row }">{{ pct(row.keyMetrics?.cpu) }}</template></el-table-column>
        <el-table-column label="连接占比" width="90"><template #default="{ row }">{{ pct(row.keyMetrics?.connPct) }}</template></el-table-column>
        <el-table-column label="活跃会话" width="85"><template #default="{ row }">{{ fmtNum(row.keyMetrics?.active) }}</template></el-table-column>
        <el-table-column label="命中率" width="80"><template #default="{ row }">{{ pct(row.keyMetrics?.hit) }}</template></el-table-column>
        <el-table-column label="表空间" width="80"><template #default="{ row }">{{ pct(row.keyMetrics?.tsMax) }}</template></el-table-column>
        <el-table-column label="主要问题" min-width="220" show-overflow-tooltip>
          <template #default="{ row }">
            <span v-if="row.status === 'OFFLINE'" class="danger-text">{{ row.error }}</span>
            <span v-else-if="(row.issues || []).length">{{ row.issues[0].text }}<span v-if="row.issueCount > 1" class="muted"> 等 {{ row.issueCount }} 项</span></span>
            <span v-else class="muted">{{ STATUS[row.status] === '在线' ? '无' : STATUS[row.status] }}</span>
          </template>
        </el-table-column>
        <el-table-column label="告警" width="70"><template #default="{ row }"><b v-if="row.alerts?.total" class="danger-text">{{ row.alerts.total }}</b><span v-else class="muted">0</span></template></el-table-column>
        <el-table-column label="采集" width="100"><template #default="{ row }"><span class="muted">{{ row.collectedAt ? ago(row.ageSec) : STATUS[row.status] }}</span></template></el-table-column>
      </el-table>
    </div>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { monitorApi } from '@/api/index.js'
import Sparkline from '@/components/monitor/Sparkline.vue'
import { GRADE, STATUS, DB_TYPES, ENVS, RULE_TEXT, grade, pctColor, ago, fmtNum } from '@/components/monitor/health.js'

const router = useRouter()
const loading = ref(false)
const error = ref('')
const items = ref([])
const summary = ref({})
const lastAt = ref('')
const kw = ref('')
const dbType = ref('')
const env = ref('')
const gradeFilter = ref('')
const groupBy = ref(localStorage.getItem('monitor.groupBy') || 'none')
const view = ref(localStorage.getItem('monitor.view') || 'card')
const collecting = reactive({})
let timer = null

const tiles = computed(() => {
  const g = summary.value.byGrade || {}
  return [
    { key: '', label: '全部实例', value: summary.value.total ?? 0 },
    { key: 'CRITICAL', label: '严重', value: g.CRITICAL ?? 0, color: GRADE.CRITICAL.color },
    { key: 'OFFLINE', label: '离线', value: g.OFFLINE ?? 0, color: GRADE.OFFLINE.color },
    { key: 'ATTENTION', label: '关注', value: g.ATTENTION ?? 0, color: GRADE.ATTENTION.color },
    { key: 'HEALTHY', label: '健康', value: g.HEALTHY ?? 0, color: GRADE.HEALTHY.color },
    { key: 'UNKNOWN', label: '无数据', value: g.UNKNOWN ?? 0, color: GRADE.UNKNOWN.color },
  ]
})

const filtered = computed(() => {
  const k = kw.value.trim().toLowerCase()
  return items.value.filter(it =>
    (!gradeFilter.value || it.grade === gradeFilter.value)
    && (!dbType.value || it.dbType === dbType.value)
    && (!env.value || it.env === env.value)
    && (!k || [it.name, it.host, it.bizLine].some(x => String(x || '').toLowerCase().includes(k))))
})

const groups = computed(() => {
  if (!groupBy.value || groupBy.value === 'none') return [{ key: 'all', label: '', items: filtered.value }]
  const m = new Map()
  for (const it of filtered.value) {
    const raw = it[groupBy.value]
    const label = groupBy.value === 'env' ? (ENVS[raw] || raw || '未设置环境') : (raw || '未设置')
    if (!m.has(label)) m.set(label, [])
    m.get(label).push(it)
  }
  return [...m.entries()].map(([label, list]) => ({ key: label, label, items: list }))
})

const pct = v => (v == null ? '-' : `${Math.round(v * 10) / 10}%`)

/** 卡片上的 4 个关键指标：CPU、连接、活跃会话、命中率 / 表空间（取有数据的） */
function kpis(it) {
  const k = it.keyMetrics || {}
  const out = [
    { label: 'CPU', text: pct(k.cpu), pct: k.cpu, color: pctColor(k.cpu, 80, 95), title: '主机 CPU 使用率' },
    {
      label: '连接', text: k.conn != null ? `${fmtNum(k.conn)}${k.connMax ? ' / ' + fmtNum(k.connMax) : ''}` : pct(k.connPct),
      pct: k.connPct, color: pctColor(k.connPct, 80, 95), title: k.connPct != null ? `占最大连接数 ${pct(k.connPct)}` : '当前连接数',
    },
    { label: '活跃会话', text: fmtNum(k.active), title: '正在执行的会话 / 线程' },
  ]
  if (k.tsMax != null) out.push({ label: '表空间', text: pct(k.tsMax), pct: k.tsMax, color: pctColor(k.tsMax, 85, 95), title: '使用率最高的表空间' })
  else if (k.hit != null) out.push({ label: '命中率', text: pct(k.hit), pct: k.hit, color: pctColor(k.hit, 95, 90, true), title: '缓存命中率' })
  else out.push({ label: k.tpsLabel || '吞吐', text: fmtNum(k.tps) })
  return out
}

async function load() {
  loading.value = true
  try {
    const r = await monitorApi.board()
    items.value = r.data?.items || []
    summary.value = r.data?.summary || {}
    error.value = ''
    const t = new Date()
    lastAt.value = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}`
  } catch (e) {
    error.value = `加载失败：${e.message || e}`
  } finally {
    loading.value = false
  }
}

async function collectNow(it) {
  collecting[it.id] = true
  try {
    const r = await monitorApi.collectNow(it.id)
    if (r.data?.ok === false) ElMessage.warning(`采集失败：${r.data.err || ''}`)
    else ElMessage.success(`${it.name} 采集完成`)
    await load()
  } catch (e) {
    ElMessage.error(e.message || '采集失败')
  } finally {
    collecting[it.id] = false
  }
}

function goDetail(id) { router.push(`/monitor/${id}`) }

watch(groupBy, v => { try { localStorage.setItem('monitor.groupBy', v) } catch { /* ignore */ } })
watch(view, v => { try { localStorage.setItem('monitor.view', v) } catch { /* ignore */ } })

onMounted(() => {
  load()
  timer = setInterval(() => { if (!document.hidden) load() }, 60000)
})
onBeforeUnmount(() => clearInterval(timer))
</script>

<style scoped>
.mon { display: flex; flex-direction: column; gap: 14px; }
.summary { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 10px; }
.tile { background: #fff; border: 1px solid #ebeef5; border-radius: 10px; padding: 12px 14px; text-align: left; cursor: pointer; display: flex; flex-direction: column; gap: 4px; font: inherit; }
.tile:hover { border-color: #91caff; }
.tile.active { border-color: #1677ff; box-shadow: 0 0 0 1px #1677ff inset; }
.tile-num { font-size: 26px; font-weight: 600; line-height: 1.1; color: #1f2329; font-variant-numeric: tabular-nums; }
.tile-label { font-size: 13px; color: #595959; display: flex; align-items: center; gap: 6px; }
.dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
.bar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.card.bar { padding: 12px 16px; }
.flex-1 { flex: 1; }
.muted { color: #8c8c8c; font-size: 12px; }
.small { font-size: 12px; }
.rules { margin: 0; padding-left: 18px; line-height: 1.7; font-size: 13px; color: #434343; }
.group-title { font-size: 14px; margin: 4px 0 10px; color: #262626; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(330px, 1fr)); gap: 14px; }
.inst { background: #fff; border: 1px solid #ebeef5; border-top: 3px solid #d9d9d9; border-radius: 10px; padding: 14px 16px 10px; cursor: pointer; display: flex; flex-direction: column; gap: 8px; transition: box-shadow .15s, transform .15s; }
.inst:hover { box-shadow: 0 6px 18px rgba(0, 0, 0, .08); transform: translateY(-1px); }
.inst-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; }
.inst-title { display: flex; align-items: center; gap: 6px; min-width: 0; flex-wrap: wrap; }
.name { font-size: 15px; font-weight: 600; color: #1f2329; max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.inst-score { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.grade { font-size: 12px; padding: 1px 8px; border-radius: 10px; font-weight: 500; white-space: nowrap; }
.score { font-size: 24px; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1; }
.sub { margin-top: -4px; }
.kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; background: #fafafa; border-radius: 8px; padding: 8px 10px; }
.kpi-label { font-size: 11px; color: #8c8c8c; }
.kpi-val { font-size: 14px; font-weight: 600; color: #262626; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.kpi .bar { height: 4px; background: #f0f0f0; border-radius: 2px; margin-top: 4px; overflow: hidden; display: block; }
.kpi .bar i { display: block; height: 100%; border-radius: 2px; }
.trend { display: flex; align-items: center; justify-content: space-between; }
.issues { list-style: none; margin: 0; padding: 0; font-size: 13px; color: #262626; display: flex; flex-direction: column; gap: 4px; min-height: 40px; }
.issues li { display: flex; align-items: center; gap: 6px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.lvl { font-size: 11px; padding: 0 5px; border-radius: 3px; flex-shrink: 0; }
.lvl.CRIT { background: #fff1f0; color: #cf1322; border: 1px solid #ffa39e; }
.lvl.WARN { background: #fffbe6; color: #d48806; border: 1px solid #ffe58f; }
.more { padding-left: 2px; }
.notice { font-size: 13px; border-radius: 6px; padding: 8px 10px; min-height: 40px; display: flex; flex-direction: column; justify-content: center; gap: 2px; }
.notice.ok { background: #f6ffed; color: #389e0d; }
.notice.warn { background: #fffbe6; color: #ad6800; }
.notice.err { background: #fff1f0; color: #a8071a; min-height: 120px; }
.notice.muted-box { background: #fafafa; color: #8c8c8c; min-height: 120px; }
.inst-foot { display: flex; align-items: center; gap: 8px; border-top: 1px solid #f0f0f0; padding-top: 8px; }
.alert-chip { font-size: 12px; color: #cf1322; background: #fff1f0; border-radius: 10px; padding: 1px 8px; }
.danger-text { color: #cf1322; }
@media (max-width: 1200px) { .summary { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
@media (max-width: 700px) { .summary { grid-template-columns: repeat(2, minmax(0, 1fr)); } .kpis { grid-template-columns: repeat(2, 1fr); } }
</style>
