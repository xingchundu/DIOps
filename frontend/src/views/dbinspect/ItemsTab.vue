<template>
  <div>
    <div class="bar">
      <el-select v-model="f.category" placeholder="分类" clearable style="width:140px" @change="load">
        <el-option v-for="c in meta.categories" :key="c.value" :label="c.label" :value="c.value" />
      </el-select>
      <el-select v-model="f.family" placeholder="数据库类型" clearable style="width:140px" @change="load">
        <el-option v-for="c in meta.families" :key="c.value" :label="c.label" :value="c.value" />
      </el-select>
      <el-input v-model="f.keyword" placeholder="名称 / 编码" clearable style="width:200px" @keyup.enter="load" @clear="load" />
      <el-button @click="load">查询</el-button>
      <el-button v-if="canWrite" type="primary" @click="openCreate">新建检查项</el-button>
      <el-popconfirm v-if="canWrite" title="重新同步内置检查项？您修改过的阈值/建议/启停不会被覆盖。" @confirm="reseed"><template #reference><el-button>同步内置项</el-button></template></el-popconfirm>
    </div>
    <el-table :data="list" v-loading="loading" border size="small" stripe>
      <el-table-column label="检查项" min-width="220">
        <template #default="{ row }"><div class="nm">{{ row.name }}<el-tag v-if="row.sqlBearing" size="small" type="warning" effect="plain" style="margin-left:6px">含 SQL ID</el-tag></div><div class="sub">{{ row.code }}</div></template>
      </el-table-column>
      <el-table-column label="分类" width="100"><template #default="{ row }">{{ catLabel(row.category) }}</template></el-table-column>
      <el-table-column label="规则" width="110"><template #default="{ row }">{{ RULE_TYPE[row.ruleType] || row.ruleType }}</template></el-table-column>
      <el-table-column label="预警 / 严重" width="120"><template #default="{ row }">{{ row.warn ?? '—' }} / {{ row.crit ?? '—' }}</template></el-table-column>
      <el-table-column label="适用数据库" min-width="200">
        <template #default="{ row }"><el-tag v-for="x in row.families" :key="x" size="small" style="margin:0 4px 2px 0">{{ famLabel(x) }}</el-tag></template>
      </el-table-column>
      <el-table-column label="阈值范围" width="90"><template #default="{ row }">{{ row.overrideCount ? `${row.overrideCount} 条` : '—' }}</template></el-table-column>
      <el-table-column label="启用" width="70"><template #default="{ row }"><el-switch :model-value="row.enabled" :disabled="!canWrite" @change="v => toggle(row, v)" /></template></el-table-column>
      <el-table-column label="操作" width="90" fixed="right"><template #default="{ row }"><el-button link type="primary" @click="openDetail(row)">详情</el-button></template></el-table-column>
    </el-table>

    <el-drawer v-model="dlg" :title="cur ? cur.name : ''" size="760px" destroy-on-close>
      <template v-if="cur">
        <el-descriptions :column="2" border size="small">
          <el-descriptions-item label="编码">{{ cur.code }}</el-descriptions-item>
          <el-descriptions-item label="分类">{{ catLabel(cur.category) }}</el-descriptions-item>
          <el-descriptions-item label="规则类型">{{ RULE_TYPE[cur.ruleType] || cur.ruleType }}</el-descriptions-item>
          <el-descriptions-item label="内置">{{ cur.builtin ? '是' : '自定义' }}</el-descriptions-item>
        </el-descriptions>
        <el-form :model="form" label-width="90px" style="margin-top:14px" :disabled="!canWrite">
          <el-form-item label="名称"><el-input v-model="form.name" /></el-form-item>
          <el-form-item label="说明"><el-input v-model="form.description" type="textarea" :rows="2" /></el-form-item>
          <el-form-item label="默认阈值">
            预警 <el-input v-model="form.warn" style="width:110px;margin:0 12px 0 6px" /> 严重 <el-input v-model="form.crit" style="width:110px;margin-left:6px" />
            <span class="sub" style="margin-left:10px">各数据库的单位/默认值见下方「采集实现」；此处留空则用采集实现里的值</span>
          </el-form-item>
          <el-form-item label="整改建议"><el-input v-model="form.advice" type="textarea" :rows="3" /></el-form-item>
          <el-form-item><el-button type="primary" @click="saveBase">保存基本信息</el-button></el-form-item>
        </el-form>

        <el-tabs>
          <el-tab-pane label="采集实现（按数据库）">
            <el-alert type="info" :closable="false" show-icon style="margin-bottom:8px"
              title="采集 SQL 只读取数据，判定由规则引擎完成。结果列约定：OBJ（对象）、VAL（判定值）、TXT（文本）；SQL 类检查项还需返回 SQL_ID / SQL_TEXT 等。可用占位符 {{TOPN}} {{DAYS}} {{MINEXECS}}。" />
            <el-collapse accordion>
              <el-collapse-item v-for="im in cur.impls" :key="im.family" :name="im.family">
                <template #title>
                  <b>{{ famLabel(im.family) }}</b>
                  <el-tag v-if="im.isCustom" size="small" type="warning" style="margin-left:8px">已自定义</el-tag>
                  <el-tag v-if="im.adaptive" size="small" style="margin-left:8px">自适应列探测</el-tag>
                  <el-tag v-if="im.dbTypes" size="small" type="info" style="margin-left:8px">仅 {{ im.dbTypes.join('/') }}</el-tag>
                  <span class="sub" style="margin-left:10px">阈值 {{ im.warn ?? '—' }} / {{ im.crit ?? '—' }} {{ im.unit || '' }}</span>
                </template>
                <el-input v-model="sqlEdit[im.family]" type="textarea" :rows="9" class="mono" :disabled="!canWrite || !!im.adaptive" />
                <div v-if="im.adaptive" class="sub" style="margin:6px 0">此实现按目标库实际存在的列动态生成查询（达梦各版本 V$SQL_STAT 列不同），不可直接编辑 SQL；可在上方「阈值范围」调整阈值。</div>
                <div v-if="canWrite && !im.adaptive" style="margin-top:8px">
                  <el-button type="primary" size="small" @click="saveImpl(im)">保存</el-button>
                  <el-button v-if="cur.builtin" size="small" @click="resetImpl(im)">恢复默认</el-button>
                  <el-button v-if="im.isCustom && !cur.builtin" size="small" type="danger" plain @click="delImpl(im)">删除</el-button>
                </div>
              </el-collapse-item>
            </el-collapse>
            <div v-if="canWrite && missingFamilies.length" style="margin-top:10px">
              <el-button v-for="m in missingFamilies" :key="m.value" size="small" @click="addImpl(m.value)">+ 添加 {{ m.label }} 实现</el-button>
            </div>
          </el-tab-pane>
          <el-tab-pane :label="`阈值与范围（${cur.overrides.length}）`">
            <el-table :data="cur.overrides" size="small" border>
              <el-table-column label="范围" width="110"><template #default="{ row }">{{ scopeLabel[row.scopeType] }}</template></el-table-column>
              <el-table-column prop="scopeValue" label="值" />
              <el-table-column label="预警"><template #default="{ row }">{{ row.warn ?? '继承' }}</template></el-table-column>
              <el-table-column label="严重"><template #default="{ row }">{{ row.crit ?? '继承' }}</template></el-table-column>
              <el-table-column label="状态" width="80"><template #default="{ row }">{{ row.enabled ? '启用' : '关闭该项' }}</template></el-table-column>
              <el-table-column v-if="canWrite" label="" width="70"><template #default="{ row }"><el-button link type="danger" @click="delOv(row)">删除</el-button></template></el-table-column>
            </el-table>
            <el-form v-if="canWrite" inline style="margin-top:10px">
              <el-form-item><el-select v-model="ov.scopeType" style="width:120px" @change="ov.scopeValue = ''"><el-option v-for="(l, k) in scopeLabel" :key="k" :label="l" :value="k" /></el-select></el-form-item>
              <el-form-item>
                <el-select v-model="ov.scopeValue" filterable allow-create style="width:200px" placeholder="范围值">
                  <el-option v-for="o in scopeOpts" :key="o.v" :label="o.l" :value="o.v" />
                </el-select>
              </el-form-item>
              <el-form-item><el-input v-model="ov.warn" placeholder="预警" style="width:90px" /></el-form-item>
              <el-form-item><el-input v-model="ov.crit" placeholder="严重" style="width:90px" /></el-form-item>
              <el-form-item><el-checkbox v-model="ov.disable">关闭该项</el-checkbox></el-form-item>
              <el-form-item><el-button type="primary" @click="addOv">添加 / 覆盖</el-button></el-form-item>
            </el-form>
            <div class="sub">优先级：实例 &gt; 业务线 &gt; 环境 &gt; 数据库类型 &gt; 默认。例如：生产环境表空间预警 80/90，测试环境放宽到 90/95。</div>
          </el-tab-pane>
        </el-tabs>
      </template>
    </el-drawer>

    <el-dialog v-model="createDlg" title="新建检查项" width="560px">
      <el-form :model="nf" label-width="90px">
        <el-form-item label="编码"><el-input v-model="nf.code" placeholder="如 custom.my_check（小写）" /></el-form-item>
        <el-form-item label="名称"><el-input v-model="nf.name" /></el-form-item>
        <el-form-item label="分类"><el-select v-model="nf.category"><el-option v-for="c in meta.categories" :key="c.value" :label="c.label" :value="c.value" /></el-select></el-form-item>
        <el-form-item label="规则类型"><el-select v-model="nf.ruleType"><el-option v-for="(l, k) in RULE_TYPE" :key="k" :label="l" :value="k" /></el-select></el-form-item>
        <el-form-item label="方向" v-if="nf.ruleType === 'THRESHOLD'"><el-radio-group v-model="nf.direction"><el-radio value="HIGH">越高越差</el-radio><el-radio value="LOW">越低越差</el-radio></el-radio-group></el-form-item>
        <el-form-item label="阈值" v-if="nf.ruleType === 'THRESHOLD'">预警 <el-input v-model="nf.warn" style="width:100px;margin:0 10px 0 6px" /> 严重 <el-input v-model="nf.crit" style="width:100px;margin-left:6px" /></el-form-item>
        <el-form-item label="说明"><el-input v-model="nf.description" type="textarea" :rows="2" /></el-form-item>
        <el-form-item label="整改建议"><el-input v-model="nf.advice" type="textarea" :rows="2" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="createDlg = false">取消</el-button><el-button type="primary" @click="create">创建后添加采集实现</el-button></template>
    </el-dialog>
  </div>
