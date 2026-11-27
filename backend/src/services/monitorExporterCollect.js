/**
 * 类 Prometheus Exporter 的拉取式采集：按 CMDB 实例类型直连 Oracle / MySQL / PostgreSQL，输出统一指标结构。
 */
const oracledb = require('oracledb');
const sql = require('mssql');
const {
  fetchCmdbInstance,
  connectOracle,
  connectMysql,
  connectPostgres,
  connectDameng,
  connectSqlServer,
  normalizeDbType,
  isPgFamily,
  isSqlServer,
} = require('../utils/monitorTargetConn');

function isMysqlFamily(t) {
  return t === 'MYSQL' || t === 'GOLDENDB';
}

/** MySQL/pg 驱动常返回小写字段名，与前端 Oracle 风格统一为大写 */
function rowKeysUpper(row) {
  if (!row || typeof row !== 'object') return row;
  const o = {};
  for (const [k, v] of Object.entries(row)) o[k.toUpperCase()] = v;
  return o;
}
function rowsUpper(rows) {
  return (rows || []).map(rowKeysUpper);
}

function exporterMeta(engine) {
  return {
    engine,
    scrape_ts: new Date().toISOString(),
    mode: 'embedded_exporter_pull',
    help: 'DIOps 内置采集（非独立进程），指标命名参考各生态 Exporter 习惯，便于对接 Prometheus',
  };
}

async function oraclePerformance(conn) {
  const [m, sess] = await Promise.all([
    conn.execute(
      `SELECT METRIC_NAME, VALUE, METRIC_UNIT
       FROM V$SYSMETRIC
       WHERE METRIC_NAME IN (
         'CPU Usage Per Sec','Host CPU Usage Per Sec','Buffer Cache Hit Ratio',
         'Shared Pool Free %','User Calls Per Sec','Logons Per Sec',
         'Redo Generated Per Sec','Active Sessions','Current Logons Count'
       ) AND GROUP_ID=2`,
      [],
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    ),
    conn.execute(
      `SELECT STATUS, COUNT(*) CNT FROM V$SESSION WHERE TYPE='USER' GROUP BY STATUS`,
      [],
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    ),
  ]);
  const metrics = m.rows || [];
  const sessions = sess.rows || [];
  // 10.2 的 V$SYSMETRIC 没有 Active Sessions，用 V$SESSION 的 ACTIVE 计数补上
  const hasActive = metrics.some((r) => String(r.METRIC_NAME || r.metric_name || '').toLowerCase() === 'active sessions');
  if (!hasActive) {
    let active = 0;
    for (const row of sessions) {
      const st = String(row.STATUS || row.status || '');
      if (st.toUpperCase() === 'ACTIVE') active += Number(row.CNT ?? row.cnt) || 0;
    }
    metrics.push({ METRIC_NAME: 'Active Sessions', VALUE: active, METRIC_UNIT: '' });
  }
  return { metrics, sessions };
}

async function mysqlPerformance(conn) {
  const [rows] = await conn.query(
    `SHOW GLOBAL STATUS WHERE Variable_name IN (
      'Threads_connected','Threads_running','Questions','Uptime','Bytes_received','Bytes_sent',
      'Innodb_buffer_pool_read_requests','Innodb_buffer_pool_reads','Slow_queries','Connections'
    )`
  );
  const map = Object.fromEntries(rows.map((r) => [r.Variable_name, Number(r.Value)]));
  const metrics = [
    { METRIC_NAME: 'mysql_global_status_threads_connected', VALUE: map.Threads_connected, METRIC_UNIT: '' },
    { METRIC_NAME: 'mysql_global_status_threads_running', VALUE: map.Threads_running, METRIC_UNIT: '' },
    { METRIC_NAME: 'mysql_global_status_questions_total', VALUE: map.Questions, METRIC_UNIT: '' },
    { METRIC_NAME: 'mysql_global_status_uptime_seconds', VALUE: map.Uptime, METRIC_UNIT: 's' },
    { METRIC_NAME: 'mysql_global_status_slow_queries', VALUE: map.Slow_queries, METRIC_UNIT: '' },
    { METRIC_NAME: 'mysql_global_status_connections', VALUE: map.Connections, METRIC_UNIT: '' },
  ];
  const req = map.Innodb_buffer_pool_read_requests;
  const rd = map.Innodb_buffer_pool_reads || 0;
  if (req > 0) {
    const hit = 100 * (1 - rd / req);
    metrics.push({ METRIC_NAME: 'mysql_innodb_buffer_pool_hit_ratio', VALUE: Number(hit.toFixed(2)), METRIC_UNIT: '%' });
  }
  const [[act]] = await conn.query(
    `SELECT COUNT(*) AS C FROM information_schema.PROCESSLIST WHERE COMMAND <> 'Sleep' AND ID IS NOT NULL`
  );
  const [[slp]] = await conn.query(
    `SELECT COUNT(*) AS C FROM information_schema.PROCESSLIST WHERE COMMAND = 'Sleep'`
  );
  const sessions = [
    { STATUS: 'ACTIVE', CNT: Number(act?.C) || 0 },
    { STATUS: 'INACTIVE', CNT: Number(slp?.C) || 0 },
  ];
  return { metrics, sessions };
}

/** 达梦 DM8：V$ 视图与 Oracle 指标名对齐，便于健康评分与前端展示 */
async function damengPerformance(conn) {
  const dmdb = require('dmdb');
  const opts = { outFormat: dmdb.OUT_FORMAT_OBJECT, maxRows: 500 };
  let sessions = [];
  try {
    const r = await conn.execute(
      `SELECT STATUS, COUNT(*) AS CNT FROM V$SESSION WHERE USERNAME IS NOT NULL GROUP BY STATUS`,
      [],
      opts
    );
    sessions = r.rows || [];
  } catch {
    try {
      const r2 = await conn.execute(
        `SELECT COUNT(*) AS CNT FROM V$SESSION WHERE USERNAME IS NOT NULL`,
        [],
        opts
      );
      const c = Number(r2.rows?.[0]?.CNT) || 0;
      sessions = [{ STATUS: 'USER_SESS', CNT: c }];
    } catch {
      sessions = [];
    }
  }

  let total = 0;
  let active = 0;
  for (const row of sessions) {
    const cnt = Number(row.CNT) || 0;
    total += cnt;
    const st = String(row.STATUS || '').toUpperCase();
    if (st === 'ACTIVE' || st === 'OPEN') active += cnt;
  }

  const metrics = [];
  const pushMetric = (name, value, unit = '') => {
    if (value == null || !Number.isFinite(Number(value))) return;
    metrics.push({ METRIC_NAME: name, VALUE: Number(value), METRIC_UNIT: unit });
  };

  try {
    const m = await conn.execute(
      `SELECT METRIC_NAME, VALUE, METRIC_UNIT
       FROM V$SYSMETRIC
       WHERE GROUP_ID = 2 AND METRIC_NAME IN (
         'CPU Usage Per Sec','Host CPU Usage Per Sec','Buffer Cache Hit Ratio',
         'Shared Pool Free %','User Calls Per Sec','Logons Per Sec',
         'Active Sessions','Current Logons Count'
       )`,
      [],
      opts
    );
    for (const row of (m.rows || [])) {
      pushMetric(row.METRIC_NAME, row.VALUE, row.METRIC_UNIT || '');
    }
  } catch {
    try {
      const stat = await conn.execute(
        `SELECT NAME, VALUE FROM V$SYSSTAT
         WHERE NAME IN ('buffer cache hit ratio','db block gets','consistent gets','execute count','parse count (total)')`,
        [],
        opts
      );
      const map = Object.fromEntries((stat.rows || []).map((r) => [String(r.NAME).toLowerCase(), Number(r.VALUE)]));
      if (map['buffer cache hit ratio'] != null) {
        pushMetric('Buffer Cache Hit Ratio', map['buffer cache hit ratio'], '%');
      }
      if (map['execute count'] != null) {
        // 累计值（自实例启动），不是每秒速率；不能当作 User Calls Per Sec
        pushMetric('dm_execute_count_total', map['execute count'], '');
      }
    } catch { /* ignore */ }
  }

  if (!metrics.some((m) => m.METRIC_NAME === 'Current Logons Count')) {
    pushMetric('Current Logons Count', total, '');
  }
  if (!metrics.some((m) => m.METRIC_NAME === 'Active Sessions')) {
    pushMetric('Active Sessions', active, '');
  }

  return { metrics, sessions };
}

