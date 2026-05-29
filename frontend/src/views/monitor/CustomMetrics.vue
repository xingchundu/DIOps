<template>
  <div class="page-wrap">
    <!-- 顶部操作栏 -->
    <div class="page-header">
      <div class="header-left">
        <span class="page-title">自定义监控项</span>
        <el-tag type="info" size="small">{{ panels.length }} 个面板</el-tag>
      </div>
      <el-button type="primary" @click="openPanelDialog()">
        <el-icon><Plus /></el-icon>新建面板
      </el-button>
    </div>

    <el-row :gutter="16">
      <!-- 左侧：面板列表 -->
      <el-col :span="6">
        <el-card shadow="never" class="panel-list-card">
          <template #header>
            <span>监控面板</span>
          </template>
          <div v-if="panelsLoading" v-loading="true" style="height:100px" />
          <div v-else-if="!panels.length" class="empty-hint">暂无面板，点击右上角创建</div>
          <div v-else class="panel-items">
            <div
              v-for="p in panels" :key="p.PANEL_ID"
              class="panel-item" :class="{ active: selectedPanel?.PANEL_ID === p.PANEL_ID }"
              @click="selectPanel(p)"
            >
              <div class="panel-item-name">{{ p.PANEL_NAME }}</div>
              <div class="panel-item-meta">
                <el-tag size="small" :type="p.DB_TYPE ? '' : 'info'">{{ p.DB_TYPE || '全部' }}</el-tag>
                <span class="metric-count">{{ p.METRIC_COUNT || 0 }} 指标</span>
              </div>
              <div class="panel-item-actions">
                <el-button link size="small" @click.stop="openPanelDialog(p)"><el-icon><Edit /></el-icon></el-button>
                <el-button link size="small" type="danger" @click.stop="deletePanel(p)"><el-icon><Delete /></el-icon></el-button>
              </div>
            </div>
          </div>
        </el-card>
      </el-col>

      <!-- 右侧：面板详情 -->
      <el-col :span="18">
        <el-card v-if="!selectedPanel" shadow="never" class="detail-card">
          <el-empty description="请从左侧选择一个面板" />
        </el-card>
        <template v-else>
          <!-- 面板信息 + 操作 -->
          <el-card shadow="never" class="detail-card">
            <template #header>
              <div class="detail-header">
                <div>
                  <span class="detail-title">{{ selectedPanel.PANEL_NAME }}</span>
                  <el-tag v-if="selectedPanel.DB_TYPE" size="small" style="margin-left:8px">{{ selectedPanel.DB_TYPE }}</el-tag>
                </div>
                <div class="detail-actions">
                  <el-button type="primary" size="small" :loading="execLoading" @click="executePanel">
                    <el-icon><CaretRight /></el-icon>执行查询
                  </el-button>
                  <el-button size="small" @click="openMetricDialog()">
                    <el-icon><Plus /></el-icon>添加指标
                  </el-button>
                </div>
              </div>
            </template>
            <p v-if="selectedPanel.DESCRIPTION" class="panel-desc">{{ selectedPanel.DESCRIPTION }}</p>

            <!-- 指标列表 -->
            <el-table :data="panelMetrics" size="small" stripe>
              <el-table-column prop="METRIC_NAME" label="指标名" width="150" />
              <el-table-column prop="METRIC_LABEL" label="显示名" width="150" />
              <el-table-column prop="METRIC_TYPE" label="类型" width="90">
                <template #default="{ row }">
                  <el-tag :type="row.METRIC_TYPE === 'SQL' ? '' : 'warning'" size="small">{{ row.METRIC_TYPE }}</el-tag>
                </template>
              </el-table-column>
              <el-table-column prop="CHART_TYPE" label="图表" width="80">
                <template #default="{ row }">
                  <el-tag size="small" type="info">{{ chartLabel(row.CHART_TYPE) }}</el-tag>
                </template>
              </el-table-column>
              <el-table-column prop="UNIT" label="单位" width="70" />
              <el-table-column label="配置" min-width="200">
                <template #default="{ row }">
                  <code v-if="row.METRIC_TYPE === 'SQL'" class="config-text">{{ truncate(row.SQL_TEXT, 60) }}</code>
                  <code v-else class="config-text">{{ row.EXPRESSION }}</code>
                </template>
              </el-table-column>
              <el-table-column label="状态" width="70">
                <template #default="{ row }">
                  <el-tag :type="row.ENABLED ? 'success' : 'info'" size="small">{{ row.ENABLED ? '启用' : '禁用' }}</el-tag>
                </template>
              </el-table-column>
              <el-table-column label="操作" width="130" fixed="right">
                <template #default="{ row }">
                  <el-button link size="small" @click="openMetricDialog(row)"><el-icon><Edit /></el-icon></el-button>
                  <el-button link size="small" type="primary" :loading="singleExecId === row.METRIC_ID" @click="executeSingle(row)">
                    <el-icon><CaretRight /></el-icon>
                  </el-button>
                  <el-button link size="small" type="danger" @click="deleteMetric(row)"><el-icon><Delete /></el-icon></el-button>
                </template>
              </el-table-column>
            </el-table>
          </el-card>

          <!-- 执行结果可视化 -->
          <el-card v-if="execResults.length" shadow="never" class="result-card">
            <template #header>
              <div class="detail-header">
                <span>执行结果</span>
                <el-tag type="success" size="small">{{ execTime }}</el-tag>
              </div>
            </template>
            <el-row :gutter="16">
              <el-col v-for="(r, idx) in execResults" :key="idx" :span="colSpan(r)">
                <!-- gauge 仪表盘 -->
                <div v-if="r.chartType === 'gauge'" class="metric-gauge-card">
                  <div class="gauge-label">{{ r.metricLabel }}</div>
                  <div ref="gaugeRefs" :data-idx="idx" style="height:180px" />
                  <div class="gauge-value" :style="{ color: valueColor(r) }">
                    {{ r.value != null ? r.value : '--' }}
                    <span v-if="r.unit" class="number-unit">{{ r.unit }}</span>
                  </div>
                  <div v-if="r.error" class="metric-error">{{ r.error }}</div>
                </div>
                <!-- number 数字展示 -->
                <div v-else-if="r.chartType === 'number'" class="metric-number-card">
                  <div class="number-label">{{ r.metricLabel }}</div>
                  <div class="number-value" :style="{ color: valueColor(r) }">
                    {{ r.value != null ? r.value : '--' }}
                    <span v-if="r.unit" class="number-unit">{{ r.unit }}</span>
                  </div>
                  <div v-if="r.error" class="metric-error">{{ r.error }}</div>
                </div>
                <!-- table 表格 -->
                <div v-else-if="r.chartType === 'table' && r.rows" class="metric-table-card">
                  <div class="table-label">{{ r.metricLabel }}</div>
                  <el-table :data="r.rows.slice(0, 10)" size="small" stripe max-height="200">
                    <el-table-column v-for="col in (r.columns || [])" :key="col" :prop="col" :label="col" />
                  </el-table>
                  <div v-if="r.error" class="metric-error">{{ r.error }}</div>
                </div>
                <!-- bar / line / 默认 -->
                <div v-else class="metric-value-card">
                  <div class="value-label">{{ r.metricLabel }}</div>
                  <div class="value-main" :style="{ color: valueColor(r) }">
                    {{ r.value != null ? r.value : '--' }}
                    <span v-if="r.unit" class="value-unit">{{ r.unit }}</span>
                  </div>
                  <div v-if="r.samples != null" class="value-samples">{{ r.samples }} 个采样</div>
                  <div v-if="r.error" class="metric-error">{{ r.error }}</div>
                </div>
              </el-col>
            </el-row>
          </el-card>
        </template>
      </el-col>
    </el-row>

    <!-- 面板编辑弹窗 -->
    <el-dialog v-model="panelDlgVisible" :title="panelForm.PANEL_ID ? '编辑面板' : '新建面板'" width="500px" :close-on-click-modal="false">
      <el-form :model="panelForm" label-width="90px">
        <el-form-item label="面板名称" required>
          <el-input v-model="panelForm.panelName" placeholder="如：核心库健康概览" />
        </el-form-item>
        <el-form-item label="描述">
          <el-input v-model="panelForm.description" type="textarea" :rows="2" />
        </el-form-item>
        <el-form-item label="数据库类型">
          <el-select v-model="panelForm.dbType" clearable placeholder="全部类型" style="width:100%">
            <el-option label="全部类型" value="" />
            <el-option label="Oracle" value="ORACLE" />
            <el-option label="MySQL" value="MYSQL" />
            <el-option label="PostgreSQL" value="POSTGRESQL" />
            <el-option label="达梦" value="DAMENG" />
          </el-select>
        </el-form-item>
        <el-form-item label="排序">
          <el-input-number v-model="panelForm.sortOrder" :min="0" :max="999" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="panelDlgVisible = false">取消</el-button>
        <el-button type="primary" :loading="panelSaving" @click="savePanel">保存</el-button>
      </template>
    </el-dialog>

    <!-- 指标编辑弹窗 -->
    <el-dialog v-model="metricDlgVisible" :title="metricForm.METRIC_ID ? '编辑指标' : '添加指标'" width="680px" :close-on-click-modal="false">
      <el-form :model="metricForm" label-width="100px">
        <el-row :gutter="16">
          <el-col :span="12">
            <el-form-item label="指标名" required>
              <el-input v-model="metricForm.metricName" placeholder="如: buffer_hit" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="显示名">
              <el-input v-model="metricForm.metricLabel" placeholder="如: Buffer命中率" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="16">
          <el-col :span="12">
            <el-form-item label="指标类型">
              <el-radio-group v-model="metricForm.metricType">
                <el-radio value="SQL">自定义SQL</el-radio>
                <el-radio value="EXPRESSION">表达式</el-radio>
              </el-radio-group>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="图表类型">
              <el-select v-model="metricForm.chartType" style="width:100%">
                <el-option label="仪表盘" value="gauge" />
                <el-option label="数字" value="number" />
                <el-option label="折线图" value="line" />
                <el-option label="柱状图" value="bar" />
                <el-option label="表格" value="table" />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>

        <!-- SQL 类型 -->
        <template v-if="metricForm.metricType === 'SQL'">
          <el-form-item label="目标实例" required>
            <el-select v-model="metricForm.instanceId" filterable placeholder="选择实例" style="width:100%">
              <el-option v-for="inst in instanceList" :key="inst.INSTANCE_ID"
                :label="`${inst.INSTANCE_NAME} (${inst.DB_TYPE})`" :value="inst.INSTANCE_ID" />
            </el-select>
          </el-form-item>
          <el-form-item label="SQL语句" required>
            <el-input v-model="metricForm.sqlText" type="textarea" :rows="3" placeholder="SELECT COUNT(*) AS VAL FROM v$session WHERE status='ACTIVE'" />
          </el-form-item>
        </template>

        <!-- EXPRESSION 类型 -->
        <template v-else>
          <el-form-item label="目标实例" required>
            <el-select v-model="metricForm.instanceId" filterable placeholder="选择实例" style="width:100%">
              <el-option v-for="inst in instanceList" :key="inst.INSTANCE_ID"
                :label="`${inst.INSTANCE_NAME} (${inst.DB_TYPE})`" :value="inst.INSTANCE_ID" />
            </el-select>
          </el-form-item>
          <el-form-item label="聚合函数">
            <el-select v-model="exprFn" style="width:120px">
              <el-option label="avg" value="avg" />
              <el-option label="last" value="last" />
              <el-option label="max" value="max" />
              <el-option label="min" value="min" />
              <el-option label="sum" value="sum" />
              <el-option label="count" value="count" />
            </el-select>
          </el-form-item>
          <el-form-item label="指标字段">
            <el-select v-model="exprMetric" filterable allow-create placeholder="选择或输入指标名" style="width:100%">
              <el-option-group label="顶层字段">
                <el-option v-for="m in (availMetrics.columnMetrics || [])" :key="m.name" :label="m.label" :value="m.name" />
              </el-option-group>
              <el-option-group label="JSON指标">
                <el-option v-for="m in (availMetrics.jsonMetrics || [])" :key="m.name" :label="m.label" :value="m.name" />
              </el-option-group>
            </el-select>
          </el-form-item>
          <el-form-item label="表达式预览">
            <code class="expr-preview">{{ exprFn }}({{ exprMetric || '...' }})</code>
          </el-form-item>
        </template>

        <el-row :gutter="16">
          <el-col :span="8">
            <el-form-item label="单位">
              <el-input v-model="metricForm.unit" placeholder="%, ms, GB" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="警告阈值">
              <el-input-number v-model="metricForm.thresholdWarn" :controls="false" style="width:100%" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="严重阈值">
              <el-input-number v-model="metricForm.thresholdCrit" :controls="false" style="width:100%" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="16">
          <el-col :span="12">
            <el-form-item label="颜色">
              <el-color-picker v-model="metricForm.color" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="排序">
              <el-input-number v-model="metricForm.sortOrder" :min="0" :max="999" />
            </el-form-item>
          </el-col>
        </el-row>
      </el-form>
      <template #footer>
        <el-button @click="metricDlgVisible = false">取消</el-button>
        <el-button type="info" @click="testMetric" :loading="testLoading">测试执行</el-button>
        <el-button type="primary" :loading="metricSaving" @click="saveMetric">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted, watch, nextTick } from 'vue'
