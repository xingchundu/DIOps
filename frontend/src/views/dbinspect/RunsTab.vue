<template>
  <div>
    <div class="bar">
      <el-select v-model="f.status" placeholder="状态" clearable style="width:120px" @change="load"><el-option v-for="(v, k) in RUN_STATUS" :key="k" :label="v[0]" :value="k" /></el-select>
      <el-select v-model="f.triggerType" placeholder="触发方式" clearable style="width:120px" @change="load"><el-option v-for="(v, k) in TRIGGER" :key="k" :label="v" :value="k" /></el-select>
      <el-input v-model="f.keyword" placeholder="模板 / 计划名" clearable style="width:180px" @keyup.enter="load" @clear="load" />
      <el-button @click="load">查询</el-button>
      <el-switch v-model="auto" active-text="自动刷新" />
    </div>
    <el-table :data="list" v-loading="loading" border size="small" stripe @row-click="r => open(r.RUN_ID)" style="cursor:pointer">
      <el-table-column label="#" width="70" prop="RUN_ID" />
      <el-table-column label="计划 / 模板" min-width="220"><template #default="{ row }"><b>{{ row.PLAN_NAME || row.TEMPLATE_NAME }}</b><div class="sub">{{ row.TEMPLATE_NAME }}</div></template></el-table-column>
      <el-table-column label="触发" width="90"><template #default="{ row }"><el-tag size="small" :type="row.TRIGGER_TYPE === 'ALERT' ? 'warning' : 'info'">{{ TRIGGER[row.TRIGGER_TYPE] }}</el-tag></template></el-table-column>
      <el-table-column label="状态" width="150">
        <template #default="{ row }">
          <el-tag size="small" :type="RUN_STATUS[row.STATUS]?.[1]">{{ RUN_STATUS[row.STATUS]?.[0] || row.STATUS }}</el-tag>
          <el-progress v-if="row.STATUS === 'RUNNING'" :percentage="pct(row)" :stroke-width="6" style="margin-top:4px" />
        </template>
      </el-table-column>
      <el-table-column label="实例" width="190"><template #default="{ row }">共 {{ row.TOTAL_INST }}　成功 {{ row.OK_INST }}<span v-if="row.FAIL_INST" class="fail">　巡检失败 {{ row.FAIL_INST }}</span></template></el-table-column>
      <el-table-column label="严重" width="70"><template #default="{ row }"><span :class="{ crit: row.CRIT_CNT }">{{ row.CRIT_CNT }}</span></template></el-table-column>
      <el-table-column label="预警" width="70"><template #default="{ row }"><span :class="{ warn: row.WARN_CNT }">{{ row.WARN_CNT }}</span></template></el-table-column>
      <el-table-column label="开始" width="160"><template #default="{ row }">{{ fmtTime(row.STARTED_AT) }}</template></el-table-column>
      <el-table-column label="发起人" width="90" prop="CREATED_NAME" />
    </el-table>
    <el-pagination v-model:current-page="page" :page-size="size" :total="total" layout="total, prev, pager, next" style="margin-top:10px" @current-change="load" />

    <el-drawer v-model="dlg" :title="`巡检记录 #${detail?.run?.RUN_ID || ''}`" size="1100px" destroy-on-close @closed="stopPoll">
      <template v-if="detail">
        <div class="sum">
          <div><label>模板</label>{{ detail.run.TEMPLATE_NAME }}</div>
          <div><label>触发</label>{{ TRIGGER[detail.run.TRIGGER_TYPE] }}{{ detail.run.TRIGGER_REF ? `（${detail.run.TRIGGER_REF}）` : '' }}</div>
          <div><label>时间</label>{{ fmtTime(detail.run.STARTED_AT) }} ~ {{ fmtTime(detail.run.FINISHED_AT) }}</div>
          <div><label>状态</label><el-tag size="small" :type="RUN_STATUS[detail.run.STATUS]?.[1]">{{ RUN_STATUS[detail.run.STATUS]?.[0] }}</el-tag></div>
          <div><label>实例</label>{{ detail.run.OK_INST }} 成功 / <span :class="{ fail: detail.run.FAIL_INST }">{{ detail.run.FAIL_INST }} 巡检失败</span> / {{ detail.run.TOTAL_INST }}</div>
          <div><label>异常</label><span class="crit">严重 {{ detail.run.CRIT_CNT }}</span>　<span class="warn">预警 {{ detail.run.WARN_CNT }}</span></div>
        </div>
        <div class="bar" style="margin:10px 0">
          <el-button size="small" type="primary" :loading="dl.word" @click="download('word')">下载 Word 报告</el-button>
          <el-button size="small" :loading="dl.excel" @click="download('excel')">下载 Excel 明细</el-button>
          <el-button v-if="canRun && detail.run.STATUS !== 'RUNNING'" size="small" @click="rerun">按相同范围重跑</el-button>
          <el-button size="small" @click="emit('goto', 'issues')">查看问题项</el-button>
        </div>
        <el-alert v-if="detail.run.MESSAGE" type="warning" :title="detail.run.MESSAGE" :closable="false" style="margin-bottom:8px" />
        <el-tabs v-model="dtab">
          <el-tab-pane label="实例结果" name="inst">
            <el-table :data="detail.instances" size="small" border @row-click="pickInst" highlight-current-row style="cursor:pointer">
              <el-table-column prop="INSTANCE_NAME" label="实例" min-width="160" />
              <el-table-column prop="DB_TYPE" label="类型" width="100" />
              <el-table-column prop="HOST_IP" label="地址" width="130" />
              <el-table-column label="结果" width="100"><template #default="{ row }">
                <el-tag v-if="row.EXEC_STATUS === 'FAILED'" size="small" type="info">巡检失败</el-tag>
                <el-tag v-else-if="row.EXEC_STATUS === 'RUNNING'" size="small">执行中</el-tag>
                <el-tag v-else-if="row.CRIT_CNT" size="small" type="danger">严重</el-tag>
                <el-tag v-else-if="row.WARN_CNT" size="small" type="warning">预警</el-tag>
                <el-tag v-else size="small" type="success">正常</el-tag></template></el-table-column>
              <el-table-column prop="CRIT_CNT" label="严重" width="60" /><el-table-column prop="WARN_CNT" label="预警" width="60" />
              <el-table-column prop="ITEMS_ERR" label="采集失败" width="80" />
              <el-table-column prop="SCORE" label="得分" width="60" />
              <el-table-column label="说明" min-width="200"><template #default="{ row }"><span class="sub">{{ row.ERROR_MSG }}</span></template></el-table-column>
            </el-table>
            <div v-if="curInst" style="margin-top:12px">
              <b>{{ curInst.INSTANCE_NAME }} · 检查项明细</b>
              <el-table :data="results" size="small" border style="margin-top:6px" max-height="420">
                <el-table-column label="分类" width="80"><template #default="{ row }">{{ catLabel(row.CATEGORY) }}</template></el-table-column>
                <el-table-column prop="ITEM_NAME" label="检查项" min-width="170" />
                <el-table-column label="结果" width="90"><template #default="{ row }"><el-tag size="small" :type="sevType(row.STATUS)">{{ sevLabel(row.STATUS) }}</el-tag></template></el-table-column>
                <el-table-column prop="WORST_VALUE" label="最差值" width="110" />
                <el-table-column prop="THRESHOLD_TEXT" label="阈值" width="130" />
                <el-table-column label="说明" min-width="240"><template #default="{ row }"><span class="sub">{{ row.MESSAGE }}</span></template></el-table-column>
                <el-table-column label="" width="70"><template #default="{ row }"><el-button v-if="row.ROW_COUNT" link type="primary" @click="showEvidence(row)">证据</el-button></template></el-table-column>
              </el-table>
            </div>
          </el-tab-pane>
          <el-tab-pane label="SQL 洞察（按库类型）" name="sql">
            <el-empty v-if="!sqlGroups.length" description="本次巡检没有 SQL 洞察数据（模板未含 SQL 检查项，或目标库未返回统计）" />
            <el-tabs v-else v-model="sqlFam" type="border-card">
              <el-tab-pane v-for="g in sqlGroups" :key="g.family" :label="g.label" :name="g.family">
                <div v-for="ins in g.instances" :key="ins.instanceId" style="margin-bottom:16px">
                  <div class="insname">{{ ins.instanceName }}<span class="sub">　{{ ins.dbType }}</span></div>
                  <div v-for="d in ins.dimensions" :key="d.dimension" style="margin:8px 0">
                    <div class="dim">{{ DIM[d.dimension] || d.dimension }}（{{ d.rows.length }}）</div>
                    <el-table :data="d.rows" size="small" border>
                      <el-table-column prop="RANK_NO" label="#" width="46" />
                      <el-table-column label="SQL ID" width="230"><template #default="{ row }"><code class="sid">{{ row.SQL_ID }}</code><el-tag size="small" type="info" effect="plain" style="margin-left:4px">{{ ID_KIND[row.SQL_ID_KIND] || row.SQL_ID_KIND }}</el-tag></template></el-table-column>
                      <el-table-column v-if="g.family !== 'MYSQL'" prop="PLAN_HASH" label="计划哈希" width="110" />
                      <el-table-column v-else prop="SCHEMA_NAME" label="库" width="100" />
                      <el-table-column label="执行次数" width="90"><template #default="{ row }">{{ fmtNum(row.EXECS) }}</template></el-table-column>
                      <el-table-column label="总耗时ms" width="100"><template #default="{ row }">{{ fmtNum(row.TOTAL_MS) }}</template></el-table-column>
                      <el-table-column label="平均ms" width="90"><template #default="{ row }">{{ fmtNum(row.AVG_MS) }}</template></el-table-column>
                      <el-table-column :label="g.family === 'MYSQL' ? '扫描行' : '逻辑读'" width="100"><template #default="{ row }">{{ fmtNum(g.family === 'MYSQL' ? row.ROWS_EXAMINED : (row.LOGICAL_READS ?? row.PHYSICAL_READS)) }}</template></el-table-column>
                      <el-table-column label="判定" width="70"><template #default="{ row }"><el-tag v-if="row.SEVERITY" size="small" :type="sevType(row.SEVERITY)">{{ sevLabel(row.SEVERITY) }}</el-tag></template></el-table-column>
                      <el-table-column label="SQL 文本" min-width="260"><template #default="{ row }"><el-tooltip placement="top" :content="row.SQL_TEXT" :show-after="300" popper-class="sqltip"><span class="sqltxt">{{ row.SQL_TEXT }}</span></el-tooltip></template></el-table-column>
                    </el-table>
                  </div>
                </div>
              </el-tab-pane>
            </el-tabs>
          </el-tab-pane>
        </el-tabs>
      </template>
    </el-drawer>

    <el-dialog v-model="evDlg" title="采集证据（前 30 行）" width="900px">
      <el-table v-if="ev" :data="ev.rows" size="small" border max-height="460"><el-table-column v-for="c in ev.columns" :key="c" :prop="c" :label="c" min-width="110" show-overflow-tooltip /></el-table>
      <div v-if="ev" class="sub" style="margin-top:6px">共 {{ ev.total }} 行</div>
    </el-dialog>
  </div>
