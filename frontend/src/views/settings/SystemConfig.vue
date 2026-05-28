<template>
  <div class="page-container">
    <div class="card" style="margin-bottom:16px">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div>
          <span style="font-size:16px;font-weight:600">系统配置</span>
          <span style="font-size:12px;color:#909399;margin-left:12px">修改后即时生效，无需重启服务</span>
        </div>
        <el-button size="small" icon="Refresh" :loading="loading" @click="loadConfigs">刷新</el-button>
      </div>
    </div>

    <div v-loading="loading">
      <div v-for="cat in categories" :key="cat" class="card" style="margin-bottom:16px">
        <div class="cat-header">
          <el-icon><Setting /></el-icon>
          <span>{{ cat }}</span>
        </div>
        <el-table :data="configsByCategory(cat)" border size="small">
          <el-table-column prop="LABEL" label="配置项" width="200" />
          <el-table-column prop="DESCRIPTION" label="说明" min-width="280" show-overflow-tooltip />
          <el-table-column label="当前值" width="200">
            <template #default="{ row }">
              <div v-if="editingKey === row.CONFIG_KEY" style="display:flex;gap:4px">
                <el-input-number v-if="row.VALUE_TYPE === 'NUMBER'" v-model="editValue" size="small"
                  :min="row.MIN_VAL" :max="row.MAX_VAL" controls-position="right" style="width:140px" />
                <el-input v-else v-model="editValue" size="small" style="width:140px" />
                <el-button size="small" type="primary" link @click="saveConfig(row)"><el-icon><Check /></el-icon></el-button>
                <el-button size="small" type="info" link @click="editingKey = null"><el-icon><Close /></el-icon></el-button>
              </div>
              <div v-else style="display:flex;align-items:center;gap:8px">
                <span :class="{ 'val-changed': String(row.CONFIG_VALUE) !== String(row.DEFAULT_VALUE) }">
                  {{ row.CONFIG_VALUE }}
                </span>
                <el-button size="small" type="primary" link @click="startEdit(row)"><el-icon><Edit /></el-icon></el-button>
                <el-button v-if="String(row.CONFIG_VALUE) !== String(row.DEFAULT_VALUE)"
                  size="small" type="warning" link @click="resetConfig(row)" title="重置为默认值">
                  <el-icon><RefreshLeft /></el-icon>
                </el-button>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="默认值" width="120">
            <template #default="{ row }">
              <span style="color:#909399">{{ row.DEFAULT_VALUE }}</span>
            </template>
          </el-table-column>
          <el-table-column v-if="cat === '保留策略'" label="范围" width="120">
            <template #default="{ row }">
              <span v-if="row.MIN_VAL != null" style="font-size:11px;color:#909399">{{ row.MIN_VAL }} ~ {{ row.MAX_VAL }}</span>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { systemConfigApi } from '@/api/index.js'
import { ElMessage, ElMessageBox } from 'element-plus'

const loading = ref(false)
const configs = ref([])
const editingKey = ref(null)
const editValue = ref(null)

const categories = computed(() => {
  const cats = [...new Set(configs.value.map(c => c.CATEGORY).filter(Boolean))]
  return cats
})

function configsByCategory(cat) {
  return configs.value.filter(c => c.CATEGORY === cat)
}

async function loadConfigs() {
  loading.value = true
  try {
    const r = await systemConfigApi.getAll()
    configs.value = r.data || []
  } catch (e) { ElMessage.error(e.message) }
  loading.value = false
}

function startEdit(row) {
  editingKey.value = row.CONFIG_KEY
  editValue.value = row.VALUE_TYPE === 'NUMBER' ? Number(row.CONFIG_VALUE) : row.CONFIG_VALUE
}

async function saveConfig(row) {
  if (editValue.value === null || editValue.value === undefined || editValue.value === '') {
    return ElMessage.warning('值不能为空')
  }
  try {
    await systemConfigApi.update(row.CONFIG_KEY, editValue.value)
    ElMessage.success('已保存')
    editingKey.value = null
    await loadConfigs()
  } catch (e) { ElMessage.error(e.message) }
}

async function resetConfig(row) {
  try {
    await ElMessageBox.confirm(`将「${row.LABEL}」重置为默认值 ${row.DEFAULT_VALUE}？`, '确认')
    await systemConfigApi.reset(row.CONFIG_KEY)
    ElMessage.success('已重置')
    await loadConfigs()
  } catch {}
}

onMounted(loadConfigs)
</script>

<style scoped>
.cat-header {
  display: flex; align-items: center; gap: 8px;
  font-size: 14px; font-weight: 600; margin-bottom: 12px;
  color: var(--agent-text, #303133);
}
.val-changed { color: #e6a23c; font-weight: 600; }
</style>
