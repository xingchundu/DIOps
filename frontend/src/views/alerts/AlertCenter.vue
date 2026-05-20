<template>
  <div class="page-container">
    <!-- 统计卡片 -->
    <el-row :gutter="16" class="mb-16">
      <el-col :span="6" v-for="c in statCards" :key="c.label">
        <div class="alert-stat-card" :style="{ borderLeftColor: c.color }">
          <div class="stat-num" :style="{ color: c.color }">{{ c.val }}</div>
          <div class="stat-lbl">{{ c.label }}</div>
        </div>
      </el-col>
    </el-row>

    <el-row :gutter="16">
      <!-- 告警列表 -->
      <el-col :span="16">
        <div class="card">
          <div class="card-title" style="justify-content:space-between">
            <span><el-icon><Bell /></el-icon> 告警记录</span>
            <div class="flex-center gap-8">
              <el-select v-model="q.status" placeholder="状态" clearable size="small" style="width:110px" @change="load">
                <el-option label="未处理" value="OPEN" />
                <el-option label="已确认" value="ACKNOWLEDGED" />
                <el-option label="已解决" value="RESOLVED" />
              </el-select>
              <el-select v-model="q.severity" placeholder="级别" clearable size="small" style="width:100px" @change="load">
                <el-option v-for="s in ['P1','P2','P3','P4']" :key="s" :label="s" :value="s" />
              </el-select>
              <el-button size="small" icon="Refresh" @click="load">刷新</el-button>
            </div>
          </div>
          <el-table :data="alerts" stripe border size="small" v-loading="loading" height="520">
            <el-table-column label="级别" width="80">
              <template #default="{ row }">
                <span :class="`badge-${row.SEVERITY?.toLowerCase()}`">{{ row.SEVERITY }}</span>
              </template>
            </el-table-column>
            <el-table-column prop="RULE_NAME"    label="规则名"  width="140" show-overflow-tooltip />
            <el-table-column prop="INSTANCE_NAME" label="实例"  width="130" />
            <el-table-column prop="CONTENT"      label="告警内容" min-width="240" show-overflow-tooltip />
            <el-table-column label="状态" width="100">
              <template #default="{ row }">
                <el-tag :type="statusType(row.STATUS)" size="small">{{ statusLabel(row.STATUS) }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="触发时间" width="155" prop="TRIGGER_TIME" :formatter="(r,c,v)=>fmt(v)" />
            <el-table-column label="操作" width="140" fixed="right">
              <template #default="{ row }">
                <el-button v-if="row.STATUS==='OPEN'" link type="primary" size="small" @click="ack(row)">确认</el-button>
                <el-button v-if="row.STATUS!=='RESOLVED'" link type="success" size="small" @click="resolve(row)">解决</el-button>
                <el-button link size="small" @click="viewAlert(row)">详情</el-button>
              </template>
            </el-table-column>
          </el-table>
          <div style="padding:12px 0;text-align:right">
            <el-pagination v-model:current-page="page" :page-size="20" :total="total"
              layout="total,prev,pager,next" @current-change="load" small />
          </div>
        </div>
      </el-col>

      <!-- 告警规则 -->
      <el-col :span="8">
        <div class="card">
          <div class="card-title" style="justify-content:space-between">
            <span><el-icon><Setting /></el-icon> 告警规则</span>
            <el-button size="small" type="primary" icon="Plus" @click="ruleDialog=true">新增规则</el-button>
          </div>
          <el-table :data="rules" stripe size="small" height="420" v-loading="rulesLoading">
            <el-table-column prop="RULE_NAME" label="规则名" min-width="120" show-overflow-tooltip />
            <el-table-column label="级别" width="65">
              <template #default="{ row }">
                <span :class="`badge-${row.SEVERITY?.toLowerCase()}`">{{ row.SEVERITY }}</span>
              </template>
            </el-table-column>
            <el-table-column label="启用" width="60">
              <template #default="{ row }">
                <el-switch v-model="row.ENABLED" :active-value="1" :inactive-value="0"
                  size="small" @change="toggleRule(row)" />
              </template>
            </el-table-column>
          </el-table>
        </div>

        <!-- 严重度分布 -->
        <div class="card" style="margin-top:16px">
          <div class="card-title"><el-icon><PieChart /></el-icon> 未处理告警分布</div>
          <div ref="pieRef" style="height:180px"></div>
        </div>
      </el-col>
    </el-row>

    <!-- 告警详情 Dialog -->
    <el-dialog v-model="detailVisible" title="告警详情" width="540px">
      <el-descriptions v-if="current" :column="1" border size="small">
        <el-descriptions-item label="规则名">{{ current.RULE_NAME }}</el-descriptions-item>
        <el-descriptions-item label="实例">{{ current.INSTANCE_NAME }}</el-descriptions-item>
        <el-descriptions-item label="级别">
          <span :class="`badge-${current.SEVERITY?.toLowerCase()}`">{{ current.SEVERITY }}</span>
        </el-descriptions-item>
        <el-descriptions-item label="告警内容">{{ current.CONTENT }}</el-descriptions-item>
        <el-descriptions-item label="触发时间">{{ fmt(current.TRIGGER_TIME) }}</el-descriptions-item>
        <el-descriptions-item label="状态">{{ statusLabel(current.STATUS) }}</el-descriptions-item>
        <el-descriptions-item label="确认人/时间">{{ current.ACK_BY || '-' }} {{ fmt(current.ACK_TIME) }}</el-descriptions-item>
        <el-descriptions-item label="解决人/时间">{{ current.RESOLVE_BY || '-' }} {{ fmt(current.RESOLVE_TIME) }}</el-descriptions-item>
      </el-descriptions>
      <template #footer>
        <el-button @click="detailVisible = false">关闭</el-button>
        <el-button v-if="current?.STATUS==='OPEN'" type="primary" @click="ack(current); detailVisible=false">确认告警</el-button>
      </template>
    </el-dialog>

    <!-- 新增规则 Dialog -->
    <el-dialog v-model="ruleDialog" title="新增告警规则" width="480px">
      <el-form :model="ruleForm" label-width="90px">
        <el-form-item label="规则名称"><el-input v-model="ruleForm.ruleName" /></el-form-item>
        <el-form-item label="监控指标"><el-input v-model="ruleForm.metric" placeholder="如: host_cpu_usage" /></el-form-item>
        <el-form-item label="条件">
          <el-select v-model="ruleForm.operator" style="width:100px">
            <el-option label=">" value="gt" /><el-option label="<" value="lt" />
            <el-option label=">=" value="gte" /><el-option label="<=" value="lte" />
          </el-select>
          <el-input-number v-model="ruleForm.threshold" style="margin-left:8px;width:130px" />
        </el-form-item>
        <el-form-item label="持续(分钟)"><el-input-number v-model="ruleForm.duration" :min="1" /></el-form-item>
        <el-form-item label="告警级别">
          <el-select v-model="ruleForm.severity">
            <el-option v-for="s in ['P1','P2','P3','P4']" :key="s" :label="s" :value="s" />
          </el-select>
        </el-form-item>
        <el-form-item label="适用DB类型">
          <el-select v-model="ruleForm.dbType" clearable placeholder="全部">
            <el-option label="Oracle" value="ORACLE" /><el-option label="MySQL" value="MYSQL" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="ruleDialog=false">取消</el-button>
        <el-button type="primary" :loading="savingRule" @click="saveRule">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, nextTick } from 'vue'
