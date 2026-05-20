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
      return Promise.reject(new Error(d.msg || '璇锋眰澶辫触'))
    }
    return d
  },
  err => { ElMessage.error(err.response?.data?.msg || err.message || '缃戠粶閿欒'); return Promise.reject(err) }
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
}
export const cmdbApi = {
  list: p => http.get('/cmdb/instances', { params: p }), get: id => http.get(`/cmdb/instances/${id}`),
  create: d => http.post('/cmdb/instances', d), update: (id, d) => http.put(`/cmdb/instances/${id}`, d),
  del: id => http.delete(`/cmdb/instances/${id}`), hosts: () => http.get('/cmdb/hosts'),
  stats: () => http.get('/cmdb/stats'), bulkImportInstances: fd => http.post('/cmdb/instances/bulk-import', fd),
}
export const alertApi = {
  list: p => http.get('/alerts', { params: p }), stats: () => http.get('/alerts/stats'),
  ack: id => http.post(`/alerts/${id}/ack`), resolve: id => http.post(`/alerts/${id}/resolve`),
  rules: () => http.get('/alerts/rules'), createRule: d => http.post('/alerts/rules', d),
  updateRule: (id, d) => http.put(`/alerts/rules/${id}`, d),
}
export const sqlApi = { slow: p => http.get('/sql/slow', { params: p }), capture: id => http.post(`/sql/capture/${id}`) }
export const sqlOptHistoryApi = {
  list: p => http.get('/sql-opt/list', { params: p }), get: id => http.get(`/sql-opt/${id}`),
  save: d => http.post('/sql-opt/save', d), updateStatus: (id, s) => http.put(`/sql-opt/${id}/status`, { status: s }),
  updateEffect: (id, d) => http.put(`/sql-opt/${id}/effect`, d),
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
  pushAuditToPublish: id => http.post(`/automation/sql-governance/audit/${id}/push-to-publish`),
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
  chat: d => http.post('/ai/chat', d), history: p => http.get('/ai/history', { params: p }),
  clearHistory: () => http.delete('/ai/history'),
}
export default http
