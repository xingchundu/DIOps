<template>
  <div>
    <div class="cards">
      <div class="card c1" @click="quick('active')"><b>{{ sm.open + sm.fixing }}</b><span>未整改</span></div>
      <div class="card c2" @click="quick('crit')"><b>{{ sm.openCritical }}</b><span>严重</span></div>
      <div class="card c3" @click="quick('warn')"><b>{{ sm.openWarning }}</b><span>预警</span></div>
      <div class="card c4" @click="quick('FIXED')"><b>{{ sm.fixed }}</b><span>已整改（复检正常自动置位）</span></div>
      <div class="card c5" @click="quick('IGNORED')"><b>{{ sm.ignored }}</b><span>已忽略</span></div>
    </div>
    <div class="bar">
      <el-select v-model="f.status" placeholder="状态" clearable style="width:110px" @change="reload"><el-option v-for="(v, k) in ISSUE_STATUS" :key="k" :label="v[0]" :value="k" /></el-select>
      <el-select v-model="f.severity" placeholder="级别" clearable style="width:100px" @change="reload"><el-option label="严重" value="CRITICAL" /><el-option label="预警" value="WARNING" /></el-select>
      <el-select v-model="f.dbType" placeholder="数据库类型" clearable style="width:130px" @change="reload"><el-option v-for="x in meta.scope.dbTypes" :key="x" :label="x" :value="x" /></el-select>
      <el-select v-model="f.category" placeholder="分类" clearable style="width:110px" @change="reload"><el-option v-for="c in meta.categories" :key="c.value" :label="c.label" :value="c.value" /></el-select>
      <el-input v-model="f.keyword" placeholder="实例 / 检查项 / 对象 / SQL ID" clearable style="width:240px" @keyup.enter="reload" @clear="reload" />
      <el-button @click="reload">查询</el-button>
    </div>
    <el-table :data="list" v-loading="loading" border size="small" stripe>
      <el-table-column label="级别" width="70"><template #default="{ row }"><el-tag size="small" :type="sevType(row.SEVERITY)">{{ sevLabel(row.SEVERITY) }}</el-tag></template></el-table-column>
      <el-table-column label="实例" min-width="150"><template #default="{ row }">{{ row.INSTANCE_NAME }}<div class="sub">{{ row.DB_TYPE }} {{ row.HOST_IP }}</div></template></el-table-column>
      <el-table-column label="检查项 / 对象" min-width="250"><template #default="{ row }"><b>{{ row.ITEM_NAME }}</b><div class="sub">{{ row.SQL_ID ? '' : row.OBJECT_KEY }}<template v-if="row.SQL_ID"><code>{{ row.SQL_ID }}</code> <el-tag size="small" type="info" effect="plain">{{ ID_KIND[row.SQL_ID_KIND] || row.SQL_ID_KIND }}</el-tag></template></div></template></el-table-column>
      <el-table-column prop="CURRENT_VALUE" label="当前值" width="110" />
      <el-table-column prop="THRESHOLD_TEXT" label="阈值" width="120" />
      <el-table-column label="状态" width="90"><template #default="{ row }"><el-tag size="small" :type="ISSUE_STATUS[row.STATUS]?.[1]">{{ ISSUE_STATUS[row.STATUS]?.[0] }}</el-tag></template></el-table-column>
      <el-table-column label="首次 / 最近" width="150"><template #default="{ row }"><div class="sub">{{ fmtTime(row.FIRST_SEEN) }}</div><div class="sub">{{ fmtTime(row.LAST_SEEN) }}　×{{ row.OCCURRENCES }}</div></template></el-table-column>
      <el-table-column label="操作" width="210" fixed="right"><template #default="{ row }">
        <el-button link type="primary" @click="detail(row)">详情</el-button>
        <template v-if="canOp && (row.STATUS === 'OPEN' || row.STATUS === 'FIXING')">
          <el-button link type="success" @click="recheck(row)">复检</el-button>
          <el-dropdown trigger="click" @command="c => setStatus(row, c)"><el-button link>处理<el-icon class="el-icon--right"><ArrowDown /></el-icon></el-button><template #dropdown><el-dropdown-menu><el-dropdown-item command="FIXING">标记整改中</el-dropdown-item><el-dropdown-item command="FIXED">标记已整改</el-dropdown-item><el-dropdown-item command="IGNORED">忽略</el-dropdown-item></el-dropdown-menu></template></el-dropdown>
        </template>
        <el-button v-else-if="canOp && row.STATUS === 'IGNORED'" link @click="setStatus(row, 'OPEN')">恢复</el-button>
      </template></el-table-column>
    </el-table>
    <el-pagination v-model:current-page="page" :page-size="size" :total="total" layout="total, prev, pager, next" style="margin-top:10px" @current-change="load" />

    <el-drawer v-model="dlg" title="问题详情" size="640px" destroy-on-close>
      <template v-if="cur">
        <el-descriptions :column="2" border size="small">
          <el-descriptions-item label="实例">{{ cur.INSTANCE_NAME }}</el-descriptions-item><el-descriptions-item label="类型">{{ cur.DB_TYPE }}</el-descriptions-item>
          <el-descriptions-item label="检查项">{{ cur.ITEM_NAME }}</el-descriptions-item><el-descriptions-item label="级别">{{ sevLabel(cur.SEVERITY) }}</el-descriptions-item>
          <el-descriptions-item label="当前值">{{ cur.CURRENT_VALUE }}</el-descriptions-item><el-descriptions-item label="阈值">{{ cur.THRESHOLD_TEXT }}</el-descriptions-item>
          <el-descriptions-item label="首次发现">{{ fmtTime(cur.FIRST_SEEN) }}</el-descriptions-item><el-descriptions-item label="最近发现">{{ fmtTime(cur.LAST_SEEN) }}（共 {{ cur.OCCURRENCES }} 次）</el-descriptions-item>
          <el-descriptions-item v-if="cur.SQL_ID" label="SQL ID" :span="2"><code>{{ cur.SQL_ID }}</code>（{{ ID_KIND[cur.SQL_ID_KIND] || cur.SQL_ID_KIND }}）</el-descriptions-item>
          <el-descriptions-item label="整改建议" :span="2">{{ cur.ADVICE || '—' }}</el-descriptions-item>
          <el-descriptions-item v-if="cur.NOTE" label="备注" :span="2">{{ cur.NOTE }}</el-descriptions-item>
        </el-descriptions>
        <div v-if="cur.SQL_TEXT" class="code">{{ cur.SQL_TEXT }}</div>
        <div v-if="cur.EVIDENCE" style="margin-top:12px"><b>证据</b><pre class="code">{{ JSON.stringify(cur.EVIDENCE, null, 2) }}</pre></div>
        <div style="margin-top:12px"><el-button v-if="cur.LAST_RUN_ID" @click="emit('goto', 'runs', cur.LAST_RUN_ID)">查看最近一次巡检记录</el-button></div>
      </template>
    </el-drawer>
  </div>