async function damengSysinfo(conn) {
  const dmdb = require('dmdb');
  let banner = '';
  try {
    const r = await conn.execute(`SELECT BANNER FROM V$VERSION WHERE ROWNUM<=1`, [], {
      outFormat: dmdb.OUT_FORMAT_OBJECT,
      maxRows: 5,
    });
    banner = r.rows?.[0]?.BANNER != null ? String(r.rows[0].BANNER) : '';
  } catch {
    banner = 'Dameng';
  }
  return {
    instance: { INSTANCE_NAME: 'Dameng', VERSION: banner.slice(0, 500), STARTUP_TIME: null, STATUS: 'OPEN' },
    database: {
      NAME: '',
      OPEN_MODE: 'READ WRITE',
      LOG_MODE: '',
      DATABASE_ROLE: 'PRIMARY',
      DB_UNIQUE_NAME: '',
    },
  };
}

async function damengTablespaces(conn) {
  const dmdb = require('dmdb');
  const opts = { outFormat: dmdb.OUT_FORMAT_OBJECT, maxRows: 200 };
  const r = await conn.execute(
    `SELECT ts.NAME AS TABLESPACE_NAME,
            ROUND(SUM(df.TOTAL_SIZE) / 1024 / 1024 / 1024, 2) AS TOTAL_GB,
            ROUND(SUM(df.TOTAL_SIZE - df.FREE_SIZE) / 1024 / 1024 / 1024, 2) AS USED_GB,
            ROUND(SUM(df.FREE_SIZE) / 1024 / 1024 / 1024, 2) AS FREE_GB,
            CASE WHEN SUM(df.TOTAL_SIZE) > 0
              THEN ROUND(SUM(df.TOTAL_SIZE - df.FREE_SIZE) * 100.0 / SUM(df.TOTAL_SIZE), 2)
              ELSE 0 END AS USED_PCT,
            ts.TYPE$ AS CONTENTS,
            ts.STATUS$ AS STATUS
     FROM V$TABLESPACE ts
     JOIN V$DATAFILE df ON ts.ID = df.GROUP_ID
     GROUP BY ts.NAME, ts.TYPE$, ts.STATUS$
     ORDER BY USED_PCT DESC`,
    [],
    opts
  );
  return r.rows || [];
}

async function pgPerformance(client) {
  const q = await client.query(`
    SELECT numbackends::float, xact_commit, xact_rollback, blks_read, blks_hit, tup_returned, tup_fetched, deadlocks
    FROM pg_stat_database WHERE datname = current_database()`);
  const row = q.rows[0] || {};
  const br = Number(row.blks_read) || 0;
  const bh = Number(row.blks_hit) || 0;
  const hit = br + bh > 0 ? (100 * bh) / (br + bh) : null;
  const metrics = [
    { METRIC_NAME: 'pg_stat_database_numbackends', VALUE: Number(row.numbackends), METRIC_UNIT: '' },
    { METRIC_NAME: 'pg_stat_database_xact_commit', VALUE: Number(row.xact_commit), METRIC_UNIT: '' },
    { METRIC_NAME: 'pg_stat_database_xact_rollback', VALUE: Number(row.xact_rollback), METRIC_UNIT: '' },
    { METRIC_NAME: 'pg_stat_database_deadlocks', VALUE: Number(row.deadlocks), METRIC_UNIT: '' },
  ];
  if (hit != null) metrics.push({ METRIC_NAME: 'pg_buffer_cache_hit_ratio', VALUE: Number(hit.toFixed(2)), METRIC_UNIT: '%' });
  const sa = await client.query(`
    SELECT
      SUM(CASE WHEN state = 'active' THEN 1 ELSE 0 END)::int AS a,
      SUM(CASE WHEN state = 'active' THEN 0 ELSE 1 END)::int AS i
    FROM pg_stat_activity WHERE pid <> pg_backend_pid()`);
  const z = sa.rows[0] || {};
  metrics.push({ METRIC_NAME: 'pg_stat_activity_active', VALUE: Number(z.a) || 0, METRIC_UNIT: '' });
  const sessions = [
    { STATUS: 'ACTIVE', CNT: Number(z.a) || 0 },
    { STATUS: 'INACTIVE', CNT: Number(z.i) || 0 },
  ];
  return { metrics, sessions };
}

async function sqlServerPerformance(pool) {
  const perf = await pool.request().query(`
    SELECT counter_name, cntr_value, object_name
    FROM sys.dm_os_performance_counters
    WHERE counter_name IN (
      'Buffer cache hit ratio', 'Buffer cache hit ratio base',
      'User Connections', 'Batch Requests/sec', 'Page life expectancy'
    )`);
  const counters = perf.recordset || [];
  const find = (name, like) => {
    const row = counters.find((r) => r.counter_name === name && (!like || String(r.object_name || '').includes(like)));
    return row ? Number(row.cntr_value) : null;
  };
  const hit = find('Buffer cache hit ratio', 'Buffer Manager');
  const hitBase = find('Buffer cache hit ratio base', 'Buffer Manager');
  const hitPct = hit != null && hitBase > 0 ? Number(((hit / hitBase) * 100).toFixed(2)) : null;
  const metrics = [
    { METRIC_NAME: 'mssql_user_connections', VALUE: find('User Connections', 'General Statistics'), METRIC_UNIT: '' },
    { METRIC_NAME: 'mssql_batch_requests_per_sec', VALUE: find('Batch Requests/sec', 'SQL Statistics'), METRIC_UNIT: '/s' },
    { METRIC_NAME: 'mssql_page_life_expectancy', VALUE: find('Page life expectancy', 'Buffer Manager'), METRIC_UNIT: 's' },
  ];
  if (hitPct != null) metrics.push({ METRIC_NAME: 'mssql_buffer_cache_hit_ratio', VALUE: hitPct, METRIC_UNIT: '%' });

  const sess = await pool.request().query(`
    SELECT
      SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS active_cnt,
      SUM(CASE WHEN status <> 'running' THEN 1 ELSE 0 END) AS inactive_cnt
    FROM sys.dm_exec_sessions WHERE is_user_process = 1`);
  const s = sess.recordset?.[0] || {};
  const active = Number(s.active_cnt) || 0;
  const inactive = Number(s.inactive_cnt) || 0;
  metrics.push({ METRIC_NAME: 'mssql_active_sessions', VALUE: active, METRIC_UNIT: '' });
  const sessions = [
    { STATUS: 'ACTIVE', CNT: active },
    { STATUS: 'INACTIVE', CNT: inactive },
  ];
  return { metrics, sessions };
}

