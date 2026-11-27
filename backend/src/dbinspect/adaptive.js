'use strict';
/**
 * 自适应取数：达梦 V$SQL_STAT 的列名随版本不同（EXEC_TIMES / EXECUTE_TIMES…、CPU_TIME / EXEC_CPU…），
 * 先 SELECT * FROM V$SQL_STAT WHERE 1=0 探测实际列名，再按“候选列”拼出采集 SQL。
 * 候选列与 Java 侧 sqlinsight/collect/StatsSource.dameng() 保持一致；所需列都不存在时抛出带实际列名的错误，
 * 巡检里该检查项记为“采集失败”（不当作数据库异常），并提示到「检查项 → 高级」里手工改 SQL。
 */

const SYS_SCHEMAS = "'SYS','SYSDBA','SYSAUDITOR','SYSSSO','CTISYS'";

function col(expr, ...requires) { return { expr, requires: requires.length ? requires : [expr] }; }

const CANDIDATES = {
  text: [col('SQL_TXT'), col('SQL_TEXT')],
  schema: [col('CURR_SCH'), col('SCH_NAME')],
  exec: [col('EXEC_TIMES'), col('EXECUTE_TIMES'), col('EXEC_COUNT'),
    col('(SEL_SQL_CNT + DEL_SQL_CNT + DDL_SQL_CNT)', 'SEL_SQL_CNT', 'DEL_SQL_CNT', 'DDL_SQL_CNT'), col('DYN_EXEC_CNT')],
  ela: [col('TOTAL_EXEC_TIME'), col('EXEC_TIME'), col('TIME_USED'),
    col('(EXEC_TIME + PARSE_TIME + HARD_PARSE_TIME + IO_WAIT_TIME)', 'EXEC_TIME', 'PARSE_TIME', 'HARD_PARSE_TIME', 'IO_WAIT_TIME')],
  cpu: [col('CPU_TIME'), col('EXEC_CPU')],
  lr: [col('LOGIC_READ_CNT'), col('LOGIC_READS'), col('(HBUF_LOGIC_READ_CNT + RECYCLE_LOGIC_READ_CNT)', 'HBUF_LOGIC_READ_CNT', 'RECYCLE_LOGIC_READ_CNT'), col('HBUF_LOGIC_READ_CNT')],
  pr: [col('PHY_READ_CNT'), col('PHY_READS'), col('HBUF_PHY_READ_CNT')],
  rows: [col('ROW_COUNT'), col('ROWS_PROCESSED'), col('VIS_RECS_CNT')],
};

function first(list, cols) {
  return list.find((c) => c.requires.every((r) => cols.has(r.toUpperCase()))) || null;
}

/**
 * @param {Set<string>} cols V$SQL_STAT 实际列名（大写）
 * @param {string} metric elapsed|cpu|io|execs|avg|rpe
 * @param {{divisor?:number}} opts  时间列除数，换算成毫秒（达梦 V$SQL_STAT 时间列默认按毫秒；微秒库设 DBINSPECT_DM_TIME_DIVISOR=1000）
 */
function buildDmSqlStat(cols, metric, opts = {}) {
  const div = Number(opts.divisor) > 0 ? Number(opts.divisor) : 1;
  if (!cols.has('SQL_ID')) {
    throw new Error(`V$SQL_STAT 没有 SQL_ID 列，无法带 sql_id 采集（实际列：${[...cols].slice(0, 40).join(',')}）`);
  }
  const c = {};
  for (const k of Object.keys(CANDIDATES)) c[k] = first(CANDIDATES[k], cols);

  const need = { elapsed: ['ela'], cpu: ['cpu'], io: ['pr'], execs: ['exec'], avg: ['ela', 'exec'], rpe: ['lr', 'exec'] }[metric];
  if (!need) throw new Error(`达梦自适应采集不支持指标 ${metric}`);
  const missing = need.filter((k) => !c[k]);
  if (missing.length) {
    throw new Error(`V$SQL_STAT 缺少 ${missing.join('/')} 对应的列，当前版本无法采集该指标（实际列：${[...cols].slice(0, 40).join(',')}）。可在「检查项 → 高级」中按实际列名改写 SQL。`);
  }

  const ms = (e) => `ROUND(${e} / ${div})`;
  const sel = [
    'SQL_ID AS SQL_ID',
    `${c.text ? `SUBSTR(${c.text.expr}, 1, 500)` : 'NULL'} AS SQL_TEXT`,
    `${c.schema ? c.schema.expr : 'NULL'} AS SCHEMA_NAME`,
    `${c.exec ? c.exec.expr : 'NULL'} AS EXECS`,
    `${c.ela ? ms(c.ela.expr) : 'NULL'} AS TOTAL_MS`,
    `${c.ela && c.exec ? `ROUND(${c.ela.expr} / ${div} / GREATEST(${c.exec.expr}, 1), 2)` : 'NULL'} AS AVG_MS`,
    `${c.cpu ? ms(c.cpu.expr) : 'NULL'} AS CPU_MS`,
    `${c.lr ? c.lr.expr : 'NULL'} AS LOGICAL_READS`,
    `${c.pr ? c.pr.expr : 'NULL'} AS PHYSICAL_READS`,
    `${c.rows ? c.rows.expr : 'NULL'} AS ROWS_PROC`,
  ];
  const E = (k) => c[k].expr;
  // 只对所选指标取值（惰性），否则缺少无关列（如无 CPU 列时查 elapsed）会空引用
  const VAL = {
    elapsed: () => ms(E('ela')),
    cpu: () => ms(E('cpu')),
    io: () => E('pr'),
    execs: () => E('exec'),
    avg: () => `ROUND(${E('ela')} / ${div} / GREATEST(${E('exec')}, 1), 2)`,
    rpe: () => `ROUND(${E('lr')} / GREATEST(${E('exec')}, 1))`,
  }[metric]();
  const ORDER = {
    elapsed: () => E('ela'), cpu: () => E('cpu'), io: () => E('pr'), execs: () => E('exec'),
    avg: () => `${E('ela')} / GREATEST(${E('exec')}, 1)`, rpe: () => `${E('lr')} / GREATEST(${E('exec')}, 1)`,
  }[metric]();
  sel.push(`${VAL} AS VAL`);

  const where = ['SQL_ID IS NOT NULL'];
  if (c.schema) where.push(`(${c.schema.expr} IS NULL OR ${c.schema.expr} NOT IN (${SYS_SCHEMAS}))`);
  if (c.text) where.push(`${c.text.expr} NOT LIKE '%V$SQL_STAT%'`);
  if ((metric === 'avg' || metric === 'rpe') && c.exec) where.push(`${c.exec.expr} >= {{MINEXECS}}`);
  return `SELECT * FROM (SELECT ${sel.join(', ')} FROM V$SQL_STAT WHERE ${where.join(' AND ')} ORDER BY ${ORDER} DESC) WHERE ROWNUM <= {{TOPN}}`;
}

module.exports = { buildDmSqlStat, CANDIDATES };
