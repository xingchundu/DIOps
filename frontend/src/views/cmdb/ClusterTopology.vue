<template>
  <div class="page-container">
    <!-- 概览卡片 -->
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
      <!-- 左侧：集群列表 -->
      <el-col :span="10">
        <div class="card">
          <div class="card-title" style="justify-content:space-between">
            <span><el-icon><Grid /></el-icon> 集群列表</span>
            <el-button v-if="canMutate" type="primary" size="small" icon="Plus" @click="openClusterForm()">新建集群</el-button>
          </div>
          <el-table :data="clusters" stripe size="small" v-loading="loading" highlight-current-row
            @current-change="onClusterSelect" height="460">
            <el-table-column prop="CLUSTER_NAME" label="集群名称" min-width="120" show-overflow-tooltip />
            <el-table-column label="类型" width="80">
              <template #default="{ row }">
                <el-tag size="small" :type="clusterTypeColor(row.CLUSTER_TYPE)">{{ row.CLUSTER_TYPE }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="状态" width="80">
              <template #default="{ row }">
                <el-tag size="small" :type="statusType(row.STATUS)">{{ statusLabel(row.STATUS) }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="MEMBER_COUNT" label="成员" width="55" align="center" />
            <el-table-column v-if="canMutate" label="操作" width="120" fixed="right">
              <template #default="{ row }">
                <el-button link type="primary" size="small" @click="openClusterForm(row)">编辑</el-button>
                <el-popconfirm title="确定删除该集群吗？" @confirm="delCluster(row.CLUSTER_ID)">
                  <template #reference><el-button link type="danger" size="small">删除</el-button></template>
                </el-popconfirm>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </el-col>

      <!-- 右侧：拓扑图 -->
      <el-col :span="14">
        <div class="card">
          <div class="card-title" style="justify-content:space-between">
            <span><el-icon><Share /></el-icon> 拓扑可视化</span>
            <el-button v-if="canMutate && currentCluster" size="small" type="primary" icon="Plus" @click="memberDialog=true">添加成员</el-button>
          </div>
          <div v-if="currentCluster" ref="topoChartRef" style="height:420px"></div>
          <el-empty v-else description="请从左侧选择一个集群" style="height:420px" />
        </div>
        <!-- 成员列表 -->
        <div v-if="currentCluster" class="card" style="margin-top:16px">
          <div class="card-title"><el-icon><User /></el-icon> 成员实例 — {{ currentCluster.CLUSTER_NAME }}</div>
          <el-table :data="members" stripe size="small" v-loading="membersLoading">
            <el-table-column prop="INSTANCE_NAME" label="实例名" min-width="140" />
            <el-table-column label="类型" width="90">
              <template #default="{ row }"><el-tag size="small">{{ row.DB_TYPE }}</el-tag></template>
            </el-table-column>
            <el-table-column prop="HOST_IP" label="IP" width="130" />
            <el-table-column label="角色" width="100">
              <template #default="{ row }">
                <el-tag size="small" :type="roleColor(row.NODE_ROLE)">{{ row.NODE_ROLE || '-' }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="实例状态" width="90">
              <template #default="{ row }">
                <el-tag size="small" :type="row.STATUS==='RUNNING'?'success':row.STATUS==='ERROR'?'danger':'info'">{{ row.STATUS }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="HEALTH_SCORE" label="健康分" width="80" align="center" />
            <el-table-column v-if="canMutate" label="操作" width="80" fixed="right">
              <template #default="{ row }">
                <el-popconfirm title="确定移除该成员吗？" @confirm="removeMember(row.INSTANCE_ID)">
                  <template #reference><el-button link type="danger" size="small">移除</el-button></template>
                </el-popconfirm>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </el-col>
    </el-row>

    <!-- 新建/编辑集群弹窗 -->
    <el-dialog v-model="clusterDialog" :title="clusterForm.CLUSTER_ID ? '编辑集群' : '新建集群'" width="460px" :close-on-click-modal="false">
      <el-form :model="clusterForm" :rules="clusterRules" ref="clusterFormRef" label-width="90px">
        <el-form-item label="集群名称" prop="clusterName">
          <el-input v-model="clusterForm.clusterName" placeholder="如 prod-rac-01" />
        </el-form-item>
        <el-form-item label="集群类型" prop="clusterType">
          <el-select v-model="clusterForm.clusterType" style="width:100%">
            <el-option v-for="t in clusterTypes" :key="t.value" :label="t.label" :value="t.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="VIP">
          <el-input v-model="clusterForm.vip" placeholder="如 192.168.1.100" />
        </el-form-item>
        <el-form-item label="状态">
          <el-select v-model="clusterForm.status" style="width:100%">
            <el-option label="正常" value="NORMAL" /><el-option label="告警" value="WARNING" />
            <el-option label="异常" value="ERROR" /><el-option label="维护" value="MAINTENANCE" />
          </el-select>
        </el-form-item>
        <el-form-item label="描述">
          <el-input v-model="clusterForm.description" type="textarea" :rows="2" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="clusterDialog=false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveCluster">保存</el-button>
      </template>
    </el-dialog>

    <!-- 添加成员弹窗 -->
    <el-dialog v-model="memberDialog" title="添加集群成员" width="420px">
      <el-form :model="memberForm" label-width="80px">
        <el-form-item label="选择实例">
          <el-select v-model="memberForm.instanceId" filterable placeholder="搜索实例" style="width:100%">
            <el-option v-for="inst in availableInstances" :key="inst.INSTANCE_ID"
              :label="`${inst.INSTANCE_NAME} (${inst.HOST_IP}:${inst.PORT})`" :value="inst.INSTANCE_ID" />
          </el-select>
        </el-form-item>
        <el-form-item label="节点角色">
          <el-select v-model="memberForm.nodeRole" style="width:100%">
            <el-option label="PRIMARY" value="PRIMARY" /><el-option label="STANDBY" value="STANDBY" />
            <el-option label="READONLY" value="READONLY" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="memberDialog=false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="addMember">添加</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onUnmounted, nextTick, watch } from 'vue'
import { useAuthStore } from '@/stores/auth.js'
import { cmdbApi } from '@/api/index.js'
import { ElMessage } from 'element-plus'
import * as echarts from 'echarts'

const auth = useAuthStore()
const canMutate = computed(() => auth.isDBA)

const clusters = ref([])
const loading = ref(false)
const currentCluster = ref(null)
const members = ref([])
const membersLoading = ref(false)
const allInstances = ref([])

const topoChartRef = ref()
let topoChart = null

// 集群类型
const clusterTypes = [
  { label: 'Oracle RAC', value: 'RAC' },
  { label: 'Oracle Data Guard', value: 'DG' },
  { label: 'MySQL MGR', value: 'MGR' },
  { label: 'Percona XtraDB Cluster', value: 'PXC' },
  { label: 'Patroni', value: 'PATRONI' },
  { label: '主从复制', value: 'REPLICATION' },
  { label: '其他', value: 'OTHER' },
]

// 统计卡片
const statCards = computed(() => {
  const total = clusters.value.length
  const byType = {}
  clusters.value.forEach(c => { byType[c.CLUSTER_TYPE] = (byType[c.CLUSTER_TYPE] || 0) + 1 })
  return [
    { label: '集群总数', val: total, icon: '🔗', g1: '#1890ff', g2: '#096dd9' },
    { label: 'RAC集群', val: byType.RAC || 0, icon: '🏢', g1: '#52c41a', g2: '#389e0d' },
    { label: 'DG集群', val: byType.DG || 0, icon: '🔄', g1: '#faad14', g2: '#d48806' },
    { label: '其他类型', val: total - (byType.RAC || 0) - (byType.DG || 0), icon: '📦', g1: '#722ed1', g2: '#531dab' },
  ]
})

// 可用实例（排除已在当前集群中的）
const availableInstances = computed(() => {
  const memberIds = new Set(members.value.map(m => m.INSTANCE_ID))
  return allInstances.value.filter(i => !memberIds.has(i.INSTANCE_ID))
})

function clusterTypeColor(t) {
  return { RAC: 'danger', DG: 'warning', MGR: 'primary', PXC: 'success', PATRONI: '', REPLICATION: 'info' }[t] || 'info'
}
function statusType(s) { return { NORMAL: 'success', WARNING: 'warning', ERROR: 'danger', MAINTENANCE: 'info' }[s] || 'info' }
function statusLabel(s) { return { NORMAL: '正常', WARNING: '告警', ERROR: '异常', MAINTENANCE: '维护' }[s] || s }
function roleColor(r) { return { PRIMARY: 'danger', STANDBY: 'warning', READONLY: 'info' }[r] || '' }

async function loadClusters() {
  loading.value = true
  try {
    const r = await cmdbApi.clusters()
    if (r.code === 200) clusters.value = r.data || []
  } finally { loading.value = false }
}

async function loadInstances() {
  try {
    const r = await cmdbApi.list({})
    if (r.code === 200) allInstances.value = r.data?.list || r.data || []
  } catch {}
}

async function onClusterSelect(row) {
  if (!row) { currentCluster.value = null; members.value = []; return }
  currentCluster.value = row
  membersLoading.value = true
  try {
    const r = await cmdbApi.clusterDetail(row.CLUSTER_ID)
    if (r.code === 200) {
      members.value = r.data.members || []
      await nextTick()
      renderTopology()
    }
  } finally { membersLoading.value = false }
}

function renderTopology() {
  if (!topoChartRef.value || !currentCluster.value) return
  if (topoChart) topoChart.dispose()
  topoChart = echarts.init(topoChartRef.value)

  const cluster = currentCluster.value
  const nodes = []
  const links = []

  // 集群中心节点
  nodes.push({
    name: cluster.CLUSTER_NAME,
    symbolSize: 60,
    symbol: 'roundRect',
    itemStyle: { color: '#1890ff', borderColor: '#096dd9', borderWidth: 2 },
    label: { show: true, position: 'inside', fontSize: 11, color: '#fff', fontWeight: 'bold' },
    category: 0,
  })

  const roleColors = { PRIMARY: '#ff4d4f', STANDBY: '#faad14', READONLY: '#52c41a' }
  const roleSizes = { PRIMARY: 45, STANDBY: 35, READONLY: 28 }

  members.value.forEach(m => {
    const nodeName = m.INSTANCE_NAME || `实例${m.INSTANCE_ID}`
    nodes.push({
      name: nodeName,
      symbolSize: roleSizes[m.NODE_ROLE] || 30,
      symbol: 'circle',
      itemStyle: { color: roleColors[m.NODE_ROLE] || '#909399' },
      label: {
        show: true, position: 'bottom', fontSize: 10,
        formatter: `${nodeName}\n${m.HOST_IP}:${m.PORT}`,
        color: '#303133',
      },
      category: 1,
    })
    links.push({
      source: cluster.CLUSTER_NAME,
      target: nodeName,
      lineStyle: { color: roleColors[m.NODE_ROLE] || '#909399', width: 2, type: 'solid' },
    })
  })

  topoChart.setOption({
    backgroundColor: 'transparent',
    tooltip: {
      formatter: p => {
        if (p.dataType === 'node') {
          const m = members.value.find(x => (x.INSTANCE_NAME || `实例${x.INSTANCE_ID}`) === p.name)
          if (m) return `${m.INSTANCE_NAME}<br/>类型: ${m.DB_TYPE}<br/>角色: ${m.NODE_ROLE}<br/>IP: ${m.HOST_IP}:${m.PORT}<br/>状态: ${m.STATUS}<br/>健康分: ${m.HEALTH_SCORE}`
          return p.name
        }
        return ''
      },
    },
    series: [{
      type: 'graph',
      layout: 'force',
      roam: true,
      draggable: true,
      force: { repulsion: 300, gravity: 0.1, edgeLength: [100, 180], layoutAnimation: true },
      data: nodes,
      links: links,
      categories: [{ name: '集群' }, { name: '实例' }],
      lineStyle: { opacity: 0.8, curveness: 0 },
      emphasis: { focus: 'adjacency', lineStyle: { width: 4 } },
    }],
  })
}

// 集群表单
const clusterDialog = ref(false)
const clusterFormRef = ref()
const saving = ref(false)
const clusterForm = reactive({ CLUSTER_ID: null, clusterName: '', clusterType: 'RAC', vip: '', status: 'NORMAL', description: '' })
const clusterRules = {
  clusterName: [{ required: true, message: '请输入集群名称', trigger: 'blur' }],
  clusterType: [{ required: true, message: '请选择集群类型', trigger: 'change' }],
}

function openClusterForm(row = null) {
  if (row) {
    Object.assign(clusterForm, {
      CLUSTER_ID: row.CLUSTER_ID, clusterName: row.CLUSTER_NAME, clusterType: row.CLUSTER_TYPE,
      vip: row.VIP || '', status: row.STATUS || 'NORMAL', description: row.DESCRIPTION || '',
    })
  } else {
    Object.assign(clusterForm, { CLUSTER_ID: null, clusterName: '', clusterType: 'RAC', vip: '', status: 'NORMAL', description: '' })
  }
  clusterDialog.value = true
}

async function saveCluster() {
  try { await clusterFormRef.value.validate() } catch { return }
  saving.value = true
  try {
    const payload = { ...clusterForm }
    let r
    if (payload.CLUSTER_ID) r = await cmdbApi.updateCluster(payload.CLUSTER_ID, payload)
    else r = await cmdbApi.createCluster(payload)
    if (r.code === 200) {
      ElMessage.success(r.msg || '操作成功')
      clusterDialog.value = false
      await loadClusters()
    } else { ElMessage.error(r.msg || '操作失败') }
  } finally { saving.value = false }
}

async function delCluster(id) {
  try {
    const r = await cmdbApi.deleteCluster(id)
    if (r.code === 200) { ElMessage.success(r.msg || '删除成功'); currentCluster.value = null; members.value = []; await loadClusters() }
    else { ElMessage.error(r.msg || '删除失败') }
  } catch (e) { ElMessage.error(e.message || '删除失败') }
}

// 成员管理
const memberDialog = ref(false)
const memberForm = reactive({ instanceId: null, nodeRole: 'PRIMARY' })

async function addMember() {
  if (!memberForm.instanceId) return ElMessage.warning('请选择实例')
  saving.value = true
  try {
    const r = await cmdbApi.addClusterMember(currentCluster.value.CLUSTER_ID, memberForm)
    if (r.code === 200) {
      ElMessage.success(r.msg || '添加成功')
      memberDialog.value = false
      await onClusterSelect(currentCluster.value)
      await loadClusters()
    } else { ElMessage.error(r.msg || '添加失败') }
  } catch (e) { ElMessage.error(e?.message || '添加失败') }
  finally { saving.value = false }
}

async function removeMember(instanceId) {
  try {
    const r = await cmdbApi.removeClusterMember(currentCluster.value.CLUSTER_ID, instanceId)
    if (r.code === 200) {
      ElMessage.success(r.msg || '已移除')
      await onClusterSelect(currentCluster.value)
      await loadClusters()
    } else { ElMessage.error(r.msg || '操作失败') }
  } catch (e) { ElMessage.error(e.message || '操作失败') }
}

onMounted(async () => {
  await Promise.all([loadClusters(), loadInstances()])
  window.addEventListener('resize', resizeHandler)
})

onUnmounted(() => {
  window.removeEventListener('resize', resizeHandler)
  if (topoChart) { topoChart.dispose(); topoChart = null }
})

// 窗口缩放时重绘拓扑图
const resizeHandler = () => { if (topoChart) topoChart.resize() }
</script>