async function sqlServerSysinfo(pool) {
  const r = await pool.request().query(`
    SELECT @@VERSION AS VERSION, DB_NAME() AS NAME, SERVERPROPERTY('ServerName') AS INSTANCE_NAME`);
  const row = r.recordset?.[0] || {};
  return {
    instance: { INSTANCE_NAME: row.INSTANCE_NAME || 'SQL Server', VERSION: row.VERSION, STARTUP_TIME: null, STATUS: 'OPEN' },
    database: {
      NAME: row.NAME || '',
      OPEN_MODE: 'READ WRITE',
      LOG_MODE: '',
      DATABASE_ROLE: 'PRIMARY',
      DB_UNIQUE_NAME: row.NAME || '',
    },
  };
}

async function sqlServerTablespaces(pool) {
  const r = await pool.request().query(`
    SELECT d.name AS TABLESPACE_NAME,
           ROUND(SUM(mf.size) * 8.0 / 1024 / 1024, 2) AS TOTAL_GB,
           ROUND(SUM(CAST(FILEPROPERTY(mf.name, 'SpaceUsed') AS bigint)) * 8.0 / 1024 / 1024, 2) AS USED_GB,
           ROUND(SUM(mf.size - CAST(FILEPROPERTY(mf.name, 'SpaceUsed') AS bigint)) * 8.0 / 1024 / 1024, 2) AS FREE_GB,
           CASE WHEN SUM(mf.size) > 0
             THEN ROUND(SUM(CAST(FILEPROPERTY(mf.name, 'SpaceUsed') AS bigint)) * 100.0 / SUM(mf.size), 2)
             ELSE 0 END AS USED_PCT,
           'DATABASE' AS CONTENTS,
           d.state_desc AS STATUS
    FROM sys.databases d
    JOIN sys.master_files mf ON d.database_id = mf.database_id
    WHERE d.database_id > 4
    GROUP BY d.name, d.state_desc
    ORDER BY SUM(mf.size) DESC`);
  return rowsUpper(r.recordset || []);
}

async function sqlServerSessions(pool, { onlyActive, status, username }) {
  let q = `
    SELECT s.session_id AS SID, s.request_id AS SERIAL_NUM, s.login_name AS USERNAME,
           s.host_name AS MACHINE, s.program_name AS PROGRAM, s.status AS STATUS,
           COALESCE(r.total_elapsed_time, 0) / 1000 AS LAST_CALL_ET,
           COALESCE(r.wait_type, '') AS WAIT_CLASS, COALESCE(r.wait_type, '') AS EVENT,
           ROUND(COALESCE(r.total_elapsed_time, 0) / 60000.0, 1) AS WAIT_MIN,
           LEFT(st.text, 4000) AS SQL_TEXT
    FROM sys.dm_exec_sessions s
    LEFT JOIN sys.dm_exec_requests r ON s.session_id = r.session_id
    OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) st
    WHERE s.is_user_process = 1`;
  if (onlyActive) q += ` AND s.status = 'running'`;
  if (status) q += ` AND s.status = @status`;
  if (username) q += ` AND s.login_name LIKE @username`;
  q += ` ORDER BY s.status, r.total_elapsed_time DESC OFFSET 0 ROWS FETCH NEXT 200 ROWS ONLY`;
  const req = pool.request();
  if (status) req.input('status', sql.VarChar, status);
  if (username) req.input('username', sql.VarChar, `%${String(username).replace(/[%_]/g, '')}%`);
  const r = await req.query(q);
  return rowsUpper(r.recordset || []).map((row) => ({ ...row, 'SERIAL#': row.SERIAL_NUM ?? 0 }));
}

async function sqlServerTopSql(pool, orderBy) {
  const orderMap = {
    elapsed: 'qs.total_elapsed_time DESC',
    exec: 'qs.execution_count DESC',
    cpu: 'qs.total_worker_time DESC',
    buffer: 'qs.total_logical_reads DESC',
  };
  const ob = orderMap[orderBy] || orderMap.elapsed;
  try {
    const r = await pool.request().query(`
      SELECT TOP 20
        SUBSTRING(st.text, (qs.statement_start_offset/2)+1,
          ((CASE qs.statement_end_offset WHEN -1 THEN DATALENGTH(st.text)
            ELSE qs.statement_end_offset END - qs.statement_start_offset)/2)+1) AS SQL_TEXT,
        qs.execution_count AS EXECUTIONS,
        qs.total_elapsed_time / 1000.0 AS ELAPSED_TIME_TOTAL,
        qs.total_worker_time / 1000.0 AS CPU_TIME_TOTAL,
        qs.total_logical_reads AS BUFFER_GETS_TOTAL,
        (qs.total_elapsed_time / 1000.0) / NULLIF(qs.execution_count, 0) AS AVG_ELAPSED_MS,
        CONVERT(VARCHAR(64), qs.query_hash, 1) AS SQL_ID
      FROM sys.dm_exec_query_stats qs
      CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) st
      WHERE st.text IS NOT NULL
      ORDER BY ${ob}`);
    return rowsUpper(r.recordset || []).map((x) => ({
      SQL_ID: x.SQL_ID,
      SQL_TEXT: x.SQL_TEXT,
      EXECUTIONS: x.EXECUTIONS,
      AVG_ELAPSED_MS: x.AVG_ELAPSED_MS,
      ELAPSED_TIME_TOTAL: x.ELAPSED_TIME_TOTAL,
      CPU_TIME_TOTAL: x.CPU_TIME_TOTAL,
      BUFFER_GETS_TOTAL: x.BUFFER_GETS_TOTAL,
      PARSING_SCHEMA_NAME: null,
      LAST_ACTIVE_TIME: null,
      PLAN_HASH_VALUE: null,
    }));
  } catch {
    return [];
  }
}

async function sqlServerWaits(pool) {
  try {
    const r = await pool.request().query(`
      SELECT TOP 15
        wait_type AS EVENT,
        wait_category_desc AS WAIT_CLASS,
        waiting_tasks_count AS TOTAL_WAITS,
        0 AS TOTAL_TIMEOUTS,
        wait_time_ms / 1000.0 AS TIME_WAITED_SEC,
        CASE WHEN waiting_tasks_count > 0 THEN wait_time_ms * 1.0 / waiting_tasks_count ELSE 0 END AS AVG_WAIT_MS
      FROM sys.dm_os_wait_stats
      WHERE wait_type NOT LIKE 'SLEEP%'
        AND wait_type NOT IN ('BROKER_TASK_STOP', 'BROKER_TO_FLUSH', 'BROKER_EVENTHANDLER')
      ORDER BY wait_time_ms DESC`);
    return rowsUpper(r.recordset || []);
  } catch {
    return [];
  }
}

