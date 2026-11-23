<template>
  <div class="sql-opt">
    <el-tabs v-model="tab" class="opt-tabs" @tab-change="onTab">
      <!-- ============================================================ 规则优化 -->
      <el-tab-pane label="规则优化" name="rule">
        <div v-if="optStats && optStats.total" class="opt-stats text-gray">
          近 {{ optStats.days }} 天优化 <b>{{ optStats.total }}</b> 次
          · 规则 {{ optStats.byMode?.rule || 0 }} / AI {{ optStats.byMode?.ai || 0 }}
          <template v-if="optStats.adoptRate != null"> · 采纳率 <b>{{ optStats.adoptRate }}%</b></template>
          <template v-if="optStats.avgImprovePct != null"> · 已验证 {{ optStats.measured }} 条，平均提速 <b>{{ optStats.avgImprovePct }}%</b></template>
          <el-button link type="primary" size="small" @click="exportOpt">导出记录 CSV</el-button>
        </div>
        <div class="rule-layout">
          <div class="card rule-input">
            <div class="input-bar">
              <el-select v-model="ruleInst" placeholder="目标实例（可选，用于执行计划和元数据）" clearable filterable size="small" style="width: 260px">
                <el-option v-for="i in supportedInstances" :key="i.INSTANCE_ID" :label="`${i.INSTANCE_NAME}（${i.DB_TYPE}）`" :value="i.INSTANCE_ID" />
              </el-select>
              <el-select v-if="!ruleInst" v-model="ruleDbType" size="small" style="width: 130px">
                <el-option v-for="t in DB_TYPES" :key="t" :label="t" :value="t" />
              </el-select>
              <el-input v-model="ruleSchema" placeholder="Schema（可选）" size="small" style="width: 140px" clearable />
            </div>
            <el-input v-model="ruleSql" type="textarea" :rows="12" class="mono" placeholder="粘贴要优化的 SQL（一次一条）" />
            <div class="input-actions">
              <el-button type="primary" :loading="optimizing" icon="MagicStick" @click="runRule()">规则优化</el-button>
              <el-button :disabled="!ruleSql.trim()" @click="toAi(ruleSql, aiPromptFromResult())">交给 AI 深度优化</el-button>
              <el-button :disabled="!result" @click="saveHistory">保存到优化记录</el-button>
              <span class="text-gray hint">规则引擎：审核 → 执行计划 → 索引建议 → 等价改写 → 改写前后计划对比；结果可复现，不依赖大模型</span>
            </div>
          </div>

          <el-alert v-if="precheck && (precheck.errors.length || precheck.warnings.length)" class="precheck"
            :type="precheck.ok ? 'warning' : 'error'" :closable="false" show-icon
            :title="precheck.ok ? 'SQL 预检提示' : `SQL 预检未通过（所选数据库：${effectiveDbType}）`">
            <div v-for="e in precheck.errors" :key="e">❌ {{ e }}</div>
            <div v-for="w in precheck.warnings" :key="w">⚠ {{ w }}</div>
            <div v-if="!precheck.ok" style="margin-top: 6px">
              <el-button size="small" @click="forceRun">仍然继续优化</el-button>
              <span class="text-gray" style="margin-left: 8px">请确认上方“数据库类型/实例”选择是否正确</span>
            </div>
          </el-alert>

          <div v-if="result" class="card rule-result" v-loading="optimizing">
            <div class="result-head">
              <el-tag :type="riskType(result.risk)" effect="dark">{{ result.risk || '-' }}</el-tag>
              <span class="score">评分 {{ result.score ?? '-' }}</span>
              <span class="text-gray">{{ result.dbType }} · {{ result.stmtType }}</span>
              <span v-if="result.assetId" class="text-gray">· SQL 资产 #{{ result.assetId }}</span>
              <el-tag v-if="result.metadataError" type="warning" size="small">元数据不可用：{{ result.metadataError }}</el-tag>
              <el-tag v-if="!result.instanceId" type="info" size="small">未选实例：仅静态分析，无执行计划和元数据</el-tag>
            </div>

            <h4>处理建议（按优先级）</h4>
            <el-empty v-if="!(result.actions || []).length" description="没有发现需要处理的问题" :image-size="60" />
            <ol class="actions">
              <li v-for="(a, i) in result.actions" :key="i">
                <el-tag size="small" :type="a.priority === 1 ? 'danger' : a.priority === 2 ? 'warning' : 'info'">P{{ a.priority }} {{ ACTION_LABEL[a.type] || a.type }}</el-tag>
                <span class="action-text">{{ a.text }}</span>
              </li>
            </ol>

            <el-collapse v-model="openPanels">
              <el-collapse-item :title="`审核问题（${(result.audit?.issues || []).length}）`" name="issues">
                <el-table :data="result.audit?.issues || []" size="small" stripe>
                  <el-table-column prop="severity" label="级别" width="90">
                    <template #default="{ row }"><el-tag size="small" :type="sevType(row.severity)">{{ row.severity }}</el-tag></template>
                  </el-table-column>
                  <el-table-column prop="code" label="规则" width="80" />
                  <el-table-column prop="message" label="问题" min-width="220" show-overflow-tooltip />
                  <el-table-column prop="suggestion" label="建议" min-width="220" show-overflow-tooltip />
                </el-table>
              </el-collapse-item>

              <el-collapse-item :title="`索引建议（${(result.indexAdvice || []).length}）`" name="index">
                <el-table :data="result.indexAdvice || []" size="small" stripe>
                  <el-table-column label="表" width="160" show-overflow-tooltip>
                    <template #default="{ row }">{{ row.schema ? row.schema + '.' : '' }}{{ row.table }}</template>
                  </el-table-column>
                  <el-table-column label="列" width="200">
                    <template #default="{ row }">{{ (row.columns || []).join(', ') }}</template>
                  </el-table-column>
                  <el-table-column label="置信度" width="80">
                    <template #default="{ row }"><el-tag size="small" :type="row.confidence === 'HIGH' ? 'success' : row.confidence === 'MEDIUM' ? 'warning' : 'info'">{{ row.confidence }}</el-tag></template>
                  </el-table-column>
                  <el-table-column label="行数" width="100"><template #default="{ row }">{{ row.rows ?? '-' }}</template></el-table-column>
                  <el-table-column prop="reason" label="依据" min-width="200" show-overflow-tooltip />
                  <el-table-column label="DDL" min-width="260">
                    <template #default="{ row }">
                      <template v-if="row.ddl">
                        <code class="ddl">{{ row.ddl }}</code>
                        <el-button link type="primary" size="small" @click="copy(row.ddl)">复制</el-button>
                      </template>
                      <span v-else class="text-gray">无需新建</span>
                    </template>
                  </el-table-column>
                </el-table>
                <p class="text-gray small">建索引前确认写入负载；DDL 按方言使用在线方式（Oracle ONLINE / PG·磐维 CONCURRENTLY / MySQL INPLACE），请在维护窗口经评审后执行。</p>
              </el-collapse-item>

              <el-collapse-item :title="`改写（${(result.rewrites || []).length}）`" name="rewrite">
                <el-table :data="result.rewrites || []" size="small" stripe>
                  <el-table-column prop="code" label="编号" width="72" />
                  <el-table-column prop="title" label="改写" width="170" />
                  <el-table-column label="方式" width="90">
                    <template #default="{ row }"><el-tag size="small" :type="row.applied ? 'success' : 'info'">{{ row.applied ? '已改写' : '建议' }}</el-tag></template>
                  </el-table-column>
                  <el-table-column prop="reason" label="原因" min-width="200" show-overflow-tooltip />
                  <el-table-column prop="suggestion" label="做法" min-width="220" show-overflow-tooltip />
                </el-table>
                <template v-if="result.rewrittenSql">
                  <div class="sub-title">
                    规则改写后 SQL
                    <el-button link type="primary" size="small" @click="copy(result.rewrittenSql)">复制</el-button>
                    <el-button link type="primary" size="small" @click="reanalyze">用改写后 SQL 再分析</el-button>
                  </div>
                  <pre class="code">{{ result.rewrittenSql }}</pre>
                </template>
              </el-collapse-item>

              <el-collapse-item title="执行计划" name="plan">
                <div v-if="!result.plan?.text" class="text-gray">没有执行计划（未选实例，或目标库执行 EXPLAIN 失败）</div>
                <div v-else class="plan-grid">
                  <div>
                    <div class="sub-title">原 SQL <span class="text-gray">代价 {{ result.plan.cost ?? '-' }}</span>
                      <el-tag v-for="t in result.plan.fullScanTables" :key="t" size="small" type="warning">全表扫描 {{ t }}</el-tag>
                    </div>
                    <pre class="code plan">{{ result.plan.text }}</pre>
                  </div>
                  <div v-if="result.rewrittenPlan">
                    <div class="sub-title">改写后 <span class="text-gray">代价 {{ result.rewrittenPlan.cost ?? '-' }}</span>
                      <el-tag v-if="gain" size="small" :type="gain > 0 ? 'success' : 'danger'">{{ gain > 0 ? '下降' : '上升' }} {{ Math.abs(gain) }}%</el-tag>
                    </div>
                    <pre class="code plan">{{ result.rewrittenPlan.text || result.rewrittenPlan.error }}</pre>
                  </div>
                </div>
                <ul v-if="(result.plan?.findings || []).length" class="findings">
                  <li v-for="f in result.plan.findings" :key="f.code + f.title"><el-tag size="small" :type="sevType(f.severity)">{{ f.code }}</el-tag> {{ f.title }}：{{ f.detail }}</li>
                </ul>
              </el-collapse-item>

              <el-collapse-item v-if="result.runtime" title="运行时证据（SQL 洞察）" name="runtime">
                <div v-if="result.runtime.last24h" class="text-gray">近 24 小时：执行 {{ result.runtime.last24h.EXECS ?? 0 }} 次，平均 {{ result.runtime.last24h.AVG_ELAPSED_MS ?? '-' }} ms</div>
                <div v-for="p in result.runtime.openProblems || []" :key="'p' + p.PROBLEM_ID">问题 [{{ p.RULE_CODE }}] {{ p.DETAIL }}</div>
                <div v-for="x in result.runtime.anomalies || []" :key="'a' + x.ANOMALY_ID">波动 {{ x.METRIC }} {{ x.ANOMALY_TYPE }} ×{{ x.RATIO }}（{{ x.STATUS }}）</div>
              </el-collapse-item>
            </el-collapse>
          </div>
        </div>
      </el-tab-pane>

      <!-- ============================================================ 慢SQL快照 -->
      <el-tab-pane label="慢SQL快照" name="slow">
        <div class="card slow-bar">
          <el-select v-model="slowInst" placeholder="全部实例" clearable filterable size="small" style="width: 200px" @change="reloadSlow">
            <el-option v-for="i in supportedInstances" :key="i.INSTANCE_ID" :label="`${i.INSTANCE_NAME}（${i.DB_TYPE}）`" :value="i.INSTANCE_ID" />
          </el-select>
          <el-date-picker v-model="slowRange" type="datetimerange" size="small" range-separator="至" start-placeholder="开始" end-placeholder="结束"
                          value-format="YYYY-MM-DD HH:mm:ss" :shortcuts="shortcuts" style="width: 340px" @change="reloadSlow" />
          <el-select v-model="slowBatch" placeholder="全部批次" clearable size="small" style="width: 230px" @change="loadSlow(1)">
            <el-option v-for="b in batches" :key="b.CAPTURE_BATCH + b.INSTANCE_ID" :value="b.CAPTURE_BATCH"
                       :label="`${fmt(b.CAPTURE_TIME)} ${b.INSTANCE_NAME || ''} · ${b.SQL_COUNT}条${b.CAPTURE_SOURCE === 'MANUAL' ? ' · 手动' : ''}`" />
          </el-select>
          <el-input v-model="slowKeyword" placeholder="SQL 文本 / SQL_ID" size="small" clearable style="width: 180px" @keyup.enter="loadSlow(1)" @clear="loadSlow(1)" />
          <el-input-number v-model="slowMinAvg" :min="0" :step="500" size="small" controls-position="right" placeholder="≥ 平均ms" style="width: 130px" />
          <el-button size="small" icon="Search" @click="loadSlow(1)">查询</el-button>
          <span class="flex-1" />
          <el-button size="small" type="primary" icon="Download" :loading="capturing" :disabled="!slowInst" @click="capture">立即采集慢SQL</el-button>
        </div>
        <p class="text-gray small hint-line">
          “立即采集”从所选实例读取执行统计，把单次平均耗时达到阈值（默认 1000 ms，可在上方“≥ 平均ms”中指定）的 SQL 按采集时间保存，便于按时间段对比；
          系统每 30 分钟自动采集一次。支持 Oracle、磐维、达梦、MySQL、PostgreSQL、SQL Server。
        </p>
        <div class="card">
          <el-table :data="slowRows" v-loading="slowLoading" stripe size="small" @row-click="openSlow">
            <el-table-column label="采集时间" width="150"><template #default="{ row }">{{ fmt(row.CAPTURE_TIME) }}</template></el-table-column>
            <el-table-column prop="INSTANCE_NAME" label="实例" width="120" show-overflow-tooltip />
            <el-table-column prop="SCHEMA_NAME" label="Schema" width="100" show-overflow-tooltip />
            <el-table-column prop="SQL_TEXT" label="SQL" min-width="260" show-overflow-tooltip />
            <el-table-column prop="AVG_ELAPSED" label="平均ms" width="90" sortable />
            <el-table-column prop="MAX_ELAPSED" label="最大ms" width="90" />
            <el-table-column prop="EXEC_COUNT" label="执行次数" width="90" />
            <el-table-column prop="LOGICAL_READS" label="逻辑读" width="100" />
            <el-table-column label="全表扫描" width="80">
              <template #default="{ row }"><el-tag v-if="row.FULL_SCAN === 1 || row.FULL_SCAN === 'Y'" size="small" type="warning">是</el-tag></template>
            </el-table-column>
            <el-table-column label="操作" width="150" fixed="right">
              <template #default="{ row }">
                <el-button link type="primary" size="small" @click.stop="toRule(row)">规则优化</el-button>
                <el-button link type="primary" size="small" @click.stop="toAi(row.SQL_TEXT)">AI</el-button>
              </template>
            </el-table-column>
          </el-table>
          <div class="pager">
            <el-pagination v-model:current-page="slowPage" :page-size="20" :total="slowTotal" layout="total, prev, pager, next" small @current-change="loadSlow" />
          </div>
        </div>
      </el-tab-pane>

      <!-- ============================================================ Oracle SQL_ID 深度诊断（orasqlx） -->
      <el-tab-pane label="Oracle 深度诊断" name="diag" lazy>
        <SqlDiagPanel v-if="tab === 'diag'" :initial="diagInit" />
      </el-tab-pane>

      <!-- ============================================================ AI 深度优化 -->
      <el-tab-pane label="AI深度优化" name="ai">
        <div class="ai-wrap">
          <!-- sandbox：禁止改写主窗口地址（top navigation）与插件；页面内 LLM 输出已做 HTML 白名单清洗。彻底隔离令牌需独立域名部署（见 docs） -->
          <iframe v-if="aiLoaded" :key="iframeKey" :src="iframeSrc" title="AI 深度优化" class="sql-agent-iframe" referrerpolicy="strict-origin-when-cross-origin"
            sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-popups allow-popups-to-escape-sandbox" />
        </div>
      </el-tab-pane>
    </el-tabs>

    <!-- 慢 SQL 详情 -->
    <el-drawer v-model="slowDrawer" title="慢 SQL 详情" size="55%" destroy-on-close>
      <template v-if="slowDetail">
        <div class="text-gray">
          {{ slowDetail.INSTANCE_NAME }} · {{ slowDetail.DB_TYPE }} · {{ slowDetail.SCHEMA_NAME || '-' }} · 来源 {{ slowDetail.STAT_SOURCE || '-' }}
          · SQL_ID {{ slowDetail.NATIVE_SQL_ID || '-' }} · 采集 {{ fmt(slowDetail.CAPTURE_TIME) }}
        </div>
        <pre class="code">{{ slowDetail.SQL_TEXT }}</pre>
        <div class="input-actions">
          <el-button type="primary" size="small" @click="toRule(slowDetail)">规则优化</el-button>
          <el-button size="small" @click="toAi(slowDetail.SQL_TEXT)">交给 AI</el-button>
          <el-button v-if="String(slowDetail.DB_TYPE).toUpperCase() === 'ORACLE' && slowDetail.NATIVE_SQL_ID" size="small" @click="toDiag(slowDetail)">Oracle 深度诊断</el-button>
          <el-button v-if="slowDetail.ASSET_ID" size="small" @click="$router.push({ path: '/sql-insight', query: { assetId: slowDetail.ASSET_ID, instanceId: slowDetail.INSTANCE_ID } })">在 SQL 洞察中查看</el-button>
        </div>
        <div class="sub-title">历次快照（近 7 天）<span class="text-gray">执行次数见下表</span></div>
        <div ref="histEl" class="hist-chart" />
        <el-table :data="histRows" size="small" max-height="220">
          <el-table-column label="采集时间" width="140"><template #default="{ row }">{{ fmt(row.CAPTURE_TIME) }}</template></el-table-column>
          <el-table-column prop="AVG_ELAPSED" label="平均ms" />
          <el-table-column prop="MAX_ELAPSED" label="最大ms" />
          <el-table-column prop="EXEC_COUNT" label="执行次数" />
          <el-table-column prop="PLAN_HASH" label="计划" show-overflow-tooltip />
        </el-table>
      </template>
    </el-drawer>
  </div>
