<template>
  <div class="page-container">
    <!-- 统计卡片 -->
    <el-row :gutter="16" class="mb-16">
      <el-col :span="6" v-for="c in statCards" :key="c.label">
        <div class="stat-card" :style="{ borderLeftColor: c.color }">
          <div class="stat-num" :style="{ color: c.color }">{{ c.val }}</div>
          <div class="stat-lbl">{{ c.label }}</div>
        </div>
      </el-col>
    </el-row>

    <el-tabs v-model="activeTab" @tab-change="onTabChange">
      <!-- 拓扑图 -->
      <el-tab-pane label="依赖拓扑图" name="topology">
        <div class="card">
          <div class="card-title" style="justify-content:space-between">
            <span>应用-数据库依赖拓扑</span>
            <el-button size="small" icon="Refresh" @click="loadTopology">刷新</el-button>
          </div>
          <div ref="graphRef" style="height:500px" v-loading="graphLoading"></div>
          <div v-if="!topoData.nodes.length && !graphLoading" style="text-align:center;padding:40px;color:#909399">
            暂无拓扑数据，请先添加应用和依赖关系
          </div>
        </div>
      </el-tab-pane>

      <!-- 应用管理 -->
      <el-tab-pane label="应用管理" name="apps">
        <div class="card">
          <div class="card-title" style="justify-content:space-between">
            <span>应用/业务系统</span>
            <el-button size="small" type="primary" icon="Plus" @click="openAppDialog()">新增应用</el-button>
          </div>
          <el-table :data="apps" stripe size="small" v-loading="appsLoading" height="460">
            <el-table-column prop="APP_NAME" label="应用名称" min-width="120" />
            <el-table-column prop="APP_CODE" label="编码" width="120" />
            <el-table-column label="类型" width="100">
              <template #default="{ row }">
                <el-tag size="small">{{ row.APP_TYPE }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="BIZ_LINE" label="业务线" width="120" />
            <el-table-column prop="OWNER" label="负责人" width="100" />
            <el-table-column label="状态" width="80">
              <template #default="{ row }">
                <el-tag :type="row.STATUS === 'ACTIVE' ? 'success' : 'info'" size="small">{{ row.STATUS }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="160" fixed="right">
              <template #default="{ row }">
                <el-button link type="primary" size="small" @click="openAppDialog(row)">编辑</el-button>
                <el-button link type="primary" size="small" @click="viewAppImpact(row)">影响分析</el-button>
                <el-button link type="danger" size="small" @click="deleteApp(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
          <div style="padding:12px 0;text-align:right">
            <el-pagination v-model:current-page="appPage" :page-size="20" :total="appTotal"
              layout="total,prev,pager,next" @current-change="loadApps" small />
          </div>
        </div>
      </el-tab-pane>

      <!-- 依赖关系管理 -->
      <el-tab-pane label="依赖关系" name="relations">
        <div class="card">
          <div class="card-title" style="justify-content:space-between">
            <span>应用-数据库依赖关系</span>
            <el-button size="small" type="primary" icon="Plus" @click="openRelDialog()">新增依赖</el-button>
          </div>
          <el-table :data="relations" stripe size="small" v-loading="relsLoading" height="460">
            <el-table-column prop="APP_NAME" label="应用" min-width="120" />
            <el-table-column label="应用类型" width="100">
              <template #default="{ row }"><el-tag size="small">{{ row.APP_TYPE }}</el-tag></template>
            </el-table-column>
            <el-table-column prop="INSTANCE_NAME" label="数据库实例" min-width="120" />
            <el-table-column label="DB类型" width="100">
              <template #default="{ row }"><el-tag size="small" type="info">{{ row.DB_TYPE }}</el-tag></template>
            </el-table-column>
            <el-table-column label="关系类型" width="110">
              <template #default="{ row }">{{ relTypeLabel(row.RELATION_TYPE) }}</template>
            </el-table-column>
            <el-table-column label="依赖强度" width="90">
              <template #default="{ row }">
                <el-tag :type="row.DEPENDENCY === 'STRONG' ? 'danger' : 'warning'" size="small">{{ row.DEPENDENCY === 'STRONG' ? '强依赖' : '弱依赖' }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="实例状态" width="80">
              <template #default="{ row }">
                <span :style="{ color: row.INST_STATUS === 'RUNNING' ? '#52c41a' : '#ff4d4f' }">{{ row.INST_STATUS }}</span>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="120" fixed="right">
              <template #default="{ row }">
                <el-button link type="primary" size="small" @click="viewBlastRadius(row.INSTANCE_ID)">爆炸半径</el-button>
                <el-button link type="danger" size="small" @click="deleteRel(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
          <div style="padding:12px 0;text-align:right">
            <el-pagination v-model:current-page="relPage" :page-size="50" :total="relTotal"
              layout="total,prev,pager,next" @current-change="loadRelations" small />
          </div>
        </div>
      </el-tab-pane>
    </el-tabs>

    <!-- 应用编辑弹窗 -->
    <el-dialog v-model="appDialogVisible" :title="editingApp ? '编辑应用' : '新增应用'" width="500px">
      <el-form :model="appForm" label-width="90px">
        <el-form-item label="应用名称" required>
          <el-input v-model="appForm.appName" placeholder="如: 核心交易系统" />
        </el-form-item>
        <el-form-item label="应用编码">
          <el-input v-model="appForm.appCode" placeholder="如: core-trade" />
        </el-form-item>
        <el-form-item label="应用类型">
          <el-select v-model="appForm.appType" style="width:100%">
            <el-option label="应用系统" value="APP" />
            <el-option label="服务" value="SERVICE" />
            <el-option label="微服务" value="MICROSERVICE" />
            <el-option label="中间件" value="MIDDLEWARE" />
            <el-option label="其他" value="OTHER" />
          </el-select>
        </el-form-item>
        <el-form-item label="业务线">
          <el-input v-model="appForm.bizLine" placeholder="如: 零售业务" />
        </el-form-item>
        <el-form-item label="负责人">
          <el-input v-model="appForm.owner" />
        </el-form-item>
        <el-form-item label="描述">
          <el-input v-model="appForm.description" type="textarea" :rows="2" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="appDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="appSaving" @click="saveApp">保存</el-button>
      </template>
    </el-dialog>

    <!-- 新增依赖弹窗 -->
    <el-dialog v-model="relDialogVisible" title="新增依赖关系" width="480px">
      <el-form :model="relForm" label-width="90px">
        <el-form-item label="应用" required>
          <el-select v-model="relForm.appId" filterable placeholder="选择应用" style="width:100%">
            <el-option v-for="a in allApps" :key="a.APP_ID" :label="a.APP_NAME" :value="a.APP_ID" />
          </el-select>
        </el-form-item>
        <el-form-item label="数据库实例" required>
          <el-select v-model="relForm.instanceId" filterable placeholder="选择实例" style="width:100%">
            <el-option v-for="i in allInstances" :key="i.INSTANCE_ID" :label="`${i.INSTANCE_NAME} (${i.DB_TYPE})`" :value="i.INSTANCE_ID" />
          </el-select>
        </el-form-item>
        <el-form-item label="关系类型">
          <el-select v-model="relForm.relationType" style="width:100%">
            <el-option label="依赖" value="DEPENDS_ON" />
            <el-option label="读取" value="READS_FROM" />
            <el-option label="写入" value="WRITES_TO" />
            <el-option label="备份" value="BACKUP_FOR" />
          </el-select>
        </el-form-item>
        <el-form-item label="依赖强度">
          <el-radio-group v-model="relForm.dependency">
            <el-radio value="STRONG">强依赖</el-radio>
            <el-radio value="WEAK">弱依赖</el-radio>
            <el-radio value="OPTIONAL">可选</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="relForm.description" type="textarea" :rows="2" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="relDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="relSaving" @click="saveRelation">保存</el-button>
      </template>
    </el-dialog>

    <!-- 爆炸半径分析弹窗 -->
    <el-dialog v-model="blastVisible" title="爆炸半径分析" width="680px">
      <div v-if="blastData" v-loading="blastLoading">
        <el-alert :title="`实例: ${blastData.instance.name} (${blastData.instance.dbType})`"
          :type="blastData.summary.totalApps > 0 ? 'warning' : 'success'" :closable="false" show-icon class="mb-16">
          <template #default>
            状态: {{ blastData.instance.status }} | 健康分: {{ blastData.instance.health ?? '-' }} |
            影响 {{ blastData.summary.totalApps }} 个应用（{{ blastData.summary.strongDeps }} 强依赖）
            <span v-if="blastData.summary.affectedBizLines.length">，涉及业务线: {{ blastData.summary.affectedBizLines.join(', ') }}</span>
          </template>
        </el-alert>

        <div v-if="blastData.affectedApps.length">
          <h4 style="margin:8px 0">受影响应用</h4>
          <el-table :data="blastData.affectedApps" size="small" stripe border>
            <el-table-column prop="APP_NAME" label="应用名" min-width="120" />
            <el-table-column prop="APP_TYPE" label="类型" width="90" />
            <el-table-column prop="BIZ_LINE" label="业务线" width="100" />
            <el-table-column prop="OWNER" label="负责人" width="90" />
            <el-table-column label="依赖强度" width="90">
              <template #default="{ row }">
                <el-tag :type="row.DEPENDENCY === 'STRONG' ? 'danger' : 'warning'" size="small">
                  {{ row.DEPENDENCY === 'STRONG' ? '强' : '弱' }}
                </el-tag>
              </template>
            </el-table-column>
          </el-table>
        </div>

        <div v-if="blastData.clusterMembers.length" style="margin-top:16px">
          <h4 style="margin:8px 0">同集群实例</h4>
          <el-table :data="blastData.clusterMembers" size="small" stripe border>
            <el-table-column prop="INSTANCE_NAME" label="实例名" />
            <el-table-column prop="DB_TYPE" label="类型" width="100" />
            <el-table-column prop="STATUS" label="状态" width="100" />
          </el-table>
        </div>

        <div v-if="blastData.activeAlerts.length" style="margin-top:16px">
          <h4 style="margin:8px 0">活跃告警</h4>
          <el-table :data="blastData.activeAlerts" size="small" stripe border>
            <el-table-column prop="RULE_NAME" label="规则" width="120" />
            <el-table-column label="级别" width="70">
              <template #default="{ row }"><span :class="`badge-${row.SEVERITY?.toLowerCase()}`">{{ row.SEVERITY }}</span></template>
            </el-table-column>
            <el-table-column prop="CONTENT" label="内容" show-overflow-tooltip />
          </el-table>
        </div>

        <el-empty v-if="!blastData.affectedApps.length" description="该实例无关联应用，爆炸半径为零" />
      </div>
    </el-dialog>

    <!-- 应用影响分析弹窗 -->
    <el-dialog v-model="impactVisible" title="应用影响分析" width="600px">
      <div v-if="impactData" v-loading="impactLoading">
        <el-alert :title="`应用: ${impactData.app.name} (${impactData.app.type})`" type="info" :closable="false" show-icon class="mb-16">
          <template #default>
            业务线: {{ impactData.app.bizLine || '-' }} | 依赖 {{ impactData.summary.totalInstances }} 个实例（{{ impactData.summary.strongDeps }} 强依赖）
          </template>
        </el-alert>
        <el-table :data="impactData.dependentInstances" size="small" stripe border>
          <el-table-column prop="INSTANCE_NAME" label="实例名" min-width="120" />
          <el-table-column prop="DB_TYPE" label="类型" width="100" />
          <el-table-column prop="HOST_IP" label="主机" width="130" />
          <el-table-column label="状态" width="80">
            <template #default="{ row }">
              <span :style="{ color: row.STATUS === 'RUNNING' ? '#52c41a' : '#ff4d4f' }">{{ row.STATUS }}</span>
            </template>
          </el-table-column>
          <el-table-column label="健康分" width="80" prop="HEALTH_SCORE" />
          <el-table-column label="依赖强度" width="90">
            <template #default="{ row }">
              <el-tag :type="row.DEPENDENCY === 'STRONG' ? 'danger' : 'warning'" size="small">
                {{ row.DEPENDENCY === 'STRONG' ? '强' : '弱' }}
              </el-tag>
            </template>
          </el-table-column>
        </el-table>
        <el-empty v-if="!impactData.dependentInstances.length" description="该应用无关联实例" />
      </div>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onUnmounted, nextTick } from 'vue'
import { appRelationApi, cmdbApi } from '@/api/index.js'
import { ElMessage, ElMessageBox } from 'element-plus'
import * as echarts from 'echarts'

const activeTab = ref('topology')
const statsData = ref({})

// ─── 统计卡片 ──────────────────────────────────────────────
const statCards = computed(() => [
  { label: '应用总数', val: statsData.value.totalApps ?? '-', color: '#1890ff' },
  { label: '依赖关系数', val: statsData.value.totalRelations ?? '-', color: '#52c41a' },
  { label: '孤立应用', val: statsData.value.orphanApps ?? '-', color: '#faad14' },
  { label: '未关联实例', val: statsData.value.unlinkedInstances ?? '-', color: '#ff4d4f' },
])

// ─── 应用管理 ──────────────────────────────────────────────
const apps = ref([])
const appsLoading = ref(false)
const appPage = ref(1)
const appTotal = ref(0)
const appDialogVisible = ref(false)
const editingApp = ref(null)
const appSaving = ref(false)
const appForm = reactive({ appName: '', appCode: '', appType: 'APP', bizLine: '', owner: '', description: '' })

async function loadApps() {
  appsLoading.value = true
  try {
    const r = await appRelationApi.apps({ page: appPage.value, size: 20 })
    if (r.code === 200) { apps.value = r.data.list || []; appTotal.value = r.data.total || 0 }
  } finally { appsLoading.value = false }
}

function openAppDialog(row) {
  editingApp.value = row || null
  if (row) {
    Object.assign(appForm, { appName: row.APP_NAME, appCode: row.APP_CODE, appType: row.APP_TYPE, bizLine: row.BIZ_LINE, owner: row.OWNER, description: row.DESCRIPTION })
  } else {
    Object.assign(appForm, { appName: '', appCode: '', appType: 'APP', bizLine: '', owner: '', description: '' })
  }
  appDialogVisible.value = true
}

async function saveApp() {
  if (!appForm.appName) return ElMessage.warning('请输入应用名称')
  appSaving.value = true
  try {
    if (editingApp.value) {
      await appRelationApi.updateApp(editingApp.value.APP_ID, appForm)
    } else {
      await appRelationApi.createApp(appForm)
    }
    ElMessage.success('保存成功')
    appDialogVisible.value = false
    loadApps()
    loadStats()
  } catch (e) { ElMessage.error(e.message) }
  finally { appSaving.value = false }
}

async function deleteApp(row) {
  await ElMessageBox.confirm(`确定删除应用 "${row.APP_NAME}"？关联的依赖关系将同时删除。`, '删除确认', { type: 'warning' })
  try {
    await appRelationApi.deleteApp(row.APP_ID)
    ElMessage.success('删除成功')
    loadApps(); loadStats(); loadTopology()
  } catch (e) { ElMessage.error(e.message) }
}

// ─── 依赖关系 ──────────────────────────────────────────────
const relations = ref([])
const relsLoading = ref(false)
const relPage = ref(1)
const relTotal = ref(0)
const relDialogVisible = ref(false)
const relSaving = ref(false)
const allApps = ref([])
const allInstances = ref([])
const relForm = reactive({ appId: null, instanceId: null, relationType: 'DEPENDS_ON', dependency: 'STRONG', description: '' })

function relTypeLabel(t) { return { DEPENDS_ON: '依赖', READS_FROM: '读取', WRITES_TO: '写入', BACKUP_FOR: '备份' }[t] || t }

async function loadRelations() {
  relsLoading.value = true
  try {
    const r = await appRelationApi.relations({ page: relPage.value, size: 50 })
    if (r.code === 200) { relations.value = r.data.list || []; relTotal.value = r.data.total || 0 }
  } finally { relsLoading.value = false }
}

async function openRelDialog() {
  relDialogVisible.value = true
  Object.assign(relForm, { appId: null, instanceId: null, relationType: 'DEPENDS_ON', dependency: 'STRONG', description: '' })
  // Load all apps and instances for selectors
  const [ar, ir] = await Promise.all([
    appRelationApi.apps({ size: 999 }),
    cmdbApi.list({ size: 999 }),
  ])
  allApps.value = ar.data?.list || []
  allInstances.value = ir.data?.list || []
}

async function saveRelation() {
  if (!relForm.appId || !relForm.instanceId) return ElMessage.warning('请选择应用和实例')
  relSaving.value = true
  try {
    await appRelationApi.createRelation(relForm)
    ElMessage.success('创建成功')
    relDialogVisible.value = false
    loadRelations(); loadStats(); loadTopology()
  } catch (e) { ElMessage.error(e.message) }
  finally { relSaving.value = false }
}

async function deleteRel(row) {
  await ElMessageBox.confirm('确定删除该依赖关系？', '删除确认', { type: 'warning' })
  try {
    await appRelationApi.deleteRelation(row.RELATION_ID)
    ElMessage.success('删除成功')
    loadRelations(); loadStats(); loadTopology()
  } catch (e) { ElMessage.error(e.message) }
}

// ─── 拓扑图 ────────────────────────────────────────────────
const graphRef = ref()
const graphLoading = ref(false)
const topoData = ref({ nodes: [], edges: [] })
const _charts = []
const _resizeHandlers = []

async function loadTopology() {
  graphLoading.value = true
  try {
    const r = await appRelationApi.topology()
    if (r.code === 200) {
      topoData.value = r.data || { nodes: [], edges: [] }
      await nextTick()
      renderGraph()
    }
  } finally { graphLoading.value = false }
}

function renderGraph() {
  if (!graphRef.value || !topoData.value.nodes.length) return
  // Dispose old instance
  const old = echarts.getInstanceByDom(graphRef.value)
  if (old) old.dispose()

  const chart = echarts.init(graphRef.value)
  _charts.push(chart)

  const nodes = topoData.value.nodes.map(n => ({
    id: n.id,
    name: n.label,
    symbolSize: n.type === 'app' ? 45 : 35,
    symbol: n.type === 'app' ? 'roundRect' : 'circle',
    category: n.type === 'app' ? 0 : 1,
    itemStyle: {
      color: n.type === 'app'
        ? (n.status === 'ACTIVE' ? '#1890ff' : '#d9d9d9')
        : (n.status === 'RUNNING' ? '#52c41a' : n.status === 'ERROR' ? '#ff4d4f' : '#faad14'),
      borderColor: '#fff', borderWidth: 2
    },
    label: { show: true, fontSize: 11, position: 'bottom' },
    tooltip: {
      formatter: n.type === 'app'
        ? `<b>${n.label}</b><br/>类型: ${n.subType}<br/>业务线: ${n.bizLine || '-'}<br/>状态: ${n.status}`
        : `<b>${n.label}</b><br/>DB: ${n.subType}<br/>主机: ${n.host}<br/>状态: ${n.status}<br/>健康: ${n.health ?? '-'}`
    }
  }))

  const edges = topoData.value.edges.map(e => ({
    source: e.source, target: e.target,
    lineStyle: { color: e.dependency === 'STRONG' ? '#ff4d4f' : '#faad14', width: e.dependency === 'STRONG' ? 3 : 1.5, type: e.dependency === 'WEAK' ? 'dashed' : 'solid' },
    label: { show: true, formatter: relTypeLabel(e.relType), fontSize: 10, color: '#909399' }
  }))

  chart.setOption({
    backgroundColor: 'transparent',
    tooltip: { trigger: 'item' },
    legend: { data: [{ name: '应用', icon: 'roundRect' }, { name: '数据库实例', icon: 'circle' }], bottom: 0 },
    series: [{
      type: 'graph', layout: 'force', roam: true, draggable: true,
      data: nodes, links: edges, categories: [{ name: '应用' }, { name: '数据库实例' }],
      force: { repulsion: 300, edgeLength: [120, 200], gravity: 0.1 },
      emphasis: { focus: 'adjacency', lineStyle: { width: 5 } },
    }]
  })

  const h = () => chart.resize()
  window.addEventListener('resize', h)
  _resizeHandlers.push(h)
}

// ─── 爆炸半径分析 ──────────────────────────────────────────
const blastVisible = ref(false)
const blastLoading = ref(false)
const blastData = ref(null)

async function viewBlastRadius(instanceId) {
  blastVisible.value = true
  blastLoading.value = true
  blastData.value = null
  try {
    const r = await appRelationApi.blastRadius(instanceId)
    if (r.code === 200) blastData.value = r.data
  } catch (e) { ElMessage.error(e.message) }
  finally { blastLoading.value = false }
}

// ─── 应用影响分析 ──────────────────────────────────────────
const impactVisible = ref(false)
const impactLoading = ref(false)
const impactData = ref(null)

async function viewAppImpact(row) {
  impactVisible.value = true
  impactLoading.value = true
  impactData.value = null
  try {
    const r = await appRelationApi.appImpact(row.APP_ID)
    if (r.code === 200) impactData.value = r.data
  } catch (e) { ElMessage.error(e.message) }
  finally { impactLoading.value = false }
}

// ─── 统计与初始化 ──────────────────────────────────────────
async function loadStats() {
  try { const r = await appRelationApi.stats(); if (r.code === 200) statsData.value = r.data } catch {}
}

function onTabChange(tab) {
  if (tab === 'apps') loadApps()
  else if (tab === 'relations') loadRelations()
  else if (tab === 'topology') { nextTick(() => renderGraph()) }
}

onMounted(() => { loadStats(); loadTopology() })
onUnmounted(() => {
  _resizeHandlers.forEach(h => window.removeEventListener('resize', h))
  _charts.forEach(c => c.dispose())
  _charts.length = 0; _resizeHandlers.length = 0
})
</script>

<style scoped>
.stat-card {
  background: var(--agent-panel-bg, #ffffff);
  border: 1px solid var(--agent-border, #e4e7ed);
  border-radius: 8px; padding: 16px 20px; border-left: 4px solid;
}
.stat-num { font-size: 28px; font-weight: 700; }
.stat-lbl { font-size: 13px; color: var(--agent-text-muted, #909399); margin-top: 4px; }
</style>
