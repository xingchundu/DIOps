/**
 * /api/workbench/* — F-24 Web SQL 工作台
 * 基于 CMDB 管理的实例连接信息，执行任意 SQL 查询
 */
const router = require('express').Router();
const oracledb = require('oracledb');
const sql = require('mssql');
const db = require('../config/db');
const { authMiddleware, requireRole } = require('../middleware/auth');
const {
  fetchCmdbInstance, connectOracle, connectMysql, connectPostgres, connectDameng,
  connectSqlServer, normalizeDbType, isPgFamily, isSqlServer,
} = require('../utils/monitorTargetConn');

router.use(authMiddleware);
const adminDbaOps = requireRole('ADMIN', 'DBA', 'OPS');

// ─── 安全限制 ──────────────────────────────────────────────────
function stripSqlComments(t) {
  return String(t || '').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n\r]*/g, ' ');
}
const MAX_ROWS = 500;           // 最大返回行数
const QUERY_TIMEOUT_MS = 30000; // 查询超时 30 秒

// 危险语句拦截：由 Java SQL 洞察按 AST 判断（多语句逐条、注释/WITH...DELETE/匿名块都能识别）；
// Java 不可达时退回本地正则（先去注释，再按语句首关键字判断），保证拦截不失效
const sqlInsight = require('../utils/sqlInsightClient');
const DANGEROUS_KEYWORDS = ['DROP', 'TRUNCATE', 'DELETE', 'ALTER', 'CREATE', 'GRANT', 'REVOKE', 'INSERT', 'UPDATE', 'MERGE',
  'REPLACE', 'RENAME', 'BEGIN', 'DECLARE', 'CALL', 'EXEC', 'EXECUTE'];

function isDangerousFallback(sql) {
  const stripped = String(sql || '').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n\r]*/g, ' ').replace(/'(?:[^']|'')*'/g, "''");
  const upper = stripped.toUpperCase();
  for (const kw of DANGEROUS_KEYWORDS) {
    if (new RegExp(`(^|;)\\s*${kw}\\b`).test(upper)) return kw;
  }
  if (/^\s*WITH\b[\s\S]*\b(DELETE|UPDATE|INSERT|MERGE)\b/.test(upper)) return 'DML';
  return null;
}

async function isDangerous(req, sql, dbType) {
  try {
    const r = await sqlInsight.classify(req, sql, dbType);
    return r.dangerous || null;
  } catch (e) {
    if (!e.unreachable) console.warn('[workbench] classify failed, fallback to regex:', e.message);
    return isDangerousFallback(sql);
  }
}

async function withSqlServerPool(inst, fn) {
  const pool = await connectSqlServer(inst);
  try {
    return await fn(pool);
  } finally {
    await pool.close();
  }
}

/**
 * 对被管实例执行 SQL
 * @param {number} instanceId
 * @param {string} sqlText
 * @param {boolean} allowDangerous - 是否允许 DDL/DCL
 * @returns {Promise<{columns: string[], rows: any[], rowCount: number, elapsed: number, truncated: boolean}>}
 */
