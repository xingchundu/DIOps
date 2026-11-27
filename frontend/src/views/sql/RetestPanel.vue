<template>
  <div class="card">
    <div class="filters">
      <el-select v-model="status" size="small" style="width: 130px" @change="load">
        <el-option label="全部" value="ALL" /><el-option label="待上线" value="PENDING" /><el-option label="观察中" value="WATCHING" /><el-option label="已出结论" value="DONE" /><el-option label="已取消" value="CANCELLED" />
      </el-select>
      <span class="text-gray">优化工单由 SQL 洞察生成时自动登记，工单通过后自动开始观察；也可在 SQL 资产详情中手动登记。优化前 = 上线前 24 小时，优化后 = 上线至今；观察满指定小时数后再看结论更可靠，超过 72 小时自动出结论。</span>
    </div>
    <el-table :data="list" size="small" stripe v-loading="loading">
      <el-table-column prop="RETEST_ID" label="#" width="60" />
      <el-table-column v-if="!instanceId" prop="INSTANCE_NAME" label="实例" width="110" show-overflow-tooltip />
      <el-table-column label="SQL_ID" width="140" show-overflow-tooltip><template #default="{ row }"><span class="mono">{{ shortSqlId(row.NATIVE_SQL_ID) }}</span></template></el-table-column>
      <el-table-column label="SQL" min-width="220" show-overflow-tooltip>
        <template #default="{ row }"><el-button link type="primary" @click="$emit('open-asset', row.ASSET_ID, row.INSTANCE_ID)">#{{ row.ASSET_ID }} {{ (row.SQL_TEXT || '').slice(0, 50) }}</el-button></template>
      </el-table-column>
      <el-table-column label="状态" width="90">
        <template #default="{ row }"><el-tag size="small" :type="{ PENDING: 'info', WATCHING: 'warning', DONE: 'success', CANCELLED: 'info' }[row.STATUS]">{{ { PENDING: '待上线', WATCHING: '观察中', DONE: '已出结论', CANCELLED: '已取消' }[row.STATUS] }}</el-tag></template>
      </el-table-column>
      <el-table-column label="工单" width="100"><template #default="{ row }">{{ row.TICKET_ID ? '#' + row.TICKET_ID + (row.TICKET_STATUS ? ' ' + row.TICKET_STATUS : '') : '-' }}</template></el-table-column>
      <el-table-column label="平均耗时 前 → 后(ms)" width="170">
        <template #default="{ row }">{{ num(row.before?.AVG_MS) }} → {{ num(row.after?.AVG_MS) }}</template>
      </el-table-column>
      <el-table-column label="单次逻辑读 前 → 后" width="150"><template #default="{ row }">{{ num(row.before?.LR) }} → {{ num(row.after?.LR) }}</template></el-table-column>
      <el-table-column label="结论" min-width="260" show-overflow-tooltip>
        <template #default="{ row }">
          <el-tag v-if="verdictOf(row)" size="small" :type="vType(verdictOf(row))" style="margin-right: 6px">{{ vLabel(verdictOf(row)) }}</el-tag>
          <span>{{ textOf(row) }}</span>
          <span v-if="row.STATUS === 'WATCHING'" class="text-gray">（已观察 {{ row.observedHours }} 小时{{ row.enough ? '' : '，未满 ' + row.MIN_HOURS + ' 小时' }}）</span>
        </template>
      </el-table-column>
      <el-table-column label="上线时间" width="130"><template #default="{ row }">{{ fmtTime(row.STARTED_AT) }}</template></el-table-column>
      <el-table-column label="操作" width="230" fixed="right">
        <template #default="{ row }">
          <el-button v-if="row.STATUS === 'PENDING' && canOps" link type="primary" size="small" @click="start(row)">已上线，开始观察</el-button>
          <el-button v-if="row.STATUS === 'WATCHING' && canOps" link type="primary" size="small" @click="finish(row)">出结论</el-button>
          <el-button v-if="['WATCHING', 'DONE'].includes(row.STATUS)" link type="primary" size="small" @click="showPlans(row)">访问路径</el-button>
          <el-button v-if="['PENDING', 'WATCHING'].includes(row.STATUS) && canOps" link type="danger" size="small" @click="cancel(row)">取消</el-button>
        </template>
      </el-table-column>
    </el-table>
    <div v-if="!loading && !list.length" class="text-gray empty">暂无复测记录</div>
    <PlanDiffDialog v-model="planVisible" :loading="planLoading" :data="planData" />
  </div>
</template>

<script setup>
import { ref, watch, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { sqlInsightApi } from '@/api/index.js'
import { shortSqlId, num, fmtTime } from './sqlInsightUtil.js'
import PlanDiffDialog from './PlanDiffDialog.vue'

const props = defineProps({ instanceId: { type: [Number, String], default: null }, canOps: Boolean })
defineEmits(['open-asset'])
const status = ref('ALL')
const list = ref([])
const loading = ref(false)
const planVisible = ref(false)
const planLoading = ref(false)
const planData = ref({})

const verdictOf = (r) => (r.STATUS === 'WATCHING' ? r.liveVerdict : r.VERDICT)
const textOf = (r) => (r.STATUS === 'WATCHING' ? r.liveText : r.VERDICT_TEXT) || (r.STATUS === 'PENDING' ? '等待优化上线' : '')
const vType = (v) => ({ IMPROVED: 'success', REGRESSION: 'danger', SIMILAR: 'info', NO_DATA: 'warning' }[v] || 'info')
const vLabel = (v) => ({ IMPROVED: '改善', REGRESSION: '退化', SIMILAR: '相近', NO_DATA: '样本不足' }[v] || v)

async function load() {
  loading.value = true
  try { list.value = (await sqlInsightApi.retests({ instanceId: props.instanceId || undefined, status: status.value })).data?.list || [] } catch { list.value = [] } finally { loading.value = false }
}
async function start(row) {
  await sqlInsightApi.startRetest(row.RETEST_ID)
  ElMessage.success('已开始观察')
  load()
}
async function finish(row) {
  if (!row.enough) {
    await ElMessageBox.confirm(`才观察 ${row.observedHours} 小时（建议 ≥ ${row.MIN_HOURS} 小时），现在出结论可能不够稳，仍要结束吗？`, '提前出结论', { type: 'warning' })
  }
  const r = (await sqlInsightApi.finishRetest(row.RETEST_ID)).data
  ElMessage.success(r?.text || '已出结论')
  load()
}
async function cancel(row) {
  await ElMessageBox.confirm('取消后不再跟踪该 SQL 的优化效果，确定吗？', '取消复测', { type: 'warning' })
  await sqlInsightApi.cancelRetest(row.RETEST_ID)
  load()
}
async function showPlans(row) {
  planVisible.value = true
  planLoading.value = true
  planData.value = {}
  try { planData.value = (await sqlInsightApi.retestPlans(row.RETEST_ID)).data || {} } catch { planData.value = { summary: '获取计划失败' } } finally { planLoading.value = false }
}
watch(() => props.instanceId, load)
defineExpose({ load })
onMounted(load)
</script>

<style scoped>
.filters { display: flex; gap: 8px; align-items: center; margin-bottom: 10px; flex-wrap: wrap; }
.empty { padding: 16px; text-align: center; }
.mono { font-family: Consolas, Menlo, monospace; font-size: 12px; }
</style>
