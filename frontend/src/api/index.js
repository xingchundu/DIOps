import axios from 'axios'
import { ElMessage } from 'element-plus'
import { redirectToLogin } from '@/utils/session.js'

const http = axios.create({ baseURL: '/api', timeout: 30000 })
// 备份/恢复/巡检/发布/HA 切换/部署等长任务：前端等待上限与 nginx 长任务 location（300s）一致
const LONG_TASK_MS = 300000

http.interceptors.request.use(cfg => {
  const token = localStorage.getItem('token')
  if (token) cfg.headers.Authorization = `Bearer ${token}`
  return cfg
})
// 401：登录失效（过期/被禁用/已退出）→ 回登录页并带上原页面；登录接口本身的 401 交给登录页显示
// config.silent=true：不弹全局错误提示，由调用方自行展示（如 SQL 洞察页面的服务不可用横幅）
function handle401(cfg) {
  const url = cfg?.url || ''
  if (!url.includes('/auth/login')) redirectToLogin('expired')
}
// 4031：授权无效 / 已到期（Java 网关 LicenseFilter）→ 回登录页显示授权状态；登录接口本身由登录页展示
const LICENSE_CODE = 4031
function handleLicense(cfg) {
  const url = cfg?.url || ''
  if (!url.includes('/auth/login')) redirectToLogin('license')
}
http.interceptors.response.use(
  res => {
    const d = res.data
    if (d && d.code != null && d.code !== '' && Number(d.code) !== 200) {
      if (Number(d.code) === 401) handle401(res.config)
      if (Number(d.code) === LICENSE_CODE) handleLicense(res.config)
      const e = new Error(d.msg || '请求失败')
      e.code = Number(d.code)
      e.data = d.data
      return Promise.reject(e)
    }
    return d
  },
  err => {
    const status = err.response?.status
    const body = err.response?.data || {}
    if (status === 401 || Number(body.code) === 401) handle401(err.config)
    if (Number(body.code) === LICENSE_CODE) handleLicense(err.config)
    const e = new Error(body.msg || (status ? `请求失败（HTTP ${status}）` : err.message) || '网络错误')
    e.code = Number(body.code || status || 0)
    e.response = err.response
    e.data = body.data
    if (!err.config?.silent && Number(body.code) !== LICENSE_CODE && !(status === 401 && !(err.config?.url || '').includes('/auth/login'))) ElMessage.error(e.message)
    return Promise.reject(e)
  }
)