import { customMetricsApi, cmdbApi } from '@/api/index.js'
import { ElMessage, ElMessageBox } from 'element-plus'
import * as echarts from 'echarts'

const panels = ref([])
const panelsLoading = ref(false)
const selectedPanel = ref(null)
const panelMetrics = ref([])
const execResults = ref([])
const execLoading = ref(false)
const execTime = ref('')
const singleExecId = ref(null)
const instanceList = ref([])
const availMetrics = ref({ columnMetrics: [], jsonMetrics: [] })
const gaugeRefs = ref([])

// ─── 面板弹窗 ───
const panelDlgVisible = ref(false)
const panelSaving = ref(false)
const panelForm = reactive({ PANEL_ID: null, panelName: '', description: '', dbType: '', sortOrder: 0 })

// ─── 指标弹窗 ───
const metricDlgVisible = ref(false)
const metricSaving = ref(false)
const testLoading = ref(false)
const metricForm = reactive({
  METRIC_ID: null, metricName: '', metricLabel: '', metricType: 'SQL',
  sqlText: '', dbType: '', expression: '', instanceId: null,
  chartType: 'gauge', unit: '', thresholdWarn: null, thresholdCrit: null, color: '', sortOrder: 0,
})
const exprFn = ref('avg')
const exprMetric = ref('')

