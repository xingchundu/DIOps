<template>
  <div>
    <div class="bar"><el-button @click="load">刷新</el-button><span class="sub">每次巡检结束自动生成一份报告；Word 供汇报阅读（含按数据库类型分节的 SQL 洞察，每条 SQL 带 SQL ID），Excel 供筛选明细。</span></div>
    <el-table :data="list" v-loading="loading" border size="small" stripe>
      <el-table-column label="报告" min-width="300"><template #default="{ row }"><b>{{ row.REPORT_NAME }}</b></template></el-table-column>
      <el-table-column label="触发" width="90"><template #default="{ row }">{{ TRIGGER[row.TRIGGER_TYPE] }}</template></el-table-column>
      <el-table-column prop="INSTANCE_COUNT" label="实例" width="70" />
      <el-table-column prop="ABNORMAL_INST" label="异常实例" width="90" />
      <el-table-column label="巡检失败" width="90"><template #default="{ row }"><span :class="{ fail: row.FAIL_INST }">{{ row.FAIL_INST }}</span></template></el-table-column>
      <el-table-column label="严重" width="70"><template #default="{ row }"><span :class="{ crit: row.CRIT_CNT }">{{ row.CRIT_CNT }}</span></template></el-table-column>
      <el-table-column label="预警" width="70"><template #default="{ row }"><span :class="{ warn: row.WARN_CNT }">{{ row.WARN_CNT }}</span></template></el-table-column>
      <el-table-column prop="OPEN_ISSUES" label="待处理问题" width="100" />
      <el-table-column label="生成时间" width="160"><template #default="{ row }">{{ fmtTime(row.CREATED_AT) }}</template></el-table-column>
      <el-table-column label="操作" width="230" fixed="right"><template #default="{ row }">
        <el-button link type="primary" :loading="busy[row.RUN_ID + 'word']" @click="dl(row, 'word')">Word</el-button>
        <el-button link type="primary" :loading="busy[row.RUN_ID + 'excel']" @click="dl(row, 'excel')">Excel</el-button>
        <el-button link @click="emit('goto', 'runs', row.RUN_ID)">查看记录</el-button>
      </template></el-table-column>
    </el-table>
    <el-pagination v-model:current-page="page" :page-size="size" :total="total" layout="total, prev, pager, next" style="margin-top:10px" @current-change="load" />
  </div>
</template>
<script setup>
import { ref, reactive, onMounted } from 'vue'
import { dbInspectApi as api } from '@/api/index.js'
import { TRIGGER, fmtTime, saveBlob } from './common.js'

const emit = defineEmits(['goto'])
const list = ref([]); const loading = ref(false); const page = ref(1); const size = 15; const total = ref(0); const busy = reactive({})
async function load() { loading.value = true; try { const d = (await api.reports({ page: page.value, size })).data; list.value = d.list; total.value = d.total } finally { loading.value = false } }
async function dl(row, kind) {
  const k = row.RUN_ID + kind; busy[k] = true
  try { saveBlob(await api.downloadReport(row.RUN_ID, kind), `数据库巡检报告-${row.RUN_ID}.${kind === 'word' ? 'docx' : 'xlsx'}`) } finally { busy[k] = false }
}
onMounted(load)
</script>
<style scoped>
.bar { display: flex; gap: 8px; margin-bottom: 10px; align-items: center; flex-wrap: wrap; }
.sub { color: #8a94a3; font-size: 12px; } .crit { color: #f56c6c; font-weight: 600; } .warn { color: #e6a23c; font-weight: 600; } .fail { color: #909399; }
</style>
