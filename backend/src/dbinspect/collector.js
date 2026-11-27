'use strict';
/**
 * 采集器：在被管库连接上执行检查项的采集 SQL，只取数不判定。
 *   - 只读保护（readOnlyViolation）、行数上限、单条超时；
 *   - 主 SQL 失败（视图 / 列不存在，版本差异）时依次尝试 fallback；
 *   - 统一结果行：键全部大写；SHOW 类结果按 map 映射成 OBJ / VAL / TXT；
 *   - sqlBearing 的检查项：每一行都保证带 SQL_ID（原生标识，缺失则 FP: 指纹）。
 */
const oracledb = require('oracledb');
const { readOnlyViolation } = require('../utils/inspectScriptParser');
const { rowToPlain } = require('../services/inspectScriptExecutor');
const { ensureSqlId } = require('./dialect');
const { buildDmSqlStat } = require('./adaptive');

const MAX_ROWS = Math.max(50, Number(process.env.DBINSPECT_MAX_ROWS) || 200);
const STMT_TIMEOUT_MS = Math.max(5000, Number(process.env.DBINSPECT_STMT_TIMEOUT_MS) || 60000);
const DM_TIME_DIVISOR = Number(process.env.DBINSPECT_DM_TIME_DIVISOR) || 1;

const kindOf = (family) => (family === 'MYSQL' ? 'mysql' : family === 'POSTGRESQL' ? 'pg' : 'oracle');   // 达梦与 oracledb 接口一致

async function prepare(family, conn) {
  try {
    if (family === 'ORACLE') conn.callTimeout = STMT_TIMEOUT_MS;
    else if (family === 'POSTGRESQL') await conn.query(`SET statement_timeout = ${STMT_TIMEOUT_MS}`);
    else if (family === 'MYSQL') await conn.query(`SET SESSION max_execution_time = ${STMT_TIMEOUT_MS}`).catch(() => {});
  } catch { /* 超时设置失败不影响巡检 */ }
}

function upperKeys(o) {
  const r = {};
  for (const k of Object.keys(o)) r[String(k).toUpperCase()] = o[k];
  return r;
}

/** 执行一条语句 → { columns, rows }，键大写、值已转为可 JSON 序列化的普通值 */
async function execRaw(family, conn, sql) {
  const kind = kindOf(family);
  if (kind === 'oracle') {
    const r = await conn.execute(sql, [], {
      outFormat: oracledb.OUT_FORMAT_OBJECT, maxRows: MAX_ROWS, autoCommit: false, fetchAsString: [oracledb.CLOB],
    });
    const rows = (r.rows || []).map((x) => upperKeys(rowToPlain(x)));
    const columns = r.metaData && r.metaData.length ? r.metaData.map((m) => String(m.name).toUpperCase()) : (rows[0] ? Object.keys(rows[0]) : []);
    return { columns, rows };
  }
  if (kind === 'mysql') {
    const [rows, fields] = await conn.query({ sql, timeout: STMT_TIMEOUT_MS });
    if (!Array.isArray(rows)) return { columns: [], rows: [] };
    const plain = rows.slice(0, MAX_ROWS).map((x) => upperKeys(rowToPlain(x)));
    const columns = fields && fields.length ? fields.map((f) => String(f.name).toUpperCase()) : (plain[0] ? Object.keys(plain[0]) : []);
    return { columns, rows: plain };
  }
  const r = await conn.query(sql);
  const res = Array.isArray(r) ? r[r.length - 1] : r;
  const rows = (res.rows || []).slice(0, MAX_ROWS).map((x) => upperKeys(rowToPlain(x)));
  const columns = res.fields && res.fields.length ? res.fields.map((f) => String(f.name).toUpperCase()) : (rows[0] ? Object.keys(rows[0]) : []);
  return { columns, rows };
}

/** 占位符：{{TOPN}} {{DAYS}} {{MINEXECS}}，只允许正整数，防注入 */
function fillParams(sql, params = {}) {
  const n = (v, d, min, max) => {
    const x = Math.floor(Number(v));
    return Number.isFinite(x) ? Math.min(max, Math.max(min, x)) : d;
  };
  return String(sql)
    .replace(/\{\{TOPN\}\}/g, String(n(params.topn, 10, 1, 100)))
    .replace(/\{\{DAYS\}\}/g, String(n(params.days, 1, 1, 90)))
    .replace(/\{\{MINEXECS\}\}/g, String(n(params.minExecs, 3, 1, 1000000)));
}

const pickCol = (row, names) => {
  for (const n of names) { const k = String(n).toUpperCase(); if (row[k] !== undefined) return row[k]; }
  return undefined;
};

