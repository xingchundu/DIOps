/**
 * F-10 自定义监控指标 — 执行服务
 * 支持两种指标类型：
 * 1. SQL — 对被管库执行自定义 SQL，返回单行单列值
 * 2. EXPRESSION — 从 MONITOR_METRIC_SAMPLE.METRICS_JSON 做聚合计算
 */
const db = require('../config/db');
const { fetchCmdbInstance, connectOracle, connectMysql, connectPostgres, connectDameng, connectSqlServer, normalizeDbType, isPgFamily, isSqlServer } = require('../utils/monitorTargetConn');

// ─── EXPRESSION 解析器 ────────────────────────────────────────────
// 支持语法: avg(METRIC_CPU), last(HEALTH_SCORE), max(METRIC_CONN), min(METRIC_CPU), sum(METRIC_CONN), count()
// 也支持 JSON 内的指标名: avg(Buffer Cache Hit Ratio)
const AGG_FNS = { avg, last, max, min, sum, count };
const EXPR_RE = /^(avg|last|max|min|sum|count)\(([^)]*)\)$/i;

function avg(arr) { const v = arr.filter(x => x != null && !isNaN(x)); return v.length ? +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2) : null; }
function last(arr) { return arr.length ? arr[arr.length - 1] : null; }
function max(arr) { const v = arr.filter(x => x != null && !isNaN(x)); return v.length ? Math.max(...v) : null; }
function min(arr) { const v = arr.filter(x => x != null && !isNaN(x)); return v.length ? Math.min(...v) : null; }
function sum(arr) { const v = arr.filter(x => x != null && !isNaN(x)); return v.length ? +(v.reduce((a, b) => a + b, 0)).toFixed(2) : null; }
function count(arr) { return arr.length; }

const FORBIDDEN_SQL_RE = /\b(insert|update|delete|merge|drop|truncate|alter|create|grant|revoke|exec|execute|call|declare|begin|commit|rollback|into\b)\b/i;
// 读文件 / 访问网络 / 执行命令 / 拖延会话 / 读口令表的函数与对象（SELECT 里也能调用，单靠关键字黑名单拦不住）
const FORBIDDEN_FN_RE = /\b(pg_read_file|pg_read_binary_file|pg_ls_dir|pg_stat_file|lo_import|lo_export|dblink\w*|pg_sleep\w*|pg_terminate_backend|pg_cancel_backend|copy|dbms_lock|dbms_pipe|dbms_scheduler|dbms_java|dbms_xmlquery|dbms_ldap|utl_http|utl_file|utl_tcp|utl_smtp|utl_inaddr|httpuritype|sys_exec|load_file|sleep|benchmark|get_lock|xp_\w+|sp_oacreate|openrowset|opendatasource|openquery)\s*\(|\b(mysql\.user|sys\.user\$|dba_users|sys\.sql_logins|pg_authid|pg_shadow|sysdba_users|outfile|dumpfile)\b/i;
const QUERY_TIMEOUT_MS = 15000;
const MAX_ROWS = 100;

function assertReadOnlySql(sqlText) {
  let sql = String(sqlText || '').trim();
  if (!sql) throw new Error('SQL 语句不能为空');
  if (sql.includes(';')) {
    const parts = sql.split(';').map((s) => s.trim()).filter(Boolean);
    if (parts.length > 1) throw new Error('不允许执行多条 SQL');
    sql = parts[0] || sql;
  }
  const stripped = sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n\r]*/g, ' ').trim();
  if (!/^select\b/i.test(stripped)) throw new Error('仅允许 SELECT 查询');
  if (FORBIDDEN_SQL_RE.test(stripped)) throw new Error('SQL 含不允许的关键字');
  if (FORBIDDEN_FN_RE.test(stripped)) throw new Error('SQL 调用了不允许的函数或系统对象');
  return sql;
}

/**
 * 执行表达式指标
 * @param {number} instanceId
 * @param {string} expression - 如 "avg(METRIC_CPU)"
 * @param {number} hours - 回溯小时数（默认 24）
 * @returns {Promise<{value: number|null, samples: number, expression: string}>}
 */
