/**
 * /api/workbench/* — F-24 Web SQL 工作台
 * 基于 CMDB 管理的实例连接信息，执行任意 SQL 查询
 */
const router = require('express').Router();
const oracledb = require('oracledb');
const db = require('../config/db');
const { authMiddleware } = require('../middleware/auth');
const {
  fetchCmdbInstance, connectOracle, connectMysql, connectPostgres, connectDameng, normalizeDbType,
} = require('../utils/monitorTargetConn');

router.use(authMiddleware);

// ─── 安全限制 ──────────────────────────────────────────────────
const MAX_ROWS = 500;           // 最大返回行数
const QUERY_TIMEOUT_MS = 30000; // 查询超时 30 秒

// 危险关键词拦截（DDL/DCL 操作需显式确认）
const DANGEROUS_KEYWORDS = ['DROP', 'TRUNCATE', 'DELETE', 'ALTER', 'CREATE', 'GRANT', 'REVOKE', 'INSERT', 'UPDATE'];

function isDangerous(sql) {
  const upper = sql.trim().toUpperCase();
  for (const kw of DANGEROUS_KEYWORDS) {
    // 匹配 SQL 开头或分号后的语句
    if (new RegExp(`(^|;\\s*)${kw}\\b`).test(upper)) return kw;
  }
  return null;
}

// ─── SQL 执行核心 ──────────────────────────────────────────────

/**
 * 对被管实例执行 SQL
 * @param {number} instanceId
 * @param {string} sqlText
 * @param {boolean} allowDangerous - 是否允许 DDL/DCL
 * @returns {Promise<{columns: string[], rows: any[], rowCount: number, elapsed: number, truncated: boolean}>}
 */