watch(() => metricForm.metricType, () => {
  if (metricForm.metricType === 'EXPRESSION' && metricForm.expression) {
    const m = metricForm.expression.match(/^(avg|last|max|min|sum|count)\(([^)]*)\)$/i)
    if (m) { exprFn.value = m[1]; exprMetric.value = m[2] }
  }
})

// ─── 加载面板列表 ───
async function loadPanels() {
  panelsLoading.value = true
  try {
    const res = await customMetricsApi.panels()
    panels.value = res.data || []
  } catch { panels.value = [] }
  panelsLoading.value = false
}

async function selectPanel(p) {
  selectedPanel.value = p
  execResults.value = []
  try {
    const res = await customMetricsApi.panel(p.PANEL_ID)
    panelMetrics.value = res.data?.metrics || []
  } catch { panelMetrics.value = [] }
}

// ─── 面板 CRUD ───
function openPanelDialog(p) {
  if (p) {
    Object.assign(panelForm, { PANEL_ID: p.PANEL_ID, panelName: p.PANEL_NAME, description: p.DESCRIPTION || '', dbType: p.DB_TYPE || '', sortOrder: p.SORT_ORDER || 0 })
  } else {
    Object.assign(panelForm, { PANEL_ID: null, panelName: '', description: '', dbType: '', sortOrder: 0 })
  }
  panelDlgVisible.value = true
}