import { alertApi } from '@/api/index.js'
import { ElMessage } from 'element-plus'
import * as echarts from 'echarts'

const alerts  = ref([]); const loading = ref(false)
const rules   = ref([]); const rulesLoading = ref(false)
const page    = ref(1);  const total   = ref(0)
const q       = reactive({ status: '', severity: '' })
const statsData = ref({})
const detailVisible = ref(false); const current = ref(null)
const ruleDialog    = ref(false); const savingRule = ref(false)
const pieRef = ref()

const ruleForm = reactive({ ruleName:'', metric:'', operator:'gt', threshold:80, duration:5, severity:'P3', dbType:'' })

const statCards = computed(() => {
  const bs = statsData.value.byStatus || []
  const bsv = statsData.value.bySeverity || []
  const get = (k, arr, field='STATUS') => arr.find(r => r[field] === k)?.CNT || 0
  return [
    { label: '未处理', val: get('OPEN', bs),         color: '#ff4d4f' },
    { label: 'P1紧急', val: get('P1', bsv, 'SEVERITY'), color: '#cf1322' },
    { label: 'P2严重', val: get('P2', bsv, 'SEVERITY'), color: '#fa541c' },
    { label: '已解决', val: get('RESOLVED', bs),     color: '#52c41a' },
  ]
})

