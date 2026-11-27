<template>
  <div class="card">
    <div class="filters">
      <el-select v-model="hours" size="small" style="width: 120px" @change="load">
        <el-option label="近 6 小时" :value="6" /><el-option label="近 24 小时" :value="24" /><el-option label="近 3 天" :value="72" /><el-option label="近 7 天" :value="168" />
      </el-select>
      <el-input-number v-model="minAvgMs" size="small" :min="0" :step="500" controls-position="right" style="width: 150px" @change="load" />
      <span class="text-gray">平均耗时 ≥ 该值(ms) 的 SQL，按 P95 窗口耗时排序。P95 = 各 1 分钟窗口平均耗时的第 95 百分位；窗口数越多说明越持续。</span>
    </div>
    <el-table :data="list" size="small" stripe v-loading="loading">
      <el-table-column v-if="!instanceId" prop="INSTANCE_NAME" label="实例" width="110" show-overflow-tooltip />
      <el-table-column label="SQL_ID" width="150" show-overflow-tooltip><template #default="{ row }"><span class="mono">{{ shortSqlId(row.NATIVE_SQL_ID) }}</span></template></el-table-column>
      <el-table-column label="SQL" min-width="240" show-overflow-tooltip>
        <template #default="{ row }"><el-button link type="primary" @click="$emit('open-asset', row.ASSET_ID, row.INSTANCE_ID)">#{{ row.ASSET_ID }} {{ (row.SQL_TEXT || '').slice(0, 60) }}</el-button></template>
      </el-table-column>
      <el-table-column label="平均(ms)" width="90"><template #default="{ row }">{{ num(row.AVG_MS) }}</template></el-table-column>
      <el-table-column label="P95(ms)" width="90"><template #default="{ row }"><b>{{ num(row.P95_MS) }}</b></template></el-table-column>
      <el-table-column label="窗口最大(ms)" width="105"><template #default="{ row }">{{ num(row.MAX_WINDOW_AVG_MS) }}</template></el-table-column>
      <el-table-column prop="EXECS" label="执行次数" width="90" />
      <el-table-column label="DB Time(s)" width="95"><template #default="{ row }">{{ num(row.DB_TIME_SEC) }}</template></el-table-column>
      <el-table-column label="持续" width="80"><template #default="{ row }"><el-tag size="small" :type="row.PERSISTENT ? 'danger' : 'info'">{{ row.WINDOWS }} 窗口</el-tag></template></el-table-column>
      <el-table-column label="单次 CPU/逻辑读/物理读" width="190"><template #default="{ row }">{{ num(row.CPU_PER_EXEC_MS) }}ms / {{ num(row.LR_PER_EXEC) }} / {{ num(row.PR_PER_EXEC) }}</template></el-table-column>
      <el-table-column label="主要等待事件（命中/总采样）" width="230" show-overflow-tooltip><template #default="{ row }">{{ row.WAIT_EVENT ? `${row.WAIT_EVENT}（${row.WAIT_SAMPLES}/${row.WAIT_TOTAL}）` : '-' }}</template></el-table-column>
      <el-table-column label="来源" width="110" show-overflow-tooltip>
        <template #default="{ row }">{{ row.CAPTURE_SOURCE || '-' }}<span v-if="row.LAST_RT_RULE"> · {{ row.LAST_RT_RULE }}</span></template>
      </el-table-column>
      <el-table-column label="窗口范围" width="170"><template #default="{ row }">{{ fmtTime(row.FIRST_WINDOW) }} ~ {{ fmtTime(row.LAST_WINDOW) }}</template></el-table-column>
    </el-table>
    <div v-if="!loading && !list.length" class="text-gray empty">窗口内没有满足条件的 SQL（需要实例已启用 SQL 洞察采集）</div>
  </div>
</template>

<script setup>
import { ref, watch, onMounted } from 'vue'
import { sqlInsightApi } from '@/api/index.js'
import { shortSqlId, num, fmtTime } from './sqlInsightUtil.js'

const props = defineProps({ instanceId: { type: [Number, String], default: null } })
defineEmits(['open-asset'])
const hours = ref(24)
const minAvgMs = ref(1000)
const list = ref([])
const loading = ref(false)
async function load() {
  loading.value = true
  try {
    list.value = (await sqlInsightApi.longSql({ instanceId: props.instanceId || undefined, hours: hours.value, minAvgMs: minAvgMs.value })).data?.list || []
  } catch { list.value = [] } finally { loading.value = false }
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
