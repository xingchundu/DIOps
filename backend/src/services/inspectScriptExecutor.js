/**
 * 在被管实例连接上执行巡检脚本（INSPECT_SCRIPT 或 master 模板），按“检查项（section）”收集结果集。
 *
 * v2（本次修复）：
 *  - 分段交给 utils/inspectScriptParser 统一解析：支持 PROMPT / PRINT / \echo / SELECT '>>SECTION:' 四种标记，
 *    保留检查项编号、标题、分类；原实现丢弃 PROMPT/\echo 行，Oracle / 达梦 / PG / 磐维模板的分段全部丢失；
 *  - 只允许只读语句（readOnlyViolation）；原实现对 INSERT/DELETE/DROP/PL/SQL 块照跑；
 *  - 单条语句超时、行数上限（超出标记 truncated，rowCount 保留真实总数）；CLOB 直接取字符串（原来 Lob 对象会让 JSON.stringify 循环引用）；
 *  - 单条语句失败只记录到该检查项，不影响其它检查项；错误里带检查项标题，Word / Excel 可定位。
 *
 * 返回（向后兼容：sections[].tables[]、errors[] 仍在）：
 *   { sections: [{ no, title, tag, category, tables:[{columns, rows, rowCount, truncated}], errors:[{sql,error}] }],
 *     errors: [{ section, sql, error }], stats: { statements, ok, failed, rows } }
 */
const oracledb = require('oracledb');
const { parseInspectScript, readOnlyViolation } = require('../utils/inspectScriptParser');

const MAX_ROWS = Math.max(100, Number(process.env.INSPECT_MAX_ROWS_PER_QUERY) || 5000);
const STMT_TIMEOUT_MS = Math.max(5000, Number(process.env.INSPECT_STMT_TIMEOUT_MS) || 120000);
const SECTION_ROW_RE = /^>>SECTION:\s*(.+)$/i;

const p2 = (n) => String(n).padStart(2, '0');
function fmtDate(d) {
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

function plainValue(v) {
  if (v == null) return v;
  if (v instanceof Date) return fmtDate(v);
  if (Buffer.isBuffer(v)) return v.length > 64 ? `0x${v.subarray(0, 32).toString('hex')}…(${v.length}B)` : `0x${v.toString('hex')}`;
  if (typeof v === 'bigint') return String(v);
  if (typeof v === 'object') {
    if (typeof v.toISOString === 'function') return v.toISOString();
    try { return JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? String(x) : x)); } catch { return String(v); }
  }
  return v;
}

function rowToPlain(row) {
  const o = {};
  for (const k of Object.keys(row)) o[k] = plainValue(row[k]);
  return o;
}

function sectionMarkerOfRows(cols, rows) {
  if (rows.length === 1 && cols.length === 1) {
    const s = rows[0][cols[0]] != null ? String(rows[0][cols[0]]).trim() : '';
    const m = SECTION_ROW_RE.exec(s);
    if (m) return m[1].trim();
  }
  return null;
}

/** 各方言执行一条语句，统一返回 { columns, rows(plain), total } */
async function runOne(d, conn, st) {
  if (d === 'ORACLE') {
    const r = await conn.execute(st, [], {
      outFormat: oracledb.OUT_FORMAT_OBJECT,
      maxRows: MAX_ROWS + 1,
      autoCommit: false,
      fetchAsString: [oracledb.CLOB],
    });
    const rows = (r.rows || []).map(rowToPlain);
    const columns = r.metaData && r.metaData.length ? r.metaData.map((m) => m.name) : rows[0] ? Object.keys(rows[0]) : [];
    return { columns, rows, total: rows.length };
  }
  if (d === 'MYSQL') {
    const [rows, fields] = await conn.query({ sql: st, timeout: STMT_TIMEOUT_MS });
    if (!Array.isArray(rows)) return { columns: [], rows: [], total: 0 };      // OK packet（SET 等）
    const plain = rows.map((row) => rowToPlain(row));
    const columns = fields && fields.length ? fields.map((f) => f.name) : plain[0] ? Object.keys(plain[0]) : [];
    return { columns, rows: plain, total: plain.length };
  }
  if (d === 'POSTGRESQL') {
    const r = await conn.query(st);
    const res = Array.isArray(r) ? r[r.length - 1] : r;                         // 多语句时取最后一个结果
    const rows = (res.rows || []).map(rowToPlain);
    const columns = res.fields && res.fields.length ? res.fields.map((f) => f.name) : rows[0] ? Object.keys(rows[0]) : [];
    return { columns, rows, total: rows.length };
  }
  if (d === 'SQLSERVER') {
    const r = await conn.request().query(st);
    const rows = (r.recordset || []).map(rowToPlain);
    const columns = r.recordset && r.recordset.columns ? Object.keys(r.recordset.columns) : rows[0] ? Object.keys(rows[0]) : [];
    return { columns, rows, total: rows.length };
  }
  throw new Error(`不支持的 DB_TYPE 用于脚本执行: ${d}`);
}