</template>
<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { dbInspectApi as api } from '@/api/index.js'
import { useAuthStore } from '@/stores/auth.js'
import { RULE_TYPE } from './common.js'

const props = defineProps({ meta: { type: Object, required: true } })
const auth = useAuthStore()
const canWrite = computed(() => ['ADMIN', 'DBA'].includes(auth.user?.role))
const f = reactive({ category: '', family: '', keyword: '' })
const list = ref([]); const loading = ref(false)
const catLabel = c => props.meta.categories.find(x => x.value === c)?.label || c
const famLabel = c => props.meta.families.find(x => x.value === c)?.label || c
const scopeLabel = { DB_TYPE: '数据库类型', ENV: '环境', BIZ_LINE: '业务线', INSTANCE: '实例' }

async function load() {
  loading.value = true
  try { list.value = (await api.items({ category: f.category || undefined, family: f.family || undefined, keyword: f.keyword || undefined })).data } finally { loading.value = false }
}
async function reseed() { await api.reseed(); ElMessage.success('已同步'); load() }
async function toggle(row, v) { await api.updateItem(row.itemId, { enabled: v }); row.enabled = v }

const dlg = ref(false); const cur = ref(null); const form = reactive({ name: '', description: '', warn: '', crit: '', advice: '' })
const sqlEdit = reactive({})
const ov = reactive({ scopeType: 'ENV', scopeValue: '', warn: '', crit: '', disable: false })
async function openDetail(row) {
  cur.value = (await api.item(row.itemId)).data
  Object.assign(form, { name: cur.value.name, description: cur.value.description || '', warn: cur.value.warn ?? '', crit: cur.value.crit ?? '', advice: cur.value.advice || '' })
  Object.keys(sqlEdit).forEach(k => delete sqlEdit[k])
  cur.value.impls.forEach(i => { sqlEdit[i.family] = i.sql })
  dlg.value = true
}
async function refreshCur() { const id = cur.value.itemId; cur.value = (await api.item(id)).data; cur.value.impls.forEach(i => { sqlEdit[i.family] = i.sql }) ; load() }
async function saveBase() { await api.updateItem(cur.value.itemId, { ...form }); ElMessage.success('已保存'); load() }
const missingFamilies = computed(() => cur.value ? props.meta.families.filter(m => !cur.value.impls.some(i => i.family === m.value)) : [])
async function saveImpl(im) {
  await api.saveImpl(cur.value.itemId, im.family, { sql: sqlEdit[im.family], fallback: im.fallback, map: im.map, unit: im.unit, warn: im.warn, crit: im.crit, enabled: im.enabled })
  ElMessage.success('已保存（后续巡检生效）'); refreshCur()
}
async function resetImpl(im) { await ElMessageBox.confirm('恢复为内置默认采集 SQL？', '确认'); await api.resetImpl(cur.value.itemId, im.family); ElMessage.success('已恢复'); refreshCur() }
async function delImpl(im) { await ElMessageBox.confirm('删除该数据库的采集实现？', '确认'); await api.deleteImpl(cur.value.itemId, im.family); refreshCur() }
async function addImpl(family) {
  await api.saveImpl(cur.value.itemId, family, { sql: 'SELECT \'-\' AS OBJ, 0 AS VAL FROM DUAL', enabled: true })
  ElMessage.info('已添加模板 SQL，请修改后保存'); refreshCur()
}
const scopeOpts = computed(() => {
  const s = props.meta.scope || {}
  if (ov.scopeType === 'DB_TYPE') return (s.dbTypes || []).map(v => ({ v, l: v }))
  if (ov.scopeType === 'ENV') return (s.envs || []).map(v => ({ v, l: v }))
  if (ov.scopeType === 'BIZ_LINE') return (s.bizLines || []).map(v => ({ v, l: v }))
  return (s.instances || []).map(i => ({ v: String(i.instanceId), l: `${i.name}（${i.dbType}）` }))
})
async function addOv() {
  await api.saveOverride(cur.value.itemId, { scopeType: ov.scopeType, scopeValue: ov.scopeValue, warn: ov.warn, crit: ov.crit, enabled: !ov.disable })
  Object.assign(ov, { scopeValue: '', warn: '', crit: '', disable: false }); refreshCur()
}
async function delOv(r) { await api.deleteOverride(r.thrId); refreshCur() }

const createDlg = ref(false); const nf = reactive({ code: '', name: '', category: 'PERFORMANCE', ruleType: 'THRESHOLD', direction: 'HIGH', warn: '', crit: '', description: '', advice: '' })
function openCreate() { createDlg.value = true }
async function create() {
  const rule = { type: nf.ruleType, ...(nf.ruleType === 'THRESHOLD' ? { direction: nf.direction } : {}) }
  const r = await api.createItem({ code: nf.code, name: nf.name, category: nf.category, rule, warn: nf.warn === '' ? null : nf.warn, crit: nf.crit === '' ? null : nf.crit, description: nf.description, advice: nf.advice })
  createDlg.value = false; await load()
  const id = r.data?.itemId ?? r.data
  if (id) openDetail({ itemId: id })
}
onMounted(load)
</script>
<style scoped>
.bar { display: flex; gap: 8px; margin-bottom: 10px; flex-wrap: wrap; }
.nm { font-weight: 500; } .sub { color: #8a94a3; font-size: 12px; }
.mono :deep(textarea) { font-family: Consolas, Menlo, monospace; font-size: 12px; }
</style>
