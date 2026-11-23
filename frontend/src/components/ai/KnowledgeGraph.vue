<template>
  <div class="kg">
    <div class="kg-bar">
      <el-input v-model="q" placeholder="搜索：实例 / SQL / 问题 / 根因 / 处置建议…" clearable size="small" style="width: 300px" @keyup.enter="doSearch" @clear="loadOverview">
        <template #append><el-button :icon="Search" @click="doSearch" /></template>
      </el-input>
      <el-select v-model="type" placeholder="节点类型" clearable size="small" style="width: 140px" @change="loadOverview">
        <el-option v-for="(label, t) in TYPE_LABEL" :key="t" :label="label" :value="t" />
      </el-select>
      <el-button size="small" :icon="Refresh" @click="loadOverview">刷新</el-button>
      <el-button size="small" type="primary" :icon="EditPen" @click="noteDlg = true">记一条经验</el-button>
      <span class="stat" v-if="stats">节点 {{ stats.totalNodes }} · 关系 {{ stats.totalEdges }}</span>
    </div>

    <el-alert v-if="empty" type="info" :closable="false" show-icon style="margin-bottom: 8px"
      title="知识图谱还没有数据"
      description="巡检、SQL 优化、Oracle SQL_ID 诊断、根因分析完成后会自动沉淀到这里；也可以手工记录经验。" />

    <div class="kg-main">
      <div ref="chartEl" class="kg-chart" v-loading="loading" />
      <div class="kg-side">
        <template v-if="cur">
          <div class="side-title"><el-tag size="small" :color="COLOR[cur.type]" effect="dark" style="border: none">{{ TYPE_LABEL[cur.type] || cur.type }}</el-tag>
            <span class="lbl">{{ cur.label }}</span></div>
          <div class="meta">出现 {{ cur.weight }} 次 · 来源 {{ cur.source || '-' }} · 更新 {{ fmt(cur.updatedAt) }}</div>
          <div v-if="props.text || props.advice || props.summary || props.lastDetail" class="box">
            <div v-if="props.advice"><b>建议：</b>{{ props.advice }}</div>
            <div v-if="props.lastDetail"><b>最近一次证据：</b>{{ props.lastDetail }}</div>
            <div v-if="props.text"><b>内容：</b>{{ props.text }}</div>
            <div v-if="props.summary"><b>摘要：</b>{{ props.summary }}</div>
            <div v-if="props.content"><b>笔记：</b>{{ props.content }}</div>
          </div>
          <pre v-else-if="props.sql" class="box code">{{ props.sql }}</pre>
          <div class="side-actions">
            <el-button size="small" @click="expand(cur.id)">展开邻居</el-button>
            <el-button size="small" type="danger" plain @click="remove(cur)">删除节点</el-button>
          </div>
          <div class="sub">关联节点</div>
          <el-scrollbar max-height="220px">
            <div v-for="n in related" :key="n.id" class="rel" @click="focus(n.id)">
              <span class="dot" :style="{ background: COLOR[n.type] }" />{{ n.label }}
            </div>
            <div v-if="!related.length" class="text-gray">无</div>
          </el-scrollbar>
        </template>
        <div v-else class="hint">
          <p>点击图中节点查看详情，双击展开邻居。</p>
          <p class="legend"><span v-for="(label, t) in TYPE_LABEL" :key="t"><i :style="{ background: COLOR[t] }" />{{ label }}</span></p>
        </div>
      </div>
    </div>

    <el-dialog v-model="noteDlg" title="记一条运维经验" width="520px">
      <el-form label-width="70px">
        <el-form-item label="标题"><el-input v-model="note.title" maxlength="100" show-word-limit /></el-form-item>
        <el-form-item label="内容"><el-input v-model="note.content" type="textarea" :rows="5" maxlength="2000" show-word-limit /></el-form-item>
        <el-form-item label="关联当前"><el-switch v-model="note.linkCur" :disabled="!cur" /><span class="text-gray" style="margin-left: 8px">{{ cur ? cur.label : '先在图中选中一个节点' }}</span></el-form-item>
      </el-form>
      <template #footer><el-button @click="noteDlg = false">取消</el-button><el-button type="primary" @click="saveNote">保存</el-button></template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Search, Refresh, EditPen } from '@element-plus/icons-vue'
