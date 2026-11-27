<template>
  <div>
    <div class="bar">
      <el-button v-if="canWrite" type="primary" @click="openEdit(null)">新建模板</el-button>
      <el-button @click="load">刷新</el-button>
      <span class="sub">模板 = 一组检查项；日常巡检跑全量，专项巡检（空间 / SQL / 主备）可绑定告警关键字，由告警自动触发。</span>
    </div>
    <el-table :data="list" v-loading="loading" border size="small" stripe>
      <el-table-column label="模板" min-width="200"><template #default="{ row }"><b>{{ row.name }}</b><el-tag v-if="row.builtin" size="small" type="info" style="margin-left:6px">内置</el-tag><div class="sub">{{ row.description }}</div></template></el-table-column>
      <el-table-column label="类型" width="100"><template #default="{ row }">{{ KIND[row.kind] || row.kind }}</template></el-table-column>
      <el-table-column label="检查项" width="80" prop="itemCount" />
      <el-table-column label="适用数据库" min-width="160"><template #default="{ row }"><span v-if="!row.families || !row.families.length">全部</span><el-tag v-for="x in row.families || []" :key="x" size="small" style="margin-right:4px">{{ famLabel(x) }}</el-tag></template></el-table-column>
      <el-table-column label="告警联动关键字" min-width="180"><template #default="{ row }"><el-tag v-for="k in row.alertRules" :key="k" size="small" type="warning" effect="plain" style="margin:0 4px 2px 0">{{ k }}</el-tag><span v-if="!row.alertRules.length" class="sub">—</span></template></el-table-column>
      <el-table-column label="被计划引用" min-width="120"><template #default="{ row }">{{ row.plans.join('、') || '—' }}</template></el-table-column>
      <el-table-column label="启用" width="70"><template #default="{ row }"><el-switch :model-value="row.enabled" :disabled="!canWrite" @change="v => toggle(row, v)" /></template></el-table-column>
      <el-table-column label="操作" width="200" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="openEdit(row)">{{ canWrite ? '编辑' : '查看' }}</el-button>
          <el-button v-if="canRun" link type="success" @click="openRun(row)">立即巡检</el-button>
          <el-button v-if="canWrite && !row.builtin" link type="danger" @click="del(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="dlg" :title="form.templateId ? '编辑模板' : '新建模板'" width="760px" top="6vh">
      <el-form :model="form" label-width="110px" :disabled="!canWrite">
        <el-form-item label="名称"><el-input v-model="form.name" /></el-form-item>
        <el-form-item label="类型"><el-radio-group v-model="form.kind"><el-radio v-for="(l, k) in KIND" :key="k" :value="k">{{ l }}</el-radio></el-radio-group></el-form-item>
        <el-form-item label="说明"><el-input v-model="form.description" /></el-form-item>
        <el-form-item label="适用数据库"><el-select v-model="form.families" multiple clearable placeholder="不选=全部" style="width:100%"><el-option v-for="c in meta.families" :key="c.value" :label="c.label" :value="c.value" /></el-select></el-form-item>
        <el-form-item label="告警关键字"><el-select v-model="form.alertRules" multiple filterable allow-create default-first-option placeholder="告警名称/内容含这些词时自动触发本模板（专项巡检）" style="width:100%" /></el-form-item>
        <el-form-item label="检查项">
          <div style="width:100%">
            <el-input v-model="kw" placeholder="筛选检查项" clearable size="small" style="width:220px;margin-bottom:6px" />
            <el-button size="small" style="margin-left:8px" @click="selectAllVisible">全选当前</el-button>
            <el-button size="small" @click="form.itemIds = []">清空</el-button>
            <span class="sub" style="margin-left:8px">已选 {{ form.itemIds.length }} 项</span>
            <div class="items">
              <div v-for="g in groupedItems" :key="g.cat">
                <div class="gt">{{ g.label }}</div>
                <el-checkbox-group v-model="form.itemIds"><el-checkbox v-for="i in g.items" :key="i.itemId" :value="i.itemId" :disabled="!i.enabled">{{ i.name }}<span v-if="i.sqlBearing" class="sqltag">SQL</span></el-checkbox></el-checkbox-group>
              </div>
            </div>
          </div>
        </el-form-item>
      </el-form>
      <template #footer><el-button @click="dlg = false">取消</el-button><el-button v-if="canWrite" type="primary" @click="save">保存</el-button></template>
    </el-dialog>

    <el-dialog v-model="runDlg" :title="`立即巡检：${runTpl?.name || ''}`" width="620px">
      <el-form label-width="90px">
        <el-form-item label="范围"><el-radio-group v-model="runMode"><el-radio value="all">全部纳管实例</el-radio><el-radio value="pick">指定实例</el-radio></el-radio-group></el-form-item>
        <el-form-item v-if="runMode === 'pick'" label="实例">
          <el-select v-model="runInst" multiple filterable style="width:100%"><el-option v-for="i in meta.scope.instances" :key="i.instanceId" :label="`${i.name}（${i.dbType} ${i.host}）`" :value="i.instanceId" /></el-select>
        </el-form-item>
      </el-form>
      <template #footer><el-button @click="runDlg = false">取消</el-button><el-button type="primary" :loading="running" @click="doRun">开始巡检</el-button></template>
    </el-dialog>
  </div>