async function savePanel() {
  if (!panelForm.panelName) return ElMessage.warning('面板名称必填')
  panelSaving.value = true
  try {
    const d = { panelName: panelForm.panelName, description: panelForm.description, dbType: panelForm.dbType || null, sortOrder: panelForm.sortOrder }
    if (panelForm.PANEL_ID) {
      await customMetricsApi.updatePanel(panelForm.PANEL_ID, d)
    } else {
      await customMetricsApi.createPanel(d)
    }
    ElMessage.success('保存成功')
    panelDlgVisible.value = false
    await loadPanels()
  } catch (e) { ElMessage.error(e.message) }
  panelSaving.value = false
}

async function deletePanel(p) {
  await ElMessageBox.confirm(`确定删除面板「${p.PANEL_NAME}」及其所有指标？`, '删除确认', { type: 'warning' })
  try {
    await customMetricsApi.deletePanel(p.PANEL_ID)
    ElMessage.success('已删除')
    if (selectedPanel.value?.PANEL_ID === p.PANEL_ID) { selectedPanel.value = null; panelMetrics.value = [] }
    await loadPanels()
  } catch {}
}

// ─── 指标 CRUD ───
async function loadInstances() {
  try {
    const res = await customMetricsApi.instances()
    instanceList.value = res.data || []
  } catch { instanceList.value = [] }
}