async function withSqlServer(inst, fn) {
  const pool = await connectSqlServer(inst);
  try {
    return await fn(pool);
  } finally {
    await pool.close();
  }
}

async function getPerformanceBundle(instanceId) {
  const inst = await fetchCmdbInstance(instanceId);
  const t = normalizeDbType(inst);
  const exp = exporterMeta(t);
  if (t === 'ORACLE') {
    const conn = await connectOracle(inst);
    try {
      const { metrics, sessions } = await oraclePerformance(conn);
      return { exporter: exp, metrics, sessions };
    } finally {
      await conn.close();
    }
  }
  if (isMysqlFamily(t)) {
    const conn = await connectMysql(inst);
    try {
      const { metrics, sessions } = await mysqlPerformance(conn);
      return { exporter: exp, metrics, sessions };
    } finally {
      await conn.end();
    }
  }
  if (isPgFamily(t)) {
    const client = await connectPostgres(inst);
    try {
      const { metrics, sessions } = await pgPerformance(client);
      return { exporter: exp, metrics, sessions };
    } finally {
      await client.end();
    }
  }
  if (t === 'DAMENG') {
    const conn = await connectDameng(inst);
    try {
      const { metrics, sessions } = await damengPerformance(conn);
      return { exporter: exp, metrics, sessions };
    } finally {
      await conn.close();
    }
  }
  if (isSqlServer(t)) {
    return withSqlServer(inst, async (pool) => {
      const { metrics, sessions } = await sqlServerPerformance(pool);
      return { exporter: exp, metrics, sessions };
    });
  }
  throw new Error(`监控采集不支持类型「${t}」，请使用 CMDB 中的 ORACLE / MYSQL / POSTGRESQL / DAMENG / GOLDENDB / PANWEI / SQLSERVER`);
}

async function oracleSysinfo(conn) {
  const [inst, db] = await Promise.all([
    conn.execute(`SELECT * FROM V$INSTANCE`, [], { outFormat: oracledb.OUT_FORMAT_OBJECT }),
    conn.execute(
      `SELECT DBID,NAME,DB_UNIQUE_NAME,OPEN_MODE,LOG_MODE,CREATED, DATABASE_ROLE,PROTECTION_MODE FROM V$DATABASE`,
      [],
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    ),
  ]);
  return { instance: inst.rows[0] || null, database: db.rows[0] || null };
}

async function mysqlSysinfo(conn) {
  const [[ver]] = await conn.query(`SELECT VERSION() AS VERSION`);
  const [[hn]] = await conn.query(`SELECT @@hostname AS HOSTNAME, @@port AS PORT`);
  const [[db]] = await conn.query(`SELECT DATABASE() AS CUR_DB`);
  return {
    instance: { INSTANCE_NAME: hn.HOSTNAME, VERSION: ver.VERSION, STARTUP_TIME: null, STATUS: 'OPEN' },
    database: {
      NAME: db.CUR_DB || '',
      OPEN_MODE: 'READ WRITE',
      LOG_MODE: '',
      DATABASE_ROLE: 'PRIMARY',
      DB_UNIQUE_NAME: db.CUR_DB || '',
    },
  };
}

async function pgSysinfo(client) {
  const v = await client.query(`SELECT version() AS VERSION, inet_server_addr()::text AS HOST`);
  const cur = await client.query(`SELECT current_database() AS NAME`);
  return {
    instance: { INSTANCE_NAME: 'PostgreSQL', VERSION: v.rows[0].VERSION, STARTUP_TIME: null, STATUS: 'OPEN' },
    database: {
      NAME: cur.rows[0].NAME,
      OPEN_MODE: 'READ WRITE',
      LOG_MODE: '',
      DATABASE_ROLE: 'PRIMARY',
      DB_UNIQUE_NAME: cur.rows[0].NAME,
    },
  };
}

async function getSysinfoBundle(instanceId) {
  const inst = await fetchCmdbInstance(instanceId);
  const t = normalizeDbType(inst);
  if (t === 'ORACLE') {
    const conn = await connectOracle(inst);
    try {
      return await oracleSysinfo(conn);
    } finally {
      await conn.close();
    }
  }
  if (isMysqlFamily(t)) {
    const conn = await connectMysql(inst);
    try {
      return await mysqlSysinfo(conn);
    } finally {
      await conn.end();
    }
  }
  if (isPgFamily(t)) {
    const client = await connectPostgres(inst);
    try {
      return await pgSysinfo(client);
    } finally {
      await client.end();
    }
  }
  if (t === 'DAMENG') {
    const conn = await connectDameng(inst);
    try {
      return await damengSysinfo(conn);
    } finally {
      await conn.close();
    }
  }
  if (isSqlServer(t)) {
    return withSqlServer(inst, (pool) => sqlServerSysinfo(pool));
  }
  throw new Error(`不支持的数据库类型: ${t}`);
}

/**
 * 19c / 12c+ 官方口径（现场在 192.168.137.102/ora19c 的 monitor 账号验证通过）。
 * metrics 里的 size 是「块数」，必须乘 DBA_TABLESPACES.BLOCK_SIZE。
 * 旧实现先查 V$INSTANCE 判版本，无字典权限时整条链路掉到 DBA_DATA_FILES 并报 ORA-00942，
 * 页面显示「暂无数据」；现在无条件优先尝试本语句。
 */
const ORACLE_TABLESPACE_19C_SQL = `
  SELECT t.tablespace_name,
         ROUND(m.tablespace_size * t.block_size / POWER(1024, 3), 2) AS total_gb,
         ROUND(m.used_space * t.block_size / POWER(1024, 3), 2) AS used_gb,
         ROUND((m.tablespace_size - m.used_space) * t.block_size / POWER(1024, 3), 2) AS free_gb,
         ROUND(m.used_percent, 2) AS used_pct
    FROM dba_tablespace_usage_metrics m
    JOIN dba_tablespaces t ON t.tablespace_name = m.tablespace_name
   ORDER BY m.used_percent DESC`;

// 低权限兜底：Oracle 并不存在 ALL_DATA_FILES / ALL_FREE_SPACE 视图（原降级分支是死路），
// 用 DBA_TABLESPACES / USER_TABLESPACES 至少把表空间名列出来，并在返回里标注 DEGRADED。
const ORACLE_TABLESPACE_NAMES_SQL = `
  SELECT tablespace_name,
         CAST(NULL AS NUMBER) AS total_gb,
         CAST(NULL AS NUMBER) AS used_gb,
         CAST(NULL AS NUMBER) AS free_gb,
         CAST(NULL AS NUMBER) AS used_pct,
         'NAMES_ONLY' AS DEGRADED
    FROM dba_tablespaces ORDER BY tablespace_name`;

