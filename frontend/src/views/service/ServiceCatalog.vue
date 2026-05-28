<template>
  <div class="page-container">
    <!-- 统计卡片 -->
    <el-row :gutter="16" class="mb-16">
      <el-col :span="6">
        <div class="stat-card">
          <div class="stat-num">{{ stats.total || 0 }}</div>
          <div class="stat-label">全部工单</div>
        </div>
      </el-col>
      <el-col :span="6">
        <div class="stat-card stat-open">
          <div class="stat-num">{{ statusCount('OPEN') }}</div>
          <div class="stat-label">待处理</div>
        </div>
      </el-col>
      <el-col :span="6">
        <div class="stat-card stat-progress">
          <div class="stat-num">{{ statusCount('IN_PROGRESS') }}</div>
          <div class="stat-label">处理中</div>
        </div>
      </el-col>
      <el-col :span="6">
        <div class="stat-card stat-resolved">
          <div class="stat-num">{{ statusCount('RESOLVED') + statusCount('CLOSED') }}</div>
          <div class="stat-label">已解决</div>
        </div>
      </el-col>
    </el-row>

    <!-- Tab 切换 -->
    <el-tabs v-model="activeTab" type="card" class="card">
      <!-- 服务目录 -->
      <el-tab-pane label="服务目录" name="catalog">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
          <span style="font-size:14px;color:#909399">选择服务类型提交工单</span>
          <el-button v-if="isAdminOrDba" type="primary" size="small" icon="Plus" @click="openCatalogDialog()">新增服务</el-button>
        </div>
        <el-row :gutter="16">
          <el-col :span="8" v-for="cat in catalogs" :key="cat.CATALOG_ID" style="margin-bottom:16px">
            <div class="catalog-card" @click="openOrderDialog(cat)">
              <div class="catalog-icon">
                <el-icon size="28"><component :is="iconMap[cat.ICON] || 'Document'" /></el-icon>
              </div>
              <div class="catalog-info">
                <div class="catalog-name">{{ cat.SERVICE_NAME }}</div>
                <div class="catalog-desc">{{ cat.DESCRIPTION || '-' }}</div>
                <div class="catalog-meta">
                  <el-tag size="small" type="info">{{ cat.CATEGORY }}</el-tag>
                  <span v-if="cat.SLA_HOURS" class="sla-tag">SLA {{ cat.SLA_HOURS }}h</span>
                  <span v-if="cat.NEED_APPROVAL" class="approval-tag">需审批</span>
                </div>
              </div>
              <el-dropdown v-if="isAdminOrDba" @command="handleCatalogCmd($event, cat)" trigger="click" @click.stop>
                <el-icon class="catalog-more"><MoreFilled /></el-icon>
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item command="edit">编辑</el-dropdown-item>
                    <el-dropdown-item command="delete" divided>删除</el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
            </div>
          </el-col>
        </el-row>
      </el-tab-pane>

      <!-- 工单列表 -->
      <el-tab-pane label="工单列表" name="orders">
        <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap">
          <el-select v-model="orderFilter.status" clearable placeholder="状态" size="small" style="width:120px" @change="loadOrders">
            <el-option label="待处理" value="OPEN" /><el-option label="处理中" value="IN_PROGRESS" />
            <el-option label="待审核" value="PENDING_REVIEW" /><el-option label="已解决" value="RESOLVED" />
            <el-option label="已关闭" value="CLOSED" /><el-option label="已拒绝" value="REJECTED" />
          </el-select>
          <el-select v-model="orderFilter.priority" clearable placeholder="优先级" size="small" style="width:110px" @change="loadOrders">
            <el-option label="紧急" value="CRITICAL" /><el-option label="高" value="HIGH" />
            <el-option label="中" value="MEDIUM" /><el-option label="低" value="LOW" />
          </el-select>
          <el-input v-model="orderFilter.keyword" placeholder="搜索标题..." size="small" clearable style="width:200px" @clear="loadOrders" @keyup.enter="loadOrders" />
          <el-button size="small" type="primary" icon="Search" @click="loadOrders">搜索</el-button>
          <el-button size="small" icon="Plus" @click="openOrderDialog()">新建工单</el-button>
        </div>
        <el-table :data="orders" stripe border size="small" @row-click="openDetail" style="cursor:pointer">
          <el-table-column prop="ORDER_ID" label="#" width="60" />
          <el-table-column prop="TITLE" label="标题" min-width="200" show-overflow-tooltip />
          <el-table-column prop="SERVICE_NAME" label="服务类型" width="120" />
          <el-table-column prop="INSTANCE_NAME" label="实例" width="130" show-overflow-tooltip />
          <el-table-column label="优先级" width="80">
            <template #default="{ row }">
              <el-tag :type="priorityType(row.PRIORITY)" size="small">{{ priorityLabel(row.PRIORITY) }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="100">
            <template #default="{ row }">
              <el-tag :type="statusType(row.STATUS)" size="small">{{ statusLabel(row.STATUS) }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="CREATOR_NAME" label="创建人" width="90" />
          <el-table-column prop="ASSIGNEE_NAME" label="指派人" width="90" />
          <el-table-column label="创建时间" width="155">
            <template #default="{ row }">{{ fmtTime(row.CREATED_AT) }}</template>
          </el-table-column>
        </el-table>
        <div style="padding:12px 0;text-align:right">
          <el-pagination v-model:current-page="orderPage" :page-size="20" :total="orderTotal"
            layout="total,prev,pager,next" @current-change="loadOrders" small />
        </div>
      </el-tab-pane>

      <!-- 我的工单 -->
      <el-tab-pane label="我的工单" name="my">
        <el-radio-group v-model="myType" size="small" style="margin-bottom:12px" @change="loadMyOrders">
          <el-radio-button label="created">我创建的</el-radio-button>
          <el-radio-button label="assigned">指派给我的</el-radio-button>
        </el-radio-group>
        <el-table :data="myOrders" stripe border size="small" @row-click="openDetail" style="cursor:pointer">
          <el-table-column prop="ORDER_ID" label="#" width="60" />
          <el-table-column prop="TITLE" label="标题" min-width="200" show-overflow-tooltip />
          <el-table-column prop="SERVICE_NAME" label="服务类型" width="120" />
          <el-table-column label="优先级" width="80">
            <template #default="{ row }">
              <el-tag :type="priorityType(row.PRIORITY)" size="small">{{ priorityLabel(row.PRIORITY) }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="100">
            <template #default="{ row }">
              <el-tag :type="statusType(row.STATUS)" size="small">{{ statusLabel(row.STATUS) }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="创建时间" width="155">
            <template #default="{ row }">{{ fmtTime(row.CREATED_AT) }}</template>
          </el-table-column>
        </el-table>
        <div style="padding:12px 0;text-align:right">
          <el-pagination v-model:current-page="myPage" :page-size="20" :total="myTotal"
            layout="total,prev,pager,next" @current-change="loadMyOrders" small />
        </div>
      </el-tab-pane>
    </el-tabs>

    <!-- 创建工单对话框 -->
    <el-dialog v-model="orderDialogVisible" title="提交工单" width="520px" :close-on-click-modal="false">
      <el-form :model="orderForm" label-width="80px">
        <el-form-item label="服务类型">
          <el-input :model-value="orderForm.serviceName" disabled />
        </el-form-item>
        <el-form-item label="关联实例">
          <el-select v-model="orderForm.instanceId" filterable clearable placeholder="选择实例（可选）" style="width:100%">
            <el-option v-for="inst in instanceList" :key="inst.INSTANCE_ID"
              :label="`${inst.INSTANCE_NAME} (${inst.DB_TYPE})`" :value="inst.INSTANCE_ID" />
          </el-select>
        </el-form-item>
        <el-form-item label="标题" required>
          <el-input v-model="orderForm.title" placeholder="简要描述需求" />
        </el-form-item>
        <el-form-item label="优先级">
          <el-select v-model="orderForm.priority" style="width:100%">
            <el-option label="低" value="LOW" /><el-option label="中" value="MEDIUM" />
            <el-option label="高" value="HIGH" /><el-option label="紧急" value="CRITICAL" />
          </el-select>
        </el-form-item>
        <el-form-item label="详细说明">
          <el-input v-model="orderForm.remark" type="textarea" :rows="3" placeholder="详细描述需求内容" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="orderDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="orderSubmitting" @click="submitOrder">提交</el-button>
      </template>
    </el-dialog>

    <!-- 新增/编辑服务目录对话框 -->
    <el-dialog v-model="catalogDialogVisible" :title="catalogEditingId ? '编辑服务' : '新增服务'" width="480px" :close-on-click-modal="false">
      <el-form :model="catalogForm" label-width="80px">
        <el-form-item label="服务名称" required>
          <el-input v-model="catalogForm.serviceName" />
        </el-form-item>
        <el-form-item label="分类">
          <el-select v-model="catalogForm.category" filterable allow-create style="width:100%">
            <el-option label="容量" value="CAPACITY" /><el-option label="权限" value="ACCESS" />
            <el-option label="数据" value="DATA" /><el-option label="配置" value="CONFIG" />
            <el-option label="故障" value="INCIDENT" /><el-option label="报告" value="REPORT" />
          </el-select>
        </el-form-item>
        <el-form-item label="描述">
          <el-input v-model="catalogForm.description" type="textarea" :rows="2" />
        </el-form-item>
        <el-form-item label="SLA(小时)">
          <el-input-number v-model="catalogForm.slaHours" :min="1" :max="720" />
        </el-form-item>
        <el-form-item label="需审批">
          <el-switch v-model="catalogForm.needApproval" />
        </el-form-item>
        <el-form-item label="默认角色">
          <el-select v-model="catalogForm.assigneeRole" clearable style="width:100%">
            <el-option label="DBA" value="DBA" /><el-option label="OPS" value="OPS" />
            <el-option label="ADMIN" value="ADMIN" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="catalogDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="catalogSubmitting" @click="submitCatalog">保存</el-button>
      </template>
    </el-dialog>

    <!-- 工单详情抽屉 -->
    <el-drawer v-model="detailVisible" title="工单详情" size="560px">
      <template v-if="detail">
        <el-descriptions :column="2" border size="small" class="mb-16">
          <el-descriptions-item label="工单号">{{ detail.ORDER_ID }}</el-descriptions-item>
          <el-descriptions-item label="状态">
            <el-tag :type="statusType(detail.STATUS)" size="small">{{ statusLabel(detail.STATUS) }}</el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="标题" :span="2">{{ detail.TITLE }}</el-descriptions-item>
          <el-descriptions-item label="服务类型">{{ detail.SERVICE_NAME }}</el-descriptions-item>
          <el-descriptions-item label="优先级">
            <el-tag :type="priorityType(detail.PRIORITY)" size="small">{{ priorityLabel(detail.PRIORITY) }}</el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="关联实例">{{ detail.INSTANCE_NAME || '-' }}</el-descriptions-item>
          <el-descriptions-item label="SLA">{{ detail.SLA_HOURS ? detail.SLA_HOURS + 'h' : '-' }}</el-descriptions-item>
          <el-descriptions-item label="创建人">{{ detail.CREATOR_NAME }}</el-descriptions-item>
          <el-descriptions-item label="指派人">{{ detail.ASSIGNEE_NAME || '未指派' }}</el-descriptions-item>
          <el-descriptions-item label="创建时间" :span="2">{{ fmtTime(detail.CREATED_AT) }}</el-descriptions-item>
          <el-descriptions-item label="详细说明" :span="2">{{ detail.REMARK || '-' }}</el-descriptions-item>
        </el-descriptions>

        <!-- 操作按钮 -->
        <div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap">
          <el-button v-if="canAssign" size="small" type="primary" @click="openAssignDialog">指派</el-button>
          <template v-for="next in allowedTransitions" :key="next">
            <el-button size="small" :type="next === 'REJECTED' ? 'danger' : 'success'" @click="changeStatus(next)">
              {{ statusActionLabel(next) }}
            </el-button>
          </template>
          <el-button v-if="canFeedback" size="small" type="warning" @click="feedbackVisible = true">满意度评价</el-button>
        </div>

        <!-- 评论/流转记录 -->
        <div class="sub-title">流转记录</div>
        <el-timeline>
          <el-timeline-item v-for="c in detail.comments" :key="c.COMMENT_ID"
            :timestamp="fmtTime(c.CREATED_AT)" placement="top"
            :type="c.COMMENT_TYPE === 'STATUS_CHANGE' ? 'primary' : c.COMMENT_TYPE === 'ASSIGN' ? 'warning' : ''">
            <div style="font-size:13px">
              <span style="color:#909399;margin-right:8px">{{ c.AUTHOR_NAME }}</span>
              <span style="white-space:pre-wrap">{{ c.CONTENT }}</span>
            </div>
          </el-timeline-item>
        </el-timeline>

        <!-- 添加评论 -->
        <div style="margin-top:16px;display:flex;gap:8px">
          <el-input v-model="newComment" placeholder="添加评论..." size="small" @keyup.enter="submitComment" />
          <el-button size="small" type="primary" :loading="commentLoading" @click="submitComment">发送</el-button>
        </div>
      </template>
    </el-drawer>

    <!-- 指派对话框 -->
    <el-dialog v-model="assignVisible" title="指派工单" width="400px">
      <el-form label-width="60px">
        <el-form-item label="指派给">
          <el-select v-model="assigneeId" filterable placeholder="选择处理人" style="width:100%">
            <el-option v-for="u in userList" :key="u.USER_ID" :label="`${u.USERNAME} (${u.ROLE})`" :value="u.USER_ID" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="assignVisible = false">取消</el-button>
        <el-button type="primary" :loading="assignLoading" @click="submitAssign">确认指派</el-button>
      </template>
    </el-dialog>

    <!-- 满意度评价对话框 -->
    <el-dialog v-model="feedbackVisible" title="满意度评价" width="400px">
      <el-form label-width="60px">
        <el-form-item label="评分">
          <el-rate v-model="feedbackScore" :max="5" />
        </el-form-item>
        <el-form-item label="评语">
          <el-input v-model="feedbackComment" type="textarea" :rows="2" placeholder="可选" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="feedbackVisible = false">取消</el-button>
        <el-button type="primary" :loading="feedbackLoading" @click="submitFeedback">提交评价</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { serviceCatalogApi, cmdbApi, userApi } from '@/api/index.js'
import { useAuthStore } from '@/stores/auth.js'
import { ElMessage, ElMessageBox } from 'element-plus'

const auth = useAuthStore()
const isAdminOrDba = computed(() => ['ADMIN', 'DBA'].includes(auth.user?.role))

const activeTab = ref('catalog')
const stats = ref({})
const catalogs = ref([])

// Icon mapping
const iconMap = { Expand: 'Expand', Lock: 'Lock', Download: 'Download', Setting: 'Setting', Warning: 'WarningFilled', Document: 'Document' }

// Orders
const orders = ref([])
const orderPage = ref(1)
const orderTotal = ref(0)
const orderFilter = reactive({ status: '', priority: '', keyword: '' })

// My orders
const myOrders = ref([])
const myPage = ref(1)
const myTotal = ref(0)
const myType = ref('created')

// Instance list for order form
const instanceList = ref([])

// User list for assign
const userList = ref([])

// Dialogs
const orderDialogVisible = ref(false)
const orderSubmitting = ref(false)
const orderForm = reactive({ catalogId: null, serviceName: '', instanceId: null, title: '', priority: 'MEDIUM', remark: '' })

const catalogDialogVisible = ref(false)
const catalogSubmitting = ref(false)
const catalogEditingId = ref(null)
const catalogForm = reactive({ serviceName: '', category: '', description: '', slaHours: 24, needApproval: true, assigneeRole: 'DBA' })

const detailVisible = ref(false)
const detail = ref(null)
const newComment = ref('')
const commentLoading = ref(false)

const assignVisible = ref(false)
const assigneeId = ref(null)
const assignLoading = ref(false)

const feedbackVisible = ref(false)
const feedbackScore = ref(5)
const feedbackComment = ref('')
const feedbackLoading = ref(false)

// Helpers
function fmtTime(v) { return v ? new Date(v).toLocaleString('zh-CN') : '-' }
function statusCount(s) { return stats.value.byStatus?.find(r => r.STATUS === s)?.CNT || 0 }
function statusType(s) { return { OPEN: 'danger', IN_PROGRESS: 'warning', PENDING_REVIEW: '', RESOLVED: 'success', CLOSED: 'info', REJECTED: 'info' }[s] || 'info' }
function statusLabel(s) { return { OPEN: '待处理', IN_PROGRESS: '处理中', PENDING_REVIEW: '待审核', RESOLVED: '已解决', CLOSED: '已关闭', REJECTED: '已拒绝' }[s] || s }
function priorityType(p) { return { CRITICAL: 'danger', HIGH: 'warning', MEDIUM: '', LOW: 'info' }[p] || 'info' }
function priorityLabel(p) { return { CRITICAL: '紧急', HIGH: '高', MEDIUM: '中', LOW: '低' }[p] || p }
function statusActionLabel(s) { return { IN_PROGRESS: '开始处理', PENDING_REVIEW: '提交审核', RESOLVED: '标记解决', CLOSED: '关闭工单', REJECTED: '拒绝工单', IN_PROGRESS: '重新打开' }[s] || s }

const allowedTransitions = computed(() => {
  if (!detail.value) return []
  const s = detail.value.STATUS
  const role = auth.user?.role
  const isCreator = detail.value.CREATED_BY === auth.user?.userId
  const isAssignee = detail.value.ASSIGNED_TO === auth.user?.userId
  if (!isCreator && !isAssignee && !['ADMIN', 'DBA'].includes(role)) return []
  const map = {
    OPEN: ['IN_PROGRESS'],
    IN_PROGRESS: ['PENDING_REVIEW', 'RESOLVED'],
    PENDING_REVIEW: ['RESOLVED', 'IN_PROGRESS'],
    RESOLVED: ['CLOSED', 'IN_PROGRESS'],
  }
  let transitions = map[s] || []
  if (s === 'OPEN' && ['ADMIN', 'DBA'].includes(role)) transitions = [...transitions, 'REJECTED']
  return transitions
})

const canAssign = computed(() => {
  if (!detail.value) return false
  return ['ADMIN', 'DBA', 'OPS'].includes(auth.user?.role) && !['CLOSED', 'REJECTED'].includes(detail.value.STATUS)
})

const canFeedback = computed(() => {
  if (!detail.value) return false
  return detail.value.CREATED_BY === auth.user?.userId && ['RESOLVED', 'CLOSED'].includes(detail.value.STATUS) && !detail.value.FEEDBACK_SCORE
})

// Loaders
async function loadStats() {
  try { const r = await serviceCatalogApi.stats(); stats.value = r.data || {} } catch {}
}

async function loadCatalogs() {
  try { const r = await serviceCatalogApi.catalogs({ size: 50 }); catalogs.value = r.data?.list || [] } catch {}
}

async function loadOrders() {
  try {
    const r = await serviceCatalogApi.orders({ page: orderPage.value, size: 20, ...orderFilter })
    orders.value = r.data?.list || []
    orderTotal.value = r.data?.total || 0
  } catch {}
}

async function loadMyOrders() {
  try {
    const r = await serviceCatalogApi.myOrders({ page: myPage.value, size: 20, type: myType.value })
    myOrders.value = r.data?.list || []
    myTotal.value = r.data?.total || 0
  } catch {}
}

async function loadInstances() {
  try { const r = await cmdbApi.list({ size: 500 }); instanceList.value = r.data?.list || [] } catch {}
}

async function loadUsers() {
  try { const r = await userApi.list({ size: 500 }); userList.value = r.data?.list || [] } catch {}
}

// Service catalog CRUD
function openCatalogDialog(cat) {
  if (cat) {
    catalogEditingId.value = cat.CATALOG_ID
    Object.assign(catalogForm, { serviceName: cat.SERVICE_NAME, category: cat.CATEGORY, description: cat.DESCRIPTION, slaHours: cat.SLA_HOURS || 24, needApproval: !!cat.NEED_APPROVAL, assigneeRole: cat.ASSIGNEE_ROLE || 'DBA' })
  } else {
    catalogEditingId.value = null
    Object.assign(catalogForm, { serviceName: '', category: '', description: '', slaHours: 24, needApproval: true, assigneeRole: 'DBA' })
  }
  catalogDialogVisible.value = true
}

async function submitCatalog() {
  if (!catalogForm.serviceName) return ElMessage.warning('请输入服务名称')
  catalogSubmitting.value = true
  try {
    if (catalogEditingId.value) {
      await serviceCatalogApi.updateCatalog(catalogEditingId.value, catalogForm)
    } else {
      await serviceCatalogApi.createCatalog(catalogForm)
    }
    ElMessage.success('保存成功')
    catalogDialogVisible.value = false
    loadCatalogs()
  } catch (e) { ElMessage.error(e.message) }
  catalogSubmitting.value = false
}

function handleCatalogCmd(cmd, cat) {
  if (cmd === 'edit') openCatalogDialog(cat)
  else if (cmd === 'delete') {
    ElMessageBox.confirm(`确定删除服务「${cat.SERVICE_NAME}」？`, '确认', { type: 'warning' }).then(async () => {
      try { await serviceCatalogApi.deleteCatalog(cat.CATALOG_ID); ElMessage.success('已删除'); loadCatalogs() } catch (e) { ElMessage.error(e.message) }
    }).catch(() => {})
  }
}

// Order CRUD
function openOrderDialog(cat) {
  Object.assign(orderForm, {
    catalogId: cat?.CATALOG_ID || null,
    serviceName: cat?.SERVICE_NAME || '',
    instanceId: null, title: '', priority: 'MEDIUM', remark: '',
  })
  orderDialogVisible.value = true
}

async function submitOrder() {
  if (!orderForm.title) return ElMessage.warning('请输入标题')
  if (!orderForm.catalogId) return ElMessage.warning('请选择服务类型')
  orderSubmitting.value = true
  try {
    await serviceCatalogApi.createOrder(orderForm)
    ElMessage.success('工单已提交')
    orderDialogVisible.value = false
    loadOrders(); loadStats()
  } catch (e) { ElMessage.error(e.message) }
  orderSubmitting.value = false
}

// Order detail
async function openDetail(row) {
  try {
    const r = await serviceCatalogApi.order(row.ORDER_ID)
    detail.value = r.data
    detailVisible.value = true
  } catch (e) { ElMessage.error(e.message) }
}

// Assign
function openAssignDialog() {
  assigneeId.value = detail.value?.ASSIGNED_TO || null
  assignVisible.value = true
}

async function submitAssign() {
  if (!assigneeId.value) return ElMessage.warning('请选择指派人')
  assignLoading.value = true
  try {
    await serviceCatalogApi.assignOrder(detail.value.ORDER_ID, { assigneeId: assigneeId.value })
    ElMessage.success('指派成功')
    assignVisible.value = false
    const r = await serviceCatalogApi.order(detail.value.ORDER_ID)
    detail.value = r.data
    loadOrders(); loadStats()
  } catch (e) { ElMessage.error(e.message) }
  assignLoading.value = false
}

// Status change
async function changeStatus(newStatus) {
  const label = statusLabel(newStatus)
  try {
    await ElMessageBox.confirm(`确认将工单状态变更为「${label}」？`, '确认')
  } catch { return }
  try {
    await serviceCatalogApi.changeOrderStatus(detail.value.ORDER_ID, { status: newStatus })
    ElMessage.success('状态已变更')
    const r = await serviceCatalogApi.order(detail.value.ORDER_ID)
    detail.value = r.data
    loadOrders(); loadStats()
  } catch (e) { ElMessage.error(e.message) }
}

// Comment
async function submitComment() {
  if (!newComment.value.trim()) return
  commentLoading.value = true
  try {
    await serviceCatalogApi.addComment(detail.value.ORDER_ID, { content: newComment.value })
    newComment.value = ''
    const r = await serviceCatalogApi.order(detail.value.ORDER_ID)
    detail.value = r.data
  } catch (e) { ElMessage.error(e.message) }
  commentLoading.value = false
}

// Feedback
async function submitFeedback() {
  feedbackLoading.value = true
  try {
    await serviceCatalogApi.feedback(detail.value.ORDER_ID, { score: feedbackScore.value, comment: feedbackComment.value })
    ElMessage.success('评价成功')
    feedbackVisible.value = false
    const r = await serviceCatalogApi.order(detail.value.ORDER_ID)
    detail.value = r.data
  } catch (e) { ElMessage.error(e.message) }
  feedbackLoading.value = false
}

onMounted(() => {
  loadStats(); loadCatalogs(); loadOrders(); loadMyOrders(); loadInstances(); loadUsers()
})
</script>

<style scoped>
.stat-card {
  background: var(--agent-panel-bg, #fff); border: 1px solid var(--agent-border, #e4e7ed);
  border-radius: 8px; padding: 16px; text-align: center;
}
.stat-num { font-size: 28px; font-weight: 700; color: var(--agent-text, #303133); }
.stat-label { font-size: 13px; color: var(--agent-text-muted, #909399); margin-top: 4px; }
.stat-open .stat-num { color: #f56c6c; }
.stat-progress .stat-num { color: #e6a23c; }
.stat-resolved .stat-num { color: #67c23a; }

.catalog-card {
  display: flex; align-items: center; gap: 14px; padding: 16px;
  background: var(--agent-panel-bg, #fff); border: 1px solid var(--agent-border, #e4e7ed);
  border-radius: 8px; cursor: pointer; transition: all 0.2s; position: relative;
}
.catalog-card:hover { border-color: #1890ff; box-shadow: 0 2px 8px rgba(24,144,255,0.15); }
.catalog-icon {
  width: 48px; height: 48px; border-radius: 10px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  background: rgba(24,144,255,0.1); color: #1890ff;
}
.catalog-info { flex: 1; min-width: 0; }
.catalog-name { font-size: 14px; font-weight: 600; color: var(--agent-text, #303133); }
.catalog-desc { font-size: 12px; color: var(--agent-text-muted, #909399); margin-top: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.catalog-meta { display: flex; gap: 6px; margin-top: 6px; align-items: center; }
.sla-tag { font-size: 11px; color: #e6a23c; }
.approval-tag { font-size: 11px; color: #f56c6c; }
.catalog-more { color: #909399; cursor: pointer; }
.catalog-more:hover { color: #1890ff; }

.sub-title { font-size: 14px; font-weight: 600; margin-bottom: 8px; color: var(--agent-text, #303133); }
</style>