</template>
<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { ArrowDown } from '@element-plus/icons-vue'
import { dbInspectApi as api } from '@/api/index.js'
import { useAuthStore } from '@/stores/auth.js'
import { ISSUE_STATUS, ID_KIND, sevLabel, sevType, fmtTime } from './common.js'

defineProps({ meta: { type: Object, required: true } })
const emit = defineEmits(['goto'])
const auth = useAuthStore()
const canOp = computed(() => ['ADMIN', 'DBA', 'OPS'].includes(auth.user?.role))
const f = reactive({ status: '', severity: '', dbType: '', category: '', keyword: '', active: '' })
const list = ref([]); const loading = ref(false); const page = ref(1); const size = 15; const total = ref(0)
const sm = ref({ open: 0, fixing: 0, fixed: 0, ignored: 0, openCritical: 0, openWarning: 0 })
async function load() {
  loading.value = true
  try {
    const d = (await api.issues({ page: page.value, size, status: f.status || undefined, severity: f.severity || undefined, dbType: f.dbType || undefined, category: f.category || undefined, keyword: f.keyword || undefined, active: f.active || undefined })).data
    list.value = d.list; total.value = d.total; sm.value = d.summary
  } finally { loading.value = false }
}
const reload = () => { page.value = 1; load() }
function quick(k) {
  Object.assign(f, { status: '', severity: '', active: '' })
  if (k === 'active') f.active = '1'; else if (k === 'crit') { f.active = '1'; f.severity = 'CRITICAL' } else if (k === 'warn') { f.active = '1'; f.severity = 'WARNING' } else f.status = k
  reload()
}
const dlg = ref(false); const cur = ref(null)
async function detail(row) { cur.value = (await api.issue(row.ISSUE_ID)).data; dlg.value = true }
async function setStatus(row, status) {
  let note
  if (status === 'IGNORED' || status === 'FIXED') { try { note = (await ElMessageBox.prompt('备注（可选）', status === 'IGNORED' ? '忽略原因' : '整改说明', { inputValue: '', confirmButtonText: '确定', cancelButtonText: '取消' })).value } catch { return } }
  await api.setIssueStatus(row.ISSUE_ID, { status, note }); ElMessage.success('已更新'); load()
}
async function recheck(row) { const r = await api.recheck(row.ISSUE_ID); ElMessage.success('已发起复检，结果正常将自动置为「已整改」'); emit('goto', 'runs', r.data.runId) }
onMounted(() => { f.active = '1'; load() })
</script>
<style scoped>
.cards { display: flex; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
.card { flex: 1; min-width: 130px; background: #fff; border: 1px solid #e4e7ed; border-radius: 8px; padding: 10px 14px; cursor: pointer; display: flex; flex-direction: column; }
.card b { font-size: 24px; } .card span { color: #8a94a3; font-size: 12px; }
.c2 b { color: #f56c6c; } .c3 b { color: #e6a23c; } .c4 b { color: #67c23a; }
.bar { display: flex; gap: 8px; margin-bottom: 10px; flex-wrap: wrap; }
.sub { color: #8a94a3; font-size: 12px; }
.code { background: #f5f7fa; border-radius: 4px; padding: 8px 10px; font-family: Consolas, Menlo, monospace; font-size: 12px; margin-top: 10px; white-space: pre-wrap; word-break: break-all; max-height: 320px; overflow: auto; }
</style>