async function executeQuery(instanceId, sqlText, allowDangerous = false, req = null) {
  const inst = await fetchCmdbInstance(instanceId);
  const dbType = normalizeDbType(inst);

  // 危险操作检查
  if (!allowDangerous) {
    const danger = await isDangerous(req, sqlText, dbType);
    if (danger) throw new Error(`安全拦截: 检测到 ${danger} 操作，请勾选「允许执行」后重试`);
  }

  const t0 = Date.now();
  let conn;
  // 查询语句在库端限制返回行数（多取一行用于判断是否截断），避免先全量取回再截断拖垮后端
  const isRead = /^\s*(select|with)\b/i.test(stripSqlComments(sqlText)) && !/;\s*\S/.test(sqlText.trim().replace(/;\s*$/, ''));
  const body = sqlText.trim().replace(/;\s*$/, '');
  const limited = isRead ? `SELECT * FROM (${body}) dbops_q LIMIT ${MAX_ROWS + 1}` : sqlText;
  const runLimited = async run => {
    if (!isRead) return run(sqlText);
    try { return await run(limited); } catch (e) {
      // 个别写法（如 SELECT ... FOR UPDATE、带 INTO）不能包成子查询，退回原语句
      if (/syntax|语法|42601|ER_PARSE_ERROR|1064/i.test(`${e.code || ''} ${e.message}`)) return run(sqlText);
      throw e;
    }
  };

  try {
    switch (dbType) {
      case 'ORACLE':
      case 'DAMENG': {
        conn = dbType === 'ORACLE' ? await connectOracle(inst) : await connectDameng(inst);
        if ('callTimeout' in conn) conn.callTimeout = QUERY_TIMEOUT_MS;
        const result = await conn.execute(sqlText, [], {
          outFormat: oracledb.OUT_FORMAT_OBJECT,
          maxRows: MAX_ROWS + 1,
          fetchTypeHandler: (metaData) => {
            // 将 LOB 类型转为字符串
            if (metaData.dbType === oracledb.DB_TYPE_CLOB) return { type: oracledb.STRING };
            return undefined;
          },
        });
        const columns = result.metaData ? result.metaData.map(m => ({
          name: m.name, type: m.dbTypeName || 'VARCHAR2', nullable: m.nullable === 1
        })) : [];
        const all = result.rows || [];
        const rows = all.slice(0, MAX_ROWS);
        const rowsAffected = result.rowsAffected || 0;
        return {
          columns: columns.map(c => c.name),
          columnDetails: columns,
          rows, rowCount: rows.length, rowsAffected,
          elapsed: Date.now() - t0,
          truncated: all.length > MAX_ROWS,
          dbType,
        };
      }

      case 'MYSQL':
      case 'GOLDENDB': {
        conn = await connectMysql(inst);
        const [rows, fields] = await runLimited(q => conn.query({ sql: q, timeout: QUERY_TIMEOUT_MS }));
        const columns = fields ? fields.map(f => f.name) : [];
        const data = Array.isArray(rows) ? rows.slice(0, MAX_ROWS) : [];
        return {
          columns,
          columnDetails: fields ? fields.map(f => ({ name: f.name, type: f.columnType || 'VARCHAR' })) : [],
          rows: data, rowCount: data.length, rowsAffected: Array.isArray(rows) ? 0 : (rows.affectedRows || 0),
          elapsed: Date.now() - t0,
          truncated: Array.isArray(rows) && rows.length > MAX_ROWS,
          dbType,
        };
      }

      case 'POSTGRESQL':
      case 'PANWEI': {
        conn = await connectPostgres(inst);
        await conn.query(`SET statement_timeout = ${QUERY_TIMEOUT_MS}`);
        const result = await runLimited(q => conn.query(q));
        const columns = result.fields ? result.fields.map(f => f.name) : [];
        const rows = (result.rows || []).slice(0, MAX_ROWS);
        return {
          columns,
          columnDetails: result.fields ? result.fields.map(f => ({ name: f.name, type: f.dataTypeID || 'text' })) : [],
          rows, rowCount: rows.length, rowsAffected: result.rowCount || 0,
          elapsed: Date.now() - t0,
          truncated: (result.rows || []).length > MAX_ROWS,
          dbType,
        };
      }

      case 'SQLSERVER': {
        return withSqlServerPool(inst, async (pool) => {
          const request = pool.request();
          request.timeout = QUERY_TIMEOUT_MS;
          // SET ROWCOUNT 只用于查询（它也会限制 UPDATE/DELETE 的影响行数）
          const result = isRead ? await request.batch(`SET ROWCOUNT ${MAX_ROWS + 1}; ${body}; SET ROWCOUNT 0;`) : await request.query(sqlText);
          const rows = (result.recordset || []).slice(0, MAX_ROWS);
          const columns = rows.length ? Object.keys(rows[0]) : [];
          return {
            columns,
            columnDetails: columns.map((name) => ({ name, type: 'varchar' })),
            rows,
            rowCount: rows.length,
            rowsAffected: (result.rowsAffected && result.rowsAffected[0]) || 0,
            elapsed: Date.now() - t0,
            truncated: (result.recordset || []).length > MAX_ROWS,
            dbType,
          };
        });
      }

      default:
        throw new Error(`不支持的数据库类型: ${dbType}`);
    }
  } finally {
    if (conn) {
      try {
        if (dbType === 'ORACLE' || dbType === 'DAMENG') await conn.close();
        else if (dbType === 'MYSQL' || dbType === 'GOLDENDB') await conn.end();
        else if (isPgFamily(dbType)) await conn.end();
        else if (isSqlServer(dbType)) await conn.close();
      } catch { /* ignore */ }
    }
  }
}

