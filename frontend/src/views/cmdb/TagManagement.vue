<template>
  <div class="page-container">
    <!-- 统计卡片 -->
    <el-row :gutter="16" class="mb-16">
      <el-col :span="6" v-for="c in statCards" :key="c.label">
        <div class="stat-card" :style="{ borderLeftColor: c.color }">
          <div class="stat-num" :style="{ color: c.color }">{{ c.val }}</div>
          <div class="stat-lbl">{{ c.label }}</div>
        </div>
      </el-col>
    </el-row>

    <el-row :gutter="16">
      <!-- 左侧：标签分组 + 标签管理 -->
      <el-col :span="10">
        <!-- 标签分组 -->
        <div class="card">
          <div class="card-title" style="justify-content:space-between">
            <span>标签分组</span>
            <el-button size="small" type="primary" icon="Plus" @click="openGroupDialog()">新增分组</el-button>
          </div>
          <el-table :data="groups" stripe size="small" v-loading="groupsLoading" highlight-current-row
            @current-change="onGroupSelect" height="280">
            <el-table-column prop="GROUP_NAME" label="分组名称" min-width="100" />
            <el-table-column prop="GROUP_CODE" label="编码" width="100" />
            <el-table-column label="标签数" width="70">
              <template #default="{ row }">{{ row.TAG_COUNT ?? 0 }}</template>
            </el-table-column>
            <el-table-column label="状态" width="70">
              <template #default="{ row }">
                <el-tag :type="row.STATUS === 'ACTIVE' ? 'success' : 'info'" size="small">{{ row.STATUS === 'ACTIVE' ? '启用' : '停用' }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="100" fixed="right">
              <template #default="{ row }">
                <el-button link type="primary" size="small" @click.stop="openGroupDialog(row)">编辑</el-button>
                <el-button link type="danger" size="small" @click.stop="deleteGroup(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
        </div>

        <!-- 标签列表 -->
        <div class="card" style="margin-top:16px">
          <div class="card-title" style="justify-content:space-between">
            <span>{{ selectedGroup ? selectedGroup.GROUP_NAME + ' - ' : '' }}标签列表</span>
            <el-button size="small" type="primary" icon="Plus" :disabled="!selectedGroup" @click="openTagDialog()">新增标签</el-button>
          </div>
          <el-table :data="tags" stripe size="small" v-loading="tagsLoading" height="300">
            <el-table-column label="标签" min-width="120">
              <template #default="{ row }">
                <el-tag :color="row.COLOR" style="color:#fff;border:none" size="small" disable-transitions>{{ row.TAG_NAME }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="GROUP_NAME" label="分组" width="80" />
            <el-table-column label="使用数" width="70">
              <template #default="{ row }">{{ row.USAGE_COUNT ?? 0 }}</template>
            </el-table-column>
            <el-table-column label="状态" width="70">
              <template #default="{ row }">
                <el-tag :type="row.STATUS === 'ACTIVE' ? 'success' : 'info'" size="small">{{ row.STATUS === 'ACTIVE' ? '启用' : '停用' }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="100" fixed="right">
              <template #default="{ row }">
                <el-button link type="primary" size="small" @click="openTagDialog(row)">编辑</el-button>
                <el-button link type="danger" size="small" @click="deleteTag(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </el-col>

      <!-- 右侧：按标签筛选实例 + 批量操作 -->
      <el-col :span="14">
        <div class="card">
          <div class="card-title" style="justify-content:space-between">
            <span>按标签筛选实例</span>
            <div style="display:flex;gap:8px;align-items:center">
              <el-select v-model="filterTagIds" multiple filterable collapse-tags placeholder="选择标签筛选" style="width:300px" @change="filterByTags">
                <el-option-group v-for="g in groups" :key="g.GROUP_ID" :label="g.GROUP_NAME">
                  <el-option v-for="t in allTags.filter(x => x.GROUP_ID === g.GROUP_ID)" :key="t.TAG_ID"
                    :label="t.TAG_NAME" :value="t.TAG_ID">
                    <el-tag :color="t.COLOR" style="color:#fff;border:none" size="small" disable-transitions>{{ t.TAG_NAME }}</el-tag>
                  </el-option>
                </el-option-group>
              </el-select>
              <el-select v-model="matchMode" style="width:100px" @change="filterByTags">
                <el-option label="任意匹配" value="ANY" />
                <el-option label="全部匹配" value="ALL" />
              </el-select>
            </div>
          </div>

          <!-- 批量操作栏 -->
          <div v-if="selectedInstances.length" style="padding:8px 0;display:flex;gap:8px;align-items:center">
            <span style="font-size:13px;color:#909399">已选 {{ selectedInstances.length }} 个实例</span>
            <el-select v-model="batchTagIds" multiple collapse-tags placeholder="选择要批量打标的标签" style="width:260px">
              <el-option-group v-for="g in groups" :key="g.GROUP_ID" :label="g.GROUP_NAME">
                <el-option v-for="t in allTags.filter(x => x.GROUP_ID === g.GROUP_ID)" :key="t.TAG_ID"
                  :label="t.TAG_NAME" :value="t.TAG_ID" />
              </el-option-group>
            </el-select>
            <el-button type="primary" size="small" :disabled="!batchTagIds.length" @click="batchAssign">批量打标</el-button>
            <el-button type="danger" size="small" :disabled="!batchTagIds.length" @click="batchRemove">批量移除</el-button>
          </div>

          <el-table :data="filteredInstances" stripe size="small" v-loading="filterLoading" height="420"
            @selection-change="onInstSelect" ref="instTableRef">
            <el-table-column type="selection" width="45" />
            <el-table-column prop="INSTANCE_NAME" label="实例名" min-width="130">
              <template #default="{ row }">
                <el-link type="primary" @click="$router.push(`/monitor/${row.INSTANCE_ID}`)">{{ row.INSTANCE_NAME }}</el-link>
              </template>
            </el-table-column>
            <el-table-column prop="DB_TYPE" label="类型" width="100">
              <template #default="{ row }"><el-tag size="small">{{ row.DB_TYPE }}</el-tag></template>
            </el-table-column>
            <el-table-column prop="HOST_IP" label="主机" width="130" />
            <el-table-column prop="ENVIRONMENT" label="环境" width="80" />
            <el-table-column prop="BIZ_LINE" label="业务线" width="100" />
            <el-table-column label="状态" width="80">
              <template #default="{ row }">
                <span :style="{ color: row.STATUS === 'RUNNING' ? '#52c41a' : row.STATUS === 'ERROR' ? '#ff4d4f' : '#faad14' }">{{ row.STATUS }}</span>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="80" fixed="right">
              <template #default="{ row }">
                <el-button link type="primary" size="small" @click="openInstanceTagDialog(row)">打标</el-button>
              </template>
            </el-table-column>
          </el-table>
          <div style="padding:12px 0;text-align:right">
            <el-pagination v-model:current-page="filterPage" :page-size="20" :total="filterTotal"
              layout="total,prev,pager,next" @current-change="filterByTags" small />
          </div>
        </div>
      </el-col>
    </el-row>

    <!-- 分组编辑弹窗 -->
    <el-dialog v-model="groupDialogVisible" :title="editingGroup ? '编辑分组' : '新增分组'" width="440px">
      <el-form :model="groupForm" label-width="80px">
        <el-form-item label="分组名称" required>
          <el-input v-model="groupForm.groupName" placeholder="如: 业务线、环境" />
        </el-form-item>
        <el-form-item label="分组编码" required>
          <el-input v-model="groupForm.groupCode" placeholder="如: BIZ_LINE、ENV" :disabled="!!editingGroup" />
        </el-form-item>
        <el-form-item label="描述">
          <el-input v-model="groupForm.description" type="textarea" :rows="2" />
        </el-form-item>
        <el-form-item label="排序">
          <el-input-number v-model="groupForm.sortOrder" :min="0" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="groupDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="groupSaving" @click="saveGroup">保存</el-button>
      </template>
    </el-dialog>

    <!-- 标签编辑弹窗 -->
    <el-dialog v-model="tagDialogVisible" :title="editingTag ? '编辑标签' : '新增标签'" width="440px">
      <el-form :model="tagForm" label-width="80px">
        <el-form-item label="所属分组">
          <el-input :value="selectedGroup?.GROUP_NAME" disabled />
        </el-form-item>
        <el-form-item label="标签名称" required>
          <el-input v-model="tagForm.tagName" placeholder="如: 核心业务" />
        </el-form-item>
        <el-form-item label="标签颜色">
          <el-color-picker v-model="tagForm.color" :predefine="presetColors" />
        </el-form-item>
        <el-form-item label="描述">
          <el-input v-model="tagForm.description" type="textarea" :rows="2" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="tagDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="tagSaving" @click="saveTag">保存</el-button>
      </template>
    </el-dialog>

    <!-- 实例打标弹窗 -->
    <el-dialog v-model="instTagDialogVisible" :title="`为实例打标: ${instTagTarget?.INSTANCE_NAME}`" width="500px">
      <div style="margin-bottom:12px">
        <span style="font-size:13px;color:#909399">选择标签（可多选）：</span>
      </div>
      <div v-for="g in groups" :key="g.GROUP_ID" style="margin-bottom:12px">
        <div style="font-size:13px;font-weight:600;margin-bottom:4px">{{ g.GROUP_NAME }}</div>
        <div style="display:flex;flex-wrap:wrap;gap:6px">
          <el-check-tag v-for="t in allTags.filter(x => x.GROUP_ID === g.GROUP_ID)" :key="t.TAG_ID"
            :checked="instTagIds.includes(t.TAG_ID)"
            @change="checked => toggleInstTag(t.TAG_ID, checked)"
            :style="instTagIds.includes(t.TAG_ID) ? { background: t.COLOR, color: '#fff', borderColor: t.COLOR } : {}">
            {{ t.TAG_NAME }}
          </el-check-tag>
        </div>
      </div>
      <template #footer>
        <el-button @click="instTagDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="instTagSaving" @click="saveInstanceTags">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { tagApi, cmdbApi } from '@/api/index.js'
import { ElMessage, ElMessageBox } from 'element-plus'

const presetColors = ['#f5222d', '#fa541c', '#fa8c16', '#faad14', '#52c41a', '#1890ff', '#13c2c2', '#722ed1', '#595959']

// ─── 统计 ──────────────────────────────────────────────────
const statsData = ref({})
const statCards = computed(() => [
  { label: '标签分组', val: statsData.value.totalGroups ?? '-', color: '#1890ff' },
  { label: '标签总数', val: statsData.value.totalTags ?? '-', color: '#52c41a' },
  { label: '标签关联数', val: statsData.value.totalAssignments ?? '-', color: '#722ed1' },
  { label: '未标记实例', val: statsData.value.untaggedInstances ?? '-', color: '#ff4d4f' },
])

// ─── 标签分组 ──────────────────────────────────────────────
const groups = ref([])
const groupsLoading = ref(false)
const selectedGroup = ref(null)
const groupDialogVisible = ref(false)
const editingGroup = ref(null)
const groupSaving = ref(false)
const groupForm = reactive({ groupName: '', groupCode: '', description: '', sortOrder: 0 })

async function loadGroups() {
  groupsLoading.value = true
  try {
    const r = await tagApi.groups()
    if (r.code === 200) groups.value = r.data || []
  } finally { groupsLoading.value = false }
}

function onGroupSelect(row) {
  selectedGroup.value = row
  if (row) loadTags(row.GROUP_ID)
}

function openGroupDialog(row) {
  editingGroup.value = row || null
  if (row) {
    Object.assign(groupForm, { groupName: row.GROUP_NAME, groupCode: row.GROUP_CODE, description: row.DESCRIPTION, sortOrder: row.SORT_ORDER })
  } else {
    Object.assign(groupForm, { groupName: '', groupCode: '', description: '', sortOrder: 0 })
  }
  groupDialogVisible.value = true
}

async function saveGroup() {
  if (!groupForm.groupName || !groupForm.groupCode) return ElMessage.warning('请填写名称和编码')
  groupSaving.value = true
  try {
    if (editingGroup.value) {
      await tagApi.updateGroup(editingGroup.value.GROUP_ID, groupForm)
    } else {
      await tagApi.createGroup(groupForm)
    }
    ElMessage.success('保存成功')
    groupDialogVisible.value = false
    loadGroups(); loadStats()
  } catch (e) { ElMessage.error(e.message) }
  finally { groupSaving.value = false }
}

async function deleteGroup(row) {
  await ElMessageBox.confirm(`确定删除分组 "${row.GROUP_NAME}"？其下所有标签将同时删除。`, '删除确认', { type: 'warning' })
  try {
    await tagApi.deleteGroup(row.GROUP_ID)
    ElMessage.success('删除成功')
    if (selectedGroup.value?.GROUP_ID === row.GROUP_ID) selectedGroup.value = null
    loadGroups(); loadAllTags(); loadStats()
  } catch (e) { ElMessage.error(e.message) }
}

// ─── 标签 ──────────────────────────────────────────────────
const tags = ref([])
const allTags = ref([])
const tagsLoading = ref(false)
const tagDialogVisible = ref(false)
const editingTag = ref(null)
const tagSaving = ref(false)
const tagForm = reactive({ tagName: '', color: '#1890ff', description: '' })

async function loadTags(groupId) {
  tagsLoading.value = true
  try {
    const r = await tagApi.list({ groupId })
    if (r.code === 200) tags.value = r.data || []
  } finally { tagsLoading.value = false }
}

async function loadAllTags() {
  try { const r = await tagApi.list(); if (r.code === 200) allTags.value = r.data || [] } catch {}
}

function openTagDialog(row) {
  editingTag.value = row || null
  if (row) {
    Object.assign(tagForm, { tagName: row.TAG_NAME, color: row.COLOR || '#1890ff', description: row.DESCRIPTION })
  } else {
    Object.assign(tagForm, { tagName: '', color: '#1890ff', description: '' })
  }
  tagDialogVisible.value = true
}

async function saveTag() {
  if (!tagForm.tagName) return ElMessage.warning('请输入标签名称')
  tagSaving.value = true
  try {
    if (editingTag.value) {
      await tagApi.updateTag(editingTag.value.TAG_ID, tagForm)
    } else {
      await tagApi.createTag({ ...tagForm, groupId: selectedGroup.value.GROUP_ID })
    }
    ElMessage.success('保存成功')
    tagDialogVisible.value = false
    loadTags(selectedGroup.value.GROUP_ID); loadAllTags(); loadGroups()
  } catch (e) { ElMessage.error(e.message) }
  finally { tagSaving.value = false }
}

async function deleteTag(row) {
  await ElMessageBox.confirm(`确定删除标签 "${row.TAG_NAME}"？`, '删除确认', { type: 'warning' })
  try {
    await tagApi.deleteTag(row.TAG_ID)
    ElMessage.success('删除成功')
    loadTags(selectedGroup.value.GROUP_ID); loadAllTags(); loadGroups()
  } catch (e) { ElMessage.error(e.message) }
}

// ─── 按标签筛选实例 ────────────────────────────────────────
const filterTagIds = ref([])
const matchMode = ref('ANY')
const filteredInstances = ref([])
const filterLoading = ref(false)
const filterPage = ref(1)
const filterTotal = ref(0)
const selectedInstances = ref([])
const batchTagIds = ref([])

async function filterByTags() {
  if (!filterTagIds.value.length) {
    // 无筛选时加载全部实例
    filterLoading.value = true
    try {
      const r = await cmdbApi.list({ page: filterPage.value, size: 20 })
      if (r.code === 200) { filteredInstances.value = r.data.list || []; filterTotal.value = r.data.total || 0 }
    } finally { filterLoading.value = false }
    return
  }
  filterLoading.value = true
  try {
    const r = await tagApi.instancesByTag({ tagIds: filterTagIds.value.join(','), matchMode: matchMode.value, page: filterPage.value, size: 20 })
    if (r.code === 200) { filteredInstances.value = r.data.list || []; filterTotal.value = r.data.total || 0 }
  } finally { filterLoading.value = false }
}

function onInstSelect(rows) { selectedInstances.value = rows }

async function batchAssign() {
  if (!selectedInstances.value.length || !batchTagIds.value.length) return
  try {
    const ids = selectedInstances.value.map(r => r.INSTANCE_ID)
    const r = await tagApi.batchAssign(ids, batchTagIds.value)
    ElMessage.success(r.msg || '批量打标完成')
    filterByTags()
  } catch (e) { ElMessage.error(e.message) }
}

async function batchRemove() {
  if (!selectedInstances.value.length || !batchTagIds.value.length) return
  await ElMessageBox.confirm('确定批量移除所选实例的指定标签？', '确认', { type: 'warning' })
  try {
    const ids = selectedInstances.value.map(r => r.INSTANCE_ID)
    const r = await tagApi.batchRemove(ids, batchTagIds.value)
    ElMessage.success(r.msg || '批量移除完成')
    filterByTags()
  } catch (e) { ElMessage.error(e.message) }
}

// ─── 实例打标弹窗 ──────────────────────────────────────────
const instTagDialogVisible = ref(false)
const instTagTarget = ref(null)
const instTagIds = ref([])
const instTagSaving = ref(false)

async function openInstanceTagDialog(row) {
  instTagTarget.value = row
  instTagSaving.value = false
  // 加载实例当前标签
  try {
    const r = await tagApi.instanceTags(row.INSTANCE_ID)
    instTagIds.value = (r.data || []).map(t => t.TAG_ID)
  } catch { instTagIds.value = [] }
  instTagDialogVisible.value = true
}

function toggleInstTag(tagId, checked) {
  if (checked) { instTagIds.value = [...instTagIds.value, tagId] }
  else { instTagIds.value = instTagIds.value.filter(id => id !== tagId) }
}

async function saveInstanceTags() {
  instTagSaving.value = true
  try {
    await tagApi.setInstanceTags(instTagTarget.value.INSTANCE_ID, instTagIds.value)
    ElMessage.success('标签更新成功')
    instTagDialogVisible.value = false
    filterByTags()
  } catch (e) { ElMessage.error(e.message) }
  finally { instTagSaving.value = false }
}

// ─── 初始化 ────────────────────────────────────────────────
async function loadStats() {
  try { const r = await tagApi.stats(); if (r.code === 200) statsData.value = r.data } catch {}
}

onMounted(() => { loadGroups(); loadAllTags(); loadStats(); filterByTags() })
</script>

<style scoped>
.stat-card {
  background: var(--agent-panel-bg, #ffffff);
  border: 1px solid var(--agent-border, #e4e7ed);
  border-radius: 8px; padding: 16px 20px; border-left: 4px solid;
}
.stat-num { font-size: 28px; font-weight: 700; }
.stat-lbl { font-size: 13px; color: var(--agent-text-muted, #909399); margin-top: 4px; }
</style>