const ORACLE_TABLESPACE_USER_SQL = `
  SELECT tablespace_name,
         CAST(NULL AS NUMBER) AS total_gb,
         CAST(NULL AS NUMBER) AS used_gb,
         CAST(NULL AS NUMBER) AS free_gb,
         CAST(NULL AS NUMBER) AS used_pct,
         'NAMES_ONLY' AS DEGRADED
    FROM user_tablespaces ORDER BY tablespace_name`;

const ORACLE_TABLESPACE_LEGACY_SQL = `
    select tbs_used_info.tablespace_name,
           tbs_used_info.total_gb,
           tbs_used_info.used_gb,
           tbs_used_info.FREE_GB,
           tbs_used_info.used_of_max USED_PCT
      from (select a.tablespace_name,
                   round(a.bytes_alloc / 1024 / 1024 / 1024) alloc_gb,
                   round((a.bytes_alloc - nvl(b.bytes_free, 0)) / 1024 / 1024 / 1024) used_gb,
                   round((a.bytes_alloc - nvl(b.bytes_free, 0)) * 100 /
                         DECODE(a.maxbytes, 0, 1, a.maxbytes)) used_of_max,
                   round((a.maxbytes - a.bytes_alloc + nvl(b.bytes_free, 0)) / 1024 / 1024 / 1024) FREE_GB,
                   round(a.maxbytes / 1024 / 1024 / 1024) total_gb
              from (select f.tablespace_name,
                           sum(f.bytes) bytes_alloc,
                           sum(decode(f.autoextensible,
                                      'YES',
                                      f.maxbytes,
                                      'NO',
                                      f.bytes)) maxbytes
                      from dba_data_files f
                     group by tablespace_name) a,
                   (select f.tablespace_name, sum(f.bytes) bytes_free
                      from dba_free_space f
                     group by tablespace_name) b
             where a.tablespace_name = b.tablespace_name(+)) tbs_used_info
     order by tbs_used_info.used_of_max desc`;

/**
 * 逐级降级：19c 语句 → legacy → 仅名称。每一级失败都记录原因，最终异常带上完整 ORA 链，
 * 不再用空 catch 把「权限不足 / 视图不存在 / 查询超时」伪装成「暂无数据」。
 */
async function oracleTablespaces(conn) {
  const failures = [];
  const candidates = [
    ['DBA_TABLESPACE_USAGE_METRICS(19c)', ORACLE_TABLESPACE_19C_SQL],
    ['DBA_DATA_FILES+DBA_FREE_SPACE(legacy)', ORACLE_TABLESPACE_LEGACY_SQL],
    ['DBA_TABLESPACES(仅名称)', ORACLE_TABLESPACE_NAMES_SQL],
    ['USER_TABLESPACES(仅名称)', ORACLE_TABLESPACE_USER_SQL],
  ];
  for (const [label, statement] of candidates) {
    try {
      const r = await conn.execute(statement, [], { outFormat: oracledb.OUT_FORMAT_OBJECT });
      const rows = rowsUpper(r.rows || []);
      if (rows.length) return rows;
      failures.push(`${label}: 查询成功但无数据`);
    } catch (e) {
      failures.push(`${label}: ORA-${e.errorNum ?? '?'}: ${String(e.message || e).split('\n')[0]}`);
    }
  }
  throw new Error(`无法读取表空间：${failures.join('；')}。请为被管账号授予 SELECT ANY DICTIONARY `
    + '（或 SELECT_CATALOG_ROLE 并单独授权 DBA_TABLESPACE_USAGE_METRICS / DBA_TABLESPACES）');
}

/** MySQL / PostgreSQL 没有表空间上限：只给库大小，使用率不适用（原先恒为 100%） */
async function mysqlTablespaces(conn) {
  const [rows] = await conn.query(
    `SELECT table_schema AS TABLESPACE_NAME,
            ROUND(SUM(data_length+index_length)/1024/1024/1024,2) AS USED_GB,
            NULL AS TOTAL_GB,
            NULL AS FREE_GB,
            NULL AS USED_PCT,
            'PERMANENT' AS CONTENTS,
            'ONLINE' AS STATUS
     FROM information_schema.tables
     WHERE table_schema NOT IN ('information_schema','mysql','performance_schema','sys')
     GROUP BY table_schema
     ORDER BY USED_GB DESC`
  );
  return rowsUpper(rows);
}

const PANWEI_TABLESPACE_SQL = `
    SELECT t.spcname AS TABLESPACE_NAME,
           CASE WHEN btrim(COALESCE(t.spcmaxsize, '')) ~ '^[0-9]+$' AND btrim(t.spcmaxsize)::numeric > 0
                THEN ROUND(btrim(t.spcmaxsize)::numeric / 1024 / 1024 / 1024, 2) ELSE NULL END AS TOTAL_GB,
           ROUND(pg_tablespace_size(t.oid) / 1024.0 / 1024 / 1024, 2) AS USED_GB,
           CASE WHEN btrim(COALESCE(t.spcmaxsize, '')) ~ '^[0-9]+$' AND btrim(t.spcmaxsize)::numeric > 0
                THEN GREATEST(ROUND((btrim(t.spcmaxsize)::numeric - pg_tablespace_size(t.oid)) / 1024 / 1024 / 1024, 2), 0)
                ELSE NULL END AS FREE_GB,
           CASE WHEN btrim(COALESCE(t.spcmaxsize, '')) ~ '^[0-9]+$' AND btrim(t.spcmaxsize)::numeric > 0
                THEN ROUND(pg_tablespace_size(t.oid) * 100.0 / btrim(t.spcmaxsize)::numeric, 2) ELSE NULL END AS USED_PCT,
           'PERMANENT' AS CONTENTS,
           'ONLINE' AS STATUS
    FROM pg_tablespace t
    ORDER BY pg_tablespace_size(t.oid) DESC`;

const PANWEI_TABLESPACE_USED_SQL = `
    SELECT t.spcname AS TABLESPACE_NAME,
           NULL::numeric AS TOTAL_GB,
           ROUND(pg_tablespace_size(t.oid) / 1024.0 / 1024 / 1024, 2) AS USED_GB,
           NULL::numeric AS FREE_GB,
           NULL::numeric AS USED_PCT,
           'PERMANENT' AS CONTENTS,
           'ONLINE' AS STATUS
    FROM pg_tablespace t
    ORDER BY pg_tablespace_size(t.oid) DESC`;

/** 磐维按表空间和 MAXSIZE（字节）计算使用率。未设上限时使用率为空，不再把库大小打成 100%。 */
async function panweiTablespaces(client) {
  try {
    const r = await client.query(PANWEI_TABLESPACE_SQL);
    if (r.rows?.length) return rowsUpper(r.rows);
  } catch { /* 旧版本没有 spcmaxsize */ }
  const r = await client.query(PANWEI_TABLESPACE_USED_SQL);
  return rowsUpper(r.rows);
}