/**
 * 获取实例的 Schema 元数据（表/视图列表）
 */
async function getSchemaMetadata(instanceId) {
  const inst = await fetchCmdbInstance(instanceId);
  const dbType = normalizeDbType(inst);
  let conn;

  try {
    switch (dbType) {
      case 'ORACLE': {
        conn = await connectOracle(inst);
        const tables = await conn.execute(
          `SELECT OWNER, OBJECT_NAME, OBJECT_TYPE FROM ALL_OBJECTS
           WHERE OBJECT_TYPE IN ('TABLE','VIEW') AND OWNER NOT IN ('SYS','SYSTEM','DBSNMP','OUTLN','XDB','CTXSYS','MDSYS','WMSYS','DBMS_JOB')
           ORDER BY OWNER, OBJECT_NAME FETCH FIRST 500 ROWS ONLY`, [],
          { outFormat: oracledb.OUT_FORMAT_OBJECT }
        );
        return { dbType, tables: tables.rows || [] };
      }
      case 'MYSQL':
      case 'GOLDENDB': {
        conn = await connectMysql(inst);
        const [rows] = await conn.query(
          `SELECT TABLE_SCHEMA AS "owner", TABLE_NAME AS "object_name", TABLE_TYPE AS "object_type"
           FROM information_schema.TABLES WHERE TABLE_SCHEMA NOT IN ('mysql','information_schema','performance_schema','sys')
           ORDER BY TABLE_SCHEMA, TABLE_NAME LIMIT 500`
        );
        return { dbType, tables: rows || [] };
      }
      case 'POSTGRESQL':
      case 'PANWEI': {
        conn = await connectPostgres(inst);
        const result = await conn.query(
          `SELECT schemaname AS "owner", tablename AS "object_name", 'TABLE' AS "object_type"
           FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')
           UNION ALL
           SELECT schemaname, viewname, 'VIEW' FROM pg_views
           WHERE schemaname NOT IN ('pg_catalog','information_schema')
           ORDER BY 1, 2 LIMIT 500`
        );
        return { dbType, tables: result.rows || [] };
      }
      case 'DAMENG': {
        conn = await connectDameng(inst);
        const result = await conn.execute(
          `SELECT OWNER, OBJECT_NAME, OBJECT_TYPE FROM ALL_OBJECTS
           WHERE OBJECT_TYPE IN ('TABLE','VIEW') AND OWNER NOT IN ('SYS','SYSDBA','SYSAUDITOR','SYSBACKUP','SYSSSO')
           ORDER BY OWNER, OBJECT_NAME`, [],
          { outFormat: oracledb.OUT_FORMAT_OBJECT, maxRows: 500 }
        );
        return { dbType, tables: result.rows || [] };
      }
      case 'SQLSERVER': {
        return withSqlServerPool(inst, async (pool) => {
          const r = await pool.request().query(
            `SELECT TOP 500 TABLE_SCHEMA AS owner, TABLE_NAME AS object_name, TABLE_TYPE AS object_type
             FROM INFORMATION_SCHEMA.TABLES
             WHERE TABLE_SCHEMA NOT IN ('sys','INFORMATION_SCHEMA')
             ORDER BY TABLE_SCHEMA, TABLE_NAME`
          );
          return { dbType, tables: r.recordset || [] };
        });
      }
      default:
        throw new Error(`不支持的数据库类型: ${dbType}`);
    }
  } finally {
    if (conn) {
      try {
        if (dbType === 'ORACLE' || dbType === 'DAMENG') await conn.close();
        else if (dbType === 'MYSQL' || dbType === 'GOLDENDB') await conn.end();
        else if (isPgFamily(dbType)) await conn.end();
        else if (isSqlServer(dbType)) await conn.close();
      } catch { /* ignore */ }
    }
  }
}