async function loadAvailMetrics() {
  try {
    const res = await customMetricsApi.availableMetrics()
    availMetrics.value = res.data || {}
  } catch {}
}

function openMetricDialog(m) {
  if (m) {
    Object.assign(metricForm, {
      METRIC_ID: m.METRIC_ID, metricName: m.METRIC_NAME, metricLabel: m.METRIC_LABEL || '',
      metricType: m.METRIC_TYPE || 'SQL', sqlText: m.SQL_TEXT || '', dbType: m.DB_TYPE || '',
      expression: m.EXPRESSION || '', instanceId: m.INSTANCE_ID || null,
      chartType: m.CHART_TYPE || 'gauge', unit: m.UNIT || '',
      thresholdWarn: m.THRESHOLD_WARN, thresholdCrit: m.THRESHOLD_CRIT,
      color: m.COLOR || '', sortOrder: m.SORT_ORDER || 0,
    })
    if (m.METRIC_TYPE === 'EXPRESSION' && m.EXPRESSION) {
      const ex = m.EXPRESSION.match(/^(avg|last|max|min|sum|count)\(([^)]*)\)$/i)
      if (ex) { exprFn.value = ex[1]; exprMetric.value = ex[2] }
    }
  } else {
    Object.assign(metricForm, {
      METRIC_ID: null, metricName: '', metricLabel: '', metricType: 'SQL',
      sqlText: '', dbType: '', expression: '', instanceId: null,
      chartType: 'gauge', unit: '', thresholdWarn: null, thresholdCrit: null, color: '', sortOrder: 0,
    })
    exprFn.value = 'avg'; exprMetric.value = ''
  }
  metricDlgVisible.value = true
}