</template>
<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { dbInspectApi as api } from '@/api/index.js'
import { useAuthStore } from '@/stores/auth.js'
import { KIND } from './common.js'

const props = defineProps({ meta: { type: Object, required: true } })
const emit = defineEmits(['goto'])
const auth = useAuthStore()
const canWrite = computed(() => ['ADMIN', 'DBA'].includes(auth.user?.role))
const canRun = computed(() => ['ADMIN', 'DBA', 'OPS'].includes(auth.user?.role))
const famLabel = c => props.meta.families.find(x => x.value === c)?.label || c
const list = ref([]); const loading = ref(false); const items = ref([])
async function load() { loading.value = true; try { list.value = (await api.templates()).data } finally { loading.value = false } }
async function toggle(row, v) {
  const t = (await api.template(row.templateId)).data
  await api.updateTemplate(row.templateId, { name: t.name, kind: t.kind, description: t.description, families: t.families, alertRules: t.alertRules, itemIds: t.items.map(i => i.itemId), enabled: v })
  row.enabled = v
}

const dlg = ref(false); const kw = ref('')
const form = reactive({ templateId: null, name: '', kind: 'DAILY', description: '', families: [], alertRules: [], itemIds: [] })
const groupedItems = computed(() => {
  const k = kw.value.trim().toLowerCase()
  return props.meta.categories.map(c => ({ cat: c.value, label: c.label, items: items.value.filter(i => i.category === c.value && (!k || `${i.name}${i.code}`.toLowerCase().includes(k))) })).filter(g => g.items.length)
})
function selectAllVisible() { const s = new Set(form.itemIds); groupedItems.value.forEach(g => g.items.forEach(i => i.enabled && s.add(i.itemId))); form.itemIds = [...s] }
async function openEdit(row) {
  if (!items.value.length) items.value = (await api.items()).data
  if (row) {
    const t = (await api.template(row.templateId)).data
    Object.assign(form, { templateId: t.templateId, name: t.name, kind: t.kind, description: t.description || '', families: t.families || [], alertRules: t.alertRules || [], itemIds: t.items.map(i => i.itemId) })
  } else Object.assign(form, { templateId: null, name: '', kind: 'DAILY', description: '', families: [], alertRules: [], itemIds: [] })
  dlg.value = true
}
async function save() {
  const d = { name: form.name, kind: form.kind, description: form.description, families: form.families, alertRules: form.alertRules, itemIds: form.itemIds, enabled: true }
  if (!d.name.trim()) return ElMessage.warning('请填写模板名称')
  if (!d.itemIds.length) return ElMessage.warning('请至少选择一个检查项')
  if (form.templateId) await api.updateTemplate(form.templateId, d); else await api.createTemplate(d)
  ElMessage.success('已保存'); dlg.value = false; load()
}
async function del(row) { await ElMessageBox.confirm(`删除模板「${row.name}」？`, '确认'); await api.deleteTemplate(row.templateId); load() }

const runDlg = ref(false); const runTpl = ref(null); const runMode = ref('all'); const runInst = ref([]); const running = ref(false)
function openRun(row) { runTpl.value = row; runMode.value = 'all'; runInst.value = []; runDlg.value = true }
async function doRun() {
  running.value = true
  try {
    const r = await api.startRun({ templateId: runTpl.value.templateId, instanceIds: runMode.value === 'pick' ? runInst.value : undefined })
    ElMessage.success(`已开始巡检 ${r.data.total} 个实例`); runDlg.value = false; emit('goto', 'runs', r.data.runId)
  } finally { running.value = false }
}
onMounted(load)
</script>
<style scoped>
.bar { display: flex; gap: 8px; margin-bottom: 10px; align-items: center; flex-wrap: wrap; }
.sub { color: #8a94a3; font-size: 12px; }
.items { max-height: 320px; overflow: auto; border: 1px solid #e4e7ed; border-radius: 4px; padding: 6px 10px; }
.gt { font-weight: 600; margin: 6px 0 2px; color: #1f3a5f; }
.sqltag { font-size: 10px; color: #e6a23c; border: 1px solid #e6a23c; border-radius: 3px; padding: 0 3px; margin-left: 4px; }
</style>
