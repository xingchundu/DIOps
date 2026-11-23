/**
 * 健康等级 / 实例状态的统一展示（监控中心、控制台、报表共用）。颜色总是和文字一起出现，不单靠颜色区分。
 * 评分规则见后端 HealthScorer：满分 100，按检查项扣分；有严重项最高 59 分，有警告项最高 89 分。
 */
export const GRADE = {
  HEALTHY: { label: '健康', color: '#52c41a', bg: '#f6ffed', tag: 'success', order: 4 },
  ATTENTION: { label: '关注', color: '#d48806', bg: '#fffbe6', tag: 'warning', order: 2 },
  CRITICAL: { label: '严重', color: '#cf1322', bg: '#fff1f0', tag: 'danger', order: 0 },
  OFFLINE: { label: '离线', color: '#595959', bg: '#f5f5f5', tag: 'info', order: 1 },
  UNKNOWN: { label: '无数据', color: '#8c8c8c', bg: '#fafafa', tag: 'info', order: 3 },
}

export const STATUS = {
  ONLINE: '在线',
  OFFLINE: '连接失败',
  STALE: '数据过期',
  NEVER: '未采集',
  STOPPED: '已停用',
}

export const DB_TYPES = [
  { label: 'Oracle', value: 'ORACLE' }, { label: 'MySQL', value: 'MYSQL' }, { label: 'PostgreSQL', value: 'POSTGRESQL' },
  { label: '磐维', value: 'PANWEI' }, { label: '达梦', value: 'DAMENG' }, { label: 'GoldenDB', value: 'GOLDENDB' }, { label: 'SQL Server', value: 'SQLSERVER' },
]
export const ENVS = { PROD: '生产', UAT: 'UAT', TEST: '测试', DEV: '开发' }

export const grade = g => GRADE[g] || GRADE.UNKNOWN

/** 百分比指标的颜色：≥crit 红，≥warn 黄，否则绿（越低越差的指标传 reverse） */
export function pctColor(v, warn = 80, crit = 95, reverse = false) {
  if (v == null) return '#d9d9d9'
  const bad = reverse ? v < crit : v >= crit
  const mid = reverse ? v < warn : v >= warn
  return bad ? '#cf1322' : mid ? '#d48806' : '#52c41a'
}

export function ago(sec) {
  if (sec == null) return '-'
  if (sec < 60) return `${sec} 秒前`
  if (sec < 3600) return `${Math.floor(sec / 60)} 分钟前`
  if (sec < 86400) return `${Math.floor(sec / 3600)} 小时前`
  return `${Math.floor(sec / 86400)} 天前`
}

export const fmtNum = v => (v == null ? '-' : Number(v) >= 10000 ? `${(Number(v) / 10000).toFixed(1)}万` : String(Math.round(Number(v) * 10) / 10))

export const RULE_TEXT = [
  '满分 100，逐项检查：正常不扣分，警告扣 10 分（轻微项 5 分），严重扣 25 分',
  '有任一严重项，最高 59 分；有任一警告项，最高 89 分 —— ≥90 健康、60~89 关注、<60 严重',
  '没有采集到的项不扣分，只显示“未采集”；连接失败显示“离线”，不打分',
  '检查项：可用性、容量（表空间 / 文件系统）、性能（命中率、提交等待、慢查询）、会话与锁（连接数占上限比例、阻塞）、主机（CPU / 内存）、数据保护（备份 / 归档）',
]
