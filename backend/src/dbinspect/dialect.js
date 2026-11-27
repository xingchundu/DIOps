'use strict';
/**
 * 数据库巡检：方言族映射 + sql_id 规范化。
 *
 * 方言族（采集 SQL 的粒度）：ORACLE / MYSQL / POSTGRESQL / DAMENG
 *   GOLDENDB → MYSQL；PANWEI（openGauss 系）→ POSTGRESQL
 *
 * “采集的语句要带上 sql_id”：
 *   Oracle  → V$SQL / V$SQLAREA 的 SQL_ID
 *   MySQL   → performance_schema 的 DIGEST（SQL 语句摘要，32 位 MD5 / 64 位 SHA-256）
 *   PG      → pg_stat_statements 的 queryid（PG14+ 的 pg_stat_activity.query_id）；磐维为 dbe_perf.statement.unique_sql_id
 *   达梦    → V$SQL_STAT / V$SESSIONS 的 SQL_ID
 *   源库没有给出标识（旧版本 / 视图不带 / 权限）时，用“归一化 SQL 文本”的指纹补上，形如 FP:3fa9…，
 *   并把 SQL_ID_KIND 标成 FINGERPRINT，报告里一眼能看出这不是库原生标识。
 */
const crypto = require('crypto');

const FAMILY = {
  ORACLE: 'ORACLE',
  MYSQL: 'MYSQL', GOLDENDB: 'MYSQL',
  POSTGRESQL: 'POSTGRESQL', PANWEI: 'POSTGRESQL',
  DAMENG: 'DAMENG', DM: 'DAMENG',
};
const FAMILIES = ['ORACLE', 'MYSQL', 'POSTGRESQL', 'DAMENG'];
const FAMILY_LABEL = { ORACLE: 'Oracle', MYSQL: 'MySQL', POSTGRESQL: 'PostgreSQL', DAMENG: '达梦 DM' };
const SQL_ID_KIND = { ORACLE: 'SQL_ID', MYSQL: 'DIGEST', POSTGRESQL: 'QUERYID', DAMENG: 'SQL_ID' };

function familyOf(dbType) {
  return FAMILY[String(dbType || '').toUpperCase()] || null;
}

/** 去注释、折叠空白、字面量→?，用于缺失原生标识时的指纹 */
function normalizeSqlText(text) {
  return String(text || '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/'(?:[^']|'')*'/g, '?')
    .replace(/\b\d+(?:\.\d+)?\b/g, '?')
    .replace(/\(\s*\?(?:\s*,\s*\?)+\s*\)/g, '(?)')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function fingerprint(text) {
  const n = normalizeSqlText(text);
  if (!n) return null;
  return `FP:${crypto.createHash('sha1').update(n).digest('hex').slice(0, 16)}`;
}

/**
 * 保证一行 SQL 结果带 SQL_ID / SQL_ID_KIND。row 的键必须是大写。
 * @returns {{sqlId:string|null, kind:string}}
 */
function ensureSqlId(row, family) {
  const native = row.SQL_ID != null && String(row.SQL_ID).trim() !== '' && String(row.SQL_ID) !== 'null'
    ? String(row.SQL_ID).trim() : null;
  if (native) {
    row.SQL_ID = native;
    row.SQL_ID_KIND = native.startsWith('FP:') ? 'FINGERPRINT' : (SQL_ID_KIND[family] || 'SQL_ID');
    return { sqlId: native, kind: row.SQL_ID_KIND };
  }
  const fp = fingerprint(row.SQL_TEXT);
  if (fp) {
    row.SQL_ID = fp;
    row.SQL_ID_KIND = 'FINGERPRINT';
    return { sqlId: fp, kind: 'FINGERPRINT' };
  }
  row.SQL_ID = null;
  row.SQL_ID_KIND = null;
  return { sqlId: null, kind: null };
}

function sqlIdLabel(family) {
  return { ORACLE: 'sql_id', MYSQL: 'digest', POSTGRESQL: 'queryid', DAMENG: 'sql_id' }[family] || 'sql_id';
}

module.exports = {
  FAMILY, FAMILIES, FAMILY_LABEL, SQL_ID_KIND,
  familyOf, normalizeSqlText, fingerprint, ensureSqlId, sqlIdLabel,
};
