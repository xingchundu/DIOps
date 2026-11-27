<template>
  <div>
    <div class="bar">
      <el-button v-if="canWrite" type="primary" @click="openEdit(null)">新建计划</el-button>
      <el-button @click="load">刷新</el-button>
      <span class="sub">计划 = 模板 + 实例范围 + Cron + 执行窗口（支持跨午夜，如 22:00-06:00）；到点不在窗口内则跳过。</span>
    </div>
    <el-table :data="list" v-loading="loading" border size="small" stripe>
      <el-table-column prop="name" label="计划" min-width="160" />
      <el-table-column prop="templateName" label="模板" min-width="150" />
      <el-table-column label="范围" min-width="200"><template #default="{ row }">{{ scopeText(row.scope) }}</template></el-table-column>
      <el-table-column label="Cron" width="130"><template #default="{ row }"><code>{{ row.cron || '仅手动' }}</code></template></el-table-column>
      <el-table-column label="执行窗口" width="120"><template #default="{ row }">{{ row.windowStart ? `${row.windowStart} - ${row.windowEnd}` : '不限' }}</template></el-table-column>
      <el-table-column label="最近一次" min-width="160"><template #default="{ row }"><template v-if="row.lastRunId"><a class="lk" @click="emit('goto', 'runs', row.lastRunId)">#{{ row.lastRunId }}</a> {{ fmtTime(row.lastRunAt) }}<div class="sub">{{ row.lastSummary }}</div></template><span v-else class="sub">—</span></template></el-table-column>
      <el-table-column label="启用" width="70"><template #default="{ row }"><el-switch :model-value="row.enabled" :disabled="!canWrite" @change="v => toggle(row, v)" /></template></el-table-column>
      <el-table-column label="操作" width="190" fixed="right"><template #default="{ row }">
        <el-button v-if="canRun" link type="success" @click="runNow(row)">立即执行</el-button>
        <el-button v-if="canWrite" link type="primary" @click="openEdit(row)">编辑</el-button>
        <el-button v-if="canWrite" link type="danger" @click="del(row)">删除</el-button>
      </template></el-table-column>
    </el-table>

    <el-dialog v-model="dlg" :title="form.planId ? '编辑计划' : '新建计划'" width="640px">
      <el-form :model="form" label-width="100px">
        <el-form-item label="计划名称"><el-input v-model="form.name" /></el-form-item>
        <el-form-item label="巡检模板"><el-select v-model="form.templateId" style="width:100%"><el-option v-for="t in templates" :key="t.templateId" :label="`${t.name}（${t.itemCount} 项）`" :value="t.templateId" :disabled="!t.enabled" /></el-select></el-form-item>
        <el-form-item label="数据库类型"><el-select v-model="form.scope.dbTypes" multiple clearable placeholder="不选=全部" style="width:100%"><el-option v-for="x in meta.scope.dbTypes" :key="x" :label="x" :value="x" /></el-select></el-form-item>
        <el-form-item label="环境"><el-select v-model="form.scope.envs" multiple clearable placeholder="不选=全部" style="width:100%"><el-option v-for="x in meta.scope.envs" :key="x" :label="x" :value="x" /></el-select></el-form-item>
        <el-form-item label="业务线"><el-select v-model="form.scope.bizLines" multiple clearable placeholder="不选=全部" style="width:100%"><el-option v-for="x in meta.scope.bizLines" :key="x" :label="x" :value="x" /></el-select></el-form-item>
        <el-form-item label="指定实例"><el-select v-model="form.scope.instanceIds" multiple filterable clearable placeholder="不选=按上面条件" style="width:100%"><el-option v-for="i in meta.scope.instances" :key="i.instanceId" :label="`${i.name}（${i.dbType}）`" :value="i.instanceId" /></el-select></el-form-item>
        <el-form-item label="Cron"><el-input v-model="form.cron" placeholder="如 0 2 * * *（每天 2 点）；留空=仅手动" /></el-form-item>
        <el-form-item label="执行窗口">
          <el-time-select v-model="form.windowStart" start="00:00" end="23:30" step="00:30" placeholder="开始" style="width:130px" clearable />
          <span style="margin:0 8px">至</span>
          <el-time-select v-model="form.windowEnd" start="00:00" end="23:30" step="00:30" placeholder="结束" style="width:130px" clearable />
          <span class="sub" style="margin-left:8px">开始 &gt; 结束 视为跨午夜</span>
        </el-form-item>
        <el-form-item label="启用"><el-switch v-model="form.enabled" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="dlg = false">取消</el-button><el-button type="primary" @click="save">保存</el-button></template>
    </el-dialog>
  </div>
</template>
<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { dbInspectApi as api } from '@/api/index.js'
import { useAuthStore } from '@/stores/auth.js'
import { fmtTime } from './common.js'

defineProps({ meta: { type: Object, required: true } })
const emit = defineEmits(['goto'])
const auth = useAuthStore()
const canWrite = computed(() => ['ADMIN', 'DBA'].includes(auth.user?.role))
const canRun = computed(() => ['ADMIN', 'DBA', 'OPS'].includes(auth.user?.role))
const list = ref([]); const loading = ref(false); const templates = ref([])
const scopeText = s => {
  const p = []
  if (s?.dbTypes?.length) p.push(`类型：${s.dbTypes.join('/')}`)
  if (s?.envs?.length) p.push(`环境：${s.envs.join('/')}`)
  if (s?.bizLines?.length) p.push(`业务线：${s.bizLines.join('/')}`)
  if (s?.instanceIds?.length) p.push(`${s.instanceIds.length} 个指定实例`)
  return p.join('；') || '全部纳管实例'
}
async function load() { loading.value = true; try { list.value = (await api.plans()).data } finally { loading.value = false } }
const dlg = ref(false)
const blank = () => ({ planId: null, name: '', templateId: null, scope: { dbTypes: [], envs: [], bizLines: [], instanceIds: [] }, cron: '', windowStart: '', windowEnd: '', enabled: true })
const form = reactive(blank())
async function openEdit(row) {
  templates.value = (await api.templates()).data
  Object.assign(form, blank(), row ? { ...row, scope: { dbTypes: [], envs: [], bizLines: [], instanceIds: [], ...(row.scope || {}) }, windowStart: row.windowStart || '', windowEnd: row.windowEnd || '', cron: row.cron || '' } : {})
  dlg.value = true
}
async function save() {
  const d = { name: form.name, templateId: form.templateId, scope: form.scope, cron: form.cron, windowStart: form.windowStart || null, windowEnd: form.windowEnd || null, enabled: form.enabled }
  if (form.planId) await api.updatePlan(form.planId, d); else await api.createPlan(d)
  ElMessage.success('已保存'); dlg.value = false; load()
}
async function toggle(row, v) { await api.updatePlan(row.planId, { name: row.name, templateId: row.templateId, scope: row.scope, cron: row.cron, windowStart: row.windowStart, windowEnd: row.windowEnd, enabled: v }); row.enabled = v }
async function del(row) { await ElMessageBox.confirm(`删除计划「${row.name}」？历史记录保留。`, '确认'); await api.deletePlan(row.planId); load() }
async function runNow(row) { const r = await api.runPlan(row.planId); ElMessage.success(`已开始巡检 ${r.data.total} 个实例`); emit('goto', 'runs', r.data.runId) }
onMounted(load)
</script>
<style scoped>
.bar { display: flex; gap: 8px; margin-bottom: 10px; align-items: center; flex-wrap: wrap; }
.sub { color: #8a94a3; font-size: 12px; } .lk { color: #409eff; cursor: pointer; }
</style>
