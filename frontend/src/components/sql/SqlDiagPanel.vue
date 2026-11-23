<template>
  <div class="diag">
    <div class="card form">
      <el-select v-model="form.instanceId" placeholder="选择 Oracle 实例（自动使用该实例的连接信息）" filterable size="small" style="width: 320px">
        <el-option v-for="i in oracleInstances" :key="i.INSTANCE_ID" :label="`${i.INSTANCE_NAME}（${i.HOST_IP}）`" :value="i.INSTANCE_ID" />
      </el-select>
      <el-input v-model="form.sqlId" placeholder="SQL_ID（13 位）" size="small" style="width: 200px" maxlength="13" clearable />
      <el-input v-model="form.pdb" placeholder="PDB（可选，CDB 环境）" size="small" style="width: 170px" clearable />
      <el-button type="primary" size="small" :loading="submitting" @click="run">开始诊断</el-button>
      <div class="text-gray tip">只读采集 V$/DBA 视图 + 执行计划，规则 R01–R23 判定后生成 Word 报告；结果自动写入知识图谱。</div>
    </div>

    <el-table :data="jobs" size="small" style="margin-top: 10px" v-loading="loading" empty-text="暂无诊断记录">
      <el-table-column prop="JOB_ID" label="#" width="60" />
      <el-table-column prop="SQL_ID" label="SQL_ID" width="140" />
      <el-table-column label="实例" min-width="140"><template #default="{ row }">{{ instName(row.INSTANCE_ID) }}</template></el-table-column>
      <el-table-column label="状态" width="100">
        <template #default="{ row }"><el-tag :type="tagType(row.STATUS)" size="small">{{ statusText(row.STATUS) }}</el-tag></template>
      </el-table-column>
      <el-table-column prop="FINDING_CNT" label="发现" width="70" />
      <el-table-column label="开始" width="150"><template #default="{ row }">{{ fmt(row.CREATED_AT) }}</template></el-table-column>
      <el-table-column label="操作" width="210">
        <template #default="{ row }">
          <el-button link type="primary" size="small" :disabled="row.STATUS === 'RUNNING'" @click="openJob(row)">结论</el-button>
          <el-button link size="small" :disabled="!row.DOCX_FILE" @click="download(row, 'docx')">Word</el-button>
          <el-button link size="small" :disabled="row.STATUS !== 'DONE'" @click="download(row, 'json')">快照</el-button>
        </template>
      </el-table-column>
    </el-table>
    <el-pagination v-if="total > size" v-model:current-page="page" :page-size="size" :total="total" layout="prev, pager, next" small style="margin-top: 8px" @current-change="load" />

    <el-drawer v-model="drawer" :title="`SQL_ID ${cur?.SQL_ID || ''} 诊断结论`" size="52%">
      <template v-if="cur">
        <el-alert v-if="cur.STATUS === 'FAILED'" type="error" :closable="false" show-icon :title="cur.ERR_MSG || '诊断失败'" />
        <template v-else-if="cur.SUMMARY">
          <div class="counts">
            <el-tag type="danger">严重 {{ cur.SUMMARY.counts?.critical || 0 }}</el-tag>
            <el-tag type="warning">警告 {{ cur.SUMMARY.counts?.warning || 0 }}</el-tag>
            <el-tag type="info">提示 {{ cur.SUMMARY.counts?.info || 0 }}</el-tag>
            <span v-if="cur.SUMMARY.meta" class="text-gray">{{ cur.SUMMARY.meta.banner }}{{ cur.SUMMARY.meta.rac ? ' · RAC' : '' }}</span>
          </div>
          <el-collapse>
            <el-collapse-item v-for="f in cur.SUMMARY.findings" :key="f.id + f.title" :name="f.id + f.title">
              <template #title><el-tag :type="levelType(f.level)" size="small" style="margin-right: 8px">{{ f.id }}</el-tag>{{ f.title }}</template>
              <div v-for="(e, i) in f.evidence || []" :key="i" class="ev">· {{ e }}</div>
              <div v-if="f.advice" class="adv"><b>建议：</b>{{ f.advice }}</div>
              <div v-if="f.risk" class="risk"><b>风险：</b>{{ f.risk }}</div>
              <div v-if="f.verify" class="risk"><b>验证：</b>{{ f.verify }}</div>
            </el-collapse-item>
          </el-collapse>
          <div v-if="cur.FINDING_CNT > (cur.SUMMARY.findings || []).length" class="text-gray" style="margin-top: 6px">仅显示前 {{ cur.SUMMARY.findings.length }} 条，完整内容见 Word 报告</div>
        </template>
      </template>
    </el-drawer>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { monitorApi, sqlDiagApi } from '@/api/index.js'