/** SHOW REPLICA STATUS 这类列名固定的结果，按 map 映射成 OBJ / VAL / TXT */
function applyMap(rows, map) {
  if (!map) return rows;
  return rows.map((r) => {
    const o = { ...r };
    if (map.obj) { const v = pickCol(r, map.obj); if (v !== undefined && v !== null && v !== '') o.OBJ = v; }
    if (map.val) { const v = pickCol(r, map.val); if (v !== undefined) o.VAL = v; }
    if (map.txt) { const v = pickCol(r, map.txt); if (v !== undefined) o.TXT = v; }
    if (map.txtAllYes) {
      const parts = map.txtAllYes.map((g) => String(pickCol(r, g) ?? ''));
      o.TXT = parts.every((p) => /^yes$/i.test(p)) ? 'RUNNING' : `STOPPED(${parts.join('/')})`;
    }
    if (o.OBJ === undefined || o.OBJ === null || o.OBJ === '') o.OBJ = '-';
    return o;
  });
}

/** 把底层报错翻译成运维能看懂的原因（原文保留在后面） */
function explainError(err, family) {
  const m = String(err && err.message ? err.message : err);
  let hint = '';
  if (/pg_stat_statements/i.test(m)) hint = '未安装 / 未加载 pg_stat_statements 扩展';
  else if (/ORA-00942|ORA-01031/.test(m)) hint = '权限不足或视图不存在（需 SELECT_CATALOG_ROLE 或 SELECT ANY DICTIONARY）';
  else if (/ORA-00904/.test(m)) hint = '当前 Oracle 版本缺少该列';
  else if (/permission denied|must be superuser|must be member/i.test(m)) hint = '权限不足（需 pg_monitor 角色或超级用户）';
  else if (/ER_TABLEACCESS_DENIED|ER_SPECIFIC_ACCESS_DENIED|SELECT command denied|Access denied/i.test(m)) hint = '权限不足（需对 performance_schema / sys / mysql 库有 SELECT，及 PROCESS 权限）';
  else if (/doesn't exist|Unknown column|Unknown table/i.test(m) && family === 'MYSQL') hint = '当前 MySQL 版本不支持该视图 / 列，或 performance_schema 未开启';
  else if (/无效的表或视图名|invalid table or view|不存在的.*(视图|表)|does not exist|undefined (table|column)/i.test(m) && family === 'DAMENG') hint = '达梦视图 / 列名不匹配（版本差异或未开启 ENABLE_MONITOR），可在「检查项 → 高级」调整 SQL';
  else if (/timeout|timed out|ETIMEDOUT|ECONNRESET|connection.*(closed|terminated)/i.test(m)) hint = '执行超时或连接中断';
  return hint ? `${hint}：${m.replace(/\s+/g, ' ').slice(0, 300)}` : m.replace(/\s+/g, ' ').slice(0, 400);
}

/** 连接已断：后续检查项不必再试 */
function isConnectionLost(err) {
  const m = String(err && err.message ? err.message : err);
  return /ORA-03113|ORA-03114|ORA-03135|DPI-1010|DPY-4011|NJS-003|NJS-500|ECONNRESET|EPIPE|Connection terminated|Can't add new command when connection is in closed state|PROTOCOL_CONNECTION_LOST|connection is closed|通讯|Not connected/i.test(m);
}

async function dmColumns(conn) {
  const r = await execRaw('DAMENG', conn, 'SELECT * FROM V$SQL_STAT WHERE 1=0');
  return new Set(r.columns.map((c) => c.toUpperCase()));
}

/**
 * @param {{conn, family, dbType, item:{ITEM_CODE,SQL_BEARING,rule}, impl:{SQL_TEXT,fallback:string[],map,adaptive,adaptiveMetric}, params}} a
 * @returns {{columns:string[], rows:object[], variant:number}}
 */
async function collect(a) {
  const { conn, family, item, impl, params } = a;
  let variants = [impl.sql, ...(impl.fallback || [])].filter(Boolean);
  const errors = [];

  if (impl.adaptive === 'DM_SQL_STAT') {
    try {
      const metric = impl.adaptiveMetric || String(impl.sql || '').split(':').pop();
      variants = [buildDmSqlStat(await dmColumns(conn), metric, { divisor: DM_TIME_DIVISOR })];
    } catch (e) {
      throw Object.assign(new Error(explainError(e, family)), { lost: isConnectionLost(e) });
    }
  }

  for (let i = 0; i < variants.length; i++) {
    const sql = fillParams(variants[i], params);
    const bad = readOnlyViolation(sql);
    if (bad) { errors.push(bad); continue; }
    try {
      const r = await execRaw(family, conn, sql);
      let rows = applyMap(r.rows, impl.map);
      if (item.SQL_BEARING) rows.forEach((row) => ensureSqlId(row, family));
      rows = rows.map((row) => { if (row.OBJ === undefined) row.OBJ = '-'; return row; });
      return { columns: r.columns, rows, variant: i };
    } catch (e) {
      errors.push(e);
      if (isConnectionLost(e)) throw Object.assign(new Error(explainError(e, family)), { lost: true });
    }
  }
  const last = errors[errors.length - 1];
  throw Object.assign(new Error(explainError(last, family)), { lost: false, tried: variants.length });
}

module.exports = { collect, execRaw, fillParams, applyMap, explainError, isConnectionLost, prepare, MAX_ROWS };