async function prepareConnection(d, conn) {
  try {
    if (d === 'ORACLE') conn.callTimeout = STMT_TIMEOUT_MS;
    else if (d === 'POSTGRESQL') await conn.query(`SET statement_timeout = ${STMT_TIMEOUT_MS}`);
    else if (d === 'MYSQL') await conn.query(`SET SESSION max_execution_time = ${STMT_TIMEOUT_MS}`).catch(() => {});
  } catch { /* 超时设置失败不影响巡检 */ }
}

/**
 * @param {string} dialect ORACLE|MYSQL|GOLDENDB|POSTGRESQL|PANWEI|DAMENG|SQLSERVER
 * @param {*} conn 驱动连接
 * @param {string} sqlText 脚本全文（可含多个 >>SECTION 分段）
 * @param {{defaultCategory?: string}} [opts]
 */
async function executeInspectScript(dialect, conn, sqlText, opts = {}) {
  let d = String(dialect || 'ORACLE').toUpperCase();
  if (d === 'PANWEI') d = 'POSTGRESQL';
  if (d === 'GOLDENDB') d = 'MYSQL';
  const parseDialect = String(dialect || 'ORACLE').toUpperCase();
  const execDialect = d === 'DAMENG' ? 'ORACLE' : d;        // dmdb 接口与 oracledb 一致
  if (!['ORACLE', 'MYSQL', 'POSTGRESQL', 'SQLSERVER'].includes(execDialect)) {
    throw new Error(`不支持的 DB_TYPE 用于脚本执行: ${d}`);
  }

  const parsed = parseInspectScript(sqlText, parseDialect, { defaultCategory: opts.defaultCategory });
  const errors = [];
  const stats = { statements: 0, ok: 0, failed: 0, rows: 0 };
  for (const e of parsed.ruleErrors) errors.push({ section: '@rule 指令', sql: '', error: e });

  await prepareConnection(execDialect, conn);

  // 会话级准备语句（SET SESSION / USE …）：执行但不产出检查项
  for (const st of parsed.preamble) {
    const v = readOnlyViolation(st);
    if (v) { errors.push({ section: '脚本准备', sql: st.slice(0, 800), error: v }); stats.failed++; continue; }
    try { await runOne(execDialect, conn, st); } catch (e) {
      errors.push({ section: '脚本准备', sql: st.slice(0, 800), error: e.message || String(e) });
    }
  }

  const sections = [];
  for (const sec of parsed.sections) {
    const out = { no: sec.no, title: sec.title, tag: sec.tag, category: sec.category, tables: [], errors: [] };
    sections.push(out);
    for (const st of sec.sqls) {
      if (!st.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, '').trim()) continue;
      stats.statements++;
      const v = readOnlyViolation(st);
      if (v) {
        out.errors.push({ sql: st.slice(0, 800), error: v });
        errors.push({ section: sec.title, sql: st.slice(0, 800), error: v });
        stats.failed++;
        continue;
      }
      try {
        const r = await runOne(execDialect, conn, st);
        stats.ok++;
        // 兼容旧脚本：单行单列的 ">>SECTION: xxx" 结果集 = 分段标记
        const mk = sectionMarkerOfRows(r.columns, r.rows);
        if (mk) { out.title = mk; continue; }
        if (!r.columns.length) continue;
        const truncated = r.rows.length > MAX_ROWS;
        const rows = truncated ? r.rows.slice(0, MAX_ROWS) : r.rows;
        stats.rows += rows.length;
        out.tables.push({ columns: r.columns, rows, rowCount: truncated ? `${MAX_ROWS}+` : rows.length, truncated });
      } catch (e) {
        const msg = e.message || String(e);
        out.errors.push({ sql: st.slice(0, 800), error: msg });
        errors.push({ section: sec.title, sql: st.slice(0, 800), error: msg });
        stats.failed++;
      }
    }
  }
  return { sections, errors, stats, rules: parsed.rules, marked: parsed.marked };
}

/** 兼容旧调用：仅做语句切分（供外部引用） */
function splitSqlStatements(sql, dialect) {
  const p = parseInspectScript(sql, dialect);
  return [...p.preamble, ...p.sections.flatMap((s) => s.sqls)];
}

module.exports = { executeInspectScript, splitSqlStatements, rowToPlain, MAX_ROWS };