async function pgTablespaces(client) {
  const r = await client.query(`
    SELECT d.datname AS TABLESPACE_NAME,
           NULL AS TOTAL_GB,
           ROUND(pg_database_size(d.oid)/1024/1024/1024.0, 2) AS USED_GB,
           NULL AS FREE_GB,
           NULL AS USED_PCT,
           'DATABASE' AS CONTENTS,
           CASE WHEN datallowconn THEN 'ONLINE' ELSE 'OFFLINE' END AS STATUS
    FROM pg_database d
    WHERE datname NOT IN ('template0','template1')
    ORDER BY pg_database_size(d.oid) DESC`);
  return rowsUpper(r.rows);
}

async function getTablespaces(instanceId) {
  const inst = await fetchCmdbInstance(instanceId);
  const t = normalizeDbType(inst);
  if (t === 'ORACLE') {
    const conn = await connectOracle(inst);
    try {
      return await oracleTablespaces(conn);
    } finally {
      await conn.close();
    }
  }
  if (isMysqlFamily(t)) {
    const conn = await connectMysql(inst);
    try {
      return await mysqlTablespaces(conn);
    } finally {
      await conn.end();
    }
  }
  if (t === 'PANWEI') {
    const client = await connectPostgres(inst);
    try {
      return await panweiTablespaces(client);
    } finally {
      await client.end();
    }
  }
  if (isPgFamily(t)) {
    const client = await connectPostgres(inst);
    try {
      return await pgTablespaces(client);
    } finally {
      await client.end();
    }
  }
  if (t === 'DAMENG') {
    const conn = await connectDameng(inst);
    try {
      try {
        return await damengTablespaces(conn);
      } catch {
        return await oracleTablespaces(conn);
      }
    } finally {
      await conn.close();
    }
  }
  if (isSqlServer(t)) {
    return withSqlServer(inst, (pool) => sqlServerTablespaces(pool));
  }
  throw new Error(`不支持的数据库类型: ${t}`);
}

async function oracleSessions(conn, { onlyActive, status, username }) {
  let where = `WHERE s.TYPE='USER'`;
  const binds = {};
  if (onlyActive) where += ` AND s.STATUS='ACTIVE'`;
  if (status) {
    where += ` AND s.STATUS=:st`;
    binds.st = status;
  }
  if (username) {
    where += ` AND s.USERNAME LIKE :un`;
    const safe = String(username).replace(/[%_]/g, '');
    binds.un = `%${safe}%`;
  }
  const r = await conn.execute(
    `SELECT SID, SERIAL_NUM, USERNAME, MACHINE, PROGRAM, STATUS, LAST_CALL_ET, WAIT_CLASS, EVENT, WAIT_MIN, SQL_TEXT FROM (
       SELECT s.SID, s.SERIAL# SERIAL_NUM, s.USERNAME, s.MACHINE, s.PROGRAM, s.STATUS,
              s.LAST_CALL_ET, s.WAIT_CLASS, s.EVENT,
              ROUND(s.LAST_CALL_ET/60,1) WAIT_MIN,
              q.SQL_TEXT
       FROM V$SESSION s
       LEFT JOIN V$SQL q ON s.SQL_ADDRESS = q.ADDRESS AND s.SQL_HASH_VALUE = q.HASH_VALUE
       ${where}
       ORDER BY s.STATUS, s.LAST_CALL_ET DESC NULLS LAST
     ) WHERE ROWNUM <= 200`,
    binds,
    { outFormat: oracledb.OUT_FORMAT_OBJECT }
  );
  return r.rows || [];
}

async function mysqlSessions(conn, { onlyActive, status, username }) {
  let sql = `SELECT ID AS SID, '' AS SERIAL_NUM, USER AS USERNAME, HOST AS MACHINE,
                    'PROCESSLIST' AS PROGRAM, COMMAND AS STATUS,
                    TIME AS LAST_CALL_ET, STATE AS WAIT_CLASS, '' AS EVENT, INFO AS SQL_TEXT,
                    ROUND(TIME/60.0,1) AS WAIT_MIN
             FROM information_schema.PROCESSLIST WHERE 1=1`;
  const params = [];
  if (onlyActive) sql += ` AND COMMAND <> 'Sleep'`;
  if (status) {
    sql += ` AND COMMAND = ?`;
    params.push(status);
  }
  if (username) {
    sql += ` AND USER LIKE ?`;
    params.push(`%${username}%`);
  }
  sql += ` ORDER BY TIME DESC LIMIT 200`;
  const [rows] = await conn.query(sql, params);
  return rowsUpper(rows).map((r) => ({ ...r, 'SERIAL#': r.SERIAL_NUM ?? '' }));
}

function pgSessionTail(onlyActive, status, username) {
  let sql = '';
  const params = [];
  let n = 1;
  if (onlyActive) sql += ` AND state = 'active'`;
  if (status) {
    sql += ` AND state = $${n++}`;
    params.push(status);
  }
  if (username) {
    sql += ` AND usename ILIKE $${n++}`;
    params.push(`%${username}%`);
  }
  sql += ` ORDER BY state_change DESC NULLS LAST LIMIT 200`;
  return { sql, params };
}

async function pgSessions(client, { onlyActive, status, username, panwei }) {
  const tail = pgSessionTail(onlyActive, status, username);
  const modern = `SELECT pid AS SID, 0 AS SERIAL_NUM, usename AS USERNAME, host(client_addr) AS MACHINE,
                    application_name AS PROGRAM, state AS STATUS,
                    COALESCE(EXTRACT(epoch FROM (now() - state_change))::int, 0) AS LAST_CALL_ET,
                    wait_event_type AS WAIT_CLASS, wait_event AS EVENT,
                    ROUND(EXTRACT(epoch FROM (now() - state_change))/60.0, 1) AS WAIT_MIN,
                    LEFT(query, 4000) AS SQL_TEXT
             FROM pg_stat_activity WHERE pid <> pg_backend_pid()`;
  const panweiSql = `SELECT pid AS SID, 0 AS SERIAL_NUM, usename AS USERNAME, CAST(client_addr AS text) AS MACHINE,
                    application_name AS PROGRAM, state AS STATUS,
                    COALESCE(CAST(EXTRACT(epoch FROM (now() - state_change)) AS int), 0) AS LAST_CALL_ET,
                    CAST('' AS text) AS WAIT_CLASS, CAST('' AS text) AS EVENT,
                    ROUND(CAST(EXTRACT(epoch FROM (now() - state_change)) / 60.0 AS numeric), 1) AS WAIT_MIN,
                    LEFT(query, 4000) AS SQL_TEXT
             FROM pg_stat_activity WHERE pid <> pg_backend_pid()`;
  let r;
  if (panwei) {
    r = await client.query(panweiSql + tail.sql, tail.params);
  } else {
    try {
      r = await client.query(modern + tail.sql, tail.params);
    } catch {
      r = await client.query(panweiSql + tail.sql, tail.params);
    }
  }
  return rowsUpper(r.rows).map((row) => ({ ...row, 'SERIAL#': row.SERIAL_NUM ?? 0 }));
}

