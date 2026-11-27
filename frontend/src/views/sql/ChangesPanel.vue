<template>
  <div class="card">
    <div class="filters">
      <el-select v-model="hours" size="small" style="width: 120px" @change="load">
        <el-option label="近 6 小时" :value="6" /><el-option label="近 24 小时" :value="24" /><el-option label="近 3 天" :value="72" /><el-option label="近 7 天" :value="168" />
      </el-select>
      <span class="text-gray">识别新增 SQL、执行时段偏移（峰值小时移动 ≥ 3 小时）、资源增量（DB Time 较前一同长窗口 +50% 且 ≥ 10 秒），并提示与实例业务高峰重叠的冲突风险。</span>
    </div>
    <div v-loading="loading">
      <el-alert v-if="data.conflicts && data.conflicts.length" type="warning" show-icon :closable="false" style="margin-bottom: 10px"
                :title="`有 ${data.conflicts.length} 条变化的 SQL 峰值落在实例高峰小时内，存在资源冲突风险`" />
      <el-tabs v-model="sub">
        <el-tab-pane :label="`新增 SQL（${(data.newSql || []).length}）`" name="new">
          <el-table :data="data.newSql || []" size="small" stripe>
            <el-table-column v-if="!instanceId" prop="INSTANCE_NAME" label="实例" width="110" show-overflow-tooltip />
            <el-table-column label="SQL_ID" width="150" show-overflow-tooltip><template #default="{ row }"><span class="mono">{{ shortSqlId(row.NATIVE_SQL_ID) }}</span></template></el-table-column>
            <el-table-column label="SQL" min-width="260" show-overflow-tooltip>
              <template #default="{ row }"><el-button link type="primary" @click="$emit('open-asset', row.ASSET_ID, row.INSTANCE_ID)">#{{ row.ASSET_ID }} {{ (row.SQL_TEXT || '').slice(0, 70) }}</el-button></template>
            </el-table-column>
            <el-table-column prop="STMT_TYPE" label="类型" width="80" />
            <el-table-column label="静态风险" width="90"><template #default="{ row }"><el-tag v-if="row.STATIC_RISK && row.STATIC_RISK !== 'NONE'" size="small" type="warning">{{ row.STATIC_RISK }}</el-tag></template></el-table-column>
            <el-table-column label="执行次数" width="90"><template #default="{ row }">{{ row.EXECS ?? '-' }}</template></el-table-column>
            <el-table-column label="DB Time(s)" width="95"><template #default="{ row }">{{ num(row.DB_TIME_SEC) }}</template></el-table-column>
            <el-table-column label="首次出现" width="130"><template #default="{ row }">{{ fmtTime(row.FIRST_SEEN) }}</template></el-table-column>
          </el-table>
        </el-tab-pane>
        <el-tab-pane :label="`执行时段偏移（${(data.timeShift || []).length}）`" name="shift">
          <el-table :data="data.timeShift || []" size="small" stripe>
            <el-table-column v-if="!instanceId" prop="INSTANCE_NAME" label="实例" width="110" show-overflow-tooltip />
            <el-table-column label="SQL_ID" width="150" show-overflow-tooltip><template #default="{ row }"><span class="mono">{{ shortSqlId(row.NATIVE_SQL_ID) }}</span></template></el-table-column>
            <el-table-column label="SQL" min-width="260" show-overflow-tooltip>
              <template #default="{ row }"><el-button link type="primary" @click="$emit('open-asset', row.ASSET_ID, row.INSTANCE_ID)">#{{ row.ASSET_ID }} {{ (row.SQL_TEXT || '').slice(0, 70) }}</el-button></template>
            </el-table-column>
            <el-table-column label="前 7 天峰值" width="110"><template #default="{ row }">{{ hh(row.PREV_PEAK_HOUR) }}</template></el-table-column>
            <el-table-column label="当前峰值" width="100"><template #default="{ row }"><b class="danger">{{ hh(row.CUR_PEAK_HOUR) }}</b></template></el-table-column>
            <el-table-column prop="SHIFT_HOURS" label="偏移(小时)" width="95" />
            <el-table-column label="执行次数 当前/前7天" width="150"><template #default="{ row }">{{ row.CUR_EXECS }} / {{ row.PREV_EXECS }}</template></el-table-column>
          </el-table>
        </el-tab-pane>
        <el-tab-pane :label="`资源增量（${(data.resourceGrowth || []).length}）`" name="growth">
          <el-table :data="data.resourceGrowth || []" size="small" stripe>
            <el-table-column v-if="!instanceId" prop="INSTANCE_NAME" label="实例" width="110" show-overflow-tooltip />
            <el-table-column label="SQL_ID" width="150" show-overflow-tooltip><template #default="{ row }"><span class="mono">{{ shortSqlId(row.NATIVE_SQL_ID) }}</span></template></el-table-column>
            <el-table-column label="SQL" min-width="260" show-overflow-tooltip>
              <template #default="{ row }"><el-button link type="primary" @click="$emit('open-asset', row.ASSET_ID, row.INSTANCE_ID)">#{{ row.ASSET_ID }} {{ (row.SQL_TEXT || '').slice(0, 70) }}</el-button></template>
            </el-table-column>
            <el-table-column label="当前 DB Time(s)" width="125"><template #default="{ row }">{{ num(row.CUR_SEC) }}</template></el-table-column>
            <el-table-column label="前一窗口(s)" width="105"><template #default="{ row }">{{ num(row.PREV_SEC) }}</template></el-table-column>
            <el-table-column label="增量(s)" width="85"><template #default="{ row }"><b class="danger">+{{ num(row.DELTA_SEC) }}</b></template></el-table-column>
            <el-table-column label="倍率" width="75"><template #default="{ row }">{{ row.RATIO ? row.RATIO + 'x' : '新增' }}</template></el-table-column>
            <el-table-column label="执行次数 当前/前" width="130"><template #default="{ row }">{{ row.CUR_EXECS }} / {{ row.PREV_EXECS }}</template></el-table-column>
          </el-table>
        </el-tab-pane>
        <el-tab-pane :label="`冲突风险（${(data.conflicts || []).length}）`" name="conflict">
          <el-table :data="data.conflicts || []" size="small" stripe>
            <el-table-column label="变化类型" width="110"><template #default="{ row }">{{ { NEW_SQL: '新增 SQL', TIME_SHIFT: '时段偏移', RESOURCE_GROWTH: '资源增量' }[row.KIND] }}</template></el-table-column>
            <el-table-column v-if="!instanceId" prop="INSTANCE_NAME" label="实例" width="110" show-overflow-tooltip />
            <el-table-column label="SQL_ID" width="150" show-overflow-tooltip><template #default="{ row }"><span class="mono">{{ shortSqlId(row.NATIVE_SQL_ID) }}</span></template></el-table-column>
            <el-table-column label="SQL" min-width="240" show-overflow-tooltip>
              <template #default="{ row }"><el-button link type="primary" @click="$emit('open-asset', row.ASSET_ID, row.INSTANCE_ID)">#{{ row.ASSET_ID }} {{ (row.SQL_TEXT || '').slice(0, 60) }}</el-button></template>
            </el-table-column>
            <el-table-column label="SQL 峰值" width="95"><template #default="{ row }">{{ hh(row.PEAK_HOUR) }}（{{ num(row.PEAK_SEC) }}s）</template></el-table-column>
            <el-table-column label="实例高峰小时" width="190"><template #default="{ row }">{{ (row.BUSY_HOURS || []).map(hh).join('、') }}</template></el-table-column>
          </el-table>
          <div class="text-gray" style="margin-top: 6px">实例高峰 = 近 7 天按小时汇总 DB Time 最高的 3 个小时。</div>
        </el-tab-pane>
      </el-tabs>
    </div>
  </div>
</template>

<script setup>
import { ref, watch, onMounted } from 'vue'
import { sqlInsightApi } from '@/api/index.js'
import { shortSqlId, num, fmtTime, hh } from './sqlInsightUtil.js'

const props = defineProps({ instanceId: { type: [Number, String], default: null } })
defineEmits(['open-asset'])
const hours = ref(24)
const sub = ref('new')
const data = ref({})
const loading = ref(false)
async function load() {
  loading.value = true
  try { data.value = (await sqlInsightApi.changes({ instanceId: props.instanceId || undefined, hours: hours.value })).data || {} } catch { data.value = {} } finally { loading.value = false }
}
watch(() => props.instanceId, load)
defineExpose({ load })
onMounted(load)
</script>

<style scoped>
.filters { display: flex; gap: 8px; align-items: center; margin-bottom: 10px; flex-wrap: wrap; }
.danger { color: #f56c6c; }
.mono { font-family: Consolas, Menlo, monospace; font-size: 12px; }
</style>