import * as echarts from 'echarts'
import { kgApi } from '@/api/index.js'

const TYPE_LABEL = {
  INSTANCE: '实例', SQL: 'SQL', FINDING: '问题', INSPECTION: '巡检', RCA: '根因分析', CAUSE: '根因', ACTION: '处置建议',
  OPT: 'SQL优化', DIAG: 'SQL诊断', KNOWLEDGE: '知识文档', TABLE: '表', TAG: '标签', NOTE: '经验笔记',
}
const COLOR = {
  INSTANCE: '#3b82f6', SQL: '#8b5cf6', FINDING: '#f59e0b', INSPECTION: '#06b6d4', RCA: '#ef4444', CAUSE: '#f97316',
  ACTION: '#10b981', OPT: '#6366f1', DIAG: '#ec4899', KNOWLEDGE: '#64748b', TABLE: '#84cc16', TAG: '#94a3b8', NOTE: '#14b8a6',
}

const q = ref(''); const type = ref(''); const loading = ref(false); const stats = ref(null)
const chartEl = ref(null); let chart = null
const nodes = new Map(); const edges = new Map()
const cur = ref(null); const noteDlg = ref(false)
const note = reactive({ title: '', content: '', linkCur: true })
const empty = computed(() => stats.value && stats.value.totalNodes === 0)
const props = computed(() => (cur.value && cur.value.props) || {})
const related = computed(() => {
  if (!cur.value) return []
  const ids = new Set()
  edges.forEach(e => { if (e.source === cur.value.id) ids.add(e.target); if (e.target === cur.value.id) ids.add(e.source) })
  return [...ids].map(i => nodes.get(i)).filter(Boolean)
})
const fmt = v => (v ? String(v).replace('T', ' ').slice(0, 19) : '-')

function merge(g) {
  g.nodes.forEach(n => nodes.set(n.id, n))
  g.edges.forEach(e => edges.set(e.id, e))
}
function reset() { nodes.clear(); edges.clear(); cur.value = null }

function render() {
  if (!chartEl.value) return
  if (!chart) {
    chart = echarts.init(chartEl.value)
    chart.on('click', p => { if (p.dataType === 'node') focus(Number(p.data.id)) })
    chart.on('dblclick', p => { if (p.dataType === 'node') expand(Number(p.data.id)) })
  }
  const data = [...nodes.values()].map(n => ({
    id: String(n.id), name: n.label, value: n.weight,
    symbolSize: Math.min(46, 14 + Math.sqrt(n.weight || 1) * 6),
    itemStyle: { color: COLOR[n.type] || '#94a3b8' },
    label: { show: n.weight > 2 || n.type === 'INSTANCE' },
  }))
  const links = [...edges.values()].filter(e => nodes.has(e.source) && nodes.has(e.target))
    .map(e => ({ source: String(e.source), target: String(e.target), value: e.rel, lineStyle: { width: Math.min(4, 1 + (e.weight || 1) * 0.3) } }))
  chart.setOption({
    tooltip: { formatter: p => (p.dataType === 'node' ? `${TYPE_LABEL[nodes.get(Number(p.data.id))?.type] || ''}：${p.data.name}<br/>出现 ${p.data.value} 次` : p.data.value) },
    series: [{
      type: 'graph', layout: 'force', roam: true, draggable: true, data, links,
      force: { repulsion: 220, edgeLength: [60, 140], gravity: 0.08 },
      edgeSymbol: ['none', 'arrow'], edgeSymbolSize: 6,
      label: { position: 'right', fontSize: 11, formatter: p => String(p.name).slice(0, 18) },
      lineStyle: { color: '#cbd5e1', opacity: 0.8, curveness: 0.1 },
      emphasis: { focus: 'adjacency' },
    }],
  }, true)
}