async function getSessions(instanceId, { onlyActive, status, username } = {}) {
  const inst = await fetchCmdbInstance(instanceId);
  const t = normalizeDbType(inst);
  const oa = onlyActive === '1' || onlyActive === true;
  const opts = { onlyActive: oa, status: status || '', username: username || '' };
  if (t === 'ORACLE') {
    const conn = await connectOracle(inst);
    try {
      return await oracleSessions(conn, opts);
    } finally {
      await conn.close();
    }
  }
  if (isMysqlFamily(t)) {
    const conn = await connectMysql(inst);
    try {
      return await mysqlSessions(conn, opts);
    } finally {
      await conn.end();
    }
  }
  if (isPgFamily(t)) {
    const client = await connectPostgres(inst);
    try {
      return await pgSessions(client, { ...opts, panwei: t === 'PANWEI' });
    } finally {
      await client.end();
    }
  }
  if (t === 'DAMENG') {
    const conn = await connectDameng(inst);
    try {
      try {
        return await oracleSessions(conn, opts);
      } catch {
        return [];
      }
    } finally {
      await conn.close();
    }
  }
  if (isSqlServer(t)) {
    return withSqlServer(inst, (pool) => sqlServerSessions(pool, opts));
  }
  throw new Error(`不支持的数据库类型: ${t}`);
}

async function oracleTopSql(conn, orderBy) {
  const orderMap = {
    elapsed: 'ELAPSED_TIME_TOTAL DESC',
    exec: 'EXECUTIONS DESC',
    cpu: 'CPU_TIME_TOTAL DESC',
    buffer: 'BUFFER_GETS_TOTAL DESC',
  };
  const ob = orderMap[orderBy] || orderMap.elapsed;
  const r = await conn.execute(
    `SELECT SQL_ID, SUBSTR(SQL_TEXT,1,200) SQL_TEXT,
            EXECUTIONS,
            ROUND(ELAPSED_TIME/1000000,2) ELAPSED_TIME_TOTAL,
            ROUND(CPU_TIME/1000000,2) CPU_TIME_TOTAL,
            BUFFER_GETS BUFFER_GETS_TOTAL,
            ROUND(ELAPSED_TIME/DECODE(EXECUTIONS,0,1,EXECUTIONS)/1000,2) AVG_ELAPSED_MS,
            PARSING_SCHEMA_NAME, LAST_ACTIVE_TIME, PLAN_HASH_VALUE
     FROM V$SQLSTATS
     WHERE EXECUTIONS > 0 AND SQL_TEXT NOT LIKE '%V$SQL%'
     ORDER BY ${ob}
     FETCH FIRST 20 ROWS ONLY`,
    [],
    { outFormat: oracledb.OUT_FORMAT_OBJECT }
  );
  return r.rows || [];
}

async function mysqlTopSql(conn, orderBy) {
  const orderMap = {
    elapsed: 'SUM_TIMER_WAIT DESC',
    exec: 'COUNT_STAR DESC',
    cpu: 'SUM_TIMER_WAIT DESC',
    buffer: 'SUM_ROWS_EXAMINED DESC',
  };
  const ob = orderMap[orderBy] || orderMap.elapsed;
  try {
    const [rows] = await conn.query(
      `SELECT DIGEST_TEXT AS SQL_TEXT, SCHEMA_NAME AS PARSING_SCHEMA_NAME,
              COUNT_STAR AS EXECUTIONS,
              ROUND(AVG_TIMER_WAIT/1000000000, 4) AS AVG_ELAPSED_MS,
              ROUND(SUM_TIMER_WAIT/1000000000, 2) AS ELAPSED_TIME_TOTAL,
              DIGEST AS SQL_ID
       FROM performance_schema.events_statements_summary_by_digest
       WHERE DIGEST_TEXT IS NOT NULL
       ORDER BY ${ob} LIMIT 20`
    );
    return rowsUpper(rows).map((r) => ({
      SQL_ID: r.SQL_ID != null ? String(r.SQL_ID) : '-',
      SQL_TEXT: r.SQL_TEXT,
      EXECUTIONS: r.EXECUTIONS,
      AVG_ELAPSED_MS: r.AVG_ELAPSED_MS,
      ELAPSED_TIME_TOTAL: r.ELAPSED_TIME_TOTAL,
      CPU_TIME_TOTAL: null,
      BUFFER_GETS_TOTAL: null,
      PLAN_HASH_VALUE: null,
      LAST_ACTIVE_TIME: null,
    }));
  } catch {
    return [];
  }
}

async function pgTopSql(client, orderBy) {
  const orderMap = {
    elapsed: 'total_exec_time DESC',
    exec: 'calls DESC',
    cpu: 'total_exec_time DESC',
    buffer: 'shared_blks_hit DESC',
  };
  const ob = orderMap[orderBy] || orderMap.elapsed;
  try {
    const r = await client.query(`
      SELECT query AS SQL_TEXT, calls AS EXECUTIONS,
             ROUND((total_exec_time::numeric / 1000.0) / NULLIF(calls,0), 4) AS AVG_ELAPSED_MS,
             ROUND(total_exec_time::numeric / 1000.0, 2) AS ELAPSED_TIME_TOTAL,
             md5(query)::text AS SQL_ID
      FROM pg_stat_statements ORDER BY ${ob} NULLS LAST LIMIT 20`);
    return rowsUpper(r.rows || []).map((x) => ({
      SQL_ID: x.SQL_ID,
      SQL_TEXT: x.SQL_TEXT,
      EXECUTIONS: x.EXECUTIONS,
      AVG_ELAPSED_MS: x.AVG_ELAPSED_MS,
      ELAPSED_TIME_TOTAL: x.ELAPSED_TIME_TOTAL,
      CPU_TIME_TOTAL: null,
      BUFFER_GETS_TOTAL: null,
      PARSING_SCHEMA_NAME: null,
      LAST_ACTIVE_TIME: null,
      PLAN_HASH_VALUE: null,
    }));
  } catch {
    return [];
  }
}

async function getTopSql(instanceId, orderBy) {
  const inst = await fetchCmdbInstance(instanceId);
  const t = normalizeDbType(inst);
  if (t === 'ORACLE') {
    const conn = await connectOracle(inst);
    try {
      return await oracleTopSql(conn, orderBy);
    } finally {
      await conn.close();
    }
  }
  if (isMysqlFamily(t)) {
    const conn = await connectMysql(inst);
    try {
      return await mysqlTopSql(conn, orderBy);
    } finally {
      await conn.end();
    }
  }
  if (isPgFamily(t)) {
    const client = await connectPostgres(inst);
    try {
      return await pgTopSql(client, orderBy);
    } finally {
      await client.end();
    }
  }
  if (t === 'DAMENG') {
    const conn = await connectDameng(inst);
    try {
      try {
        return await oracleTopSql(conn, orderBy);
      } catch {
        return [];
      }
    } finally {
      await conn.close();
    }
  }
  if (isSqlServer(t)) {
    return withSqlServer(inst, (pool) => sqlServerTopSql(pool, orderBy));
  }
  throw new Error(`不支持的数据库类型: ${t}`);
}

