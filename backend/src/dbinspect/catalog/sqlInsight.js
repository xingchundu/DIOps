'use strict';
/**
 * SQL 洞察类检查项：每条结果行都是一条 SQL，必带 sql_id。
 *   Oracle → SQL_ID（v$sqlarea_plan_hash）    MySQL → DIGEST（performance_schema 语句摘要）
 *   PG     → queryid（pg_stat_statements；磐维为 dbe_perf.statement.unique_sql_id）
 *   达梦   → SQL_ID（V$SQL_STAT，按实际列名自适应拼 SQL，见 adaptive.js）
 *
 * 统计视图里是“自游标载入 / 统计复位以来”的累计值：Oracle / MySQL 用 last_active / last_seen 限定“近 {{DAYS}} 天仍在执行”，
 * PG / 达梦没有最近活跃时间，按累计值排行。分钟级增量与波动检测由「SQL 洞察」模块负责，这里只做巡检时点的快照。
 *
 * 占位符：{{TOPN}} 取前 N（默认 10）、{{DAYS}} 活跃天数（默认 1）、{{MINEXECS}} 判定所需最少执行次数（默认 3）。
 */
const { ORA_SYS } = require('./core');

const MY_SYS_SCHEMA = "(SCHEMA_NAME IS NULL OR SCHEMA_NAME NOT IN ('mysql','performance_schema','information_schema','sys'))";
const PG_SYS_DB = "d.datname NOT IN ('template0','template1')";

// ------------------------------------------------------------------ Oracle
const ORA_METRIC = {
  elapsed: { order: 'elapsed_time', val: 'ROUND(elapsed_time / 1000)' },
  cpu: { order: 'cpu_time', val: 'ROUND(cpu_time / 1000)' },
  io: { order: 'disk_reads', val: 'disk_reads' },
  execs: { order: 'executions', val: 'executions' },
  avg: { order: 'elapsed_time / GREATEST(executions, 1)', val: 'ROUND(elapsed_time / 1000 / GREATEST(executions, 1), 2)', minExecs: true },
  rpe: { order: 'buffer_gets / GREATEST(executions, 1)', val: 'ROUND(buffer_gets / GREATEST(executions, 1))', minExecs: true },
};
function oracleTop(metric, view = 'v$sqlarea_plan_hash') {
  const m = ORA_METRIC[metric];
  return `SELECT * FROM (SELECT sql_id AS SQL_ID, plan_hash_value AS PLAN_HASH, parsing_schema_name AS SCHEMA_NAME, executions AS EXECS, `
    + `ROUND(elapsed_time / 1000) AS TOTAL_MS, ROUND(elapsed_time / 1000 / GREATEST(executions, 1), 2) AS AVG_MS, ROUND(cpu_time / 1000) AS CPU_MS, `
    + `buffer_gets AS LOGICAL_READS, disk_reads AS PHYSICAL_READS, rows_processed AS ROWS_PROC, TO_CHAR(last_active_time, 'YYYY-MM-DD HH24:MI:SS') AS LAST_ACTIVE, `
    + `${m.val} AS VAL, SUBSTR(sql_text, 1, 500) AS SQL_TEXT FROM ${view} WHERE parsing_schema_name NOT IN (${ORA_SYS}) `
    + `AND last_active_time >= SYSDATE - {{DAYS}} AND command_type IN (2, 3, 6, 7, 189)${m.minExecs ? ' AND executions >= {{MINEXECS}}' : ''} `
    + `ORDER BY ${m.order} DESC) WHERE ROWNUM <= {{TOPN}}`;
}
const oraImpl = (metric, extra = {}) => ({ sql: oracleTop(metric), fallback: [oracleTop(metric, 'v$sqlarea')], ...extra });

