/**
 * SQL 治理中心：选定实例后的表存在性、可执行性、执行计划（按 DB_TYPE）
 */
const oracledb = require('oracledb');
const {
  fetchCmdbInstance,
  connectOracle,
  connectMysql,
  connectPostgres,
  connectDameng,
  normalizeDbType,
} = require('../utils/monitorTargetConn');

/** 去除 Oracle 驱动等不可 JSON 序列化的对象，避免 circular structure 错误 */
function toPlainJson(value) {
  const seen = new WeakSet();
  return JSON.parse(JSON.stringify(value, (key, val) => {
    if (val != null && typeof val === 'object') {
      if (seen.has(val)) return undefined;
      seen.add(val);
      const cn = val.constructor?.name || '';
      if (/ConnectDescription|ConnOption|^Connection$|^Pool$/i.test(cn)) return undefined;
    }
    if (typeof val === 'bigint') return String(val);
    if (val instanceof Date) return val.toISOString();
    return val;
  }));
}

/** 仅保留可安全返回前端的实例校验字段 */
function sanitizeInstanceCheck(ic) {
  if (!ic) return null;
  return {
    instanceId: ic.instanceId,
    instanceName: ic.instanceName != null ? String(ic.instanceName) : null,
    dbType: ic.dbType != null ? String(ic.dbType) : null,
    connected: !!ic.connected,
    connectionError: ic.connectionError != null ? String(ic.connectionError) : null,
    tables: Array.isArray(ic.tables)
      ? ic.tables.map((t) => ({
        schema: t.schema != null ? String(t.schema) : null,
        name: t.name != null ? String(t.name) : null,
        exists: !!t.exists,
        message: t.message != null ? String(t.message) : '',
      }))
      : [],
    tableNote: ic.tableNote != null ? String(ic.tableNote) : null,
    executable: ic.executable,
    executeMessage: ic.executeMessage != null ? String(ic.executeMessage) : null,
    explainSupported: !!ic.explainSupported,
    explainOk: !!ic.explainOk,
    explainPlan: ic.explainPlan != null ? String(ic.explainPlan) : '',
    fullScanDetected: !!ic.fullScanDetected,
    optimizeSuggestions: Array.isArray(ic.optimizeSuggestions)
      ? ic.optimizeSuggestions.map((s) => String(s))
      : [],
  };
}

const FULL_SCAN_OPTIMIZE_HINTS = [
  '执行计划存在全表扫描：请为 WHERE/JOIN 条件列创建或补齐索引',
  '确认过滤条件是否命中索引，避免隐式类型转换导致索引失效',
  '避免 SELECT *，仅查询必要列以降低回表与 IO',
  '大表查询建议评估分区、覆盖索引或 SQL 改写（如 EXISTS 替代 IN）',
];

/** 从执行计划文本识别全表扫描并生成优化建议 */
function detectFullScanFromExplain(explainPlan, dbType) {
  const plan = String(explainPlan || '');
  if (!plan.trim()) {
    return { fullScanDetected: false, optimizeSuggestions: [] };
  }
  const t = String(dbType || '').toUpperCase();
  let fullScanDetected = false;
  if (t === 'ORACLE' || t === 'DAMENG') {
    fullScanDetected = /TABLE\s+ACCESS\s+FULL|FULL\s+TABLE\s+SCAN/i.test(plan);
  } else if (t === 'MYSQL' || t === 'GOLDENDB') {
    fullScanDetected = /\|\s*ALL\s*\|/i.test(plan)
      || /"access_type"\s*:\s*"ALL"/i.test(plan)
      || /Seq Scan/i.test(plan);
  } else if (t === 'POSTGRESQL') {
    fullScanDetected = /Seq Scan on/i.test(plan);
  } else {
    fullScanDetected = /TABLE\s+ACCESS\s+FULL|Seq Scan|\|\s*ALL\s*\|/i.test(plan);
  }
  return {
    fullScanDetected,
    optimizeSuggestions: fullScanDetected ? [...FULL_SCAN_OPTIMIZE_HINTS] : [],
  };
}