async function oracleWaits(conn) {
  const r = await conn.execute(
    `SELECT EVENT, WAIT_CLASS, TOTAL_WAITS, TOTAL_TIMEOUTS,
            ROUND(TIME_WAITED_MICRO/1000000,2) TIME_WAITED_SEC,
            ROUND(TIME_WAITED_MICRO/NULLIF(TOTAL_WAITS,0)/1000,2) AVG_WAIT_MS
     FROM V$SYSTEM_EVENT
     WHERE WAIT_CLASS NOT IN ('Idle','Other')
     ORDER BY TIME_WAITED_MICRO DESC FETCH FIRST 15 ROWS ONLY`,
    [],
    { outFormat: oracledb.OUT_FORMAT_OBJECT }
  );
  return r.rows || [];
}

async function mysqlWaits(conn) {
  try {
    const [rows] = await conn.query(
      `SELECT EVENT_NAME AS EVENT, 'Wait' AS WAIT_CLASS, COUNT_STAR AS TOTAL_WAITS,
              0 AS TOTAL_TIMEOUTS,
              ROUND(SUM_TIMER_WAIT/1000000000000,2) AS TIME_WAITED_SEC,
              ROUND(AVG_TIMER_WAIT/1000000,2) AS AVG_WAIT_MS
       FROM performance_schema.events_waits_summary_global_by_event_name
       WHERE SUM_TIMER_WAIT > 0 AND EVENT_NAME NOT LIKE 'wait/io/table/sql/handler'
       ORDER BY SUM_TIMER_WAIT DESC LIMIT 15`
    );
    return rowsUpper(rows);
  } catch {
    return [];
  }
}

async function pgWaits(client) {
  try {
    const r = await client.query(`
      SELECT COALESCE(wait_event, '(none)') AS EVENT,
             COALESCE(wait_event_type, '-') AS WAIT_CLASS,
             COUNT(*)::bigint AS TOTAL_WAITS,
             0::bigint AS TOTAL_TIMEOUTS,
             0::numeric AS TIME_WAITED_SEC,
             0::numeric AS AVG_WAIT_MS
      FROM pg_stat_activity
      WHERE pid <> pg_backend_pid() AND wait_event IS NOT NULL
      GROUP BY wait_event_type, wait_event
      ORDER BY COUNT(*) DESC
      LIMIT 15`);
    return rowsUpper(r.rows || []);
  } catch {
    return [];
  }
}

async function getWaits(instanceId) {
  const inst = await fetchCmdbInstance(instanceId);
  const t = normalizeDbType(inst);
  if (t === 'ORACLE') {
    const conn = await connectOracle(inst);
    try {
      return await oracleWaits(conn);
    } finally {
      await conn.close();
    }
  }
  if (isMysqlFamily(t)) {
    const conn = await connectMysql(inst);
    try {
      return await mysqlWaits(conn);
    } finally {
      await conn.end();
    }
  }
  if (isPgFamily(t)) {
    const client = await connectPostgres(inst);
    try {
      return await pgWaits(client);
    } finally {
      await client.end();
    }
  }
  if (t === 'DAMENG') {
    const conn = await connectDameng(inst);
    try {
      try {
        return await oracleWaits(conn);
      } catch {
        return [];
      }
    } finally {
      await conn.close();
    }
  }
  if (isSqlServer(t)) {
    return withSqlServer(inst, (pool) => sqlServerWaits(pool));
  }
  return [];
}

/**
 * 运行自检：逐条验证表空间查询链路，返回每一级语句的行数与原始 ORA 错误。
 * 与 Java ExporterCollector.oracleTablespaceDiagnostics 同构，便于在页面上直接判断
 * 「是 19c 语句问题、字典权限问题，还是部署了旧版本代码」。
 */
async function oracleTablespaceDiagnostics(instanceId) {
  const inst = await fetchCmdbInstance(instanceId);
  const out = {
    instanceId: Number(instanceId) || instanceId,
    instanceName: inst.INSTANCE_NAME || null,
    hostIp: inst.HOST_IP || null,
    port: inst.PORT || null,
    dbUser: inst.DB_USER || null,
    dbType: inst.DB_TYPE || null,
    probes: [],
  };
  if (normalizeDbType(inst) !== 'ORACLE') {
    out.skipped = true;
    out.reason = '表空间链路自检仅支持 Oracle 实例';
    return out;
  }

  let conn;
  try {
    conn = await connectOracle(inst);
  } catch (e) {
    out.connectError = String(e.message || e).slice(0, 300);
    out.ok = false;
    return out;
  }

  try {
    // 版本只用于展示，绝不作为选择 19c 语句的前置条件
    try {
      const v = await conn.execute('SELECT VERSION FROM V$INSTANCE', [],
        { outFormat: oracledb.OUT_FORMAT_OBJECT });
      out.version = v.rows?.[0]?.VERSION || v.rows?.[0]?.version || null;
    } catch (e) {
      out.version = null;
      out.versionError = String(e.message || e).split('\n')[0].slice(0, 200);
    }

    const candidates = [
      ['19c DBA_TABLESPACE_USAGE_METRICS', ORACLE_TABLESPACE_19C_SQL],
      ['legacy DBA_DATA_FILES/DBA_FREE_SPACE', ORACLE_TABLESPACE_LEGACY_SQL],
      ['DBA_TABLESPACES(仅名称)', ORACLE_TABLESPACE_NAMES_SQL],
      ['USER_TABLESPACES(仅名称)', ORACLE_TABLESPACE_USER_SQL],
    ];
    for (const [name, statement] of candidates) {
      const p = { name, sql: String(statement).trim().replace(/\s+/g, ' ').slice(0, 500) };
      try {
        const r = await conn.execute(statement, [], { outFormat: oracledb.OUT_FORMAT_OBJECT });
        const rows = rowsUpper(r.rows || []);
        p.ok = true;
        p.rows = rows.length;
        p.sample = rows[0] || null;
        if (rows[0] && rows[0].DEGRADED === 'NAMES_ONLY') p.degraded = 'NAMES_ONLY';
      } catch (e) {
        p.ok = false;
        p.rows = 0;
        p.error = `ORA-${e.errorNum ?? '?'}: ${String(e.message || e).split('\n')[0]}`.slice(0, 300);
      }
      out.probes.push(p);
    }
  } finally {
    try { await conn.close(); } catch { /* ignore */ }
  }

  const full = out.probes.find((p) => p.ok && !p.degraded);
  out.ok = Boolean(full);
  out.activeStrategy = full ? full.name : null;
  if (!full) {
    out.advice = '所有表空间查询均失败。请为被管账号授予 SELECT ANY DICTIONARY，'
      + '或 SELECT_CATALOG_ROLE 并对 DBA_TABLESPACE_USAGE_METRICS / DBA_TABLESPACES 单独授权；'
      + '同时确认后端已更新到含 19c 语句的版本。';
  } else if (full.name.startsWith('19c')) {
    out.advice = '19c 口径可用，表空间容量与使用率读取正常。';
  } else {
    out.advice = `当前由「${full.name}」兜底提供数据，建议补齐字典视图权限以启用 19c 口径。`;
  }
  return out;
}

module.exports = {
  getPerformanceBundle,
  getSysinfoBundle,
  getTablespaces,
  getSessions,
  getTopSql,
  getWaits,
  oracleTablespaceDiagnostics,
};