async function saveMetric() {
  if (!metricForm.metricName) return ElMessage.warning('指标名必填')
  const d = { ...metricForm, panelId: selectedPanel.value.PANEL_ID }
  if (d.metricType === 'EXPRESSION') {
    d.expression = `${exprFn.value}(${exprMetric.value})`
    if (!exprMetric.value) return ElMessage.warning('请选择指标字段')
  }
  if (d.metricType === 'SQL' && !d.sqlText) return ElMessage.warning('SQL语句必填')
  if (!d.instanceId) return ElMessage.warning('请选择目标实例')
  metricSaving.value = true
  try {
    if (d.METRIC_ID) {
      await customMetricsApi.updateMetric(d.METRIC_ID, d)
    } else {
      await customMetricsApi.createMetric(d)
    }
    ElMessage.success('保存成功')
    metricDlgVisible.value = false
    await selectPanel(selectedPanel.value)
    await loadPanels()
  } catch (e) { ElMessage.error(e.message) }
  metricSaving.value = false
}

async function deleteMetric(m) {
  await ElMessageBox.confirm(`确定删除指标「${m.METRIC_NAME}」？`, '删除确认', { type: 'warning' })
  try {
    await customMetricsApi.deleteMetric(m.METRIC_ID)
    ElMessage.success('已删除')
    await selectPanel(selectedPanel.value)
    await loadPanels()
  } catch {}
}

async function testMetric() {
  testLoading.value = true
  try {
    const d = { metricType: metricForm.metricType, instanceId: metricForm.instanceId }
    if (metricForm.metricType === 'SQL') {
      d.sqlText = metricForm.sqlText
    } else {
      d.expression = `${exprFn.value}(${exprMetric.value})`
    }
    const res = await customMetricsApi.execute(d)
    if (res.code === 200) {
      ElMessage.success(`执行成功，结果: ${JSON.stringify(res.data.value ?? res.data)}`)
    } else {
      ElMessage.error(res.msg)
    }
  } catch (e) { ElMessage.error(e.message) }
  testLoading.value = false
}

// ─── 执行面板 ───
async function executePanel() {
  execLoading.value = true
  execResults.value = []
  const t0 = Date.now()
  try {
    const res = await customMetricsApi.executePanel(selectedPanel.value.PANEL_ID)
    execResults.value = res.data || []
    execTime.value = `${((Date.now() - t0) / 1000).toFixed(1)}s`
    await nextTick()
    renderGauges()
  } catch (e) { ElMessage.error(e.message) }
  execLoading.value = false
}

async function executeSingle(m) {
  singleExecId.value = m.METRIC_ID
  try {
    const d = { metricType: m.METRIC_TYPE, instanceId: m.INSTANCE_ID }
    if (m.METRIC_TYPE === 'SQL') d.sqlText = m.SQL_TEXT
    else d.expression = m.EXPRESSION
    const res = await customMetricsApi.execute(d)
    if (res.code === 200) {
      ElMessage.success(`${m.METRIC_LABEL || m.METRIC_NAME}: ${res.data.value ?? JSON.stringify(res.data)}`)
    } else {
      ElMessage.error(res.msg)
    }
  } catch (e) { ElMessage.error(e.message) }
  singleExecId.value = null
}

// ─── 图表渲染 ───
function renderGauges() {
  const refs = document.querySelectorAll('[data-idx]')
  refs.forEach(el => {
    const idx = Number(el.dataset.idx)
    const r = execResults.value[idx]
    if (!r || r.chartType !== 'gauge') return
    let chart = echarts.getInstanceByDom(el)
    if (!chart) chart = echarts.init(el)
    const val = r.value != null ? Number(r.value) : 0
    const max = r.thresholdCrit || r.thresholdWarn || 100
    chart.setOption({
      backgroundColor: 'transparent',
      series: [{
        type: 'gauge',
        center: ['50%', '50%'],
        radius: '90%',
        min: 0, max: Math.max(max * 1.2, val * 1.2, 100),
        progress: { show: true, width: 14 },
        axisLine: { lineStyle: { width: 14 } },
        axisTick: { show: false },
        splitLine: { length: 8, lineStyle: { width: 2, color: '#999' } },
        axisLabel: { distance: 20, fontSize: 11 },
        pointer: { itemStyle: { color: 'auto' } },
        detail: { show: false },
        title: { show: false },
        data: [{ value: val }],
        itemStyle: { color: valueColor(r) },
      }],
    }, true)
  })
}