/** 推送发布时合并审核 JSON（附带全表扫描优化建议） */
function buildPublishReviewResult(auditResultRaw) {
  let base = {};
  try {
    base = typeof auditResultRaw === 'string' ? JSON.parse(auditResultRaw) : (auditResultRaw || {});
  } catch {
    base = {};
  }
  const ic = base.instanceCheck || {};
  const hints = [...(base.hints || [])];
  const extra = [...(ic.optimizeSuggestions || [])];
  if (ic.fullScanDetected) {
    if (!hints.some((h) => /全表扫描/.test(h))) {
      hints.unshift('【执行计划告警】检测到全表扫描，发布审核请重点关注索引与过滤条件');
    }
    for (const s of extra) {
      if (!hints.includes(s)) hints.push(s);
    }
  }
  return JSON.stringify(toPlainJson({
    ...base,
    hints,
    fullScanDetected: !!ic.fullScanDetected,
    optimizeSuggestions: extra,
    pushedFromGovernance: true,
    pushedAt: new Date().toISOString(),
  }));
}

const RESERVED = new Set([
  'SELECT', 'WHERE', 'ON', 'SET', 'VALUES', 'DUAL', 'LATERAL', 'UNNEST',
  'PIVOT', 'UNPIVOT', 'FROM', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS',
]);

