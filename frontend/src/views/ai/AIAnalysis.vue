<template>
  <div class="ai-analysis-page">
    <!-- 顶部标题栏 -->
    <div class="page-header">
      <el-icon class="header-icon"><MagicStick /></el-icon>
      <div>
        <h1>AI 智能分析中心</h1>
        <p>根因分析 · 异常检测 · 告警降噪 · 智能问答 · 知识库</p>
      </div>
      <el-tag type="success" style="margin-left:auto" size="large">
        <el-icon><CircleCheck /></el-icon> deepseek-r1:1.5b
      </el-tag>
    </div>

    <!-- 功能 Tab -->
    <el-tabs v-model="activeTab" class="ai-tabs" @tab-click="onTabChange">
      <!-- ① 根因分析 RCA -->
      <el-tab-pane label="🔍 根因分析 (RCA)" name="rca">
        <el-card class="section-card">
          <template #header><span class="section-title">触发根因分析</span></template>
          <el-form :model="rcaForm" label-width="120px" inline>
            <el-form-item label="关联告警ID">
              <el-input-number v-model="rcaForm.alert_id" :min="0" placeholder="可选" style="width:140px" />
            </el-form-item>
            <el-form-item label="数据库实例" required>
              <el-select v-model="rcaForm.instance_id" placeholder="选择实例" style="width:200px" filterable>
                <el-option v-for="i in instances" :key="i.INSTANCE_ID"
                  :label="i.INSTANCE_NAME" :value="i.INSTANCE_ID" />
              </el-select>
            </el-form-item>
            <el-form-item label="告警描述" required style="width:100%">
              <el-input v-model="rcaForm.alert_content" type="textarea" :rows="3"
                placeholder="描述告警内容，如：CPU使用率超过90%，持续5分钟..." style="width:600px" />
            </el-form-item>
            <el-form-item>
              <el-button type="primary" :loading="rcaLoading" @click="runRca"
                icon="MagicStick">开始 RCA 分析</el-button>
            </el-form-item>
          </el-form>
        </el-card>

        <!-- RCA 结果 -->
        <el-card v-if="rcaResult" class="section-card result-card">
          <template #header>
            <span class="section-title">分析结论</span>
            <el-tag :type="rcaResult.confidence >= 70 ? 'success' : 'warning'" style="margin-left:12px">
              置信度 {{ rcaResult.confidence?.toFixed?.(0) ?? '-' }}%
            </el-tag>
          </template>
          <div class="rca-result">
            <div class="rca-section">
              <h4>🎯 根因结论</h4>
              <div class="llm-output">{{ rcaResult.root_cause }}</div>
            </div>
            <el-divider />
            <div class="rca-section" v-if="rcaResult.propagation_path?.length">
              <h4>🗺️ 拓扑传导路径</h4>
              <el-steps :active="rcaResult.propagation_path.length" finish-status="success" simple>
                <el-step v-for="(step, i) in rcaResult.propagation_path" :key="i"
                  :title="step.layer" :description="step.component" />
              </el-steps>
            </div>
            <el-divider />
            <div class="rca-section" v-if="rcaResult.anomaly_points && Object.keys(rcaResult.anomaly_points).length">
              <h4>📊 检测到的异常突变点</h4>
              <div v-for="(pts, metric) in rcaResult.anomaly_points" :key="metric" class="anomaly-metric">
                <el-tag type="danger" size="small">{{ metric }}</el-tag>
                <span v-for="(pt, i) in pts" :key="i" class="anomaly-pt">
                  {{ pt.ts?.slice(11,19) }} 值={{ pt.value }} Z={{ pt.z_score }}
                </span>
              </div>
            </div>
          </div>
        </el-card>

        <!-- RCA 历史列表 -->
        <el-card class="section-card">
          <template #header>
            <span class="section-title">分析历史</span>
            <el-button size="small" @click="loadRcaList" style="margin-left:auto">刷新</el-button>
          </template>
          <el-table :data="rcaList" stripe size="small" v-loading="rcaListLoading">
            <el-table-column prop="RCA_ID" label="ID" width="70" />
            <el-table-column prop="INSTANCE_ID" label="实例ID" width="80" />
            <el-table-column prop="ROOT_CAUSE" label="根因结论" show-overflow-tooltip />
            <el-table-column prop="CONFIDENCE" label="置信度" width="90">
              <template #default="{ row }">
                <el-progress :percentage="row.CONFIDENCE || 0" :stroke-width="8"
                  :status="row.CONFIDENCE >= 70 ? 'success' : 'warning'" />
              </template>
            </el-table-column>
            <el-table-column prop="ANALYSIS_TIME" label="分析时间" width="160" />
            <el-table-column label="操作" width="80">
              <template #default="{ row }">
                <el-button size="small" type="primary" link @click="openRcaDetail(row.RCA_ID)">详情</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-tab-pane>

      <!-- ② 异常检测 -->
      <el-tab-pane label="📈 异常检测" name="anomaly">
        <el-card class="section-card">
          <template #header><span class="section-title">无阈值时序异常检测（IsolationForest + MAD + ZScore）</span></template>
          <el-row :gutter="16" align="middle">
            <el-col :span="6">
              <el-select v-model="anomalyForm.instance_id" placeholder="选择实例" filterable>
                <el-option v-for="i in instances" :key="i.INSTANCE_ID"
                  :label="i.INSTANCE_NAME" :value="i.INSTANCE_ID" />
              </el-select>
            </el-col>
            <el-col :span="5">
              <el-input-number v-model="anomalyForm.lookback_minutes" :min="10" :max="1440"
                placeholder="回溯分钟" style="width:100%">
                <template #suffix>分钟</template>
              </el-input-number>
            </el-col>
            <el-col :span="4">
              <el-button type="primary" :loading="anomalyLoading" @click="runAnomalyDetect">
                开始检测
              </el-button>
            </el-col>
            <el-col :span="5">
              <el-select v-model="anomalyFilter.instance_id" placeholder="过滤实例" clearable filterable
                @change="loadAnomalies">
                <el-option v-for="i in instances" :key="i.INSTANCE_ID"
                  :label="i.INSTANCE_NAME" :value="i.INSTANCE_ID" />
              </el-select>
            </el-col>
          </el-row>
        </el-card>

        <el-card class="section-card">
          <template #header>
            <span class="section-title">异常记录</span>
            <el-button size="small" @click="loadAnomalies" style="margin-left:auto">刷新</el-button>
          </template>
          <el-table :data="anomalyList" stripe size="small" v-loading="anomalyListLoading">
            <el-table-column prop="ANOMALY_ID" label="ID" width="70" />
            <el-table-column prop="INSTANCE_ID" label="实例ID" width="80" />
            <el-table-column prop="METRIC_NAME" label="指标" width="130">
              <template #default="{ row }">
                <el-tag size="small">{{ row.METRIC_NAME }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="METRIC_VALUE" label="实际值" width="90" />
            <el-table-column prop="EXPECTED_VALUE" label="预期值" width="90" />
            <el-table-column prop="ANOMALY_SCORE" label="异常分" width="110">
              <template #default="{ row }">
                <el-progress :percentage="Math.round(row.ANOMALY_SCORE || 0)"
                  :status="row.ANOMALY_SCORE >= 80 ? 'exception' : row.ANOMALY_SCORE >= 60 ? 'warning' : ''"
                  :stroke-width="8" />
              </template>
            </el-table-column>
            <el-table-column prop="SEVERITY" label="严重度" width="90">
              <template #default="{ row }">
                <el-tag :type="sevColor(row.SEVERITY)" size="small">{{ row.SEVERITY }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="ALGORITHM" label="算法" width="200" show-overflow-tooltip />
            <el-table-column prop="DETECTED_AT" label="检测时间" width="160" />
          </el-table>
        </el-card>
      </el-tab-pane>

      <!-- ③ 告警聚类降噪 -->
      <el-tab-pane label="🔕 告警降噪" name="cluster">
        <el-card class="section-card">
          <template #header><span class="section-title">相似告警聚类（向量相似度合并）</span></template>
          <el-row :gutter="16" align="middle">
            <el-col :span="6">
              <el-slider v-model="clusterThreshold" :min="0.5" :max="1" :step="0.05"
                show-input :precision="2" />
            </el-col>
            <el-col :span="3">
              <span style="color:#909399">相似度阈值</span>
            </el-col>
            <el-col :span="4">
              <el-button type="warning" :loading="clusterLoading" @click="runCluster">
                执行聚类降噪
              </el-button>
            </el-col>
          </el-row>
          <el-alert v-if="clusterResult" :title="clusterResult" type="success" show-icon
            style="margin-top:12px" />
        </el-card>

        <el-card class="section-card">
          <template #header>
            <span class="section-title">聚类结果</span>
            <el-button size="small" @click="loadClusters" style="margin-left:auto">刷新</el-button>
          </template>
          <el-table :data="clusterList" stripe size="small" v-loading="clusterListLoading">
            <el-table-column prop="CLUSTER_ID" label="聚类ID" width="80" />
            <el-table-column prop="ALERT_COUNT" label="合并数" width="80">
              <template #default="{ row }">
                <el-badge :value="row.ALERT_COUNT" type="danger" />
              </template>
            </el-table-column>
            <el-table-column prop="SIMILARITY_AVG" label="平均相似度" width="110">
              <template #default="{ row }">{{ row.SIMILARITY_AVG }}%</template>
            </el-table-column>
            <el-table-column prop="CLUSTER_REASON" label="聚类原因" show-overflow-tooltip />
            <el-table-column prop="STATUS" label="状态" width="90">
              <template #default="{ row }">
                <el-tag :type="row.STATUS === 'ACTIVE' ? 'warning' : 'info'" size="small">
                  {{ row.STATUS }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="CREATED_AT" label="创建时间" width="160" />
            <el-table-column label="告警IDs" width="120">
              <template #default="{ row }">
                <el-popover placement="right" trigger="hover">
                  <template #reference>
                    <el-button size="small" link>查看</el-button>
                  </template>
                  <div>{{ Array.isArray(row.ALERT_IDS) ? row.ALERT_IDS.join(', ') : row.ALERT_IDS }}</div>
                </el-popover>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-tab-pane>

      <!-- ④ ChatOps 智能问答 -->
      <el-tab-pane label="💬 智能问答" name="chat">
        <el-card class="section-card chat-card">
          <template #header>
            <span class="section-title">ChatOps 自然语言运维问答</span>
            <el-select v-model="chatInstanceId" placeholder="关联实例（可选）" clearable
              filterable size="small" style="width:200px;margin-left:12px">
              <el-option v-for="i in instances" :key="i.INSTANCE_ID"
                :label="i.INSTANCE_NAME" :value="i.INSTANCE_ID" />
            </el-select>
            <el-button size="small" style="margin-left:8px" @click="newChatSession">
              新对话
            </el-button>
          </template>

          <div class="chat-layout">
            <aside class="chat-session-rail" aria-label="历史会话">
              <div class="chat-session-rail-head">
                <span class="chat-session-rail-title">历史会话</span>
                <el-button type="primary" link size="small" @click="loadChatSessionList">刷新</el-button>
              </div>
              <div
                class="chat-session-list"
                v-loading="chatSessionListLoading"
                element-loading-background="rgba(255,255,255,0.6)"
              >
                <div
                  v-for="s in chatSessions"
                  :key="s.SESSION_ID || s.session_id"
                  :class="['chat-session-item', { active: (s.SESSION_ID || s.session_id) === chatSessionId }]"
                  @click="selectChatSession(s.SESSION_ID || s.session_id)"
                >
                  <div class="chat-session-preview">
                    {{ truncateText(s.PREVIEW || s.preview || '（无首问）', 48) }}
                  </div>
                  <div class="chat-session-meta">
                    {{ formatSessionTime(s.LAST_TIME || s.last_time) }}
                  </div>
                </div>
                <div v-if="!chatSessionListLoading && chatSessions.length === 0" class="chat-session-empty">
                  暂无会话记录
                </div>
              </div>
            </aside>

            <div class="chat-main">
              <!-- 消息区 -->
              <div class="chat-messages" ref="chatScrollRef">
                <div v-if="chatMessages.length === 0" class="chat-empty">
                  <el-icon size="40" color="#c0c4cc"><ChatDotRound /></el-icon>
                  <p>向 AI 提问，例如：</p>
                  <el-space wrap>
                    <el-tag v-for="q in suggestedQuestions" :key="q" type="info" size="large"
                      style="cursor:pointer" @click="askSuggested(q)">{{ q }}</el-tag>
                  </el-space>
                </div>

                <div v-for="(msg, i) in chatMessages" :key="i"
                  :class="['chat-bubble', msg.role === 'user' ? 'user-bubble' : 'ai-bubble']">
                  <div class="bubble-avatar">
                    <span v-if="msg.role === 'user'">👤</span>
                    <span v-else>🤖</span>
                  </div>
                  <div class="bubble-content">
                    <div class="bubble-text" v-html="formatChatText(msg.content || msg.CONTENT)" />
                    <div v-if="msg.retrieved_docs?.length" class="retrieved-docs">
                      <el-divider content-position="left">参考知识库</el-divider>
                      <el-tag v-for="d in msg.retrieved_docs" :key="d.title"
                        type="info" size="small" style="margin:2px">
                        {{ d.title }} ({{ (d.similarity * 100).toFixed(0) }}%)
                      </el-tag>
                    </div>
                  </div>
                </div>

                <div v-if="chatLoading" class="chat-bubble ai-bubble">
                  <div class="bubble-avatar">🤖</div>
                  <div class="bubble-content">
                    <el-skeleton :rows="2" animated />
                  </div>
                </div>
              </div>

              <!-- 输入区 -->
              <div class="chat-input-area">
                <el-input v-model="chatInput" class="chat-input-grow" type="textarea" :rows="2"
                  placeholder="输入运维问题，如：这个数据库为什么慢？帮我分析锁等待原因..."
                  @keydown.ctrl.enter="sendChat" resize="none" />
                <el-button class="chat-send-btn" circle :loading="chatLoading" @click="sendChat"
                  :disabled="!chatInput.trim()" title="发送（Ctrl+Enter）">
                  <el-icon v-if="!chatLoading" :size="20"><Top /></el-icon>
                </el-button>
              </div>
            </div>
          </div>
        </el-card>
      </el-tab-pane>

      <!-- ⑤ 知识库管理 -->
      <el-tab-pane label="📚 知识库" name="knowledge">
        <el-card class="section-card">
          <template #header>
            <span class="section-title">知识库管理（RAG 检索增强）</span>
            <el-button type="primary" size="small" style="margin-left:auto"
              @click="showAddKnowledge = true">新增知识</el-button>
          </template>

          <!-- 搜索 -->
          <el-row :gutter="12" style="margin-bottom:12px">
            <el-col :span="14">
              <el-input v-model="kbSearchQuery" placeholder="语义检索知识库..." clearable
                @keydown.enter="searchKnowledge">
                <template #append>
                  <el-button @click="searchKnowledge" icon="Search">检索</el-button>
                </template>
              </el-input>
            </el-col>
            <el-col :span="5">
              <el-select v-model="kbDocTypeFilter" placeholder="文档类型" clearable @change="loadKnowledge">
                <el-option label="SQL优化案例" value="SQL_CASE" />
                <el-option label="故障处理经验" value="EXPERIENCE" />
                <el-option label="运维手册" value="MANUAL" />
                <el-option label="FAQ" value="FAQ" />
              </el-select>
            </el-col>
            <el-col :span="5">
              <el-upload action="" :before-upload="uploadKnowledgeFile" :show-file-list="false"
                accept=".txt,.md,.log,.pdf,.docx">
                <el-button icon="Upload">上传文件</el-button>
              </el-upload>
            </el-col>
          </el-row>

          <!-- 检索结果 -->
          <div v-if="kbSearchResults.length" style="margin-bottom:16px">
            <el-alert title="语义检索结果" type="info" show-icon :closable="false" />
            <div v-for="r in kbSearchResults" :key="r.chunk_id" class="kb-search-result">
              <div class="kb-result-header">
                <el-tag type="success" size="small">{{ (r.similarity * 100).toFixed(0) }}% 相似</el-tag>
                <span class="kb-result-title">{{ r.doc_title }}</span>
                <el-tag size="small">{{ r.doc_type }}</el-tag>
              </div>
              <div class="kb-result-snippet">{{ r.chunk_text?.slice(0, 200) }}...</div>
            </div>
            <el-button size="small" @click="kbSearchResults = []">清除结果</el-button>
          </div>

          <!-- 文档列表 -->
          <el-table :data="knowledgeList" stripe size="small" v-loading="knowledgeLoading">
            <el-table-column prop="DOC_ID" label="ID" width="70" />
            <el-table-column prop="TITLE" label="标题" show-overflow-tooltip />
            <el-table-column prop="DOC_TYPE" label="类型" width="120">
              <template #default="{ row }">
                <el-tag :type="docTypeColor(row.DOC_TYPE)" size="small">{{ row.DOC_TYPE }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="TAGS" label="标签" show-overflow-tooltip width="180" />
            <el-table-column prop="CHUNK_COUNT" label="分块数" width="80" />
            <el-table-column prop="SOURCE" label="来源" width="120" show-overflow-tooltip />
            <el-table-column prop="CREATED_AT" label="创建时间" width="160" />
            <el-table-column label="操作" width="140">
              <template #default="{ row }">
                <el-button size="small" type="primary" link @click="reindexDoc(row.DOC_ID)">
                  重建索引
                </el-button>
                <el-button size="small" type="danger" link @click="deleteDoc(row.DOC_ID)">
                  删除
                </el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-tab-pane>
    </el-tabs>

    <!-- 新增知识对话框 -->
    <el-dialog v-model="showAddKnowledge" title="新增知识文档" width="700px">
      <el-form :model="newDocForm" label-width="90px">
        <el-form-item label="标题" required>
          <el-input v-model="newDocForm.title" placeholder="知识文档标题" />
        </el-form-item>
        <el-form-item label="类型">
          <el-select v-model="newDocForm.doc_type">
            <el-option label="SQL优化案例" value="SQL_CASE" />
            <el-option label="故障处理经验" value="EXPERIENCE" />
            <el-option label="运维手册" value="MANUAL" />
            <el-option label="FAQ" value="FAQ" />
          </el-select>
        </el-form-item>
        <el-form-item label="标签">
          <el-input v-model="newDocForm.tags" placeholder="逗号分隔，如：索引,优化,Oracle" />
        </el-form-item>
        <el-form-item label="内容" required>
          <el-input v-model="newDocForm.content" type="textarea" :rows="10"
            placeholder="输入知识文档内容..." />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showAddKnowledge = false">取消</el-button>
        <el-button type="primary" :loading="addDocLoading" @click="submitNewDoc">
          提交并向量化索引
        </el-button>
      </template>
    </el-dialog>

    <!-- RCA 详情对话框 -->
    <el-dialog v-model="rcaDetailVisible" title="RCA 详情" width="760px">
      <div v-if="rcaDetailData" class="rca-detail-dialog">
        <el-descriptions :column="2" border size="small">
          <el-descriptions-item label="RCA ID">{{ rcaDetailData.RCA_ID }}</el-descriptions-item>
          <el-descriptions-item label="实例ID">{{ rcaDetailData.INSTANCE_ID }}</el-descriptions-item>
          <el-descriptions-item label="置信度">{{ rcaDetailData.CONFIDENCE }}%</el-descriptions-item>
          <el-descriptions-item label="分析时间">{{ rcaDetailData.ANALYSIS_TIME }}</el-descriptions-item>
        </el-descriptions>
        <el-divider>根因 & 处置建议</el-divider>
        <div class="llm-output" style="max-height:400px;overflow-y:auto">
          {{ rcaDetailData.RECOMMENDATIONS }}
        </div>
      </div>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted, nextTick, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { MagicStick, CircleCheck, ChatDotRound, Top } from '@element-plus/icons-vue'
import axios from 'axios'

const API = axios.create({ baseURL: '/api', timeout: 180000 })
API.interceptors.request.use(cfg => {
  const token = localStorage.getItem('token')
  if (token) cfg.headers.Authorization = `Bearer ${token}`
  return cfg
})

// ─── 全局状态 ──────────────────────────────────────────────────
const activeTab = ref('rca')
const instances = ref([])

// ─── RCA ──────────────────────────────────────────────────────
const rcaForm = reactive({ alert_id: 0, instance_id: null, alert_content: '' })
const rcaLoading = ref(false)
const rcaResult = ref(null)
const rcaList = ref([])
const rcaListLoading = ref(false)
const rcaDetailVisible = ref(false)
const rcaDetailData = ref(null)

async function runRca() {
  if (!rcaForm.instance_id || !rcaForm.alert_content) {
    return ElMessage.warning('请选择实例并填写告警描述')
  }
  rcaLoading.value = true
  rcaResult.value = null
  try {
    const { data } = await API.post('/ai/rca', rcaForm)
    if (data.code === 200) {
      ElMessage.success('RCA 分析完成')
      // 加载详情
      const detail = await API.get(`/ai/rca/${data.data.rca_id}`)
      if (detail.data.code === 200) rcaResult.value = detail.data.data
      loadRcaList()
    } else {
      ElMessage.error(data.msg || 'RCA 分析失败')
    }
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    rcaLoading.value = false
  }
}

async function loadRcaList() {
  rcaListLoading.value = true
  try {
    const { data } = await API.get('/ai/rca/list', { params: { limit: 30 } })
    if (data.code === 200) rcaList.value = data.data || []
  } finally {
    rcaListLoading.value = false
  }
}

async function openRcaDetail(id) {
  const { data } = await API.get(`/ai/rca/${id}`)
  if (data.code === 200) {
    rcaDetailData.value = data.data
    rcaDetailVisible.value = true
  }
}

// ─── 异常检测 ──────────────────────────────────────────────────
const anomalyForm = reactive({ instance_id: null, lookback_minutes: 60 })
const anomalyFilter = reactive({ instance_id: null })
const anomalyLoading = ref(false)
const anomalyList = ref([])
const anomalyListLoading = ref(false)

async function runAnomalyDetect() {
  if (!anomalyForm.instance_id) return ElMessage.warning('请选择实例')
  anomalyLoading.value = true
  try {
    const { data } = await API.post('/ai/anomaly/detect', anomalyForm)
    if (data.code === 200) {
      ElMessage.success(`检测完成，发现 ${data.data.detected_count} 个异常`)
      loadAnomalies()
    } else {
      ElMessage.error(data.msg)
    }
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    anomalyLoading.value = false
  }
}

async function loadAnomalies() {
  anomalyListLoading.value = true
  const params = { limit: 50 }
  if (anomalyFilter.instance_id) params.instance_id = anomalyFilter.instance_id
  try {
    const { data } = await API.get('/ai/anomaly', { params })
    if (data.code === 200) anomalyList.value = data.data || []
  } finally {
    anomalyListLoading.value = false
  }
}

function sevColor(sev) {
  return { CRITICAL: 'danger', HIGH: 'warning', MEDIUM: '', LOW: 'info' }[sev] || ''
}

// ─── 告警聚类 ──────────────────────────────────────────────────
const clusterThreshold = ref(0.75)
const clusterLoading = ref(false)
const clusterResult = ref('')
const clusterList = ref([])
const clusterListLoading = ref(false)

async function runCluster() {
  clusterLoading.value = true
  clusterResult.value = ''
  try {
    const { data } = await API.post('/ai/cluster', { similarity_threshold: clusterThreshold.value })
    if (data.code === 200) {
      clusterResult.value = `聚类完成！合并为 ${data.data.cluster_count} 个告警簇，减少重复处理`
      loadClusters()
    } else {
      ElMessage.error(data.msg)
    }
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    clusterLoading.value = false
  }
}

async function loadClusters() {
  clusterListLoading.value = true
  try {
    const { data } = await API.get('/ai/cluster', { params: { status: 'ACTIVE', limit: 50 } })
    if (data.code === 200) clusterList.value = data.data || []
  } finally {
    clusterListLoading.value = false
  }
}

// ─── ChatOps ──────────────────────────────────────────────────
const chatInput = ref('')
const chatLoading = ref(false)
const chatMessages = ref([])
const chatSessionId = ref('')
const chatInstanceId = ref(null)
const chatScrollRef = ref(null)
const chatSessions = ref([])
const chatSessionListLoading = ref(false)

const suggestedQuestions = [
  '这个数据库为什么慢？',
  '帮我优化这条SQL',
  '如何排查锁等待问题？',
  'CPU高负载的原因是什么？',
  'Oracle内存如何调优？',
]

function newChatSession() {
  chatSessionId.value = 'session_' + Date.now()
  chatMessages.value = []
}

function truncateText(s, maxLen) {
  const t = (s == null ? '' : String(s)).replace(/\s+/g, ' ').trim()
  if (t.length <= maxLen) return t
  return t.slice(0, maxLen) + '…'
}

function formatSessionTime(t) {
  if (t == null || t === '') return ''
  try {
    const d = new Date(t)
    if (Number.isNaN(d.getTime())) return String(t).slice(0, 16)
    return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

function isApiOk(payload) {
  return payload != null && Number(payload.code) === 200
}

/** 兼容 Oracle/代理返回大小写不一致的字段名 */
function normalizeChatSessionRow(s) {
  const o = s || {}
  return {
    SESSION_ID: o.SESSION_ID ?? o.session_id ?? '',
    LAST_TIME: o.LAST_TIME ?? o.last_time,
    PREVIEW: o.PREVIEW ?? o.preview,
  }
}

async function loadChatSessionList() {
  chatSessionListLoading.value = true
  try {
    const { data } = await API.get('/ai/chat/sessions', { params: { limit: 40 } })
    if (isApiOk(data) && data.data != null) {
      const raw = Array.isArray(data.data) ? data.data : []
      chatSessions.value = raw.map(normalizeChatSessionRow).filter((x) => x.SESSION_ID)
    } else {
      chatSessions.value = []
    }
  } catch {
    chatSessions.value = []
  } finally {
    chatSessionListLoading.value = false
  }
}

function selectChatSession(sid) {
  if (!sid) return
  chatSessionId.value = sid
  loadChatHistory()
}

/** 将后端 AI_CHAT_HISTORY 行转为气泡展示结构 */
function mapChatHistoryRow(row) {
  const r = row || {}
  const roleRaw = String(r.ROLE ?? r.role ?? '').toLowerCase()
  const role = roleRaw === 'user' ? 'user' : 'assistant'
  const content = r.CONTENT ?? r.content ?? ''
  let retrieved_docs
  if (role === 'assistant') {
    const raw = r.RETRIEVED_DOCS ?? r.retrieved_docs
    if (raw) {
      try {
        const arr = typeof raw === 'string' ? JSON.parse(raw) : raw
        if (Array.isArray(arr)) {
          retrieved_docs = arr.map((x) => ({
            title: x.title || '',
            similarity:
              typeof x.similarity === 'number'
                ? x.similarity
                : typeof x.sim === 'number'
                  ? x.sim
                  : 0,
          }))
        }
      } catch {
        retrieved_docs = undefined
      }
    }
  }
  return { role, content, retrieved_docs }
}

/** 从服务端加载当前会话历史（切换回智能问答 Tab 时与 DB 对齐） */
async function loadChatHistory() {
  const sid = chatSessionId.value
  if (!sid) return
  try {
    const { data } = await API.get(`/ai/chat/${encodeURIComponent(sid)}`, { params: { limit: 50 } })
    if (!isApiOk(data) || !Array.isArray(data.data)) return
    chatMessages.value = data.data.map(mapChatHistoryRow)
    await nextTick()
    scrollChat()
  } catch {
    /* 忽略拉取失败，保留本地已有消息 */
  }
}

async function sendChat() {
  if (!chatInput.value.trim()) return
  if (!chatSessionId.value) newChatSession()

  const q = chatInput.value.trim()
  chatMessages.value.push({ role: 'user', content: q })
  chatInput.value = ''
  chatLoading.value = true
  await nextTick()
  scrollChat()

  try {
    const { data } = await API.post('/ai/chat', {
      question: q,
      session_id: chatSessionId.value,
      instance_id: chatInstanceId.value || null,
    })
    if (data.code === 200) {
      if (data.data?.session_id) chatSessionId.value = data.data.session_id
      chatMessages.value.push({
        role: 'assistant',
        content: data.data.answer,
        retrieved_docs: data.data.retrieved_docs,
      })
    } else {
      chatMessages.value.push({ role: 'assistant', content: `[错误] ${data.msg}` })
    }
  } catch (e) {
    chatMessages.value.push({ role: 'assistant', content: `[请求失败] ${e.message}` })
  } finally {
    chatLoading.value = false
    await nextTick()
    scrollChat()
    loadChatSessionList()
  }
}

function askSuggested(q) {
  chatInput.value = q
  sendChat()
}

function scrollChat() {
  if (chatScrollRef.value) chatScrollRef.value.scrollTop = chatScrollRef.value.scrollHeight
}

function formatChatText(text) {
  if (!text) return ''
  // 简单 Markdown-like 格式化
  return text
    .replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\n/g, '<br>')
}

// ─── 知识库 ──────────────────────────────────────────────────
const knowledgeList = ref([])
const knowledgeLoading = ref(false)
const kbDocTypeFilter = ref('')
const kbSearchQuery = ref('')
const kbSearchResults = ref([])
const showAddKnowledge = ref(false)
const addDocLoading = ref(false)
const newDocForm = reactive({ title: '', content: '', doc_type: 'EXPERIENCE', tags: '', source: '' })

async function loadKnowledge() {
  knowledgeLoading.value = true
  kbSearchResults.value = []
  const params = {}
  if (kbDocTypeFilter.value) params.doc_type = kbDocTypeFilter.value
  try {
    const { data } = await API.get('/ai/knowledge', { params })
    if (data.code === 200) knowledgeList.value = data.data || []
  } finally {
    knowledgeLoading.value = false
  }
}

async function searchKnowledge() {
  if (!kbSearchQuery.value.trim()) return loadKnowledge()
  knowledgeLoading.value = true
  try {
    const { data } = await API.get('/ai/knowledge/search', {
      params: { q: kbSearchQuery.value, top_k: 5 }
    })
    if (data.code === 200) kbSearchResults.value = data.data || []
  } finally {
    knowledgeLoading.value = false
  }
}

async function submitNewDoc() {
  if (!newDocForm.title || !newDocForm.content) return ElMessage.warning('标题和内容不能为空')
  addDocLoading.value = true
  try {
    const { data } = await API.post('/ai/knowledge', newDocForm)
    if (data.code === 200) {
      ElMessage.success(`文档已添加，ID=${data.data.doc_id}，向量化索引完成`)
      showAddKnowledge.value = false
      Object.assign(newDocForm, { title: '', content: '', doc_type: 'EXPERIENCE', tags: '', source: '' })
      loadKnowledge()
    } else {
      ElMessage.error(data.msg)
    }
  } finally {
    addDocLoading.value = false
  }
}

async function uploadKnowledgeFile(file) {
  const formData = new FormData()
  formData.append('file', file)
  try {
    const { data } = await API.post(
      `/ai/knowledge/upload?doc_type=MANUAL`,
      formData,
      { headers: { 'Content-Type': 'multipart/form-data' } }
    )
    if (Number(data?.code) === 200) {
      ElMessage.success(data.msg || `文件「${file.name}」上传成功，已建立索引`)
      loadKnowledge()
    } else {
      ElMessage.error(data?.msg || '上传失败')
    }
  } catch (e) {
    ElMessage.error(e.message)
  }
  return false // 阻止默认上传
}

async function reindexDoc(docId) {
  try {
    const { data } = await API.post(`/ai/knowledge/${docId}/reindex`)
    if (Number(data?.code) === 200) {
      ElMessage.success(data.msg || '重建索引成功')
    } else {
      ElMessage.error(data?.msg || '重建索引失败')
    }
  } catch (e) {
    ElMessage.error(e.message)
  }
}

async function deleteDoc(docId) {
  await ElMessageBox.confirm('确认删除该知识文档及其所有向量块？', '删除确认', { type: 'warning' })
  try {
    const { data } = await API.delete(`/ai/knowledge/${docId}`)
    data.code === 200 ? ElMessage.success('删除成功') : ElMessage.error(data.msg)
    loadKnowledge()
  } catch (e) {
    if (e !== 'cancel') ElMessage.error(e.message)
  }
}

function docTypeColor(t) {
  return { SQL_CASE: 'success', EXPERIENCE: 'warning', MANUAL: '', FAQ: 'info' }[t] || ''
}

// ─── Tab切换加载数据 ────────────────────────────────────────────
function onTabChange({ paneName }) {
  if (paneName === 'rca') loadRcaList()
  else if (paneName === 'anomaly') loadAnomalies()
  else if (paneName === 'cluster') loadClusters()
  else if (paneName === 'knowledge') loadKnowledge()
}

// ─── 初始化 ─────────────────────────────────────────────────────
async function loadInstances() {
  try {
    const { data } = await API.get('/cmdb/instances', { params: { size: 200 } })
    if (data.code === 200) instances.value = data.data?.list || data.data || []
  } catch {}
}

watch(activeTab, (name) => {
  if (name === 'chat') {
    loadChatSessionList()
    loadChatHistory()
  }
})

onMounted(() => {
  loadInstances()
  loadRcaList()
  newChatSession()
  loadChatSessionList()
})
</script>

<style scoped>
.ai-analysis-page {
  padding: 20px;
  background: var(--el-bg-color-page, #f5f7fa);
  min-height: 100vh;
}

.page-header {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 20px 24px;
  background: linear-gradient(135deg, #1a73e8 0%, #0d47a1 100%);
  border-radius: 12px;
  margin-bottom: 20px;
  color: #fff;
}

.header-icon { font-size: 40px; color: #fff; }
.page-header h1 { margin: 0; font-size: 22px; font-weight: 700; }
.page-header p  { margin: 4px 0 0; font-size: 13px; opacity: 0.85; }

.ai-tabs { background: transparent; }
.ai-tabs :deep(.el-tabs__header) { margin-bottom: 0; }
.ai-tabs :deep(.el-tabs__nav-wrap) {
  background: #fff;
  border-radius: 8px 8px 0 0;
  padding: 0 16px;
}

.section-card {
  margin-bottom: 16px;
  border-radius: 8px;
  box-shadow: 0 2px 8px rgba(0,0,0,.06);
}

.section-title { font-size: 15px; font-weight: 600; color: #303133; }

/* RCA */
.result-card { border-left: 4px solid #1a73e8; }
.rca-result { padding: 4px 8px; }
.rca-section { margin-bottom: 12px; }
.rca-section h4 { margin: 0 0 10px; color: #303133; font-size: 14px; }
.llm-output {
  background: #f8f9fa;
  border-radius: 6px;
  padding: 14px;
  font-size: 13.5px;
  line-height: 1.8;
  white-space: pre-wrap;
  word-break: break-word;
  color: #303133;
  border-left: 3px solid #1a73e8;
}
.anomaly-metric { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; flex-wrap: wrap; }
.anomaly-pt {
  background: #fff3f3;
  border: 1px solid #fda39a;
  border-radius: 4px;
  padding: 2px 8px;
  font-size: 12px;
  color: #c0392b;
}

/* Chat */
.chat-card :deep(.el-card__body) {
  padding: 0;
  display: flex;
  flex-direction: column;
  min-height: 520px;
}
.chat-layout {
  display: flex;
  flex: 1;
  min-height: 0;
  align-items: stretch;
}
.chat-session-rail {
  width: 248px;
  flex-shrink: 0;
  border-right: 1px solid #ebeef5;
  background: #f5f7fa;
  display: flex;
  flex-direction: column;
  min-height: 480px;
  max-height: 640px;
}
.chat-session-rail-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-bottom: 1px solid #ebeef5;
  flex-shrink: 0;
}
.chat-session-rail-title {
  font-size: 13px;
  font-weight: 600;
  color: #303133;
}
.chat-session-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
  min-height: 0;
}
.chat-session-item {
  padding: 10px 10px;
  margin-bottom: 6px;
  border-radius: 8px;
  cursor: pointer;
  border: 1px solid transparent;
  background: #fff;
  transition: background 0.15s, border-color 0.15s;
}
.chat-session-item:hover {
  background: #ecf5ff;
}
.chat-session-item.active {
  border-color: #1a73e8;
  background: #e8f1fc;
}
.chat-session-preview {
  font-size: 12px;
  color: #303133;
  line-height: 1.45;
  word-break: break-word;
}
.chat-session-meta {
  font-size: 11px;
  color: #909399;
  margin-top: 4px;
}
.chat-session-empty {
  font-size: 12px;
  color: #909399;
  text-align: center;
  padding: 24px 8px;
}
.chat-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.chat-messages {
  flex: 1;
  min-height: 280px;
  max-height: 500px;
  overflow-y: auto;
  padding: 20px;
  background: #fafafa;
}
.chat-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 40px;
  color: #909399;
}
.chat-bubble {
  display: flex;
  gap: 12px;
  margin-bottom: 16px;
}
.user-bubble { flex-direction: row-reverse; }
.bubble-avatar { font-size: 24px; flex-shrink: 0; }
.bubble-content { max-width: 75%; }
.bubble-text {
  background: #fff;
  border-radius: 12px;
  padding: 12px 16px;
  font-size: 14px;
  line-height: 1.7;
  box-shadow: 0 1px 4px rgba(0,0,0,.08);
}
.user-bubble .bubble-text {
  background: #1a73e8;
  color: #fff;
  border-radius: 12px 2px 12px 12px;
}
/* AI 回复：加深文字与底色对比，避免浅灰字看不清 */
.ai-bubble .bubble-text {
  background: #e8edf5;
  color: #1a1d26;
  border: 1px solid #d5dde8;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06);
}
.ai-bubble .bubble-text :deep(strong) {
  color: #0f1219;
  font-weight: 600;
}
.ai-bubble .bubble-text :deep(code) {
  background: rgba(15, 18, 25, 0.08);
  color: #111827;
  padding: 1px 5px;
  border-radius: 3px;
  font-family: ui-monospace, monospace;
}
.bubble-text code {
  background: rgba(0,0,0,.06);
  padding: 1px 5px;
  border-radius: 3px;
  font-family: monospace;
}
.user-bubble .bubble-text code { background: rgba(255,255,255,.2); }
.retrieved-docs { margin-top: 8px; }

.chat-input-area {
  display: flex;
  align-items: flex-end;
  gap: 10px;
  padding: 16px;
  border-top: 1px solid #ebeef5;
  background: #fff;
}
.chat-input-grow { flex: 1; min-width: 0; }
.chat-input-area :deep(.el-textarea__inner) { border-radius: 8px; }
/* 图二：圆形发送，浅紫蓝底 + 白箭头，逻辑仍为点击 / Ctrl+Enter */
.chat-send-btn {
  flex-shrink: 0;
  width: 44px;
  height: 44px;
  padding: 0;
  border: none;
  background: linear-gradient(180deg, #c9d2ff 0%, #aeb8f0 100%);
  color: #fff;
}
.chat-send-btn:hover:not(:disabled) {
  background: linear-gradient(180deg, #bac6ff 0%, #9da8e8 100%);
  color: #fff;
}
.chat-send-btn:focus-visible {
  outline: 2px solid #7c8fd4;
  outline-offset: 2px;
}
.chat-send-btn.is-disabled {
  opacity: 0.45;
}

/* Knowledge */
.kb-search-result {
  background: #f0f9eb;
  border: 1px solid #b3e19d;
  border-radius: 6px;
  padding: 10px 14px;
  margin-bottom: 8px;
}
.kb-result-header { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.kb-result-title { font-weight: 600; font-size: 13px; flex: 1; }
.kb-result-snippet { font-size: 12.5px; color: #606266; line-height: 1.6; }
</style>