function valueColor(r) {
  if (r.value == null) return '#909399'
  if (r.thresholdCrit != null && Number(r.value) >= r.thresholdCrit) return '#f56c6c'
  if (r.thresholdWarn != null && Number(r.value) >= r.thresholdWarn) return '#e6a23c'
  return '#67c23a'
}

function colSpan(r) {
  if (r.chartType === 'table') return 24
  if (r.chartType === 'gauge') return 6
  return 6
}

function chartLabel(t) {
  const m = { gauge: '仪表盘', number: '数字', line: '折线', bar: '柱状', table: '表格' }
  return m[t] || t
}

function truncate(s, n) {
  if (!s) return ''
  return s.length > n ? s.slice(0, n) + '...' : s
}

// ─── 初始化 ───
onMounted(() => {
  loadPanels()
  loadInstances()
  loadAvailMetrics()
})
</script>

<style scoped>
.page-wrap { padding: 16px; }
.page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
.header-left { display: flex; align-items: center; gap: 12px; }
.page-title { font-size: 18px; font-weight: 600; }

.panel-list-card { min-height: 500px; }
.panel-items { display: flex; flex-direction: column; gap: 8px; }
.panel-item {
  padding: 12px; border-radius: 8px; cursor: pointer;
  border: 1px solid var(--el-border-color-lighter);
  transition: all 0.2s;
}
.panel-item:hover { border-color: var(--el-color-primary); background: var(--el-fill-color-light); }
.panel-item.active { border-color: var(--el-color-primary); background: var(--el-color-primary-light-9); }
.panel-item-name { font-weight: 600; font-size: 14px; margin-bottom: 4px; }
.panel-item-meta { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--el-text-color-secondary); }
.metric-count { margin-left: auto; }
.panel-item-actions { margin-top: 6px; display: flex; gap: 4px; justify-content: flex-end; }

.detail-card { margin-bottom: 16px; }
.detail-header { display: flex; justify-content: space-between; align-items: center; }
.detail-title { font-size: 16px; font-weight: 600; }
.detail-actions { display: flex; gap: 8px; }
.panel-desc { color: var(--el-text-color-secondary); font-size: 13px; margin-bottom: 12px; }

.config-text { font-size: 12px; color: var(--el-text-color-regular); word-break: break-all; }
.expr-preview { font-size: 14px; color: var(--el-color-primary); font-weight: 600; }

.result-card { margin-bottom: 16px; }

.metric-gauge-card, .metric-number-card, .metric-value-card, .metric-table-card {
  padding: 16px; margin-bottom: 16px;
  border-radius: 8px; border: 1px solid var(--el-border-color-lighter);
  background: var(--el-fill-color-blank);
}
.gauge-label, .number-label, .value-label, .table-label {
  font-size: 13px; color: var(--el-text-color-secondary); margin-bottom: 8px; text-align: center;
}
.gauge-value, .number-value, .value-main {
  font-size: 32px; font-weight: 700; text-align: center;
  line-height: 1.2; min-height: 40px; display: flex; align-items: center; justify-content: center;
}
.number-unit, .value-unit { font-size: 14px; font-weight: 400; color: var(--el-text-color-secondary); }
.value-samples { text-align: center; font-size: 12px; color: var(--el-text-color-secondary); margin-top: 4px; }
.metric-error { color: var(--el-color-danger); font-size: 12px; margin-top: 8px; text-align: center; }

.empty-hint { text-align: center; color: var(--el-text-color-secondary); padding: 40px 0; font-size: 13px; }
</style>