async function evaluateExpression(instanceId, expression, hours = 24) {
  const match = String(expression || '').trim().match(EXPR_RE);
  if (!match) return { value: null, samples: 0, expression, error: 'Invalid expression syntax' };

  const fnName = match[1].toLowerCase();
  const metricKey = match[2].trim();
  const fn = AGG_FNS[fnName];
  if (!fn) return { value: null, samples: 0, expression, error: `Unknown function: ${fnName}` };

  // 读取最近 N 小时的采样数据
  const sql = metricKey === 'METRIC_CPU' || metricKey === 'METRIC_CONN' || metricKey === 'HEALTH_SCORE'
    ? `SELECT ${metricKey} AS VAL FROM MONITOR_METRIC_SAMPLE
       WHERE INSTANCE_ID = :1 AND COLLECTED_AT >= SYSTIMESTAMP - NUMTODSINTERVAL(:2, 'HOUR')
       AND ${metricKey} IS NOT NULL ORDER BY COLLECTED_AT ASC`
    : null;

  let values = [];
  if (sql) {
    // 直接从顶层列取值
    const r = await db.execute(sql, [instanceId, hours]);
    values = (r.rows || []).map(row => Number(row.VAL));
  } else {
    // 从 METRICS_JSON 中按 METRIC_NAME 匹配
    const r = await db.execute(
      `SELECT METRICS_JSON FROM MONITOR_METRIC_SAMPLE
       WHERE INSTANCE_ID = :1 AND COLLECTED_AT >= SYSTIMESTAMP - NUMTODSINTERVAL(:2, 'HOUR')
       AND METRICS_JSON IS NOT NULL ORDER BY COLLECTED_AT ASC`,
      [instanceId, hours]
    );
    for (const row of (r.rows || [])) {
      try {
        const parsed = JSON.parse(row.METRICS_JSON);
        const metrics = parsed.metrics || [];
        const found = metrics.find(m => m.METRIC_NAME === metricKey);
        if (found && found.VALUE != null && !isNaN(Number(found.VALUE))) {
          values.push(Number(found.VALUE));
        }
      } catch { /* skip invalid JSON */ }
    }
  }

  const value = fn(values);
  return { value, samples: values.length, expression, metricKey, fnName };
}

/**
 * 执行自定义 SQL 指标
 * @param {number} instanceId - 被管实例 ID
 * @param {string} sqlText - 自定义 SQL（返回单行单列）
 * @returns {Promise<{value: any, columns: string[], rows: any[]}>}
 */
async function executeCustomSql(instanceId, sqlText) {
  // CLOB columns may return as Lob objects; ensure we have a plain string
  if (sqlText && typeof sqlText !== 'string') {
    sqlText = typeof sqlText.getData === 'function' ? await sqlText.getData() : String(sqlText);
  }
  if (!sqlText || !sqlText.trim()) throw new Error('SQL 语句不能为空');
  sqlText = assertReadOnlySql(sqlText);
  const inst = await fetchCmdbInstance(instanceId);
  const dbType = normalizeDbType(inst);
  let conn;

  try {
    switch (dbType) {
      case 'ORACLE': conn = await connectOracle(inst); break;
      case 'MYSQL':
      case 'GOLDENDB': conn = await connectMysql(inst); break;
      case 'POSTGRESQL':
      case 'PANWEI': conn = await connectPostgres(inst); break;
      case 'DAMENG': conn = await connectDameng(inst); break;
      case 'SQLSERVER': conn = await connectSqlServer(inst); break;
      default: throw new Error(`Unsupported DB type: ${dbType}`);
    }

    // 只读事务 + 语句超时 + 行数上限：即使绕过了文本检查，也无法改数据或长时间占用会话
    const pick = (rows, columns) => ({
      value: rows.length === 1 && columns.length === 1 ? rows[0][columns[0]] : null,
      columns, rows: rows.slice(0, MAX_ROWS), dbType, truncated: rows.length > MAX_ROWS,
    });
    if (dbType === 'ORACLE' || dbType === 'DAMENG') {
      try { await conn.execute('SET TRANSACTION READ ONLY'); } catch { /* 部分版本不支持时继续，仍有关键字检查 */ }
      if ('callTimeout' in conn) conn.callTimeout = QUERY_TIMEOUT_MS;
      try {
        const result = await conn.execute(sqlText, [], { outFormat: require('oracledb').OUT_FORMAT_OBJECT, maxRows: MAX_ROWS + 1 });
        return pick(result.rows || [], result.metaData ? result.metaData.map(m => m.name) : []);
      } finally {
        try { await conn.rollback(); } catch { /* ignore */ }
      }
    }

    if (dbType === 'MYSQL' || dbType === 'GOLDENDB') {
      await conn.query('START TRANSACTION READ ONLY');
      try {
        const [rows] = await conn.query({ sql: `SELECT * FROM (${sqlText}) dbops_q LIMIT ${MAX_ROWS + 1}`, timeout: QUERY_TIMEOUT_MS });
        return pick(rows, rows.length > 0 ? Object.keys(rows[0]) : []);
      } finally {
        try { await conn.query('ROLLBACK'); } catch { /* ignore */ }
      }
    }

    if (dbType === 'POSTGRESQL' || dbType === 'PANWEI') {
      await conn.query('BEGIN READ ONLY');
      try {
        await conn.query(`SET LOCAL statement_timeout = ${QUERY_TIMEOUT_MS}`);
        const result = await conn.query(`SELECT * FROM (${sqlText}) dbops_q LIMIT ${MAX_ROWS + 1}`);
        return pick(result.rows || [], result.fields ? result.fields.map(f => f.name) : []);
      } finally {
        try { await conn.query('ROLLBACK'); } catch { /* ignore */ }
      }
    }

    if (dbType === 'SQLSERVER') {
      const req = conn.request();
      req.timeout = QUERY_TIMEOUT_MS;
      const result = await req.batch(`SET ROWCOUNT ${MAX_ROWS + 1}; ${sqlText}; SET ROWCOUNT 0;`);
      const rows = result.recordset || [];
      return pick(rows, rows.length > 0 ? Object.keys(rows[0]) : []);
    }

    throw new Error(`Unsupported DB type: ${dbType}`);
  } finally {
    if (conn) {
      try {
        if (dbType === 'ORACLE' || dbType === 'DAMENG') await conn.close();
        else if (dbType === 'MYSQL' || dbType === 'GOLDENDB') await conn.end();
        else if (isPgFamily(dbType)) await conn.end();
        else if (isSqlServer(dbType)) await conn.close();
      } catch { /* ignore close errors */ }
    }
  }
}

