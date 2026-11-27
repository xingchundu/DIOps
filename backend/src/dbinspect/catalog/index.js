'use strict';
const core = require('./core');
const sqlInsight = require('./sqlInsight');
const oracleCollect = require('./oracleCollect');

const CATEGORY_LABEL = {
  AVAILABILITY: '可用性', RESOURCE: '资源', STORAGE: '存储', PERFORMANCE: '性能', SQL: 'SQL 洞察',
  HA: '高可用', BACKUP: '备份', CONFIG: '配置', SECURITY: '安全', LOG: '日志',
};
const CATEGORY_ORDER = ['AVAILABILITY', 'RESOURCE', 'STORAGE', 'PERFORMANCE', 'SQL', 'HA', 'BACKUP', 'CONFIG', 'SECURITY', 'LOG'];

const ITEMS = [...core.ITEMS, ...sqlInsight.ITEMS, ...oracleCollect.ITEMS].sort((a, b) => (a.sort || 100) - (b.sort || 100));

const byCat = (cats) => ITEMS.filter((i) => cats.includes(i.category)).map((i) => i.code);
const codes = (list) => list;

/** 内置模板：日常 / 专项（可被告警联动）/ 基线 */
const TEMPLATES = [
  {
    code: 'db-daily-health', name: '数据库日常健康巡检', kind: 'DAILY',
    desc: '每日全量巡检：可用性、资源、存储、性能、高可用、备份，并附 SQL 洞察（Top 耗时 SQL、慢 SQL、长时间运行 SQL，均带 sql_id）。',
    items: codes([
      'avail.instance_status', 'avail.uptime', 'res.conn_usage', 'storage.tablespace', 'storage.temp_space', 'storage.asm', 'storage.fra',
      'storage.db_size', 'perf.cache_hit', 'perf.lock_wait', 'perf.long_tx', 'perf.top_waits', 'perf.dead_tuples', 'perf.xid_age',
      'ha.replication_lag', 'ha.replication_state', 'backup.last_backup', 'backup.archive_failing', 'object.invalid',
      'sql.stats_ready', 'sql.top_elapsed', 'sql.slow_avg', 'sql.long_running',
    ]),
  },
  {
    code: 'db-sql-insight', name: 'SQL 洞察专项巡检', kind: 'SPECIAL',
    desc: '专项：Top SQL（耗时 / CPU / 物理读 / 执行次数）、慢 SQL、大表全扫、计划不稳、字面量 SQL、长运行 SQL、锁等待与长事务；每条 SQL 都带 sql_id（MySQL 为 digest，PG 为 queryid）。',
    alertRules: ['慢SQL', '慢 SQL', 'SQL', '锁等待', '长事务', 'CPU', '活动会话', 'slow'],
    items: codes([
      'sql.stats_ready', 'sql.top_elapsed', 'sql.top_cpu', 'sql.top_io', 'sql.top_execs', 'sql.slow_avg', 'sql.high_reads',
      'sql.full_scan', 'sql.plan_change', 'sql.no_bind', 'sql.long_running', 'perf.lock_wait', 'perf.long_tx', 'perf.top_waits', 'perf.cache_hit',
    ]),
  },
  {
    code: 'db-space-special', name: '空间专项巡检', kind: 'SPECIAL',
    desc: '专项：表空间 / 临时表空间 / ASM / FRA 使用率与库容量排行；表空间类告警触发后自动联动巡检。',
    alertRules: ['表空间', 'tablespace', '磁盘', '空间', 'disk', 'FRA', 'ASM'],
    items: codes(['storage.tablespace', 'storage.temp_space', 'storage.asm', 'storage.fra', 'storage.db_size', 'backup.archive_failing', 'log.errors']),
  },
  {
    code: 'db-ha-backup', name: '高可用与备份专项', kind: 'SPECIAL',
    desc: '专项：复制延迟与状态、备份时效、归档 / Binlog / WAL 归档是否开启。',
    alertRules: ['复制', '延迟', '主备', 'replication', '备份', 'backup', 'lag'],
    items: codes(['avail.instance_status', 'ha.replication_lag', 'ha.replication_state', 'backup.last_backup', 'backup.archive_mode', 'backup.archive_failing']),
  },
  {
    code: 'db-baseline', name: '安全与配置基线巡检', kind: 'BASELINE',
    desc: '基线：账户口令（过期 / 默认 / 空口令）、关键参数、归档开启、失效对象与近 24 小时错误日志。建议每周执行。',
    items: codes(['security.pwd_expiry', 'security.weak_account', 'config.key_params', 'backup.archive_mode', 'object.invalid', 'log.errors', 'sql.stats_ready']),
  },
  ...oracleCollect.TEMPLATES,
  {
    code: 'db-full', name: '数据库全量巡检', kind: 'DAILY',
    desc: '全部内置检查项（含 SQL 洞察全部维度），适合月度深度巡检或上线前验收。',
    items: [...core.ITEMS, ...sqlInsight.ITEMS].map((i) => i.code),
  },
];

// 模板里引用的检查项必须存在（加载期自检，避免发版后模板里留悬空编码）
const known = new Set(ITEMS.map((i) => i.code));
for (const t of TEMPLATES) {
  for (const c of t.items) if (!known.has(c)) throw new Error(`内置模板 ${t.code} 引用了不存在的检查项 ${c}`);
}

module.exports = { ITEMS, TEMPLATES, CATEGORY_LABEL, CATEGORY_ORDER };