</template>

<script setup>
import { computed, nextTick, onMounted, onBeforeUnmount, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import * as echarts from 'echarts'
import { sqlApi, sqlInsightApi, sqlOptHistoryApi, sqlPrecheckApi, monitorApi } from '@/api/index.js'
import SqlDiagPanel from '@/components/sql/SqlDiagPanel.vue'

const route = useRoute()
const router = useRouter()

const DB_TYPES = ['ORACLE', 'MYSQL', 'POSTGRESQL', 'PANWEI', 'DAMENG', 'SQLSERVER', 'GOLDENDB']
const ACTION_LABEL = { FIX: '修复', INDEX: '索引', FILTER: '过滤', REWRITE: '改写', SUGGEST: '建议', PLAN: '计划' }

const tab = ref(['rule', 'slow', 'diag', 'ai'].includes(route.query.tab) ? route.query.tab : (route.query.sql ? 'ai' : 'rule'))
const aiLoaded = ref(tab.value === 'ai')
const instances = ref([])
const supportedInstances = computed(() => instances.value.filter(x => DB_TYPES.includes(String(x.DB_TYPE || '').toUpperCase())))

const diagInit = ref(null)
/** 慢 SQL → Oracle SQL_ID 深度诊断：带上实例与 SQL_ID 直接跳到诊断页签 */
function toDiag(row) {
  diagInit.value = { instanceId: row.INSTANCE_ID, sqlId: row.NATIVE_SQL_ID }
  slowDrawer.value = false
  tab.value = 'diag'
  onTab('diag')
}
function onTab(name) {
  if (name === 'ai') aiLoaded.value = true
  if (name === 'slow' && !slowRows.value.length) reloadSlow()
  router.replace({ path: '/sql', query: { ...route.query, tab: name } })
}

// ------------------------------------------------------------ 规则优化
const ruleInst = ref(null)
const ruleDbType = ref('ORACLE')
const ruleSchema = ref('')
const ruleSql = ref(route.query.tab === 'rule' && route.query.sql ? String(route.query.sql) : '')
const optimizing = ref(false)
const result = ref(null)
const openPanels = ref(['index', 'rewrite'])

const gain = computed(() => {
  const a = result.value?.plan?.cost
  const b = result.value?.rewrittenPlan?.cost
  return a && b != null ? Math.round((a - b) * 100 / a) : null
})

const optStats = ref(null)
async function loadOptStats() { try { optStats.value = (await sqlOptHistoryApi.stats({ days: 30 })).data } catch (_) { optStats.value = null } }
async function exportOpt() {
  const r = await sqlOptHistoryApi.exportCsv()
  const blob = r instanceof Blob ? r : r?.data
  if (!(blob instanceof Blob)) return ElMessage.error('导出失败')
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'sql_opt_history.csv'; a.click(); URL.revokeObjectURL(a.href)
}
const precheck = ref(null)
const effectiveDbType = computed(() => {
  const inst = ruleInst.value && instances.value.find(i => i.INSTANCE_ID === ruleInst.value)
  return String(inst?.DB_TYPE || ruleDbType.value || 'ORACLE')
})
/** 先判断这条语句按所选数据库类型是否正确；预检服务不可用时不拦截（只是少一层保护） */
async function runPrecheckStep() {
  precheck.value = null
  try {
    const r = await sqlPrecheckApi.check(ruleSql.value, effectiveDbType.value)
    precheck.value = r.data
    return r.data
  } catch (_) {
    return null
  }
}
async function forceRun() { await runRule(true) }
async function runRule(skipCheck = false) {
  if (!ruleSql.value.trim()) return ElMessage.warning('请输入 SQL')
  if (skipCheck !== true) {
    const pre = await runPrecheckStep()
    if (pre && !pre.ok) return
    if (pre?.sql && pre.statements > 1) ruleSql.value = pre.sql
  }
  optimizing.value = true
  try {
    const r = await sqlInsightApi.optimize({ sqlText: ruleSql.value, instanceId: ruleInst.value || undefined, dbType: ruleDbType.value, schema: ruleSchema.value || undefined })
    result.value = r.data
    openPanels.value = ['index', 'rewrite', ...(r.data?.plan?.text ? ['plan'] : [])]
  } finally {
    optimizing.value = false
  }
}

function reanalyze() {
  ruleSql.value = result.value.rewrittenSql
  runRule()
}

async function saveHistory() {
  const r = result.value
  if (!r) return
  await sqlOptHistoryApi.save({
    sqlText: ruleSql.value, dbType: r.dbType, optimizedSql: r.rewrittenSql || null, llmProvider: 'RULE', llmModel: 'dbops-rule-engine',
    ruleEngine: { score: r.score, risk: r.risk, actions: r.actions, indexAdvice: r.indexAdvice, rewrites: r.rewrites },
    optMode: 'rule', instanceId: ruleInst.value || undefined, precheck: precheck.value || undefined,
    instanceName: instances.value.find(i => i.INSTANCE_ID === ruleInst.value)?.INSTANCE_NAME,
    explainBefore: r.plan?.text || null, explainAfter: r.rewrittenPlan?.text || null, sqlHash: r.audit?.fingerprint || null,
  })
  ElMessage.success('已保存到优化记录')
  loadOptStats()
}

/** 把规则结果整理成 AI 的提示：AI 在规则结论的基础上做深度改写，规则结论本身不由 AI 改变 */
function aiPromptFromResult() {
  const r = result.value
  if (!r) return ''
  const lines = (r.actions || []).slice(0, 8).map((a, i) => `${i + 1}. ${a.text}`)
  return lines.length ? `规则引擎已给出以下建议，请在此基础上进一步优化并解释：\n${lines.join('\n')}` : ''
}

// ------------------------------------------------------------ 慢 SQL 快照
const slowInst = ref(route.query.instanceId ? Number(route.query.instanceId) : null)
const slowRange = ref(null)
const slowBatch = ref(null)
const slowKeyword = ref('')
const slowMinAvg = ref(null)
const slowRows = ref([])
const slowTotal = ref(0)
const slowPage = ref(1)
const slowLoading = ref(false)
const batches = ref([])
const capturing = ref(false)
const shortcuts = [
  { text: '最近 1 小时', value: () => [new Date(Date.now() - 3600e3), new Date()] },
  { text: '最近 24 小时', value: () => [new Date(Date.now() - 86400e3), new Date()] },
  { text: '最近 7 天', value: () => [new Date(Date.now() - 7 * 86400e3), new Date()] },
]

function rangeParams() {
  const [from, to] = slowRange.value || []
  return { instanceId: slowInst.value || undefined, from: from || undefined, to: to || undefined }
}

async function loadBatches() {
  try {
    const r = await sqlApi.batches(rangeParams())
    batches.value = r.data || []
  } catch {
    batches.value = []
  }
}

async function loadSlow(page) {
  if (typeof page === 'number') slowPage.value = page
  slowLoading.value = true
  try {
    const r = await sqlApi.slow({ ...rangeParams(), batch: slowBatch.value || undefined, keyword: slowKeyword.value || undefined,
      minAvgMs: slowMinAvg.value || undefined, page: slowPage.value, size: 20 })
    slowRows.value = r.data?.list || []
    slowTotal.value = r.data?.total || 0
  } finally {
    slowLoading.value = false
  }
}

function reloadSlow() {
  slowBatch.value = null
  loadBatches()
  loadSlow(1)
}

async function capture() {
  capturing.value = true
  try {
    const r = await sqlApi.capture(slowInst.value, slowMinAvg.value || undefined)
    ElMessage.success(r.msg || '采集完成')
    slowRange.value = null
    await loadBatches()
    slowBatch.value = r.data?.batch || null
    await loadSlow(1)
  } finally {
    capturing.value = false
  }
}

const slowDrawer = ref(false)
const slowDetail = ref(null)
const histEl = ref(null)
const histRows = ref([])
let histChart = null

async function openSlow(row) {
  slowDrawer.value = true
  slowDetail.value = row
  try {
    const [d, h] = await Promise.all([sqlApi.row(row.ROW_ID), sqlApi.history(row.ROW_ID, 7)])
    slowDetail.value = d.data || row
    await nextTick()
    histRows.value = h.data || []
    drawHistory(histRows.value)
  } catch { /* 详情失败时保留列表数据 */ }
}

function drawHistory(rows) {
  if (!histEl.value) return
  histChart?.dispose()
  histChart = echarts.init(histEl.value)
  histChart.setOption({
    tooltip: { trigger: 'axis', valueFormatter: v => (v == null ? '-' : `${v} ms`) },
    legend: { data: ['平均耗时', '最大耗时'] },
    grid: { left: 56, right: 20, top: 30, bottom: 30 },
    xAxis: { type: 'category', data: rows.map(r => fmt(r.CAPTURE_TIME)) },
    yAxis: { type: 'value', name: 'ms' },
    series: [
      { name: '平均耗时', type: 'line', data: rows.map(r => r.AVG_ELAPSED), symbolSize: 8, lineStyle: { width: 2 }, itemStyle: { color: '#2a78d6' } },
      { name: '最大耗时', type: 'line', data: rows.map(r => r.MAX_ELAPSED), symbolSize: 8, lineStyle: { width: 2 }, itemStyle: { color: '#eb6834' } },
    ],
  })
}

function toRule(row) {
  slowDrawer.value = false
  ruleSql.value = row.SQL_TEXT || ''
  ruleInst.value = row.INSTANCE_ID || null
  ruleSchema.value = row.SCHEMA_NAME && row.SCHEMA_NAME !== '-' ? row.SCHEMA_NAME : ''
  tab.value = 'rule'
  onTab('rule')
  runRule()
}

// ------------------------------------------------------------ AI 深度优化（Python Agent，同源 /sql-optimizer）
const aiSql = ref(route.query.sql ? String(route.query.sql) : '')
const aiPrompt = ref(route.query.prompt ? String(route.query.prompt) : '')
const aiNonce = ref(0)
const iframeSrc = computed(() => {
  const envOrigin = import.meta.env.VITE_SQL_AGENT_ORIGIN
  const u = envOrigin && String(envOrigin).trim()
    ? new URL(`${String(envOrigin).replace(/\/$/, '')}/`)
    : new URL('/sql-optimizer/index.html', window.location.origin)
  if (aiSql.value.trim()) u.searchParams.set('presetSql', aiSql.value.slice(0, 4000))
  if (aiPrompt.value.trim()) u.searchParams.set('presetPrompt', aiPrompt.value.slice(0, 2000))
  return u.toString()
})
const iframeKey = computed(() => `${aiNonce.value}`)

function toAi(sql, prompt) {
  slowDrawer.value = false
  aiSql.value = String(sql || '')
  aiPrompt.value = String(prompt || '')
  aiNonce.value++
  aiLoaded.value = true
  tab.value = 'ai'
  router.replace({ path: '/sql', query: { tab: 'ai' } })
}

// ------------------------------------------------------------ 公共
function fmt(v) {
  if (!v) return '-'
  const d = new Date(v)
  if (isNaN(d)) return String(v)
  const p = n => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
const riskType = r => ({ CRITICAL: 'danger', HIGH: 'danger', MEDIUM: 'warning', LOW: 'success' }[r] || 'info')
const sevType = s => ({ CRITICAL: 'danger', ERROR: 'danger', WARNING: 'warning' }[s] || 'info')
async function copy(t) {
  try {
    await navigator.clipboard.writeText(t)
    ElMessage.success('已复制')
  } catch {
    ElMessage.warning('浏览器不允许访问剪贴板，请手动复制')
  }
}

onMounted(async () => {
  loadOptStats()
  try {
    instances.value = (await monitorApi.instances()).data || []
  } catch {
    instances.value = []
  }
  if (route.query.instanceId) ruleInst.value = Number(route.query.instanceId)
  if (tab.value === 'slow') reloadSlow()
  if (tab.value === 'rule' && ruleSql.value) runRule()
})
// 内嵌 Agent 页收到 401 时通知这里，跳转登录
function onAgentMessage(e) {
  if (e.origin === window.location.origin && e.data?.type === 'dbops-auth-expired') {
    router.push({ path: '/login', query: { redirect: route.fullPath, reason: 'expired' } })
  }
}
window.addEventListener('message', onAgentMessage)
onBeforeUnmount(() => {
  histChart?.dispose()
  window.removeEventListener('message', onAgentMessage)
})
</script>

<style scoped>
.opt-stats { margin: 0 0 8px; font-size: 12px }
.precheck { margin-bottom: 10px }
.sql-opt { padding: 0 4px; }
.opt-tabs :deep(.el-tabs__content) { overflow: visible; }
.rule-layout { display: flex; flex-direction: column; gap: 12px; }
.input-bar, .input-actions, .slow-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 8px; }
.input-actions { margin: 10px 0 0; }
.hint { font-size: 12px; }
.mono :deep(textarea), .code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px; }
.result-head { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; margin-bottom: 6px; }
.score { font-size: 18px; font-weight: 600; }
.actions { margin: 4px 0 12px; padding-left: 20px; }
.actions li { margin: 6px 0; line-height: 1.6; }
.action-text { margin-left: 6px; word-break: break-all; }
.code { background: var(--el-fill-color-light, #f5f7fa); border-radius: 6px; padding: 10px; white-space: pre-wrap; word-break: break-all; max-height: 360px; overflow: auto; margin: 6px 0; }
.plan { white-space: pre; }
.plan-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(380px, 1fr)); gap: 12px; }
.sub-title { font-weight: 600; margin: 10px 0 4px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ddl { font-size: 12px; word-break: break-all; }
.small { font-size: 12px; }
.findings { padding-left: 18px; }
.flex-1 { flex: 1; }
.hint-line { margin: 0 0 10px; line-height: 1.6; }
.pager { display: flex; justify-content: flex-end; padding-top: 10px; }
.ai-wrap { height: calc(100vh - var(--header-height, 56px) - 70px); min-height: 520px; }
.sql-agent-iframe { width: 100%; height: 100%; border: 0; display: block; }
.hist-chart { width: 100%; height: 260px; }
</style>