function stripSqlComments(sql) {
  return String(sql || '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n\r]*/g, ' ');
}

/** 从 SQL 提取表引用（schema.table 或 table） */
function extractTableRefs(sql) {
  const clean = stripSqlComments(sql);
  const refs = new Map();
  const patterns = [
    /\bFROM\s+([`"\w$.]+)/gi,
    /\bJOIN\s+([`"\w$.]+)/gi,
    /\bINTO\s+([`"\w$.]+)/gi,
    /\bUPDATE\s+([`"\w$.]+)/gi,
  ];
  const addToken = (raw) => {
    const token = String(raw || '').replace(/[`"]/g, '').trim();
    if (!token || token.startsWith('(')) return;
    const parts = token.split('.').filter(Boolean);
    if (!parts.length) return;
    const name = parts[parts.length - 1];
    if (!name || RESERVED.has(name.toUpperCase()) || /^\d+$/.test(name)) return;
    const schema = parts.length > 1 ? parts[parts.length - 2] : null;
    const key = `${schema || ''}.${name}`.toUpperCase();
    if (!refs.has(key)) refs.set(key, { schema, name });
  };
  for (const re of patterns) {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(clean)) !== null) {
      const chunk = m[1];
      chunk.split(',').forEach((part) => addToken(part));
    }
  }
  return [...refs.values()];
}

function sqlFirstKeyword(sql) {
  const s = stripSqlComments(sql).trim();
  const m = s.match(/^(\w+)/);
  return m ? m[1].toUpperCase() : '';
}

function isExplainable(sql) {
  const kw = sqlFirstKeyword(sql);
  return ['SELECT', 'WITH', 'EXPLAIN'].includes(kw);
}

async function closeConn(conn, dbType) {
  if (!conn) return;
  try {
    if (dbType === 'MYSQL' || dbType === 'GOLDENDB') await conn.end();
    else if (dbType === 'POSTGRESQL') await conn.end();
    else if (conn.close) await conn.close();
  } catch { /* ignore */ }
}

async function openConn(inst) {
  const dbType = normalizeDbType(inst);
  if (dbType === 'ORACLE') return { conn: await connectOracle(inst), dbType };
  if (dbType === 'MYSQL' || dbType === 'GOLDENDB') return { conn: await connectMysql(inst), dbType };
  if (dbType === 'POSTGRESQL') return { conn: await connectPostgres(inst), dbType };
  if (dbType === 'DAMENG') return { conn: await connectDameng(inst), dbType };
  throw new Error(`不支持的数据库类型: ${dbType}`);
}

async function checkTableOracle(conn, schema, tableName) {
  let owner = schema ? String(schema).toUpperCase() : null;
  if (!owner) {
    const r = await conn.execute(`SELECT SYS_CONTEXT('USERENV','CURRENT_SCHEMA') S FROM DUAL`, [], { outFormat: oracledb.OUT_FORMAT_OBJECT });
    owner = r.rows[0]?.S;
  }
  const r = await conn.execute(
    `SELECT COUNT(*) C FROM ALL_TABLES WHERE OWNER=:1 AND TABLE_NAME=:2`,
    [owner, String(tableName).toUpperCase()],
    { outFormat: oracledb.OUT_FORMAT_OBJECT }
  );
  const exists = Number(r.rows[0]?.C || 0) > 0;
  return { exists, message: exists ? '表存在' : `表不存在 (OWNER=${owner})` };
}

async function checkTableDameng(conn, schema, tableName) {
  return checkTableOracle(conn, schema, tableName);
}

async function checkTableMysql(conn, schema, tableName) {
  const dbSchema = schema || null;
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS C FROM information_schema.tables
     WHERE table_schema = IFNULL(?, DATABASE()) AND table_name = ?`,
    [dbSchema, tableName]
  );
  const exists = Number(rows[0]?.C || 0) > 0;
  return { exists, message: exists ? '表存在' : '表不存在' };
}

async function checkTablePostgres(conn, schema, tableName) {
  const sch = schema ? String(schema).toLowerCase() : null;
  const r = await conn.query(
    `SELECT COUNT(*)::int AS c FROM information_schema.tables
     WHERE table_schema = COALESCE($1, current_schema()) AND table_name = $2`,
    [sch, String(tableName).toLowerCase()]
  );
  const exists = Number(r.rows[0]?.c || 0) > 0;
  return { exists, message: exists ? '表存在' : '表不存在' };
}

async function checkTables(conn, dbType, tables) {
  const out = [];
  for (const t of tables) {
    try {
      let r;
      if (dbType === 'ORACLE') r = await checkTableOracle(conn, t.schema, t.name);
      else if (dbType === 'DAMENG') r = await checkTableDameng(conn, t.schema, t.name);
      else if (dbType === 'MYSQL' || dbType === 'GOLDENDB') r = await checkTableMysql(conn, t.schema, t.name);
      else if (dbType === 'POSTGRESQL') r = await checkTablePostgres(conn, t.schema, t.name);
      else r = { exists: false, message: '未知库类型' };
      out.push({ schema: t.schema, name: t.name, exists: r.exists, message: r.message });
    } catch (e) {
      out.push({ schema: t.schema, name: t.name, exists: false, message: `检查失败: ${e.message}` });
    }
  }
  return out;
}

async function explainOracle(conn, sql) {
  await conn.execute(`EXPLAIN PLAN FOR ${sql}`);
  const r = await conn.execute(
    `SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY('PLAN_TABLE', NULL, 'ALL'))`,
    [],
    { outFormat: oracledb.OUT_FORMAT_ARRAY }
  );
  const lines = (r.rows || []).map((row) => row[0]).filter(Boolean);
  if (lines.length) return ['[Oracle] Execution Plan:', '-'.repeat(50), ...lines].join('\n');
  return '[Oracle] 执行计划为空';
}

async function explainDameng(conn, sql) {
  try {
    return await explainOracle(conn, sql);
  } catch (e1) {
    try {
      const r = await conn.execute(`EXPLAIN FOR ${sql}`);
      const rows = r.rows || [];
      const lines = ['[达梦 DM] Execution Plan:', '-'.repeat(50)];
      for (const row of rows) {
        if (Array.isArray(row)) lines.push(row.map((c) => (c != null ? String(c) : 'NULL')).join(' | '));
        else if (row && typeof row === 'object') lines.push(Object.values(row).map((c) => (c != null ? String(c) : 'NULL')).join(' | '));
        else lines.push(String(row));
      }
      return lines.join('\n');
    } catch (e2) {
      throw new Error(`${e1.message}; ${e2.message}`);
    }
  }
}

async function explainMysql(conn, sql, label) {
  const [rows, fields] = await conn.query(`EXPLAIN ${sql}`);
  const cols = fields?.map((f) => f.name) || (rows[0] ? Object.keys(rows[0]) : []);
  const lines = [`[${label}] Execution Plan:`, cols.join(' | '), '-'.repeat(40)];
  for (const row of rows) {
    lines.push(cols.map((c) => (row[c] != null ? String(row[c]) : 'NULL')).join(' | '));
  }
  try {
    const [jr] = await conn.query(`EXPLAIN FORMAT=JSON ${sql}`);
    if (jr?.[0]) {
      const key = Object.keys(jr[0]).find((k) => /EXPLAIN/i.test(k)) || Object.keys(jr[0])[0];
      lines.push('', '-- JSON:', JSON.stringify(jr[0][key] ?? jr[0], null, 2));
    }
  } catch { /* optional */ }
  return lines.join('\n');
}

async function explainPostgres(conn, sql) {
  const r = await conn.query(`EXPLAIN (FORMAT TEXT) ${sql}`);
  return ['[PostgreSQL] Execution Plan:', '-'.repeat(50), ...(r.rows || []).map((row) => row['QUERY PLAN'] || Object.values(row)[0])].join('\n');
}

async function runExplain(conn, dbType, sql) {
  const text = String(sql || '').trim().replace(/;+\s*$/, '');
  if (!isExplainable(text)) {
    return {
      explainSupported: false,
      explainOk: false,
      explainPlan: '执行计划仅支持 SELECT / WITH 语句；当前语句请通过「可执行性检查」验证语法',
    };
  }
  let plan;
  if (dbType === 'ORACLE') plan = await explainOracle(conn, text);
  else if (dbType === 'DAMENG') plan = await explainDameng(conn, text);
  else if (dbType === 'MYSQL') plan = await explainMysql(conn, text, 'MySQL');
  else if (dbType === 'GOLDENDB') plan = await explainMysql(conn, text, 'GoldenDB');
  else if (dbType === 'POSTGRESQL') plan = await explainPostgres(conn, text);
  else throw new Error(`不支持 EXPLAIN 的数据库类型: ${dbType}`);
  return { explainSupported: true, explainOk: true, explainPlan: plan };
}

/** 用 EXPLAIN / EXPLAIN PLAN 探测 SQL 是否可解析执行（不写数据） */
async function probeExecutable(conn, dbType, sql) {
  const text = String(sql || '').trim().replace(/;+\s*$/, '');
  if (!text) return { executable: false, executeMessage: 'SQL 为空' };

  if (isExplainable(text)) {
    try {
      await runExplain(conn, dbType, text);
      return { executable: true, executeMessage: 'SELECT 语句 EXPLAIN 成功' };
    } catch (e) {
      return { executable: false, executeMessage: `EXPLAIN 失败: ${e.message}` };
    }
  }

  try {
    if (dbType === 'ORACLE' || dbType === 'DAMENG') {
      const stmtId = `DIOps_X_${Date.now().toString(36)}`;
      await conn.execute(`EXPLAIN PLAN SET STATEMENT_ID=:1 FOR ${text}`, [stmtId]);
      try {
        await conn.execute(`DELETE FROM plan_table WHERE statement_id=:1`, [stmtId], { autoCommit: true });
      } catch { /* ignore */ }
      return { executable: true, executeMessage: '语句已通过 EXPLAIN PLAN 语法检查' };
    }
    if (dbType === 'MYSQL' || dbType === 'GOLDENDB') {
      await conn.query(`EXPLAIN ${text}`);
      return { executable: true, executeMessage: '语句已通过 EXPLAIN 语法检查' };
    }
    if (dbType === 'POSTGRESQL') {
      await conn.query(`EXPLAIN ${text}`);
      return { executable: true, executeMessage: '语句已通过 EXPLAIN 语法检查' };
    }
    return { executable: false, executeMessage: '未知数据库类型' };
  } catch (e) {
    return { executable: false, executeMessage: e.message || String(e) };
  }
}

/**
 * 在指定 CMDB 实例上执行：表存在性、可执行性、执行计划
 */
async function runInstanceSqlAudit(instanceId, sqlText) {
  const inst = await fetchCmdbInstance(instanceId);
  const dbType = normalizeDbType(inst);
  const tables = extractTableRefs(sqlText);
  const base = {
    instanceId: Number(instanceId),
    instanceName: inst.INSTANCE_NAME,
    dbType,
    connected: false,
    connectionError: null,
    tables: [],
    executable: null,
    executeMessage: null,
    explainSupported: false,
    explainOk: false,
    explainPlan: '',
  };

  let conn;
  let connDbType = dbType;
  try {
    const opened = await openConn(inst);
    conn = opened.conn;
    connDbType = opened.dbType;
    base.connected = true;

    if (tables.length) {
      base.tables = await checkTables(conn, connDbType, tables);
    } else {
      base.tables = [];
      base.tableNote = '未从 SQL 中识别到表名（如 SELECT 1、仅函数调用等）';
    }

    const execProbe = await probeExecutable(conn, connDbType, sqlText);
    base.executable = execProbe.executable;
    base.executeMessage = execProbe.executeMessage;

    try {
      const exp = await runExplain(conn, connDbType, sqlText);
      Object.assign(base, exp);
      const scan = detectFullScanFromExplain(base.explainPlan, connDbType);
      base.fullScanDetected = scan.fullScanDetected;
      base.optimizeSuggestions = scan.optimizeSuggestions;
    } catch (e) {
      base.explainSupported = isExplainable(sqlText);
      base.explainOk = false;
      base.explainPlan = `获取执行计划失败: ${e.message}`;
      base.fullScanDetected = false;
      base.optimizeSuggestions = [];
    }
  } catch (e) {
    base.connected = false;
    base.connectionError = e.message || String(e);
    base.executable = false;
    base.executeMessage = base.connectionError;
    base.explainOk = false;
    base.explainPlan = base.connectionError;
  } finally {
    await closeConn(conn, connDbType);
  }
  return sanitizeInstanceCheck(base);
}

/** 将实例检查结果合并进规则审核结果（供即时审核 API 使用） */
function mergeInstanceCheckIntoAudit(auditResult, instCheck, calcScore, calcRisk) {
  if (!instCheck) return auditResult;
  const issues = [...(auditResult.issues || [])];

  if (!instCheck.connected) {
    issues.push({
      code: 'DB_UNREACHABLE',
      severity: 'CRITICAL',
      message: `无法连接目标实例: ${instCheck.connectionError || '连接失败'}`,
    });
  } else {
    for (const t of instCheck.tables || []) {
      if (!t.exists) {
        issues.push({
          code: 'TABLE_NOT_FOUND',
          severity: 'ERROR',
          message: `表 ${t.schema ? `${t.schema}.` : ''}${t.name} 在实例 [${instCheck.instanceName}] 中不存在`,
        });
      }
    }
    if (instCheck.executable === false) {
      issues.push({
        code: 'SQL_NOT_EXECUTABLE',
        severity: 'ERROR',
        message: instCheck.executeMessage || 'SQL 无法在目标库执行',
      });
    }
  }

  const hints = [...(auditResult.hints || [])];
  if (instCheck.explainOk && instCheck.explainPlan) {
    const filtered = hints.filter((h) => !/EXPLAIN/.test(h));
    hints.length = 0;
    hints.push(...filtered);
  }
  if (instCheck.fullScanDetected) {
    if (!hints.some((h) => /全表扫描/.test(h))) {
      hints.unshift('【执行计划】检测到全表扫描，建议优化索引或改写 SQL 后再发布');
    }
    for (const s of instCheck.optimizeSuggestions || []) {
      if (!hints.includes(s)) hints.push(s);
    }
    issues.push({
      code: 'FULL_TABLE_SCAN',
      severity: 'WARNING',
      message: '执行计划存在全表扫描，推送发布时将附带优化建议供审核人参考',
    });
  }

  const score = calcScore(issues);
  return {
    ...auditResult,
    issues,
    hints,
    score,
    risk: calcRisk(score),
    instanceCheck: instCheck,
  };
}

module.exports = {
  extractTableRefs,
  runInstanceSqlAudit,
  mergeInstanceCheckIntoAudit,
  sanitizeInstanceCheck,
  toPlainJson,
  buildPublishReviewResult,
};
