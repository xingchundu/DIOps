<template>
  <div class="page-wrap">
    <!-- 统计卡片 -->
    <el-row :gutter="16" class="stat-row">
      <el-col :span="6">
        <el-card shadow="never" class="stat-card">
          <div class="stat-label">待审核</div>
          <div class="stat-value warning">{{ stats.pendingCount || 0 }}</div>
        </el-card>
      </el-col>
      <el-col :span="6">
        <el-card shadow="never" class="stat-card">
          <div class="stat-label">平均评分</div>
          <div class="stat-value primary">{{ stats.avgScore || '-' }}</div>
        </el-card>
      </el-col>
      <el-col :span="6">
        <el-card shadow="never" class="stat-card">
          <div class="stat-label">已通过</div>
          <div class="stat-value success">{{ statusCnt('APPROVED') }}</div>
        </el-card>
      </el-col>
      <el-col :span="6">
        <el-card shadow="never" class="stat-card">
          <div class="stat-label">已拒绝</div>
          <div class="stat-value danger">{{ statusCnt('REJECTED') }}</div>
        </el-card>
      </el-col>
    </el-row>

    <!-- 工具栏 -->
    <el-card shadow="never" class="main-card">
      <div class="toolbar">
        <div class="toolbar-left">
          <el-select v-model="filters.status" placeholder="状态" clearable size="default" style="width: 130px" @change="loadTickets">
            <el-option label="待审核" value="PENDING" /><el-option label="审核中" value="IN_REVIEW" />
            <el-option label="已通过" value="APPROVED" /><el-option label="已拒绝" value="REJECTED" />
            <el-option label="需修改" value="CHANGES_REQUESTED" /><el-option label="已取消" value="CANCELLED" />
          </el-select>
          <el-select v-model="filters.source" placeholder="来源" clearable size="default" style="width: 120px" @change="loadTickets">
            <el-option label="在线" value="ONLINE" /><el-option label="离线" value="OFFLINE" /><el-option label="自助" value="SELF" />
          </el-select>
          <el-select v-model="filters.priority" placeholder="优先级" clearable size="default" style="width: 120px" @change="loadTickets">
            <el-option label="低" value="LOW" /><el-option label="普通" value="NORMAL" />
            <el-option label="高" value="HIGH" /><el-option label="紧急" value="URGENT" />
          </el-select>
        </div>
        <div class="toolbar-right">
          <el-button type="primary" @click="showCreate = true">
            <el-icon><Plus /></el-icon> 新建工单
          </el-button>
          <el-button @click="loadTickets"><el-icon><Refresh /></el-icon></el-button>
        </div>
      </div>

      <!-- 工单列表 -->
      <el-table :data="tickets" v-loading="loading" stripe @row-click="openDetail" style="cursor: pointer">
        <el-table-column prop="TICKET_ID" label="ID" width="70" />
        <el-table-column prop="TITLE" label="标题" min-width="180" show-overflow-tooltip />
        <el-table-column prop="INSTANCE_NAME" label="目标实例" width="130" show-overflow-tooltip />
        <el-table-column prop="SOURCE" label="来源" width="80">
          <template #default="{ row }">
            <el-tag size="small" :type="sourceColor(row.SOURCE)">{{ sourceLabel(row.SOURCE) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="ENVIRONMENT" label="环境" width="80">
          <template #default="{ row }">
            <el-tag size="small" :type="envColor(row.ENVIRONMENT)">{{ row.ENVIRONMENT }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="PRIORITY" label="优先级" width="80">
          <template #default="{ row }">
            <el-tag size="small" :type="priorityColor(row.PRIORITY)">{{ priorityLabel(row.PRIORITY) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="STATUS" label="状态" width="100">
          <template #default="{ row }">
            <el-tag size="small" :type="statusColor(row.STATUS)">{{ statusLabel(row.STATUS) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="SCORE" label="评分" width="70">
          <template #default="{ row }">
            <span v-if="row.SCORE != null" :style="{ color: scoreColor(row.SCORE), fontWeight: 600 }">{{ row.SCORE }}</span>
            <span v-else class="text-muted">-</span>
          </template>
        </el-table-column>
        <el-table-column prop="RISK_LEVEL" label="风险" width="80">
          <template #default="{ row }">
            <el-tag v-if="row.RISK_LEVEL" size="small" :type="riskColor(row.RISK_LEVEL)">{{ row.RISK_LEVEL }}</el-tag>
            <span v-else class="text-muted">-</span>
          </template>
        </el-table-column>
        <el-table-column prop="SUBMITTER_REAL_NAME" label="提交人" width="90" show-overflow-tooltip>
          <template #default="{ row }">{{ row.SUBMITTER_REAL_NAME || row.SUBMITTER_NAME }}</template>
        </el-table-column>
        <el-table-column prop="COMMENT_COUNT" label="评论" width="60" align="center" />
        <el-table-column prop="CREATED_AT" label="创建时间" width="160">
          <template #default="{ row }">{{ fmtTime(row.CREATED_AT) }}</template>
        </el-table-column>
      </el-table>

      <div class="pagination-wrap">
        <el-pagination
          v-model:current-page="page" v-model:page-size="pageSize" :total="total"
          :page-sizes="[10, 20, 50]" layout="total, sizes, prev, pager, next" @change="loadTickets"
        />
      </div>
    </el-card>

    <!-- 新建工单弹窗 -->
    <el-dialog v-model="showCreate" title="新建 SQL 评审工单" width="700px" :close-on-click-modal="false" destroy-on-close>
      <el-form ref="createFormRef" :model="createForm" :rules="createRules" label-width="90px">
        <el-form-item label="标题" prop="title">
          <el-input v-model="createForm.title" placeholder="请输入工单标题" />
        </el-form-item>
        <el-form-item label="SQL 内容" prop="sqlText">
          <el-input v-model="createForm.sqlText" type="textarea" :rows="10" placeholder="请输入待评审的 SQL 语句" />
        </el-form-item>
        <el-row :gutter="16">
          <el-col :span="12">
            <el-form-item label="目标实例">
              <el-select v-model="createForm.instanceId" placeholder="选择实例" clearable filterable style="width: 100%">
                <el-option v-for="i in instances" :key="i.INSTANCE_ID" :label="i.INSTANCE_NAME" :value="i.INSTANCE_ID" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="数据库类型">
              <el-select v-model="createForm.dbType" placeholder="选择类型" clearable style="width: 100%">
                <el-option label="Oracle" value="ORACLE" /><el-option label="MySQL" value="MYSQL" />
                <el-option label="PostgreSQL" value="POSTGRESQL" />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="16">
          <el-col :span="12">
            <el-form-item label="环境">
              <el-select v-model="createForm.environment" style="width: 100%">
                <el-option label="DEV" value="DEV" /><el-option label="STAGING" value="STAGING" /><el-option label="PROD" value="PROD" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="来源">
              <el-select v-model="createForm.source" style="width: 100%">
                <el-option label="在线" value="ONLINE" /><el-option label="离线" value="OFFLINE" /><el-option label="自助" value="SELF" />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="16">
          <el-col :span="12">
            <el-form-item label="优先级">
              <el-select v-model="createForm.priority" style="width: 100%">
                <el-option label="低" value="LOW" /><el-option label="普通" value="NORMAL" />
                <el-option label="高" value="HIGH" /><el-option label="紧急" value="URGENT" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="指定审核人">
              <el-select v-model="createForm.assignedTo" placeholder="可选" clearable filterable style="width: 100%">
                <el-option v-for="u in users" :key="u.USER_ID" :label="u.REAL_NAME || u.USERNAME" :value="u.USER_ID" />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>
      </el-form>
      <template #footer>
        <el-button @click="showCreate = false">取消</el-button>
        <el-button type="primary" :loading="createLoading" @click="submitCreate">提交工单</el-button>
      </template>
    </el-dialog>

    <!-- 工单详情弹窗 -->
    <el-dialog v-model="showDetail" title="SQL 评审工单详情" width="860px" destroy-on-close>
      <div v-if="detail" class="detail-wrap">
        <!-- 头部信息 -->
        <div class="detail-header">
          <div class="detail-title">
            <span class="ticket-id">#{{ detail.TICKET_ID }}</span>
            {{ detail.TITLE }}
            <el-tag size="small" :type="statusColor(detail.STATUS)" style="margin-left: 12px">{{ statusLabel(detail.STATUS) }}</el-tag>
          </div>
          <div class="detail-meta">
            <span>提交人: {{ detail.SUBMITTER_REAL_NAME || detail.SUBMITTER_NAME }}</span>
            <span>环境: <el-tag size="small" :type="envColor(detail.ENVIRONMENT)">{{ detail.ENVIRONMENT }}</el-tag></span>
            <span>来源: {{ sourceLabel(detail.SOURCE) }}</span>
            <span>优先级: <el-tag size="small" :type="priorityColor(detail.PRIORITY)">{{ priorityLabel(detail.PRIORITY) }}</el-tag></span>
            <span v-if="detail.INSTANCE_NAME">实例: {{ detail.INSTANCE_NAME }}</span>
          </div>
        </div>

        <!-- SQL 内容 -->
        <div class="detail-section">
          <div class="section-title">SQL 内容</div>
          <pre class="sql-block">{{ detail.SQL_TEXT }}</pre>
        </div>

        <!-- 自动审核结果 -->
        <div class="detail-section" v-if="detail.auditResult || detail.SCORE != null">
          <div class="section-title">
            自动审核结果
            <el-button size="small" type="primary" plain :loading="auditLoading" @click="triggerAudit" style="margin-left: 12px">
              {{ detail.auditResult ? '重新审核' : '触发审核' }}
            </el-button>
          </div>
          <div class="audit-result" v-if="detail.SCORE != null">
            <div class="audit-score">
              <span class="score-num" :style="{ color: scoreColor(detail.SCORE) }">{{ detail.SCORE }}</span>
              <span class="score-label">评分</span>
            </div>
            <div class="audit-risk">
              <el-tag :type="riskColor(detail.RISK_LEVEL)" size="large">{{ detail.RISK_LEVEL }}</el-tag>
              <span class="risk-label">风险等级</span>
            </div>
          </div>
          <div v-if="detail.auditResult" class="audit-issues">
            <div v-if="detail.auditResult.issues?.length" class="issue-list">
              <div v-for="(issue, idx) in detail.auditResult.issues" :key="idx" class="issue-item">
                <el-tag size="small" :type="severityTagType(issue.severity)">{{ issue.severity }}</el-tag>
                <span class="issue-code">{{ issue.code }}</span>
                <span>{{ issue.message }}</span>
              </div>
            </div>
            <div v-if="detail.auditResult.hints?.length" class="hint-list">
              <div v-for="(hint, idx) in detail.auditResult.hints" :key="idx" class="hint-item">
                <el-icon color="#E6A23C"><Warning /></el-icon> {{ hint }}
              </div>
            </div>
          </div>
        </div>
        <div class="detail-section" v-else>
          <div class="section-title">
            自动审核
            <el-button size="small" type="primary" :loading="auditLoading" @click="triggerAudit" style="margin-left: 12px">
              触发审核
            </el-button>
          </div>
          <el-empty description="尚未进行自动审核" :image-size="60" />
        </div>

        <!-- 审核操作 -->
        <div class="detail-section" v-if="canReview(detail.STATUS)">
          <div class="section-title">审核操作</div>
          <div class="review-actions">
            <el-input v-model="reviewComment" type="textarea" :rows="2" placeholder="审核意见（可选）" style="margin-bottom: 12px" />
            <div class="review-btns">
              <el-button type="success" :loading="reviewLoading" @click="doReview('APPROVE')">
                <el-icon><Select /></el-icon> 通过
              </el-button>
              <el-button type="danger" :loading="reviewLoading" @click="doReview('REJECT')">
                <el-icon><CloseBold /></el-icon> 拒绝
              </el-button>
              <el-button type="warning" :loading="reviewLoading" @click="doReview('REQUEST_CHANGE')">
                <el-icon><Edit /></el-icon> 要求修改
              </el-button>
            </div>
          </div>
        </div>

        <!-- 评论区 -->
        <div class="detail-section">
          <div class="section-title">评论 ({{ comments.length }})</div>
          <div class="comment-list" v-loading="commentLoading">
            <div v-for="c in comments" :key="c.COMMENT_ID" class="comment-item" :class="{ 'comment-system': c.COMMENT_TYPE === 'SYSTEM' }">
              <div class="comment-header">
                <span class="comment-user">{{ c.REAL_NAME || c.USERNAME }}</span>
                <el-tag v-if="c.COMMENT_TYPE !== 'COMMENT'" size="small" :type="commentTypeColor(c.COMMENT_TYPE)">
                  {{ commentTypeLabel(c.COMMENT_TYPE) }}
                </el-tag>
                <span class="comment-time">{{ fmtTime(c.CREATED_AT) }}</span>
              </div>
              <div class="comment-body">{{ c.COMMENT_TEXT }}</div>
            </div>
            <el-empty v-if="!comments.length && !commentLoading" description="暂无评论" :image-size="48" />
          </div>
          <div class="comment-input">
            <el-input v-model="newComment" type="textarea" :rows="2" placeholder="添加评论..." />
            <el-button type="primary" size="small" :disabled="!newComment.trim()" :loading="addCommentLoading" @click="submitComment" style="margin-top: 8px">
              发表评论
            </el-button>
          </div>
        </div>
      </div>
      <template #footer>
        <el-button v-if="canCancel(detail?.STATUS, detail?.SUBMITTED_BY)" type="danger" plain @click="doCancel">取消工单</el-button>
        <el-button @click="showDetail = false">关闭</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import { sqlReviewApi, cmdbApi, userApi } from '@/api/index.js'
import { useAuthStore } from '@/stores/auth.js'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus, Refresh, Select, CloseBold, Edit, Warning } from '@element-plus/icons-vue'

const auth = useAuthStore()

// ── Stats ──
const stats = ref({})
function statusCnt(s) { return stats.value.byStatus?.find(r => r.STATUS === s)?.CNT || 0 }

// ── List ──
const tickets = ref([])
const loading = ref(false)
const page = ref(1)
const pageSize = ref(20)
const total = ref(0)
const filters = reactive({ status: '', source: '', priority: '' })

async function loadTickets() {
  loading.value = true
  try {
    const res = await sqlReviewApi.tickets({ ...filters, page: page.value, size: pageSize.value })
    tickets.value = res.data?.list || []
    total.value = res.data?.total || tickets.value.length
  } catch { /* handled by interceptor */ }
  loading.value = false
}

async function loadStats() {
  try { const res = await sqlReviewApi.stats(); stats.value = res.data || {} } catch {}
}

// ── Create ──
const showCreate = ref(false)
const createLoading = ref(false)
const createFormRef = ref()
const createForm = reactive({
  title: '', sqlText: '', instanceId: null, dbType: '', environment: 'DEV', source: 'ONLINE', priority: 'NORMAL', assignedTo: null,
})
const createRules = {
  title: [{ required: true, message: '请输入标题', trigger: 'blur' }],
  sqlText: [{ required: true, message: '请输入 SQL 内容', trigger: 'blur' }],
}
const instances = ref([])
const users = ref([])

async function loadInstances() {
  try { const res = await cmdbApi.list({ size: 999 }); instances.value = res.data?.list || [] } catch {}
}
async function loadUsers() {
  try { const res = await userApi.list({ size: 999 }); users.value = res.data?.list || [] } catch {}
}

async function submitCreate() {
  try { await createFormRef.value.validate() } catch { return }
  createLoading.value = true
  try {
    const res = await sqlReviewApi.createTicket(createForm)
    if (res.code === 200) {
      ElMessage.success('工单创建成功')
      showCreate.value = false
      Object.assign(createForm, { title: '', sqlText: '', instanceId: null, dbType: '', environment: 'DEV', source: 'ONLINE', priority: 'NORMAL', assignedTo: null })
      loadTickets(); loadStats()
    } else { ElMessage.error(res.msg) }
  } catch { /* handled */ }
  createLoading.value = false
}

// ── Detail ──
const showDetail = ref(false)
const detail = ref(null)
const comments = ref([])
const commentLoading = ref(false)
const newComment = ref('')
const addCommentLoading = ref(false)
const reviewComment = ref('')
const reviewLoading = ref(false)
const auditLoading = ref(false)

async function openDetail(row) {
  showDetail.value = true
  detail.value = null
  comments.value = []
  try {
    const res = await sqlReviewApi.ticket(row.TICKET_ID)
    detail.value = res.data
    loadComments(row.TICKET_ID)
  } catch {}
}

async function loadComments(ticketId) {
  commentLoading.value = true
  try { const res = await sqlReviewApi.comments(ticketId); comments.value = res.data || [] } catch {}
  commentLoading.value = false
}

async function submitComment() {
  if (!newComment.value.trim()) return
  addCommentLoading.value = true
  try {
    await sqlReviewApi.addComment(detail.value.TICKET_ID, { commentText: newComment.value })
    newComment.value = ''
    loadComments(detail.value.TICKET_ID)
  } catch {}
  addCommentLoading.value = false
}

async function triggerAudit() {
  auditLoading.value = true
  try {
    const res = await sqlReviewApi.autoAudit(detail.value.TICKET_ID)
    if (res.code === 200) {
      ElMessage.success('审核完成')
      const refreshed = await sqlReviewApi.ticket(detail.value.TICKET_ID)
      detail.value = refreshed.data
      loadTickets(); loadStats()
    } else { ElMessage.error(res.msg) }
  } catch {}
  auditLoading.value = false
}

async function doReview(action) {
  const labels = { APPROVE: '通过', REJECT: '拒绝', REQUEST_CHANGE: '要求修改' }
  await ElMessageBox.confirm(`确定${labels[action]}该工单？`, '审核确认', { type: 'warning' }).catch(() => null)
  reviewLoading.value = true
  try {
    const res = await sqlReviewApi.review(detail.value.TICKET_ID, { action, comment: reviewComment.value })
    if (res.code === 200) {
      ElMessage.success(res.msg)
      reviewComment.value = ''
      const refreshed = await sqlReviewApi.ticket(detail.value.TICKET_ID)
      detail.value = refreshed.data
      loadTickets(); loadStats()
    } else { ElMessage.error(res.msg) }
  } catch {}
  reviewLoading.value = false
}

async function doCancel() {
  await ElMessageBox.confirm('确定取消该工单？', '确认', { type: 'warning' }).catch(() => null)
  try {
    const res = await sqlReviewApi.cancel(detail.value.TICKET_ID)
    if (res.code === 200) {
      ElMessage.success('已取消')
      const refreshed = await sqlReviewApi.ticket(detail.value.TICKET_ID)
      detail.value = refreshed.data
      loadTickets(); loadStats()
    } else { ElMessage.error(res.msg) }
  } catch {}
}

// ── Helpers ──
function canReview(status) { return ['PENDING', 'IN_REVIEW', 'CHANGES_REQUESTED'].includes(status) }
function canCancel(status, submittedBy) {
  if (!['PENDING', 'CHANGES_REQUESTED'].includes(status)) return false
  return submittedBy === auth.user?.userId || ['ADMIN', 'DBA'].includes(auth.user?.role)
}

function fmtTime(t) { if (!t) return '-'; return new Date(t).toLocaleString('zh-CN', { hour12: false }) }
function sourceLabel(s) { return { ONLINE: '在线', OFFLINE: '离线', SELF: '自助' }[s] || s }
function sourceColor(s) { return { ONLINE: '', OFFLINE: 'warning', SELF: 'success' }[s] || 'info' }
function envColor(e) { return { DEV: 'success', STAGING: 'warning', PROD: 'danger' }[e] || 'info' }
function priorityLabel(p) { return { LOW: '低', NORMAL: '普通', HIGH: '高', URGENT: '紧急' }[p] || p }
function priorityColor(p) { return { LOW: 'info', NORMAL: '', HIGH: 'warning', URGENT: 'danger' }[p] || 'info' }
function statusLabel(s) {
  return { PENDING: '待审核', IN_REVIEW: '审核中', APPROVED: '已通过', REJECTED: '已拒绝', CHANGES_REQUESTED: '需修改', CANCELLED: '已取消' }[s] || s
}
function statusColor(s) {
  return { PENDING: 'warning', IN_REVIEW: '', APPROVED: 'success', REJECTED: 'danger', CHANGES_REQUESTED: 'warning', CANCELLED: 'info' }[s] || 'info'
}
function riskColor(r) { return { LOW: 'success', MEDIUM: 'warning', HIGH: 'danger', CRITICAL: 'danger' }[r] || 'info' }
function scoreColor(s) { return s >= 90 ? '#67C23A' : s >= 70 ? '#E6A23C' : '#F56C6C' }
function severityTagType(s) { return { CRITICAL: 'danger', ERROR: 'danger', WARNING: 'warning', INFO: 'info' }[s] || 'info' }
function commentTypeLabel(t) { return { APPROVE: '通过', REJECT: '拒绝', REQUEST_CHANGE: '要求修改', SYSTEM: '系统' }[t] || t }
function commentTypeColor(t) { return { APPROVE: 'success', REJECT: 'danger', REQUEST_CHANGE: 'warning', SYSTEM: 'info' }[t] || '' }

onMounted(() => { loadTickets(); loadStats(); loadInstances(); loadUsers() })
</script>

<style scoped>
.page-wrap { padding: 16px; }
.stat-row { margin-bottom: 16px; }
.stat-card { text-align: center; }
.stat-label { font-size: 13px; color: var(--el-text-color-secondary); margin-bottom: 4px; }
.stat-value { font-size: 28px; font-weight: 700; }
.stat-value.primary { color: var(--el-color-primary); }
.stat-value.success { color: var(--el-color-success); }
.stat-value.warning { color: var(--el-color-warning); }
.stat-value.danger { color: var(--el-color-danger); }

.main-card { min-height: 500px; }
.toolbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; flex-wrap: wrap; gap: 8px; }
.toolbar-left { display: flex; gap: 8px; flex-wrap: wrap; }
.toolbar-right { display: flex; gap: 8px; }
.pagination-wrap { display: flex; justify-content: flex-end; margin-top: 16px; }
.text-muted { color: var(--el-text-color-placeholder); }

/* Detail */
.detail-wrap { max-height: 70vh; overflow-y: auto; padding-right: 4px; }
.detail-header { margin-bottom: 20px; }
.detail-title { font-size: 18px; font-weight: 600; margin-bottom: 8px; display: flex; align-items: center; }
.ticket-id { color: var(--el-color-primary); margin-right: 8px; font-size: 14px; }
.detail-meta { display: flex; flex-wrap: wrap; gap: 16px; font-size: 13px; color: var(--el-text-color-secondary); }

.detail-section { margin-bottom: 20px; }
.section-title { font-size: 14px; font-weight: 600; margin-bottom: 10px; padding-bottom: 6px; border-bottom: 1px solid var(--el-border-color-lighter); display: flex; align-items: center; }

.sql-block {
  background: var(--el-fill-color-light); border-radius: 6px; padding: 12px;
  font-family: 'Consolas', 'Monaco', monospace; font-size: 13px; line-height: 1.6;
  overflow-x: auto; white-space: pre-wrap; word-break: break-all; max-height: 200px; overflow-y: auto;
  margin: 0;
}

/* Audit */
.audit-result { display: flex; gap: 32px; align-items: center; margin-bottom: 12px; }
.audit-score { display: flex; flex-direction: column; align-items: center; }
.score-num { font-size: 36px; font-weight: 700; }
.score-label { font-size: 12px; color: var(--el-text-color-secondary); }
.audit-risk { display: flex; flex-direction: column; align-items: center; gap: 4px; }
.risk-label { font-size: 12px; color: var(--el-text-color-secondary); }

.audit-issues { margin-top: 8px; }
.issue-list { display: flex; flex-direction: column; gap: 6px; }
.issue-item { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.issue-code { font-family: monospace; color: var(--el-color-danger); font-weight: 500; min-width: 140px; }
.hint-list { margin-top: 8px; display: flex; flex-direction: column; gap: 4px; }
.hint-item { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--el-color-warning); }

/* Review */
.review-actions { }
.review-btns { display: flex; gap: 12px; }

/* Comments */
.comment-list { max-height: 300px; overflow-y: auto; margin-bottom: 12px; }
.comment-item { padding: 10px 12px; border-radius: 6px; margin-bottom: 8px; background: var(--el-fill-color-lighter); }
.comment-system { background: var(--el-color-info-light-9); border-left: 3px solid var(--el-color-info); }
.comment-header { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; font-size: 12px; }
.comment-user { font-weight: 600; color: var(--el-text-color-primary); }
.comment-time { color: var(--el-text-color-placeholder); margin-left: auto; }
.comment-body { font-size: 13px; line-height: 1.5; white-space: pre-wrap; }
.comment-input { border-top: 1px solid var(--el-border-color-lighter); padding-top: 12px; }
</style>