function statusType(s) { return { OPEN:'danger', ACKNOWLEDGED:'warning', RESOLVED:'success', SUPPRESSED:'info' }[s] || 'info' }
function statusLabel(s) { return { OPEN:'未处理', ACKNOWLEDGED:'已确认', RESOLVED:'已解决', SUPPRESSED:'已抑制' }[s] || s }
function fmt(v) { return v ? new Date(v).toLocaleString('zh-CN') : '-' }

async function load() {
  loading.value = true
  try {
    const r = await alertApi.list({ ...q, page: page.value, size: 20 })
    if (r.code === 200) { alerts.value = r.data.list || []; total.value = r.data.total || 0 }
  } finally { loading.value = false }
}

async function loadStats() {
  try {
    const r = await alertApi.stats()
    if (r.code === 200) { statsData.value = r.data; initPie() }
  } catch {}
}

async function loadRules() {
  rulesLoading.value = true
  try { const r = await alertApi.rules(); rules.value = r.data || [] }
  finally { rulesLoading.value = false }
}

async function ack(row) {
  await alertApi.ack(row.ALERT_ID); ElMessage.success('已确认'); load(); loadStats()
}
async function resolve(row) {
  await alertApi.resolve(row.ALERT_ID); ElMessage.success('已解决'); load(); loadStats()
}
function viewAlert(row) { current.value = row; detailVisible.value = true }

async function toggleRule(row) {
  await alertApi.updateRule(row.RULE_ID, { ...row, enabled: row.ENABLED })
  ElMessage.success(row.ENABLED ? '已启用' : '已禁用')
}

async function saveRule() {
  savingRule.value = true
  try {
    await alertApi.createRule(ruleForm)
    ElMessage.success('规则创建成功')
    ruleDialog.value = false; loadRules()
  } finally { savingRule.value = false }
}

function initPie() {
  nextTick(() => {
    if (!pieRef.value) return
    const c = echarts.getInstanceByDom(pieRef.value) || echarts.init(pieRef.value)
    const bsv = statsData.value.bySeverity || []
    c.setOption({
      backgroundColor: 'transparent',
      textStyle: { color: '#909399' },
      tooltip: { trigger: 'item' },
      series: [{ type: 'pie', radius: '65%',
        data: ['P1','P2','P3','P4'].map(s => ({
          name: s, value: bsv.find(r => r.SEVERITY === s)?.CNT || 0,
          itemStyle: { color: { P1:'#ff4d4f', P2:'#fa541c', P3:'#faad14', P4:'#52c41a' }[s] }
        })),
      }],
    })
  })
}

onMounted(() => { load(); loadStats(); loadRules() })
</script>

<style scoped>
.alert-stat-card {
  background: var(--agent-panel-bg, #ffffff);
  border: 1px solid var(--agent-border, #e4e7ed);
  border-radius: 8px;
  padding: 16px 20px;
  border-left: 4px solid;
  box-shadow: none;
}
.stat-num { font-size: 28px; font-weight: 700; color: var(--agent-text, #303133); }
.stat-lbl { font-size: 13px; color: var(--agent-text-muted, #909399); margin-top: 4px; }
</style>