// ------------------------------------------------------------------ MySQL
const MY_METRIC = {
  elapsed: { order: 'SUM_TIMER_WAIT', val: 'ROUND(SUM_TIMER_WAIT / 1000000000)' },
  cpu: { order: 'SUM_CPU_TIME', val: 'ROUND(SUM_CPU_TIME / 1000000000)' },
  io: { order: 'SUM_ROWS_EXAMINED', val: 'SUM_ROWS_EXAMINED' },
  execs: { order: 'COUNT_STAR', val: 'COUNT_STAR' },
  avg: { order: 'SUM_TIMER_WAIT / GREATEST(COUNT_STAR, 1)', val: 'ROUND(SUM_TIMER_WAIT / 1000000000 / GREATEST(COUNT_STAR, 1), 2)', minExecs: true },
  rpe: { order: 'SUM_ROWS_EXAMINED / GREATEST(COUNT_STAR, 1)', val: 'ROUND(SUM_ROWS_EXAMINED / GREATEST(COUNT_STAR, 1))', minExecs: true },
};
function mysqlTop(metric, withCpu = true) {
  const m = MY_METRIC[metric];
  return `SELECT DIGEST AS SQL_ID, SCHEMA_NAME AS SCHEMA_NAME, COUNT_STAR AS EXECS, ROUND(SUM_TIMER_WAIT / 1000000000) AS TOTAL_MS, `
    + `ROUND(SUM_TIMER_WAIT / 1000000000 / GREATEST(COUNT_STAR, 1), 2) AS AVG_MS, ${withCpu ? 'ROUND(SUM_CPU_TIME / 1000000000)' : 'NULL'} AS CPU_MS, `
    + `SUM_ROWS_EXAMINED AS ROWS_EXAMINED, SUM_ROWS_SENT AS ROWS_PROC, SUM_NO_INDEX_USED AS NO_INDEX_EXECS, DATE_FORMAT(LAST_SEEN, '%Y-%m-%d %H:%i:%s') AS LAST_ACTIVE, `
    + `${m.val} AS VAL, LEFT(DIGEST_TEXT, 500) AS SQL_TEXT FROM performance_schema.events_statements_summary_by_digest `
    + `WHERE DIGEST IS NOT NULL AND ${MY_SYS_SCHEMA} AND LAST_SEEN >= NOW() - INTERVAL {{DAYS}} DAY${m.minExecs ? ' AND COUNT_STAR >= {{MINEXECS}}' : ''} `
    + `ORDER BY ${m.order} DESC LIMIT {{TOPN}}`;
}
const myImpl = (metric, extra = {}) => (metric === 'cpu'
  ? { sql: mysqlTop(metric), ...extra }                                    // SUM_CPU_TIME 需 8.0.28+，不降级（降级后排序无意义）
  : { sql: mysqlTop(metric), fallback: [mysqlTop(metric, false)], ...extra });