/**
 * 批量执行面板下所有指标
 * @param {number} panelId
 * @returns {Promise<Array>}
 */
async function executePanelMetrics(panelId) {
  const panelRes = await db.execute(
    `SELECT PANEL_ID, PANEL_NAME, DB_TYPE FROM MONITOR_CUSTOM_PANEL WHERE PANEL_ID = :1 AND ENABLED = 1`,
    [panelId]
  );
  if (!panelRes.rows.length) throw new Error(`Panel ${panelId} not found or disabled`);

  const metricRes = await db.execute(
    `SELECT * FROM MONITOR_CUSTOM_METRIC WHERE PANEL_ID = :1 AND ENABLED = 1 ORDER BY SORT_ORDER`,
    [panelId]
  );

  const results = [];
  for (const m of (metricRes.rows || [])) {
    const entry = {
      metricId: m.METRIC_ID,
      metricName: m.METRIC_NAME,
      metricLabel: m.METRIC_LABEL || m.METRIC_NAME,
      metricType: m.METRIC_TYPE,
      chartType: m.CHART_TYPE,
      unit: m.UNIT,
      thresholdWarn: m.THRESHOLD_WARN,
      thresholdCrit: m.THRESHOLD_CRIT,
      color: m.COLOR,
    };

    try {
      if (m.METRIC_TYPE === 'EXPRESSION' && m.INSTANCE_ID) {
        const evalResult = await evaluateExpression(m.INSTANCE_ID, m.EXPRESSION);
        entry.value = evalResult.value;
        entry.samples = evalResult.samples;
        entry.error = evalResult.error || null;
      } else if (m.METRIC_TYPE === 'SQL' && m.SQL_TEXT) {
        // SQL 类型需要指定实例 — 从面板绑定或指标绑定
        // 如果面板有 DB_TYPE 约束，取匹配实例
        if (m.INSTANCE_ID) {
          const sqlResult = await executeCustomSql(m.INSTANCE_ID, m.SQL_TEXT);
          entry.value = sqlResult.value;
          entry.columns = sqlResult.columns;
          entry.rows = sqlResult.rows;
          entry.error = null;
        } else {
          entry.value = null;
          entry.error = 'SQL metric requires INSTANCE_ID';
        }
      } else {
        entry.value = null;
        entry.error = 'Invalid metric configuration';
      }
    } catch (e) {
      entry.value = null;
      entry.error = (e.message || String(e)).slice(0, 500);
    }

    results.push(entry);
  }

  return results;
}

module.exports = {
  evaluateExpression,
  executeCustomSql,
  executePanelMetrics,
};
