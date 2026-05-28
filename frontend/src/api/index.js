import axios from 'axios'
import { ElMessage } from 'element-plus'

const http = axios.create({ baseURL: '/api', timeout: 30000 })

http.interceptors.request.use(cfg => {
  const token = localStorage.getItem('token')
  if (token) cfg.headers.Authorization = `Bearer ${token}`
  return cfg
})
http.interceptors.response.use(
  res => {
    const d = res.data
    if (d.code != null && d.code !== '' && Number(d.code) !== 200) {
      if (Number(d.code) === 401) {
        const url = res.config?.url || ''
        if (!url.includes('/auth/login')) { localStorage.clear(); window.location.href = '/login' }
      }
      return Promise.reject(new Error(d.msg || '请求失败'))
    }
    return d
  },
  err => { ElMessage.error(err.response?.data?.msg || err.message || '网络错误'); return Promise.reject(err) }
)

export const authApi = {
  login: d => http.post('/auth/login', d), logout: () => http.post('/auth/logout'),
  profile: () => http.get('/auth/profile'), updateProfile: d => http.put('/auth/profile', d),
  changePwd: d => http.post('/auth/change-password', d), resetPwd: d => http.post('/auth/reset-password', d),
}
export const monitorApi = {
  overview: () => http.get('/monitor/overview'), instances: () => http.get('/monitor/instances'),
  basic: id => http.get(`/monitor/instances/${id}/basic`), sysinfo: id => http.get(`/monitor/instances/${id}/sysinfo`),
  performance: id => http.get(`/monitor/instances/${id}/performance`), tablespaces: id => http.get(`/monitor/instances/${id}/tablespaces`),
  sessions: (id, p) => http.get(`/monitor/instances/${id}/sessions`, { params: p }),
  killSession: (id, d) => http.post(`/monitor/instances/${id}/sessions/kill`, d),
  topsql: (id, p) => http.get(`/monitor/instances/${id}/topsql`, { params: p }),
  waits: id => http.get(`/monitor/instances/${id}/waits`), locks: id => http.get(`/monitor/instances/${id}/locks`),
  awrSnapshots: id => http.get(`/monitor/instances/${id}/awr-snapshots`),
  alerts: id => http.get(`/monitor/instances/${id}/alerts`), audit: id => http.get(`/monitor/instances/${id}/audit`),
  collectNow: id => http.post(`/monitor/instances/${id}/collect`, {}),
  trend: (id, p) => http.get(`/monitor/instances/${id}/trend`, { params: p }),
  collectSchedulerStatus: () => http.get('/monitor/collect-scheduler/status'),
  healthDetail: id => http.get(`/monitor/instances/${id}/health-detail`),
}
export const cmdbApi = {
  list: p => http.get('/cmdb/instances', { params: p }), get: id => http.get(`/cmdb/instances/${id}`),
  create: d => http.post('/cmdb/instances', d), update: (id, d) => http.put(`/cmdb/instances/${id}`, d),
  del: id => http.delete(`/cmdb/instances/${id}`),
  hosts: p => http.get('/cmdb/hosts', { params: p }),
  createHost: d => http.post('/cmdb/hosts', d), updateHost: (id, d) => http.put(`/cmdb/hosts/${id}`, d),
  deleteHost: id => http.delete(`/cmdb/hosts/${id}`),
  clusters: () => http.get('/cmdb/clusters'), clusterDetail: id => http.get(`/cmdb/clusters/${id}`),
  createCluster: d => http.post('/cmdb/clusters', d), updateCluster: (id, d) => http.put(`/cmdb/clusters/${id}`, d),
  deleteCluster: id => http.delete(`/cmdb/clusters/${id}`),
  addClusterMember: (id, d) => http.post(`/cmdb/clusters/${id}/members`, d),
  removeClusterMember: (id, iid) => http.delete(`/cmdb/clusters/${id}/members/${iid}`),
  stats: () => http.get('/cmdb/stats'), bulkImportInstances: fd => http.post('/cmdb/instances/bulk-import', fd),
}
export const appRelationApi = {
  // 应用 CRUD
  apps: p => http.get('/app-relation/apps', { params: p }),
  app: id => http.get(`/app-relation/apps/${id}`),
  createApp: d => http.post('/app-relation/apps', d),
  updateApp: (id, d) => http.put(`/app-relation/apps/${id}`, d),
  deleteApp: id => http.delete(`/app-relation/apps/${id}`),
  // 依赖关系
  relations: p => http.get('/app-relation/relations', { params: p }),
  createRelation: d => http.post('/app-relation/relations', d),
  deleteRelation: id => http.delete(`/app-relation/relations/${id}`),
  // 拓扑与分析
  topology: () => http.get('/app-relation/topology'),
  blastRadius: id => http.get(`/app-relation/blast-radius/${id}`),
  appImpact: id => http.get(`/app-relation/app-impact/${id}`),
  stats: () => http.get('/app-relation/stats'),
}
export const tagApi = {
  // 标签分组
  groups: p => http.get('/tags/groups', { params: p }),
  group: id => http.get(`/tags/groups/${id}`),
  createGroup: d => http.post('/tags/groups', d),
  updateGroup: (id, d) => http.put(`/tags/groups/${id}`, d),
  deleteGroup: id => http.delete(`/tags/groups/${id}`),
  // 标签
  list: p => http.get('/tags', { params: p }),
  createTag: d => http.post('/tags', d),
  updateTag: (id, d) => http.put(`/tags/${id}`, d),
  deleteTag: id => http.delete(`/tags/${id}`),
  // 实例标签
  instanceTags: instId => http.get(`/tags/instance/${instId}`),
  setInstanceTags: (instId, tagIds) => http.post(`/tags/instance/${instId}`, { tagIds }),
  // 批量操作
  batchAssign: (instanceIds, tagIds) => http.post('/tags/batch-assign', { instanceIds, tagIds }),
  batchRemove: (instanceIds, tagIds) => http.post('/tags/batch-remove', { instanceIds, tagIds }),
  instancesByTag: p => http.get('/tags/instances-by-tag', { params: p }),
  stats: () => http.get('/tags/stats'),
}
export const alertApi = {
  list: p => http.get('/alerts', { params: p }), stats: () => http.get('/alerts/stats'),
  ack: id => http.post(`/alerts/${id}/ack`), resolve: id => http.post(`/alerts/${id}/resolve`),
  rules: () => http.get('/alerts/rules'), createRule: d => http.post('/alerts/rules', d),
  updateRule: (id, d) => http.put(`/alerts/rules/${id}`, d), deleteRule: id => http.delete(`/alerts/rules/${id}`),
  // F-17 告警抑制
  suppressionRules: () => http.get('/alerts/suppression-rules'),
  createSuppressionRule: d => http.post('/alerts/suppression-rules', d),
  updateSuppressionRule: (id, d) => http.put(`/alerts/suppression-rules/${id}`, d),
  deleteSuppressionRule: id => http.delete(`/alerts/suppression-rules/${id}`),
  checkSuppression: d => http.post('/alerts/check-suppression', d),
  batchCheckSuppression: () => http.post('/alerts/batch-check-suppression'),
  suppressedBy: id => http.get(`/alerts/${id}/suppressed-by`),
  suppressing: id => http.get(`/alerts/${id}/suppressing`),
  unsuppress: (id, d) => http.post(`/alerts/${id}/unsuppress`, d),
  suppressionStats: () => http.get('/alerts/suppression-stats'),
  // F-16 告警聚合去重
  aggregate: d => http.post('/alerts/aggregate', d),
  aggGroups: p => http.get('/alerts/aggregation-groups', { params: p }),
  aggGroupStats: () => http.get('/alerts/aggregation-groups/stats'),
  aggGroupDetail: id => http.get(`/alerts/aggregation-groups/${id}`),
  aggGroupResolve: id => http.post(`/alerts/aggregation-groups/${id}/resolve`),
  aggGroupSplit: id => http.post(`/alerts/aggregation-groups/${id}/split`),
  // F-18 告警静默
  silenceRules: () => http.get('/alerts/silence-rules'),
  createSilenceRule: d => http.post('/alerts/silence-rules', d),
  updateSilenceRule: (id, d) => http.put(`/alerts/silence-rules/${id}`, d),
  deleteSilenceRule: id => http.delete(`/alerts/silence-rules/${id}`),
  checkSilence: d => http.post('/alerts/check-silence', d),
  batchCheckSilence: () => http.post('/alerts/batch-check-silence'),
  unsilence: id => http.post(`/alerts/${id}/unsilence`),
  silenceStats: () => http.get('/alerts/silence-stats'),
}
export const sqlApi = { slow: p => http.get('/sql/slow', { params: p }), capture: id => http.post(`/sql/capture/${id}`) }
export const sqlReviewApi = {
  tickets: p => http.get('/sql-review/tickets', { params: p }),
  ticket: id => http.get(`/sql-review/tickets/${id}`),
  createTicket: d => http.post('/sql-review/tickets', d),
  autoAudit: id => http.post(`/sql-review/tickets/${id}/auto-audit`),
  review: (id, d) => http.post(`/sql-review/tickets/${id}/review`, d),
  cancel: id => http.post(`/sql-review/tickets/${id}/cancel`),
  comments: id => http.get(`/sql-review/tickets/${id}/comments`),
  addComment: (id, d) => http.post(`/sql-review/tickets/${id}/comments`, d),
  stats: () => http.get('/sql-review/stats'),
}
export const sqlOptHistoryApi = {
  list: p => http.get('/sql-opt/list', { params: p }), get: id => http.get(`/sql-opt/${id}`),
  save: d => http.post('/sql-opt/save', d), updateStatus: (id, s) => http.put(`/sql-opt/${id}/status`, { status: s }),
  updateEffect: (id, d) => http.put(`/sql-opt/${id}/effect`, d),
}
export const reportApi = {
  overview: () => http.get('/reports/overview'),
  sla: p => http.get('/reports/sla', { params: p }),
  alertTrend: p => http.get('/reports/alert-trend', { params: p }),
  capacity: () => http.get('/reports/capacity'),
  sqlQuality: () => http.get('/reports/sql-quality'),
  inspectSummary: () => http.get('/reports/inspect-summary'),
  aiStats: () => http.get('/reports/ai-stats'),
}
export const automationApi = {
  schedulerStatus: () => http.get('/automation/scheduler/status'),
  // 巡检脚本
  inspectScripts: p => http.get('/automation/inspect/scripts', { params: p }),
  inspectScriptTemplates: () => http.get('/automation/inspect/scripts/templates'),
  inspectScript: id => http.get(`/automation/inspect/scripts/${id}`),
  createInspectScript: d => http.post('/automation/inspect/scripts', d),
  uploadInspectScript: fd => http.post('/automation/inspect/scripts/upload', fd),
  downloadInspectTemplate: p =>
    http.get('/automation/inspect/scripts/template', {
      params: { file: p.file },
      responseType: 'blob',
    }),
  updateInspectScript: (id, d) => http.put(`/automation/inspect/scripts/${id}`, d),
  deleteInspectScript: id => http.delete(`/automation/inspect/scripts/${id}`),
  // 巡检任务
  inspectTasks: () => http.get('/automation/inspect/tasks'),
  createInspectTask: d => http.post('/automation/inspect/tasks', d),
  runInspectTask: id => http.post(`/automation/inspect/tasks/${id}/run`),
  deleteInspectTask: id => http.delete(`/automation/inspect/tasks/${id}`),
  // 巡检报告
  inspectReports: p => http.get('/automation/inspect/reports', { params: p }),
  inspectReport: id => http.get(`/automation/inspect/reports/${id}`),
  inspectReportDocx: id =>
    http.get(`/automation/inspect/reports/${id}/docx`, { responseType: 'blob' }),
  // 故障处理
  faultDashboard: () => http.get('/automation/fault/dashboard'),
  faultPolicies: p => http.get('/automation/fault/policies', { params: p }),
  createFaultPolicy: d => http.post('/automation/fault/policies', d),
  updateFaultPolicy: (id, d) => http.put(`/automation/fault/policies/${id}`, d),
  deleteFaultPolicy: id => http.delete(`/automation/fault/policies/${id}`),
  triggerFaultPolicy: (id, d) => http.post(`/automation/fault/policies/${id}/trigger`, d),
  autoProcessFault: d => http.post('/automation/fault/auto-process', d),
  faultLogs: p => http.get('/automation/fault/logs', { params: p }),
  // 自动发布
  publishTickets: p => http.get('/automation/publish/tickets', { params: p }),
  publishTicket: id => http.get(`/automation/publish/tickets/${id}`),
  createPublishTicket: d => http.post('/automation/publish/tickets', d),
  reviewPublishTicket: (id, d) => http.post(`/automation/publish/tickets/${id}/review`, d),
  executePublishTicket: (id, d) => http.post(`/automation/publish/tickets/${id}/execute`, d),
  rollbackPublishTicket: (id, d) => http.post(`/automation/publish/tickets/${id}/rollback`, d),
  publishPipelineOverview: () => http.get('/automation/publish/pipeline-overview'),
  ddlRules: () => http.get('/automation/publish/ddl-rules'),
  createDdlRule: d => http.post('/automation/publish/ddl-rules', d),
  updateDdlRule: (id, d) => http.put(`/automation/publish/ddl-rules/${id}`, d),
  // SQL治理
  sqlAudit: d => http.post('/automation/sql-governance/audit', d),
  sqlAuditRecords: p => http.get('/automation/sql-governance/audit/records', { params: p }),
  sqlHealthOverview: () => http.get('/automation/sql-governance/health-overview'),
  importSlowQueries: d => http.post('/automation/sql-governance/import-slow-queries', d),
  sqlAuditDetail: id => http.get(`/automation/sql-governance/audit/${id}`),
  sqlAuditReview: (id, d) => http.post(`/automation/sql-governance/audit/${id}/review`, d),
  pushAuditToPublish: (id, d) => http.post(`/automation/sql-governance/audit/${id}/push-to-publish`, d),
  sqlScoreConfig: () => http.get('/automation/sql-governance/score-config'),
  updateSqlScoreConfig: (id, d) => http.put(`/automation/sql-governance/score-config/${id}`, d),
  sqlBaselines: p => http.get('/automation/sql-governance/baselines', { params: p }),
  createSqlBaseline: d => http.post('/automation/sql-governance/baselines', d),
  activateSqlBaseline: id => http.post(`/automation/sql-governance/baselines/${id}/activate`),
  runSqlRegression: d => http.post('/automation/sql-governance/regression', d),
  sqlRegressions: p => http.get('/automation/sql-governance/regressions', { params: p }),
  // HA管理
  haDashboard: () => http.get('/automation/ha/dashboard'),
  haTopologies: () => http.get('/automation/ha/topologies'),
  createHaTopology: d => http.post('/automation/ha/topologies', d),
  updateHaTopology: (id, d) => http.put(`/automation/ha/topologies/${id}`, d),
  haHealthCheck: id => http.get(`/automation/ha/topologies/${id}/health-check`),
  haSwitch: (id, d) => http.post(`/automation/ha/topologies/${id}/switch`, d),
  haSwitches: p => http.get('/automation/ha/switches', { params: p }),
  drLinks: () => http.get('/automation/ha/dr-links'),
  createDrLink: d => http.post('/automation/ha/dr-links', d),
  refreshDrLink: id => http.post(`/automation/ha/dr-links/${id}/refresh`),
  drDrill: id => http.post(`/automation/ha/dr-links/${id}/drill`),
  // 容量预测
  capacitySnapshots: p => http.get('/automation/capacity/snapshots', { params: p }),
  collectCapacitySnapshot: d => http.post('/automation/capacity/snapshots/collect', d),
  capacityForecasts: p => http.get('/automation/capacity/forecasts', { params: p }),
  runCapacityForecast: d => http.post('/automation/capacity/forecasts/run', d),
  costAnalysis: () => http.get('/automation/capacity/cost-analysis'),
  runCostAnalysis: () => http.post('/automation/capacity/cost-analysis/run'),
  // 备份恢复
  backupPolicies: () => http.get('/automation/backup/policies'),
  createBackupPolicy: d => http.post('/automation/backup/policies', d),
  updateBackupPolicy: (id, d) => http.put(`/automation/backup/policies/${id}`, d),
  deleteBackupPolicy: id => http.delete(`/automation/backup/policies/${id}`),
  runBackupPolicy: id => http.post(`/automation/backup/policies/${id}/run`),
  backupRecords: p => http.get('/automation/backup/records', { params: p }),
  backupStats: () => http.get('/automation/backup/stats'),
  restoreTasks: () => http.get('/automation/backup/restores'),
  createRestoreTask: d => http.post('/automation/backup/restores', d),
  executeRestoreTask: id => http.post(`/automation/backup/restores/${id}/execute`),
  // 兼容
  automationExecLog: () => http.get('/automation/exec-log'),
}
export const userApi = {
  list: p => http.get('/users', { params: p }), create: d => http.post('/users', d),
  update: (id, d) => http.put(`/users/${id}`, d), disable: id => http.post(`/users/${id}/disable`),
  enable: id => http.post(`/users/${id}/enable`), audit: p => http.get('/users/audit', { params: p }),
}
export const rbacApi = {
  menus: () => http.get('/rbac/menus'), roles: () => http.get('/rbac/roles'),
  createRole: d => http.post('/rbac/roles', d), updateRole: (id, d) => http.put(`/rbac/roles/${id}`, d),
  deleteRole: id => http.delete(`/rbac/roles/${id}`), roleMenus: id => http.get(`/rbac/roles/${id}/menus`),
  saveRoleMenus: (id, d) => http.put(`/rbac/roles/${id}/menus`, d),
}
export const aiApi = {
  // ChatOps 问答
  chat: d => http.post('/ai/chat', d, { timeout: 180000 }),
  chatSessions: p => http.get('/ai/chat/sessions', { params: p }),
  chatHistory: (sid, p) => http.get(`/ai/chat/${encodeURIComponent(sid)}`, { params: p }),
  // RCA 根因分析
  rca: d => http.post('/ai/rca', d, { timeout: 180000 }),
  rcaList: p => http.get('/ai/rca/list', { params: p }),
  rcaDetail: id => http.get(`/ai/rca/${id}`),
  // 异常检测
  anomalyDetect: d => http.post('/ai/anomaly/detect', d, { timeout: 120000 }),
  anomalyList: p => http.get('/ai/anomaly', { params: p }),
  // 告警聚类
  cluster: d => http.post('/ai/cluster', d, { timeout: 120000 }),
  clusterList: p => http.get('/ai/cluster', { params: p }),
  // 知识库 RAG
  knowledge: p => http.get('/ai/knowledge', { params: p }),
  knowledgeSearch: p => http.get('/ai/knowledge/search', { params: p }),
  addKnowledge: d => http.post('/ai/knowledge', d),
  deleteKnowledge: id => http.delete(`/ai/knowledge/${id}`),
  reindexKnowledge: id => http.post(`/ai/knowledge/${id}/reindex`),
  uploadKnowledge: (fd, p) => http.post('/ai/knowledge/upload', fd, { params: p, headers: { 'Content-Type': 'multipart/form-data' }, timeout: 60000 }),
  // 智能优先级
  smartPriority: p => http.get('/alerts/smart-priority', { params: p }),
  // 健康检查
  health: () => http.get('/ai/health'),
}
export const customMetricsApi = {
  // 面板
  panels: () => http.get('/custom-metrics/panels'),
  panel: id => http.get(`/custom-metrics/panels/${id}`),
  createPanel: d => http.post('/custom-metrics/panels', d),
  updatePanel: (id, d) => http.put(`/custom-metrics/panels/${id}`, d),
  deletePanel: id => http.delete(`/custom-metrics/panels/${id}`),
  // 指标
  createMetric: d => http.post('/custom-metrics/metrics', d),
  updateMetric: (id, d) => http.put(`/custom-metrics/metrics/${id}`, d),
  deleteMetric: id => http.delete(`/custom-metrics/metrics/${id}`),
  // 执行
  execute: d => http.post('/custom-metrics/execute', d, { timeout: 60000 }),
  executePanel: id => http.get(`/custom-metrics/panels/${id}/execute`, { timeout: 60000 }),
  // 辅助
  instances: () => http.get('/custom-metrics/instances'),
  availableMetrics: () => http.get('/custom-metrics/available-metrics'),
}
export const workbenchApi = {
  instances: () => http.get('/workbench/instances'),
  execute: d => http.post('/workbench/execute', d, { timeout: 60000 }),
  explain: d => http.post('/workbench/explain', d, { timeout: 60000 }),
  schema: id => http.get(`/workbench/schema/${id}`, { timeout: 30000 }),
  columns: (id, p) => http.get(`/workbench/columns/${id}`, { params: p, timeout: 30000 }),
  history: p => http.get('/workbench/history', { params: p }),
}
export const serviceCatalogApi = {
  // 统计
  stats: () => http.get('/service-catalog/stats'),
  // 服务目录
  catalogs: p => http.get('/service-catalog/catalogs', { params: p }),
  catalog: id => http.get(`/service-catalog/catalogs/${id}`),
  createCatalog: d => http.post('/service-catalog/catalogs', d),
  updateCatalog: (id, d) => http.put(`/service-catalog/catalogs/${id}`, d),
  deleteCatalog: id => http.delete(`/service-catalog/catalogs/${id}`),
  // 工单
  orders: p => http.get('/service-catalog/orders', { params: p }),
  order: id => http.get(`/service-catalog/orders/${id}`),
  createOrder: d => http.post('/service-catalog/orders', d),
  updateOrder: (id, d) => http.put(`/service-catalog/orders/${id}`, d),
  assignOrder: (id, d) => http.post(`/service-catalog/orders/${id}/assign`, d),
  changeOrderStatus: (id, d) => http.post(`/service-catalog/orders/${id}/status`, d),
  addComment: (id, d) => http.post(`/service-catalog/orders/${id}/comment`, d),
  feedback: (id, d) => http.post(`/service-catalog/orders/${id}/feedback`, d),
  myOrders: p => http.get('/service-catalog/my-orders', { params: p }),
}
export const systemConfigApi = {
  getAll: () => http.get('/system-config'),
  update: (key, value) => http.put(`/system-config/${encodeURIComponent(key)}`, { value }),
  reset: key => http.post(`/system-config/${encodeURIComponent(key)}/reset`),
  reload: () => http.post('/system-config/reload'),
}
export const deployApi = {
  templates: () => http.get('/deploy/templates'),
  template: id => http.get(`/deploy/templates/${id}`),
  createTemplate: d => http.post('/deploy/templates', d),
  updateTemplate: (id, d) => http.put(`/deploy/templates/${id}`, d),
  jobs: p => http.get('/deploy/jobs', { params: p }),
  job: id => http.get(`/deploy/jobs/${id}`),
  createJob: d => http.post('/deploy/jobs', d),
  executeJob: id => http.post(`/deploy/jobs/${id}/execute`),
  cancelJob: id => http.post(`/deploy/jobs/${id}/cancel`),
  jobLog: id => http.get(`/deploy/jobs/${id}/log`),
  stats: () => http.get('/deploy/stats'),
}
export default http