</template>
<script setup>
import { ref, reactive, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { ElMessage } from 'element-plus'
import { dbInspectApi as api } from '@/api/index.js'
import { useAuthStore } from '@/stores/auth.js'
import { RUN_STATUS, TRIGGER, DIM, ID_KIND, sevLabel, sevType, fmtTime, fmtNum, saveBlob } from './common.js'

const props = defineProps({ meta: { type: Object, required: true }, openRun: { type: Number, default: null } })
const emit = defineEmits(['goto'])
const auth = useAuthStore()
const canRun = computed(() => ['ADMIN', 'DBA', 'OPS'].includes(auth.user?.role))
const catLabel = c => props.meta.categories.find(x => x.value === c)?.label || c
const f = reactive({ status: '', triggerType: '', keyword: '' })
const list = ref([]); const loading = ref(false); const page = ref(1); const size = 15; const total = ref(0); const auto = ref(true)
const pct = r => (r.TOTAL_INST ? Math.round((r.DONE_INST / r.TOTAL_INST) * 100) : 0)
async function load(silent) {
  if (silent !== true) loading.value = true
  try { const d = (await api.runs({ page: page.value, size, status: f.status || undefined, triggerType: f.triggerType || undefined, keyword: f.keyword || undefined })).data; list.value = d.list; total.value = d.total } finally { loading.value = false }
}
let timer = null
function tick() { if (!auto.value) return; if (list.value.some(r => r.STATUS === 'RUNNING') || (dlg.value && detail.value?.run.STATUS === 'RUNNING')) { load(true); if (dlg.value) refreshDetail() } }

const dlg = ref(false); const detail = ref(null); const dtab = ref('inst'); const curInst = ref(null); const results = ref([])
const sqlGroups = ref([]); const sqlFam = ref('')
const dl = reactive({ word: false, excel: false })
async function refreshDetail() {
  if (!detail.value) return
  const id = detail.value.run.RUN_ID
  detail.value = (await api.run(id)).data
  if (curInst.value) results.value = (await api.runResults(id, { instanceId: curInst.value.INSTANCE_ID })).data
}
async function open(id) {
  detail.value = (await api.run(id)).data; dtab.value = 'inst'; curInst.value = null; results.value = []
  sqlGroups.value = (await api.runSql(id)).data; sqlFam.value = sqlGroups.value[0]?.family || ''
  dlg.value = true
}
async function pickInst(r) { curInst.value = r; results.value = (await api.runResults(detail.value.run.RUN_ID, { instanceId: r.INSTANCE_ID })).data }
function stopPoll() { detail.value = null }
const evDlg = ref(false); const ev = ref(null)
async function showEvidence(row) { ev.value = (await api.evidence(row.RESULT_ID)).data; evDlg.value = true }
async function download(kind) {
  dl[kind] = true
  try { const blob = await api.downloadReport(detail.value.run.RUN_ID, kind); saveBlob(blob, `数据库巡检报告-${detail.value.run.RUN_ID}.${kind === 'word' ? 'docx' : 'xlsx'}`) } finally { dl[kind] = false }
}
async function rerun() { const r = await api.rerun(detail.value.run.RUN_ID); ElMessage.success('已开始重跑'); dlg.value = false; await load(); open(r.data.runId) }
watch(() => props.openRun, v => { if (v) open(v) })
onMounted(async () => { await load(); if (props.openRun) open(props.openRun); timer = setInterval(tick, 3000) })
onBeforeUnmount(() => clearInterval(timer))
</script>
<style scoped>
.bar { display: flex; gap: 8px; margin-bottom: 10px; align-items: center; flex-wrap: wrap; }
.sub { color: #8a94a3; font-size: 12px; }
.crit { color: #f56c6c; font-weight: 600; } .warn { color: #e6a23c; font-weight: 600; } .fail { color: #909399; }
.sum { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px 16px; background: #f5f7fa; padding: 10px 14px; border-radius: 6px; font-size: 13px; }
.sum label { color: #8a94a3; margin-right: 8px; }
.insname { font-weight: 600; color: #1f3a5f; } .dim { color: #1f3a5f; margin: 4px 0; font-size: 13px; }
.sid { font-size: 12px; } .sqltxt { display: inline-block; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: Consolas, Menlo, monospace; font-size: 12px; }
</style>
<style>.sqltip { max-width: 640px; word-break: break-all; font-family: Consolas, Menlo, monospace; }</style>