async function loadStats() { stats.value = (await kgApi.stats()).data }
async function loadOverview() {
  loading.value = true
  try {
    reset(); await loadStats()
    merge((await kgApi.overview({ limit: 80, type: type.value || undefined })).data)
    await nextTick(); render()
  } finally { loading.value = false }
}
async function doSearch() {
  if (!q.value.trim()) return loadOverview()
  loading.value = true
  try {
    const list = (await kgApi.search({ q: q.value.trim(), type: type.value || undefined, limit: 12 })).data
    reset()
    if (!list.length) { ElMessage.info('没有匹配的节点'); return }
    for (const n of list.slice(0, 6)) merge((await kgApi.node(n.id, 1)).data.graph)
    list.forEach(n => nodes.set(n.id, n))
    await nextTick(); render(); focus(list[0].id)
  } finally { loading.value = false }
}
function focus(id) { cur.value = nodes.get(id) || null }
async function expand(id) {
  loading.value = true
  try { merge((await kgApi.node(id, 1)).data.graph); render(); focus(id) } finally { loading.value = false }
}
async function remove(n) {
  await ElMessageBox.confirm(`删除节点「${n.label}」及其关系？`, '确认', { type: 'warning' })
  await kgApi.remove(n.id)
  nodes.delete(n.id); [...edges.values()].forEach(e => { if (e.source === n.id || e.target === n.id) edges.delete(e.id) })
  cur.value = null; render(); loadStats()
}
async function saveNote() {
  if (!note.title.trim()) return ElMessage.warning('请填写标题')
  const r = await kgApi.addNote({ title: note.title, content: note.content, relateTo: note.linkCur && cur.value ? [cur.value.id] : [] })
  ElMessage.success('已记录'); noteDlg.value = false; note.title = ''; note.content = ''
  if (r.data?.nodeId) { const g = (await kgApi.node(r.data.nodeId, 1)).data.graph; merge(g); render() }
  loadStats()
}
const onResize = () => chart && chart.resize()
onMounted(() => { loadOverview(); window.addEventListener('resize', onResize) })
onBeforeUnmount(() => { window.removeEventListener('resize', onResize); chart && chart.dispose(); chart = null })
</script>

<style scoped>
.kg-bar { display: flex; gap: 8px; align-items: center; margin-bottom: 10px; flex-wrap: wrap }
.stat { color: #94a3b8; font-size: 12px; margin-left: auto }
.kg-main { display: flex; gap: 12px }
.kg-chart { flex: 1; height: 560px; border: 1px solid var(--el-border-color-lighter); border-radius: 6px; min-width: 0 }
.kg-side { width: 300px; border: 1px solid var(--el-border-color-lighter); border-radius: 6px; padding: 12px; font-size: 13px }
.side-title { display: flex; gap: 8px; align-items: center; margin-bottom: 6px }
.lbl { font-weight: 600; word-break: break-all }
.meta { color: #94a3b8; font-size: 12px; margin-bottom: 8px }
.box { background: var(--el-fill-color-light); border-radius: 4px; padding: 8px; margin-bottom: 8px; line-height: 1.6; word-break: break-all }
.code { white-space: pre-wrap; font-size: 12px; max-height: 160px; overflow: auto }
.side-actions { display: flex; gap: 8px; margin-bottom: 10px }
.sub { font-weight: 600; margin: 6px 0 }
.rel { padding: 3px 0; cursor: pointer; display: flex; align-items: center; gap: 6px }
.rel:hover { color: var(--el-color-primary) }
.dot { width: 8px; height: 8px; border-radius: 50%; flex: none }
.hint { color: #94a3b8 }
.legend { display: flex; flex-wrap: wrap; gap: 6px 12px }
.legend i { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 4px }
</style>