// ------------------------------------------------------------------ PostgreSQL / 磐维
const PG_METRIC = {   // 以 T 代表“总耗时”列表达式
  elapsed: { order: (T) => T, val: (T) => `ROUND(${T}::numeric)` },
  io: { order: () => 's.shared_blks_read', val: () => 's.shared_blks_read' },
  execs: { order: () => 's.calls', val: () => 's.calls' },
  avg: { order: (T) => `${T} / GREATEST(s.calls, 1)`, val: (T) => `ROUND((${T} / GREATEST(s.calls, 1))::numeric, 2)`, minExecs: true },
  rpe: { order: () => '(s.shared_blks_hit + s.shared_blks_read) / GREATEST(s.calls, 1)', val: () => 'ROUND(((s.shared_blks_hit + s.shared_blks_read) / GREATEST(s.calls, 1))::numeric)', minExecs: true },
};
function pgTop(metric, T = 's.total_exec_time') {
  const m = PG_METRIC[metric];
  return `SELECT s.queryid::text AS SQL_ID, d.datname AS SCHEMA_NAME, s.calls AS EXECS, ROUND(${T}::numeric) AS TOTAL_MS, `
    + `ROUND((${T} / GREATEST(s.calls, 1))::numeric, 2) AS AVG_MS, (s.shared_blks_hit + s.shared_blks_read) AS LOGICAL_READS, `
    + `s.shared_blks_read AS PHYSICAL_READS, s.rows AS ROWS_PROC, ${m.val(T)} AS VAL, LEFT(s.query, 500) AS SQL_TEXT `
    + `FROM pg_stat_statements s JOIN pg_database d ON d.oid = s.dbid WHERE ${PG_SYS_DB} AND s.query NOT ILIKE '%pg_stat_statements%'${m.minExecs ? ' AND s.calls >= {{MINEXECS}}' : ''} `
    + `ORDER BY ${m.order(T)} DESC LIMIT {{TOPN}}`;
}
// 磐维 / openGauss：dbe_perf.statement（时间单位微秒）
const OG_METRIC = {
  elapsed: { order: 'total_elapse_time', val: 'ROUND(total_elapse_time / 1000.0)' },
  cpu: { order: 'cpu_time', val: 'ROUND(cpu_time / 1000.0)' },
  io: { order: '(n_blocks_fetched - n_blocks_hit)', val: '(n_blocks_fetched - n_blocks_hit)' },
  execs: { order: 'n_calls', val: 'n_calls' },
  avg: { order: 'total_elapse_time / GREATEST(n_calls, 1)', val: 'ROUND(total_elapse_time / 1000.0 / GREATEST(n_calls, 1), 2)', minExecs: true },
  rpe: { order: 'n_blocks_fetched / GREATEST(n_calls, 1)', val: 'ROUND(n_blocks_fetched / GREATEST(n_calls, 1))', minExecs: true },
};
function openGaussTop(metric) {
  const m = OG_METRIC[metric];
  return `SELECT unique_sql_id::text AS SQL_ID, user_name AS SCHEMA_NAME, n_calls AS EXECS, ROUND(total_elapse_time / 1000.0) AS TOTAL_MS, `
    + `ROUND(total_elapse_time / 1000.0 / GREATEST(n_calls, 1), 2) AS AVG_MS, ROUND(cpu_time / 1000.0) AS CPU_MS, n_blocks_fetched AS LOGICAL_READS, `
    + `(n_blocks_fetched - n_blocks_hit) AS PHYSICAL_READS, n_returned_rows AS ROWS_PROC, ${m.val} AS VAL, LEFT(query, 500) AS SQL_TEXT `
    + `FROM dbe_perf.statement WHERE n_calls > 0${m.minExecs ? ' AND n_calls >= {{MINEXECS}}' : ''} ORDER BY ${m.order} DESC LIMIT {{TOPN}}`;
}
const pgImpl = (metric, extra = {}) => ({
  sql: pgTop(metric),
  fallback: [pgTop(metric, 's.total_time'), openGaussTop(metric)],        // PG13+ → PG≤12 → 磐维 / openGauss
  ...extra,
});

// ------------------------------------------------------------------ 达梦
const dmImpl = (metric, extra = {}) => ({ adaptive: 'DM_SQL_STAT', adaptiveMetric: metric, sql: `-- adaptive:DM_SQL_STAT:${metric}`, ...extra });

