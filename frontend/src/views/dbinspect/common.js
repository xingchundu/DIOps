export const SEV = { CRITICAL: ['严重', 'danger'], WARNING: ['预警', 'warning'], OK: ['正常', 'success'], INFO: ['提示', 'info'], NA: ['不适用', 'info'], ERROR: ['采集失败', 'info'] }
export const sevLabel = s => (SEV[s] || [s || '—'])[0]
export const sevType = s => (SEV[s] || [0, 'info'])[1]
export const ISSUE_STATUS = { OPEN: ['待处理', 'danger'], FIXING: ['整改中', 'warning'], FIXED: ['已整改', 'success'], IGNORED: ['已忽略', 'info'] }
export const TRIGGER = { SCHEDULE: '定时', MANUAL: '手动', ALERT: '告警联动', RECHECK: '复检' }
export const RUN_STATUS = { RUNNING: ['执行中', 'primary'], SUCCESS: ['成功', 'success'], PARTIAL: ['部分失败', 'warning'], FAILED: ['失败', 'danger'] }
export const KIND = { DAILY: '日常巡检', SPECIAL: '专项巡检', BASELINE: '基线检查' }
export const RULE_TYPE = { THRESHOLD: '阈值', ROWS: '有返回即异常', STATUS: '状态', TOPN: 'Top N', INFO: '仅记录' }
export const DIM = {
  ELAPSED: 'Top 总耗时', CPU: 'Top CPU', IO: 'Top IO', EXECS: 'Top 执行次数', SLOW: '平均耗时过高', READS: '读/扫描过大',
  FULLSCAN: '全表扫描', PLAN_CHANGE: '执行计划变化', NO_BIND: '未绑定变量', LONG_RUN: '长时间运行', LOCK: '锁等待', TX: '长事务',
}
export const ID_KIND = { SQL_ID: 'SQL_ID', QUERYID: 'queryid', DIGEST: 'digest', FINGERPRINT: '指纹' }
export const fmtTime = t => (t ? String(t).replace('T', ' ').replace(/\.\d+Z?$/, '').slice(0, 19) : '—')
export const fmtNum = n => (n == null || n === '' ? '' : Number(n) >= 1000 ? Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 }) : String(Math.round(Number(n) * 100) / 100))
export function saveBlob(blob, name) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(a.href), 3000)
}