/**
 * 获取表的列信息
 */
async function getTableColumns(instanceId, owner, tableName) {
  const inst = await fetchCmdbInstance(instanceId);
  const dbType = normalizeDbType(inst);
  let conn;

  try {
    switch (dbType) {
      case 'ORACLE':
      case 'DAMENG': {
        conn = dbType === 'ORACLE' ? await connectOracle(inst) : await connectDameng(inst);
        const r = await conn.execute(
          `SELECT COLUMN_NAME, DATA_TYPE, DATA_LENGTH, NULLABLE, DATA_DEFAULT
           FROM ALL_TAB_COLUMNS WHERE OWNER=:1 AND TABLE_NAME=:2 ORDER BY COLUMN_ID`,
          [owner, tableName], { outFormat: oracledb.OUT_FORMAT_OBJECT }
        );
        return { columns: r.rows || [] };
      }
      case 'MYSQL':
      case 'GOLDENDB': {
        conn = await connectMysql(inst);
        const [rows] = await conn.query(
          `SELECT COLUMN_NAME AS "COLUMN_NAME", DATA_TYPE AS "DATA_TYPE",
                  CHARACTER_MAXIMUM_LENGTH AS "DATA_LENGTH", IS_NULLABLE AS "NULLABLE", COLUMN_DEFAULT AS "DATA_DEFAULT"
           FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION`,
          [owner, tableName]
        );
        return { columns: rows || [] };
      }
      case 'POSTGRESQL':
      case 'PANWEI': {
        conn = await connectPostgres(inst);
        const r = await conn.query(
          `SELECT column_name AS "COLUMN_NAME", data_type AS "DATA_TYPE",
                  character_maximum_length AS "DATA_LENGTH", is_nullable AS "NULLABLE", column_default AS "DATA_DEFAULT"
           FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position`,
          [owner, tableName]
        );
        return { columns: r.rows || [] };
      }
      case 'SQLSERVER': {
        return withSqlServerPool(inst, async (pool) => {
          const r = await pool.request()
            .input('owner', sql.VarChar, owner)
            .input('table', sql.VarChar, tableName)
            .query(
              `SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH AS DATA_LENGTH,
                      IS_NULLABLE AS NULLABLE, COLUMN_DEFAULT AS DATA_DEFAULT
               FROM INFORMATION_SCHEMA.COLUMNS
               WHERE TABLE_SCHEMA = @owner AND TABLE_NAME = @table
               ORDER BY ORDINAL_POSITION`
            );
          return { columns: r.recordset || [] };
        });
      }
      default:
        throw new Error(`不支持的数据库类型: ${dbType}`);
    }
  } finally {
    if (conn) {
      try {
        if (dbType === 'ORACLE' || dbType === 'DAMENG') await conn.close();
        else if (dbType === 'MYSQL' || dbType === 'GOLDENDB') await conn.end();
        else if (isPgFamily(dbType)) await conn.end();
        else if (isSqlServer(dbType)) await conn.close();
      } catch { /* ignore */ }
    }
  }
}

// ─── API 端点 ──────────────────────────────────────────────────