const ITEMS = [
  {
    code: 'sql.stats_ready', name: 'SQL 统计采集就绪', category: 'SQL', sort: 200,
    desc: 'SQL 洞察依赖各库的 SQL 统计视图：PG 需安装 pg_stat_statements，MySQL 需开启 performance_schema，Oracle 的 statistics_level 不能为 BASIC，达梦需 ENABLE_MONITOR=1。未就绪时 Top SQL 类检查项会采集失败。',
    rule: { type: 'STATUS', ok: ['INSTALLED', 'ON', 'TYPICAL', 'ALL', '1', '2'], level: 'WARNING' },
    advice: 'PG：CREATE EXTENSION pg_stat_statements 并加入 shared_preload_libraries；MySQL：performance_schema=ON；Oracle：ALTER SYSTEM SET statistics_level=TYPICAL；达梦：SP_SET_PARA_VALUE 设 ENABLE_MONITOR=1。',
    impls: {
      ORACLE: { sql: "SELECT 'statistics_level' AS OBJ, UPPER(value) AS TXT FROM v$parameter WHERE name = 'statistics_level'" },
      MYSQL: { sql: "SELECT 'performance_schema' AS OBJ, IF(@@performance_schema = 1, 'ON', 'OFF') AS TXT" },
      POSTGRESQL: { sql: "SELECT 'pg_stat_statements' AS OBJ, CASE WHEN EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements') THEN 'INSTALLED' ELSE 'MISSING' END AS TXT" },
      DAMENG: {
        sql: "SELECT 'ENABLE_MONITOR' AS OBJ, TO_CHAR(PARA_VALUE) AS TXT FROM V$DM_INI WHERE PARA_NAME = 'ENABLE_MONITOR'",
        fallback: ["SELECT 'ENABLE_MONITOR' AS OBJ, TO_CHAR(VALUE) AS TXT FROM V$PARAMETER WHERE NAME = 'ENABLE_MONITOR'"],
      },
    },
  },

  // ---------------- Top 排行（不判定，只展示；落入 SQL 洞察章节）
  {
    code: 'sql.top_elapsed', name: 'Top SQL：总耗时', category: 'SQL', sort: 210, sqlBearing: true, dimension: 'ELAPSED',
    desc: '近期仍在执行的 SQL 中，累计总耗时最高的前 N 条（带 sql_id / digest / queryid）。',
    rule: { type: 'TOPN' }, advice: '',
    impls: { ORACLE: oraImpl('elapsed'), MYSQL: myImpl('elapsed'), POSTGRESQL: pgImpl('elapsed'), DAMENG: dmImpl('elapsed') },
  },
  {
    code: 'sql.top_cpu', name: 'Top SQL：CPU 时间', category: 'SQL', sort: 211, sqlBearing: true, dimension: 'CPU',
    desc: '累计 CPU 时间最高的前 N 条。MySQL 需 8.0.28+；PG 官方版无 CPU 计量，仅磐维 / openGauss 提供。',
    rule: { type: 'TOPN' }, advice: '',
    impls: {
      ORACLE: oraImpl('cpu'), MYSQL: myImpl('cpu'), DAMENG: dmImpl('cpu'),
      POSTGRESQL: { sql: openGaussTop('cpu'), dbTypes: ['PANWEI'] },
    },
  },
  {
    code: 'sql.top_io', name: 'Top SQL：物理读 / 扫描量', category: 'SQL', sort: 212, sqlBearing: true, dimension: 'IO',
    desc: '物理读最多的前 N 条（Oracle disk_reads、PG shared_blks_read、达梦物理读；MySQL 无物理读计量，用扫描行数）。',
    rule: { type: 'TOPN' }, advice: '',
    impls: { ORACLE: oraImpl('io'), MYSQL: myImpl('io'), POSTGRESQL: pgImpl('io'), DAMENG: dmImpl('io') },
  },
  {
    code: 'sql.top_execs', name: 'Top SQL：执行次数', category: 'SQL', sort: 213, sqlBearing: true, dimension: 'EXECS',
    desc: '执行次数最多的前 N 条，用于识别高频 SQL 与连接风暴。',
    rule: { type: 'TOPN' }, advice: '',
    impls: { ORACLE: oraImpl('execs'), MYSQL: myImpl('execs'), POSTGRESQL: pgImpl('execs'), DAMENG: dmImpl('execs') },
  },

  // ---------------- 判定类
  {
    code: 'sql.slow_avg', name: '慢 SQL：单次平均耗时过长', category: 'SQL', sort: 220, sqlBearing: true, dimension: 'SLOW',
    desc: '单次平均耗时超过阈值的 SQL（执行次数不少于 minExecs 次，排除偶发）。每条问题都带 sql_id，可到「SQL 洞察」按该标识看波动与计划。',
    rule: { type: 'THRESHOLD', direction: 'HIGH', unit: 'ms', minExecs: 3, maxFindings: 20 }, warn: 1000, crit: 5000,
    advice: '按 sql_id 取执行计划（Oracle DBMS_XPLAN.DISPLAY_CURSOR / PG EXPLAIN (ANALYZE, BUFFERS) / MySQL EXPLAIN ANALYZE），检查索引缺失、统计信息陈旧与低效连接，必要时交给 SQL 优化。',
    impls: { ORACLE: oraImpl('avg'), MYSQL: myImpl('avg'), POSTGRESQL: pgImpl('avg'), DAMENG: dmImpl('avg') },
  },
  {
    code: 'sql.high_reads', name: '单次读取量过大的 SQL', category: 'SQL', sort: 221, sqlBearing: true, dimension: 'READS',
    desc: '单次执行平均逻辑读（Oracle / PG / 达梦为块数，MySQL 为扫描行数）过大的 SQL，通常是缺索引或大范围扫描。',
    rule: { type: 'THRESHOLD', direction: 'HIGH', unit: '块', minExecs: 3, maxFindings: 20 }, warn: 50000, crit: 500000,
    advice: '核对 WHERE 条件与索引，避免函数 / 隐式转换导致索引失效；大范围统计类 SQL 评估分区裁剪或汇总表。',
    impls: {
      ORACLE: oraImpl('rpe'),
      MYSQL: myImpl('rpe', { unit: '行', warn: 10000, crit: 100000 }),
      POSTGRESQL: pgImpl('rpe'),
      DAMENG: dmImpl('rpe'),
    },
  },
  {
    code: 'sql.full_scan', name: '大表全表扫描 / 未走索引的 SQL', category: 'SQL', sort: 222, sqlBearing: true, dimension: 'FULLSCAN',
    desc: 'Oracle：执行计划中对大于阈值（MB）的表做 TABLE ACCESS FULL 的 SQL；MySQL：未使用索引且平均扫描行数过大的 SQL。PG / 达梦暂无等价视图。',
    rule: { type: 'THRESHOLD', direction: 'HIGH', unit: 'MB', maxFindings: 20 }, warn: 100, crit: 1024,
    advice: '为过滤 / 连接列建立合适索引，或改写 SQL 避免函数包裹列；小表全扫无需处理。',
    impls: {
      ORACLE: {
        sql: `SELECT * FROM (SELECT s.sql_id AS SQL_ID, s.plan_hash_value AS PLAN_HASH, s.parsing_schema_name AS SCHEMA_NAME, p.object_owner || '.' || p.object_name AS TABLE_NAME, `
          + `ROUND(sg.bytes / 1048576) AS VAL, s.executions AS EXECS, ROUND(s.elapsed_time / 1000 / GREATEST(s.executions, 1), 2) AS AVG_MS, s.disk_reads AS PHYSICAL_READS, `
          + `TO_CHAR(s.last_active_time, 'YYYY-MM-DD HH24:MI:SS') AS LAST_ACTIVE, SUBSTR(s.sql_text, 1, 500) AS SQL_TEXT FROM v$sql_plan p `
          + `JOIN v$sql s ON s.sql_id = p.sql_id AND s.child_number = p.child_number `
          + `JOIN (SELECT owner, segment_name, SUM(bytes) AS bytes FROM dba_segments WHERE segment_type LIKE 'TABLE%' GROUP BY owner, segment_name) sg ON sg.owner = p.object_owner AND sg.segment_name = p.object_name `
          + `WHERE p.operation = 'TABLE ACCESS' AND p.options = 'FULL' AND sg.bytes >= 100 * 1048576 AND s.parsing_schema_name NOT IN (${ORA_SYS}) `
          + `AND s.last_active_time >= SYSDATE - {{DAYS}} AND s.command_type IN (2, 3, 6, 7, 189) ORDER BY sg.bytes DESC, s.elapsed_time DESC) WHERE ROWNUM <= 20`,
      },
      MYSQL: {
        sql: `SELECT DIGEST AS SQL_ID, SCHEMA_NAME AS SCHEMA_NAME, COUNT_STAR AS EXECS, ROUND(SUM_TIMER_WAIT / 1000000000 / GREATEST(COUNT_STAR, 1), 2) AS AVG_MS, `
          + `ROUND(SUM_ROWS_EXAMINED / GREATEST(COUNT_STAR, 1)) AS VAL, SUM_NO_INDEX_USED AS NO_INDEX_EXECS, SUM_NO_GOOD_INDEX_USED AS NO_GOOD_INDEX_EXECS, `
          + `SUM_ROWS_EXAMINED AS ROWS_EXAMINED, SUM_ROWS_SENT AS ROWS_PROC, DATE_FORMAT(LAST_SEEN, '%Y-%m-%d %H:%i:%s') AS LAST_ACTIVE, LEFT(DIGEST_TEXT, 500) AS SQL_TEXT `
          + `FROM performance_schema.events_statements_summary_by_digest WHERE DIGEST IS NOT NULL AND (SUM_NO_INDEX_USED > 0 OR SUM_NO_GOOD_INDEX_USED > 0) AND ${MY_SYS_SCHEMA} `
          + `AND LAST_SEEN >= NOW() - INTERVAL {{DAYS}} DAY ORDER BY SUM_ROWS_EXAMINED / GREATEST(COUNT_STAR, 1) DESC LIMIT 20`,
        unit: '行/次', warn: 10000, crit: 100000,
      },
    },
  },
  {
    code: 'sql.plan_change', name: '执行计划不稳定（同一 sql_id 多个计划且耗时差异大）', category: 'SQL', sort: 223, sqlBearing: true, dimension: 'PLAN_CHANGE',
    desc: 'Oracle：同一个 sql_id 存在多个 plan_hash_value，且最慢计划的平均耗时是最快计划的数倍，说明计划发生过退化或绑定变量窥探导致计划不稳。',
    rule: { type: 'THRESHOLD', direction: 'HIGH', unit: '倍', maxFindings: 20 }, warn: 3, crit: 10,
    advice: '对比各 plan_hash 的执行计划，必要时用 SQL Plan Baseline / SQL Profile 固定好计划，并刷新相关统计信息。',
    impls: {
      ORACLE: {
        sql: `SELECT * FROM (SELECT sql_id AS SQL_ID, COUNT(*) AS PLAN_COUNT, ROUND(MAX(elapsed_time / GREATEST(executions, 1)) / NULLIF(MIN(elapsed_time / GREATEST(executions, 1)), 0), 1) AS VAL, `
          + `ROUND(MIN(elapsed_time / 1000 / GREATEST(executions, 1)), 2) AS MIN_AVG_MS, ROUND(MAX(elapsed_time / 1000 / GREATEST(executions, 1)), 2) AS MAX_AVG_MS, `
          + `MAX(parsing_schema_name) AS SCHEMA_NAME, MAX(SUBSTR(sql_text, 1, 500)) AS SQL_TEXT FROM v$sqlarea_plan_hash WHERE parsing_schema_name NOT IN (${ORA_SYS}) `
          + `AND executions > 0 AND last_active_time >= SYSDATE - {{DAYS}} GROUP BY sql_id HAVING COUNT(*) > 1 `
          + `AND MAX(elapsed_time / GREATEST(executions, 1)) > 3 * MIN(elapsed_time / GREATEST(executions, 1)) ORDER BY VAL DESC) WHERE ROWNUM <= 20`,
      },
    },
  },
  {
    code: 'sql.no_bind', name: '未使用绑定变量（字面量 SQL 泛滥）', category: 'SQL', sort: 224, sqlBearing: true, dimension: 'NO_BIND',
    desc: 'Oracle：force_matching_signature 相同、仅字面量不同的 SQL 变体过多（硬解析 / 共享池碎片）。MySQL / PG / 达梦的统计视图已按语句摘要归并，不涉及该问题。',
    rule: { type: 'THRESHOLD', direction: 'HIGH', unit: '个变体', maxFindings: 20 }, warn: 50, crit: 500,
    advice: '推动应用改用绑定变量；短期可评估 cursor_sharing=FORCE（先在测试环境验证）。sql_id 为该组中的一个代表。',
    impls: {
      ORACLE: {
        sql: `SELECT * FROM (SELECT MIN(sql_id) AS SQL_ID, COUNT(*) AS VAL, force_matching_signature AS FMS, MAX(parsing_schema_name) AS SCHEMA_NAME, SUM(executions) AS EXECS, `
          + `MAX(SUBSTR(sql_text, 1, 500)) AS SQL_TEXT FROM v$sqlarea WHERE force_matching_signature <> 0 AND parsing_schema_name NOT IN (${ORA_SYS}) AND command_type IN (2, 3, 6, 7, 189) `
          + `GROUP BY force_matching_signature HAVING COUNT(*) >= 20 ORDER BY COUNT(*) DESC) WHERE ROWNUM <= 20`,
      },
    },
  },
  {
    code: 'sql.long_running', name: '长时间运行的 SQL（当前活动会话）', category: 'SQL', sort: 225, sqlBearing: true, dimension: 'LONG_RUN',
    desc: '当前仍在执行、已运行超过阈值的活动会话及其 SQL（带 sql_id / digest / queryid）。',
    rule: { type: 'THRESHOLD', direction: 'HIGH', unit: '秒', maxFindings: 20 }, warn: 300, crit: 1800,
    advice: '确认是否为预期的批处理 / 报表；否则按 sql_id 取执行计划与等待事件，评估终止会话与 SQL 优化。',
    impls: {
      ORACLE: { sql: "SELECT * FROM (SELECT s.sid || ',' || s.serial# AS OBJ, s.last_call_et AS VAL, s.username AS USERNAME, s.event AS EVENT, s.machine AS MACHINE, s.program AS PROGRAM, s.sql_id AS SQL_ID, s.sql_child_number AS CHILD_NO, SUBSTR(q.sql_text, 1, 500) AS SQL_TEXT FROM v$session s LEFT JOIN v$sql q ON q.sql_id = s.sql_id AND q.child_number = s.sql_child_number WHERE s.type = 'USER' AND s.status = 'ACTIVE' AND s.sql_id IS NOT NULL AND s.sid <> SYS_CONTEXT('USERENV', 'SID') ORDER BY s.last_call_et DESC) WHERE ROWNUM <= 20" },
      MYSQL: {
        sql: "SELECT p.ID AS OBJ, p.TIME AS VAL, p.USER AS USERNAME, p.HOST AS MACHINE, p.DB AS SCHEMA_NAME, p.COMMAND AS COMMAND, p.STATE AS STATE, e.DIGEST AS SQL_ID, LEFT(COALESCE(p.INFO, e.SQL_TEXT), 500) AS SQL_TEXT FROM information_schema.PROCESSLIST p LEFT JOIN performance_schema.threads t ON t.PROCESSLIST_ID = p.ID LEFT JOIN performance_schema.events_statements_current e ON e.THREAD_ID = t.THREAD_ID WHERE p.COMMAND NOT IN ('Sleep', 'Daemon', 'Binlog Dump', 'Binlog Dump GTID') AND p.ID <> CONNECTION_ID() AND p.INFO IS NOT NULL ORDER BY p.TIME DESC LIMIT 20",
        fallback: ["SELECT p.ID AS OBJ, p.TIME AS VAL, p.USER AS USERNAME, p.HOST AS MACHINE, p.DB AS SCHEMA_NAME, p.COMMAND AS COMMAND, p.STATE AS STATE, LEFT(p.INFO, 500) AS SQL_TEXT FROM information_schema.PROCESSLIST p WHERE p.COMMAND NOT IN ('Sleep', 'Daemon', 'Binlog Dump', 'Binlog Dump GTID') AND p.ID <> CONNECTION_ID() AND p.INFO IS NOT NULL ORDER BY p.TIME DESC LIMIT 20"],
      },
      POSTGRESQL: {
        sql: "SELECT pid::text AS OBJ, ROUND(EXTRACT(EPOCH FROM (now() - query_start))::numeric) AS VAL, usename AS USERNAME, wait_event AS EVENT, client_addr::text AS MACHINE, application_name AS PROGRAM, datname AS SCHEMA_NAME, query_id::text AS SQL_ID, LEFT(query, 500) AS SQL_TEXT FROM pg_stat_activity WHERE state = 'active' AND pid <> pg_backend_pid() AND backend_type = 'client backend' AND query_start IS NOT NULL ORDER BY query_start LIMIT 20",
        fallback: [
          "SELECT pid::text AS OBJ, ROUND(EXTRACT(EPOCH FROM (now() - query_start))::numeric) AS VAL, usename AS USERNAME, wait_event AS EVENT, client_addr::text AS MACHINE, application_name AS PROGRAM, datname AS SCHEMA_NAME, LEFT(query, 500) AS SQL_TEXT FROM pg_stat_activity WHERE state = 'active' AND pid <> pg_backend_pid() AND backend_type = 'client backend' AND query_start IS NOT NULL ORDER BY query_start LIMIT 20",
          "SELECT pid::text AS OBJ, ROUND(EXTRACT(EPOCH FROM (now() - query_start))::numeric) AS VAL, usename AS USERNAME, client_addr::text AS MACHINE, application_name AS PROGRAM, datname AS SCHEMA_NAME, LEFT(query, 500) AS SQL_TEXT FROM pg_stat_activity WHERE state = 'active' AND pid <> pg_backend_pid() AND query_start IS NOT NULL ORDER BY query_start LIMIT 20",
        ],
      },
      DAMENG: {
        sql: "SELECT * FROM (SELECT SESS_ID AS OBJ, ROUND((SYSDATE - LAST_RECV_TIME) * 86400) AS VAL, USER_NAME AS USERNAME, CLNT_IP AS MACHINE, APPNAME AS PROGRAM, SQL_ID AS SQL_ID, SUBSTR(SQL_TEXT, 1, 500) AS SQL_TEXT FROM V$SESSIONS WHERE STATE = 'ACTIVE' AND SESS_ID <> SESSID() ORDER BY LAST_RECV_TIME) WHERE ROWNUM <= 20",
        fallback: [
          "SELECT * FROM (SELECT SESS_ID AS OBJ, ROUND((SYSDATE - LAST_RECV_TIME) * 86400) AS VAL, USER_NAME AS USERNAME, CLNT_IP AS MACHINE, APPNAME AS PROGRAM, SUBSTR(SQL_TEXT, 1, 500) AS SQL_TEXT FROM V$SESSIONS WHERE STATE = 'ACTIVE' AND SESS_ID <> SESSID() ORDER BY LAST_RECV_TIME) WHERE ROWNUM <= 20",
          "SELECT * FROM (SELECT SESS_ID AS OBJ, ROUND((SYSDATE - LAST_RECV_TIME) * 86400) AS VAL, USER_NAME AS USERNAME, CLNT_IP AS MACHINE, SUBSTR(SQL_TEXT, 1, 500) AS SQL_TEXT FROM V$SESSIONS WHERE STATE = 'ACTIVE' AND SESS_ID <> SESSID() ORDER BY LAST_RECV_TIME) WHERE ROWNUM <= 20",
        ],
      },
    },
  },
];

module.exports = { ITEMS, oracleTop, mysqlTop, pgTop, openGaussTop };
