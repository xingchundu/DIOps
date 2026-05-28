/**
 * F-10 自定义监控指标 — 执行服务
 * 支持两种指标类型：
 * 1. SQL — 对被管库执行自定义 SQL，返回单行单列值
 * 2. EXPRESSION — 从 MONITOR_METRIC_SAMPLE.METRICS_JSON 做聚合计算
 */
const db = require('../config/db');
const { fetchCmdbInstance, connectOracle, connectMysql, connectPostgres, connectDameng, normalizeDbType } = require('../utils/monitorTargetConn');

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
  const inst = await fetchCmdbInstance(instanceId);
  const dbType = normalizeDbType(inst);
  let conn;

  try {
    switch (dbType) {
      case 'ORACLE': conn = await connectOracle(inst); break;
      case 'MYSQL':
      case 'GOLDENDB': conn = await connectMysql(inst); break;
      case 'POSTGRESQL': conn = await connectPostgres(inst); break;
      case 'DAMENG': conn = await connectDameng(inst); break;
      default: throw new Error(`Unsupported DB type: ${dbType}`);
    }

    if (dbType === 'ORACLE' || dbType === 'DAMENG') {
      const result = await conn.execute(sqlText, [], { outFormat: require('oracledb').OUT_FORMAT_OBJECT, maxRows: 100 });
      const columns = result.metaData ? result.metaData.map(m => m.name) : [];
      const rows = result.rows || [];
      const value = rows.length === 1 && columns.length === 1 ? rows[0][columns[0]] : null;
      return { value, columns, rows, dbType };
    }

    if (dbType === 'MYSQL' || dbType === 'GOLDENDB') {
      const [rows] = await conn.query(sqlText);
      const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
      const value = rows.length === 1 && columns.length === 1 ? rows[0][columns[0]] : null;
      return { value, columns, rows: rows.slice(0, 100), dbType };
    }

    if (dbType === 'POSTGRESQL') {
      const result = await conn.query(sqlText);
      const columns = result.fields ? result.fields.map(f => f.name) : [];
      const rows = result.rows || [];
      const value = rows.length === 1 && columns.length === 1 ? rows[0][columns[0]] : null;
      return { value, columns, rows: rows.slice(0, 100), dbType };
    }

    throw new Error(`Unsupported DB type: ${dbType}`);
  } finally {
    if (conn) {
      try {
        if (dbType === 'ORACLE' || dbType === 'DAMENG') await conn.close();
        else if (dbType === 'MYSQL' || dbType === 'GOLDENDB') await conn.end();
        else if (dbType === 'POSTGRESQL') await conn.end();
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