const props = defineProps({ initial: { type: Object, default: null } })
const instances = ref([]); const jobs = ref([]); const loading = ref(false)
const submitting = ref(false); const page = ref(1); const size = 10; const total = ref(0)
const form = reactive({ instanceId: null, sqlId: '', pdb: '' })
const drawer = ref(false); const cur = ref(null); let timer = null
const oracleInstances = computed(() => instances.value.filter(i => String(i.DB_TYPE).toUpperCase() === 'ORACLE'))
const instName = id => instances.value.find(i => i.INSTANCE_ID === id)?.INSTANCE_NAME || id
const fmt = v => (v ? String(v).replace('T', ' ').slice(0, 19) : '-')
const statusText = s => ({ RUNNING: '诊断中', DONE: '完成', FAILED: '失败', PENDING: '排队' }[s] || s)
const tagType = s => ({ DONE: 'success', FAILED: 'danger', RUNNING: 'warning' }[s] || 'info')
const levelType = l => ({ critical: 'danger', warning: 'warning' }[l] || 'info')

async function load() {
  loading.value = true
  try {
    const d = (await sqlDiagApi.jobs({ page: page.value, size })).data || {}
    jobs.value = d.rows || d.list || []; total.value = d.total || jobs.value.length
    schedulePoll()
  } finally { loading.value = false }
}
function schedulePoll() {
  clearTimeout(timer)
  if (jobs.value.some(j => j.STATUS === 'RUNNING')) timer = setTimeout(load, 4000)
}
async function run() {
  if (!form.instanceId) return ElMessage.warning('请选择 Oracle 实例')
  if (!/^[0-9a-z]{13}$/i.test(form.sqlId.trim())) return ElMessage.warning('SQL_ID 应为 13 位字母数字')
  submitting.value = true
  try {
    await sqlDiagApi.run({ instanceId: form.instanceId, sqlId: form.sqlId.trim(), pdb: form.pdb || undefined, noAwr: true })
    ElMessage.success('已开始诊断，完成后可查看结论 / 下载 Word'); page.value = 1; await load()
  } finally { submitting.value = false }
}
async function openJob(row) { cur.value = (await sqlDiagApi.job(row.JOB_ID)).data; drawer.value = true }
async function download(row, kind) {
  const r = await (kind === 'docx' ? sqlDiagApi.docx(row.JOB_ID) : sqlDiagApi.json(row.JOB_ID))
  const blob = r instanceof Blob ? r : (r.data instanceof Blob ? r.data : new Blob([r.data ?? r]))
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob)
  a.download = `${row.SQL_ID}_${kind === 'docx' ? 'diag.docx' : 'snapshot.json'}`; a.click(); URL.revokeObjectURL(a.href)
}
onMounted(async () => {
  sqlDiagApi.status().catch(() => { /* 后台探测/触发自动编译，不弹窗 */ })
  try { const r = await monitorApi.instances?.({ pageSize: 500 }); instances.value = r?.data?.rows || r?.data?.list || r?.data || [] } catch (_) { /* ignore */ }
  load()
})
watch(() => props.initial, v => { if (v) { form.instanceId = v.instanceId; form.sqlId = v.sqlId || '' } }, { immediate: true })
onBeforeUnmount(() => clearTimeout(timer))
</script>

<style scoped>
.form { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding: 12px }
.tip { width: 100%; font-size: 12px }
.counts { display: flex; gap: 8px; align-items: center; margin-bottom: 10px }
.ev { font-size: 13px; line-height: 1.7; color: var(--el-text-color-regular) }
.adv { margin-top: 6px; line-height: 1.7 }
.risk { margin-top: 4px; font-size: 12px; color: #94a3b8; line-height: 1.6 }
</style>