export const authApi = {
  login: d => http.post('/auth/login', d, { silent: true }), logout: () => http.post('/auth/logout', null, { silent: true }),
  profile: () => http.get('/auth/profile'), updateProfile: d => http.put('/auth/profile', d),
  changePwd: d => http.post('/auth/change-password', d), resetPwd: d => http.post('/auth/reset-password', d),
  ssoConfig: () => http.get('/platform/sso/sso-config', { silent: true }),
  ldapLogin: d => http.post('/platform/sso/ldap-login', d, { silent: true }),
  oidcCallback: d => http.post('/platform/sso/oidc/callback', d, { silent: true }),
}
// 授权：status / activate 不需要登录
export const licenseApi = {
  status: () => http.get('/license/status', { silent: true }),
  activate: content => http.post('/license/activate', { content }, { silent: true }),
  info: () => http.get('/license/info'),
}
export const monitorApi = {
  overview: () => http.get('/monitor/overview'), instances: () => http.get('/monitor/instances'),
  board: () => http.get('/monitor/board', { silent: true }),
  dashboard: () => http.get('/monitor/dashboard', { silent: true }),
  basic: id => http.get(`/monitor/instances/${id}/basic`), sysinfo: id => http.get(`/monitor/instances/${id}/sysinfo`),
  performance: id => http.get(`/monitor/instances/${id}/performance`),
  // [fix] 表空间查询有 4 级降级链路，30s 默认超时会被截断成「timeout of 30000ms exceeded」
  tablespaces: id => http.get(`/monitor/instances/${id}/tablespaces`, { timeout: 120000 }),
  tablespaceDiagnostics: id => http.get(`/monitor/instances/${id}/tablespace-diagnostics`, { timeout: 120000 }),
  sessions: (id, p) => http.get(`/monitor/instances/${id}/sessions`, { params: p }),
  killSession: (id, d) => http.post(`/monitor/instances/${id}/sessions/kill`, d),
  waits: id => http.get(`/monitor/instances/${id}/waits`), locks: id => http.get(`/monitor/instances/${id}/locks`),
  awrSnapshots: id => http.get(`/monitor/instances/${id}/awr-snapshots`),
  awrReport: (id, d) => http.post(`/monitor/instances/${id}/awr-report`, d, { timeout: 300000 }),
  alerts: id => http.get(`/monitor/instances/${id}/alerts`), audit: id => http.get(`/monitor/instances/${id}/audit`),
  collectNow: id => http.post(`/monitor/instances/${id}/collect`, {}),
  // [dxc][2026-10-17][新增] 本实例自动采集间隔（秒），0=关闭
  setCollectSchedule: (id, d) => http.put(`/monitor/instances/${id}/collect-schedule`, d),
  trend: (id, p) => http.get(`/monitor/instances/${id}/trend`, { params: p }),
  healthDetail: id => http.get(`/monitor/instances/${id}/health-detail`),
  // [dxc][2026-10-08][新增] 深度监控摘要 API — 原因：实例详情页展示 enginePhase2Summary
  enginePhase2: id => http.get(`/monitor/instances/${id}/engine-phase2`),
  // [dxc][2026-10-08][新增] SSH 主机采集摘要
  hostChecks: id => http.get(`/monitor/instances/${id}/host-checks`),
}
export const cmdbApi = {
  list: p => http.get('/cmdb/instances', { params: p }), get: id => http.get(`/cmdb/instances/${id}`),
  create: d => http.post('/cmdb/instances', d), update: (id, d) => http.put(`/cmdb/instances/${id}`, d),
  del: id => http.delete(`/cmdb/instances/${id}`),
  hosts: p => http.get('/cmdb/hosts', { params: p }),
  createHost: d => http.post('/cmdb/hosts', d), updateHost: (id, d) => http.put(`/cmdb/hosts/${id}`, d),
  deleteHost: id => http.delete(`/cmdb/hosts/${id}`),
  checkHost: id => http.post(`/cmdb/hosts/${id}/check`), checkAllHosts: () => http.post('/cmdb/hosts/check-all'),
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
  applyPolicies: () => http.post('/alerts/apply-policies'),
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
// 慢 SQL 快照（SQL_SLOW_SUMMARY，按采集时间存放）
export const sqlApi = {
  slow: p => http.get('/sql/slow', { params: p }),
  batches: p => http.get('/sql/slow/batches', { params: p, silent: true }),
  row: id => http.get(`/sql/slow/${id}`),
  history: (id, days) => http.get(`/sql/slow/${id}/history`, { params: { days } }),
  capture: (id, minAvgMs) => http.post(`/sql/capture/${id}`, null, { params: minAvgMs ? { minAvgMs } : {}, timeout: 120000 }),
}
// SQL 洞察（Java dbops-server）：问题识别 / 波动检测 / 诊断 / 统一审核
export const sqlInsightApi = {
  overview: p => http.get('/sql-insight/overview', { params: p, silent: true }),
  assets: p => http.get('/sql-insight/assets', { params: p, silent: true }),
  asset: (id, p) => http.get(`/sql-insight/assets/${id}`, { params: p }),
  trend: (id, p) => http.get(`/sql-insight/assets/${id}/trend`, { params: p }),
  updateAsset: (id, d) => http.put(`/sql-insight/assets/${id}`, d),
  setBizType: (instanceId, d) => http.put(`/sql-insight/instances/${instanceId}/biz-type`, d),
  problems: p => http.get('/sql-insight/problems', { params: p, silent: true }),
  resolveProblem: id => http.post(`/sql-insight/problems/${id}/resolve`),
  anomalies: p => http.get('/sql-insight/anomalies', { params: p, silent: true }),
  anomaly: id => http.get(`/sql-insight/anomalies/${id}`),
  diagnose: id => http.post(`/sql-insight/anomalies/${id}/diagnose`, null, { timeout: 60000 }),
  accept: (id, d) => http.post(`/sql-insight/anomalies/${id}/accept`, d || {}),
  resolveAnomaly: id => http.post(`/sql-insight/anomalies/${id}/resolve`),
  rules: p => http.get('/sql-insight/rules', { params: p, silent: true }),
  saveRule: d => http.post('/sql-insight/rules', d),
  deleteRule: id => http.delete(`/sql-insight/rules/${id}`),
  changeWindows: p => http.get('/sql-insight/change-windows', { params: p, silent: true }),
  addChangeWindow: d => http.post('/sql-insight/change-windows', d),
  deleteChangeWindow: id => http.delete(`/sql-insight/change-windows/${id}`),
  capability: instanceId => http.get('/sql-insight/capability', { params: { instanceId }, silent: true }),
  collect: (instanceId, reprobe) => http.post(`/sql-insight/collect/${instanceId}`, null, { params: { reprobe: reprobe ? 1 : 0 }, timeout: 120000 }),
  audit: d => http.post('/sql-insight/audit', d, { timeout: 60000 }),
  optimize: d => http.post('/sql-insight/optimize', d, { timeout: 90000 }),
  screen: p => http.get('/sql-insight/screen', { params: p, silent: true }),
  planChanges: p => http.get('/sql-insight/plan-changes', { params: p, silent: true }),
  createTicket: d => http.post('/sql-insight/tickets', d, { timeout: 90000 }),
}
export const sqlReviewApi = {
  tickets: p => http.get('/sql-review/tickets', { params: p }),
  ticket: id => http.get(`/sql-review/tickets/${id}`),
  createTicket: d => http.post('/sql-review/tickets', d),
  // [fix] 指派接口在 Java 网关/旧 Node 部署下可能只认 POST；PATCH 404 时自动回退一次
  assign: async (id, d) => {
    try {
      return await http.patch(`/sql-review/tickets/${id}/assign`, d)
    } catch (e) {
      const msg = String(e?.message || '')
      if (!/接口不存在|404|Not Found|405|Method Not Allowed/i.test(msg)) throw e
      return http.post(`/sql-review/tickets/${id}/assign`, d)
    }
  },
  reviewers: () => http.get('/sql-review/reviewers'),
  autoAudit: id => http.post(`/sql-review/tickets/${id}/auto-audit`, {}, { timeout: 120000 }),
  review: (id, d) => http.post(`/sql-review/tickets/${id}/review`, d, { timeout: 60000 }),
  cancel: id => http.post(`/sql-review/tickets/${id}/cancel`),
  pushToPublish: (id, d) => http.post(`/sql-review/tickets/${id}/push-to-publish`, d || {}, { timeout: 60000 }),
  comments: id => http.get(`/sql-review/tickets/${id}/comments`),
  addComment: (id, d) => http.post(`/sql-review/tickets/${id}/comments`, d),
  stats: p => http.get('/sql-review/stats', { params: p }),
}
export const sqlOptHistoryApi = {
  list: p => http.get('/sql-opt/list', { params: p }), get: id => http.get(`/sql-opt/${id}`),
  save: d => http.post('/sql-opt/save', d), updateStatus: (id, s) => http.put(`/sql-opt/${id}/status`, { status: s }),
  updateEffect: (id, d) => http.put(`/sql-opt/${id}/effect`, d),
  stats: p => http.get('/sql-opt/stats', { params: p }),
  exportCsv: () => http.get('/sql-opt/export', { responseType: 'blob' }),
}
// SQL 预检：Java 内置（Druid AST），不依赖 Python :8000
export const sqlPrecheckApi = {
  check: (sql, dbType) => http.post('/sql-insight/precheck', { sql, dbType }, { silent: true }),
}
// Oracle SQL_ID 深度诊断（orasqlx）
export const sqlDiagApi = {
  status: () => http.get('/sql-diag/status', { silent: true }),
  run: d => http.post('/sql-diag/run', d),
  jobs: p => http.get('/sql-diag/jobs', { params: p }),
  job: id => http.get(`/sql-diag/jobs/${id}`),
  docx: id => http.get(`/sql-diag/jobs/${id}/docx`, { responseType: 'blob' }),
  json: id => http.get(`/sql-diag/jobs/${id}/json`, { responseType: 'blob' }),
}
// AI 知识图谱
export const kgApi = {
  stats: () => http.get('/kg/stats'),
  overview: p => http.get('/kg/overview', { params: p }),
  search: p => http.get('/kg/search', { params: p }),
  node: (id, depth = 1) => http.get(`/kg/node/${id}`, { params: { depth } }),
  addNote: d => http.post('/kg/note', d),
  remove: id => http.delete(`/kg/node/${id}`),
}
// 运行报告（日报 / 周报 / 月报 / 自定义）
export const reportApi = {
  build: p => http.get('/monitor/report', { params: p, timeout: 120000 }),
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
  runInspectTask: id => http.post(`/automation/inspect/tasks/${id}/run`, null, { timeout: LONG_TASK_MS }),
  deleteInspectTask: id => http.delete(`/automation/inspect/tasks/${id}`),
  // 巡检报告
  inspectReports: p => http.get('/automation/inspect/reports', { params: p }),
  inspectReport: id => http.get(`/automation/inspect/reports/${id}`),
  inspectReportDocx: id =>
    http.get(`/automation/inspect/reports/${id}/docx`, { responseType: 'blob' }),
  // 批量任务最近一次结果：汇总 + 每实例 Word 清单；批量汇总 Excel
  inspectTaskLatest: id => http.get(`/automation/inspect/tasks/${id}/latest`),
  inspectTaskExcel: id => http.get(`/automation/inspect/tasks/${id}/excel`, { responseType: 'blob' }),
  // 保存前校验巡检脚本：分段、@rule 指令、只读检查
  validateInspectScript: d => http.post('/automation/inspect/scripts/validate', d),
  // 故障处理
  faultDashboard: () => http.get('/automation/fault/dashboard'),
  faultPolicies: p => http.get('/automation/fault/policies', { params: p }),
  createFaultPolicy: d => http.post('/automation/fault/policies', d),
  updateFaultPolicy: (id, d) => http.put(`/automation/fault/policies/${id}`, d),
  deleteFaultPolicy: id => http.delete(`/automation/fault/policies/${id}`),
  triggerFaultPolicy: (id, d) => http.post(`/automation/fault/policies/${id}/trigger`, d, { timeout: LONG_TASK_MS }),
  autoProcessFault: d => http.post('/automation/fault/auto-process', d),
  faultLogs: p => http.get('/automation/fault/logs', { params: p }),
  // 自动发布
  publishTickets: p => http.get('/automation/publish/tickets', { params: p }),
  publishTicket: id => http.get(`/automation/publish/tickets/${id}`),
  createPublishTicket: d => http.post('/automation/publish/tickets', d),
  reviewPublishTicket: (id, d) => http.post(`/automation/publish/tickets/${id}/review`, d),
  executePublishTicket: (id, d) => http.post(`/automation/publish/tickets/${id}/execute`, d, { timeout: LONG_TASK_MS }),
  rollbackPublishTicket: (id, d) => http.post(`/automation/publish/tickets/${id}/rollback`, d, { timeout: LONG_TASK_MS }),
  publishPipelineOverview: () => http.get('/automation/publish/pipeline-overview'),
  // SQL治理
  // HA管理
  haDashboard: () => http.get('/automation/ha/dashboard'),
  haTopologies: () => http.get('/automation/ha/topologies'),
  createHaTopology: d => http.post('/automation/ha/topologies', d),
  updateHaTopology: (id, d) => http.put(`/automation/ha/topologies/${id}`, d),
  haHealthCheck: id => http.get(`/automation/ha/topologies/${id}/health-check`),
  haSwitch: (id, d) => http.post(`/automation/ha/topologies/${id}/switch`, d, { timeout: LONG_TASK_MS }),
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
  // 备份恢复
  backupPolicies: () => http.get('/automation/backup/policies'),
  createBackupPolicy: d => http.post('/automation/backup/policies', d),
  updateBackupPolicy: (id, d) => http.put(`/automation/backup/policies/${id}`, d),
  deleteBackupPolicy: id => http.delete(`/automation/backup/policies/${id}`),
  runBackupPolicy: id => http.post(`/automation/backup/policies/${id}/run`, null, { timeout: LONG_TASK_MS }),
  backupRecords: p => http.get('/automation/backup/records', { params: p }),
  backupStats: () => http.get('/automation/backup/stats'),
  restoreTasks: () => http.get('/automation/backup/restores'),
  createRestoreTask: d => http.post('/automation/backup/restores', d),
  executeRestoreTask: id => http.post(`/automation/backup/restores/${id}/execute`, null, { timeout: LONG_TASK_MS }),
}
export const userApi = {
  list: p => http.get('/users', { params: p }), create: d => http.post('/users', d),
  update: (id, d) => http.put(`/users/${id}`, d), disable: id => http.post(`/users/${id}/disable`),
  enable: id => http.post(`/users/${id}/enable`), audit: p => http.get('/users/audit', { params: p }),
}
/** 平台运维闭环（dxc 2026-11-12） */
export const platformApi = {
  notify: {
    status: () => http.get('/platform/notify/status'),
    channels: () => http.get('/platform/notify/channels'),
    createChannel: d => http.post('/platform/notify/channels', d),
    updateChannel: (id, d) => http.put(`/platform/notify/channels/${id}`, d),
    deleteChannel: id => http.delete(`/platform/notify/channels/${id}`),
    testChannel: id => http.post(`/platform/notify/channels/${id}/test`),
    outbox: p => http.get('/platform/notify/outbox', { params: p }),
    outboxByAlert: alertId => http.get(`/platform/notify/outbox/by-alert/${alertId}`),
    runNotifyOnce: () => http.post('/platform/notify/notify/run-once'),
    backupRetentionLogs: p => http.get('/platform/notify/backup-retention/logs', { params: p }),
  },
  governance: {
    status: () => http.get('/platform/governance/status'),
    runRetention: () => http.post('/platform/governance/retention/run-once'),
    retentionRuns: p => http.get('/platform/governance/retention/runs', { params: p }),
    runEscalation: () => http.post('/platform/governance/escalation/run-once'),
    escalationLogs: p => http.get('/platform/governance/escalation/logs', { params: p }),
    escalationByAlert: alertId => http.get(`/platform/governance/escalation/by-alert/${alertId}`),
    runMaintenance: () => http.post('/platform/governance/maintenance/run-once'),
    maintenanceWindows: () => http.get('/platform/governance/maintenance/windows'),
    saveMaintenanceWindow: d => http.post('/platform/governance/maintenance/windows', d),
    inspectCompare: p => http.get('/platform/governance/inspect/compare', { params: p }),
    restoreDrillList: p => http.get('/platform/governance/restore-drill/list', { params: p }),
  },
  health: {
    status: () => http.get('/platform/status'),
    healthLatest: () => http.get('/platform/health/latest'),
    healthHistory: p => http.get('/platform/health/history', { params: p }),
    runHealth: () => http.post('/platform/health/run-once'),
    openApiLinks: () => http.get('/platform/openapi/links'),
  },
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
  addKnowledge: d => http.post('/ai/knowledge', d, { timeout: 600000 }),
  deleteKnowledge: id => http.delete(`/ai/knowledge/${id}`),
  reindexKnowledge: id => http.post(`/ai/knowledge/${id}/reindex`, null, { timeout: 600000 }),
  uploadKnowledge: (fd, p) => http.post('/ai/knowledge/upload', fd, { params: p, headers: { 'Content-Type': 'multipart/form-data' }, timeout: 600000 }),
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
  executeJob: id => http.post(`/deploy/jobs/${id}/execute`, null, { timeout: LONG_TASK_MS }),
  cancelJob: id => http.post(`/deploy/jobs/${id}/cancel`),
  jobLog: id => http.get(`/deploy/jobs/${id}/log`),
  stats: () => http.get('/deploy/stats'),
}
export const diagnosticsApi = {
  routes: () => http.get('/diagnostics/routes', { timeout: 60000 }),
  reports: () => http.get('/diagnostics/reports', { timeout: 60000 }),
  target: (id, d) => http.post(`/diagnostics/target/${id}`, d || {}, { timeout: 120000 }),
}
export default http