async function executeQuery(instanceId, sqlText, allowDangerous = false) {
  const inst = await fetchCmdbInstance(instanceId);
  const dbType = normalizeDbType(inst);

  // 危险操作检查
  if (!allowDangerous) {
    const danger = isDangerous(sqlText);
    if (danger) throw new Error(`安全拦截: 检测到 ${danger} 操作，请勾选「允许执行」后重试`);
  }

  const t0 = Date.now();
  let conn;

  try {
    switch (dbType) {
      case 'ORACLE':
      case 'DAMENG': {
        conn = dbType === 'ORACLE' ? await connectOracle(inst) : await connectDameng(inst);
        const result = await conn.execute(sqlText, [], {
          outFormat: oracledb.OUT_FORMAT_OBJECT,
          maxRows: MAX_ROWS,
          fetchTypeHandler: (metaData) => {
            // 将 LOB 类型转为字符串
            if (metaData.dbType === oracledb.DB_TYPE_CLOB) return { type: oracledb.STRING };
            return undefined;
          },
        });
        const columns = result.metaData ? result.metaData.map(m => ({
          name: m.name, type: m.dbTypeName || 'VARCHAR2', nullable: m.nullable === 1
        })) : [];
        const rows = result.rows || [];
        const rowsAffected = result.rowsAffected || 0;
        return {
          columns: columns.map(c => c.name),
          columnDetails: columns,
          rows, rowCount: rows.length, rowsAffected,
          elapsed: Date.now() - t0,
          truncated: rows.length >= MAX_ROWS,
          dbType,
        };
      }

      case 'MYSQL':
      case 'GOLDENDB': {
        conn = await connectMysql(inst);
        const [rows, fields] = await conn.query(sqlText);
        const columns = fields ? fields.map(f => f.name) : [];
        const data = Array.isArray(rows) ? rows.slice(0, MAX_ROWS) : [];
        return {
          columns,
          columnDetails: fields ? fields.map(f => ({ name: f.name, type: f.columnType || 'VARCHAR' })) : [],
          rows: data, rowCount: data.length, rowsAffected: Array.isArray(rows) ? 0 : (rows.affectedRows || 0),
          elapsed: Date.now() - t0,
          truncated: Array.isArray(rows) && rows.length >= MAX_ROWS,
          dbType,
        };
      }

      case 'POSTGRESQL': {
        conn = await connectPostgres(inst);
        const result = await conn.query(sqlText);
        const columns = result.fields ? result.fields.map(f => f.name) : [];
        const rows = (result.rows || []).slice(0, MAX_ROWS);
        return {
          columns,
          columnDetails: result.fields ? result.fields.map(f => ({ name: f.name, type: f.dataTypeID || 'text' })) : [],
          rows, rowCount: rows.length, rowsAffected: result.rowCount || 0,
          elapsed: Date.now() - t0,
          truncated: (result.rows || []).length >= MAX_ROWS,
          dbType,
        };
      }

      default:
        throw new Error(`不支持的数据库类型: ${dbType}`);
    }
  } finally {
    if (conn) {
      try {
        if (dbType === 'ORACLE' || dbType === 'DAMENG') await conn.close();
        else if (dbType === 'MYSQL' || dbType === 'GOLDENDB') await conn.end();
        else if (dbType === 'POSTGRESQL') await conn.end();
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
      case 'POSTGRESQL': {
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
          { outFormat: oracledb.OUT_FORMAT_OBJECT }
        );
        return { dbType, tables: result.rows || [] };
      }
      default:
        throw new Error(`不支持的数据库类型: ${dbType}`);
    }
  } finally {
    if (conn) {
      try {
        if (dbType === 'ORACLE' || dbType === 'DAMENG') await conn.close();
        else if (dbType === 'MYSQL' || dbType === 'GOLDENDB') await conn.end();
        else if (dbType === 'POSTGRESQL') await conn.end();
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
      case 'POSTGRESQL': {
        conn = await connectPostgres(inst);
        const r = await conn.query(
          `SELECT column_name AS "COLUMN_NAME", data_type AS "DATA_TYPE",
                  character_maximum_length AS "DATA_LENGTH", is_nullable AS "NULLABLE", column_default AS "DATA_DEFAULT"
           FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position`,
          [owner, tableName]
        );
        return { columns: r.rows || [] };
      }
      default:
        throw new Error(`不支持的数据库类型: ${dbType}`);
    }
  } finally {
    if (conn) {
      try {
        if (dbType === 'ORACLE' || dbType === 'DAMENG') await conn.close();
        else if (dbType === 'MYSQL' || dbType === 'GOLDENDB') await conn.end();
        else if (dbType === 'POSTGRESQL') await conn.end();
      } catch { /* ignore */ }
    }
  }
}

// ─── API 端点 ──────────────────────────────────────────────────

// POST /api/workbench/execute — 执行 SQL
router.post('/execute', async (req, res) => {
  try {
    const { instanceId, sql, allowDangerous } = req.body;
    if (!instanceId || !sql) return res.json({ code: 400, msg: '实例和SQL必填' });
    const trimmed = sql.trim();
    if (!trimmed) return res.json({ code: 400, msg: 'SQL不能为空' });

    const result = await executeQuery(instanceId, trimmed, !!allowDangerous);

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

// POST /api/workbench/explain — 执行 EXPLAIN
router.post('/explain', async (req, res) => {
  try {
    const { instanceId, sql } = req.body;
    if (!instanceId || !sql) return res.json({ code: 400, msg: '实例和SQL必填' });

    const inst = await fetchCmdbInstance(instanceId);
    const dbType = normalizeDbType(inst);
    let conn;

    try {
      switch (dbType) {
        case 'ORACLE':
        case 'DAMENG': {
          conn = dbType === 'ORACLE' ? await connectOracle(inst) : await connectDameng(inst);
          await conn.execute(`EXPLAIN PLAN FOR ${sql}`, [], { autoCommit: true });
          const r = await conn.execute(
            `SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY(NULL, NULL, 'ALL'))`, [],
            { outFormat: oracledb.OUT_FORMAT_OBJECT }
          );
          return res.json({ code: 200, data: { dbType, plan: (r.rows || []).map(row => Object.values(row)[0]) } });
        }
        case 'MYSQL':
        case 'GOLDENDB': {
          conn = await connectMysql(inst);
          const [rows] = await conn.query(`EXPLAIN ${sql}`);
          return res.json({ code: 200, data: { dbType, plan: rows || [] } });
        }
        case 'POSTGRESQL': {
          conn = await connectPostgres(inst);
          const r = await conn.query(`EXPLAIN (FORMAT TEXT) ${sql}`);
          return res.json({ code: 200, data: { dbType, plan: (r.rows || []).map(row => row['QUERY PLAN']) } });
        }
        default:
          return res.json({ code: 400, msg: `不支持的数据库类型: ${dbType}` });
      }
    } finally {
      if (conn) {
        try {
          if (dbType === 'ORACLE' || dbType === 'DAMENG') await conn.close();
          else if (dbType === 'MYSQL' || dbType === 'GOLDENDB') await conn.end();
          else if (dbType === 'POSTGRESQL') await conn.end();
        } catch { /* ignore */ }
      }
    }
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

module.exports = router;