// POST /api/workbench/execute — 执行 SQL
router.post('/execute', adminDbaOps, async (req, res) => {
  try {
    const { instanceId, sql, allowDangerous } = req.body;
    if (!instanceId || !sql) return res.json({ code: 400, msg: '实例和SQL必填' });
    const trimmed = sql.trim();
    if (!trimmed) return res.json({ code: 400, msg: 'SQL不能为空' });

    const result = await executeQuery(instanceId, trimmed, !!allowDangerous, req);

    // 记录到历史
    try {
      await db.execute(
        `INSERT INTO SQL_WORKBENCH_HISTORY (INSTANCE_ID, SQL_TEXT, ROW_COUNT, ELAPSED_MS, CREATED_BY)
         VALUES (:1, :2, :3, :4, :5)`,
        [instanceId, trimmed.substring(0, 2000), result.rowCount || result.rowsAffected || 0,
         result.elapsed, req.user.username]
      );
    } catch { /* history table may not exist */ }

    res.json({ code: 200, data: result });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// GET /api/workbench/schema/:instanceId — 获取 Schema 元数据
router.get('/schema/:instanceId', async (req, res) => {
  try {
    const result = await getSchemaMetadata(req.params.instanceId);
    res.json({ code: 200, data: result });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// GET /api/workbench/columns/:instanceId — 获取表列信息
router.get('/columns/:instanceId', async (req, res) => {
  try {
    const { owner, table } = req.query;
    if (!owner || !table) return res.json({ code: 400, msg: 'owner 和 table 参数必填' });
    const result = await getTableColumns(req.params.instanceId, owner, table);
    res.json({ code: 200, data: result });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// GET /api/workbench/instances — 可用实例列表
router.get('/instances', async (req, res) => {
  try {
    const { rows } = await db.execute(
      `SELECT INSTANCE_ID, INSTANCE_NAME, DB_TYPE, HOST_IP, PORT, STATUS
       FROM CMDB_INSTANCE WHERE STATUS = 'RUNNING' ORDER BY INSTANCE_NAME`, []
    );
    res.json({ code: 200, data: rows });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// GET /api/workbench/history — 执行历史
router.get('/history', async (req, res) => {
  try {
    const { instanceId, page = 1, size = 20 } = req.query;
    let where = ['1=1']; let binds = []; let bi = 1;
    if (instanceId) { where.push(`INSTANCE_ID=:${bi}`); binds.push(Number(instanceId)); bi++; }
    const sql = `SELECT h.*, i.INSTANCE_NAME
      FROM SQL_WORKBENCH_HISTORY h
      LEFT JOIN CMDB_INSTANCE i ON h.INSTANCE_ID = i.INSTANCE_ID
      WHERE ${where.join(' AND ')} ORDER BY h.CREATED_AT DESC`;
    const data = await db.queryPage(sql, binds, page, size);
    res.json({ code: 200, data });
  } catch (err) {
    if (/ORA-00942|942/.test(err.message || '')) return res.json({ code: 200, data: { rows: [], total: 0 } });
    res.json({ code: 500, msg: err.message });
  }
});

// POST /api/workbench/explain — 执行计划（Java ExplainService：5 库、单语句校验、SQL Server 在同一连接上 SHOWPLAN）
// [fix] 原 SQL Server 分支用连接池的三个 request 分别执行 SET SHOWPLAN_TEXT ON / SQL / OFF，
//       可能落在不同连接上 → SHOWPLAN 不生效，DML 会被真实执行
router.post('/explain', adminDbaOps, async (req, res) => {
  try {
    const { instanceId, sql, allowDangerous } = req.body;
    if (!instanceId || !sql) return res.json({ code: 400, msg: '实例和SQL必填' });
    const inst = await fetchCmdbInstance(instanceId);
    const dbType = normalizeDbType(inst);
    // 危险操作检查（EXPLAIN 同样需要拦截 DML）
    if (!allowDangerous) {
      const danger = await isDangerous(req, sql, dbType);
      if (danger) return res.json({ code: 403, msg: `安全拦截: 检测到 ${danger} 操作，请勾选「允许执行」后重试` });
    }
    const r = await sqlInsight.explain(req, Number(instanceId), sql);
    const lines = String(r.plan || '').split('\n').filter((l) => l.trim() !== '');
    return res.json({ code: 200, data: { dbType, plan: lines, fullScanDetected: !!r.fullScanDetected, issues: r.issues || [] } });
  } catch (err) { res.json({ code: err.code === 400 ? 400 : 500, msg: err.message }); }
});

module.exports = router;
