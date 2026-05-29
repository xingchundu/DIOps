/**
 * 类 Prometheus Exporter 的拉取式采集：按 CMDB 实例类型直连 Oracle / MySQL / PostgreSQL，输出统一指标结构。
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
  return { metrics: m.rows || [], sessions: sess.rows || [] };
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

/** 达梦 DM8：V$ 视图与 Oracle 相近，指标名对齐 collectPersist 中 ORACLE/DAMENG 分支 */
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
  const metrics = [
    { METRIC_NAME: 'Current Logons Count', VALUE: total, METRIC_UNIT: '' },
    { METRIC_NAME: 'Active Sessions', VALUE: active || Math.min(total, 1), METRIC_UNIT: '' },
  ];
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
  const sessions = [
    { STATUS: 'ACTIVE', CNT: Number(z.a) || 0 },
    { STATUS: 'INACTIVE', CNT: Number(z.i) || 0 },
  ];
  return { metrics, sessions };
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
  if (t === 'POSTGRESQL') {
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
  throw new Error(`监控采集不支持类型「${t}」，请使用 CMDB 中的 ORACLE / MYSQL / POSTGRESQL / DAMENG / GOLDENDB`);
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
  if (t === 'POSTGRESQL') {
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
  throw new Error(`不支持的数据库类型: ${t}`);
}

async function oracleTablespaces(conn) {
  const r = await conn.execute(
    `select tbs_used_info.tablespace_name,
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
     order by tbs_used_info.used_of_max desc`,
    [],
    { outFormat: oracledb.OUT_FORMAT_OBJECT }
  );
  return r.rows || [];
}

async function mysqlTablespaces(conn) {
  const [rows] = await conn.query(
    `SELECT table_schema AS TABLESPACE_NAME,
            ROUND(SUM(data_length+index_length)/1024/1024/1024,2) AS USED_GB,
            ROUND(SUM(data_length+index_length)/1024/1024/1024,2) AS TOTAL_GB,
            0 AS FREE_GB,
            100 AS USED_PCT,
            'PERMANENT' AS CONTENTS,
            'ONLINE' AS STATUS
     FROM information_schema.tables
     WHERE table_schema NOT IN ('information_schema','mysql','performance_schema','sys')
     GROUP BY table_schema
     ORDER BY USED_GB DESC`
  );
  return rowsUpper(rows);
}

async function pgTablespaces(client) {
  const r = await client.query(`
    SELECT d.datname AS TABLESPACE_NAME,
           ROUND(pg_database_size(d.oid)/1024/1024/1024.0, 2) AS TOTAL_GB,
           ROUND(pg_database_size(d.oid)/1024/1024/1024.0, 2) AS USED_GB,
           0 AS FREE_GB,
           100 AS USED_PCT,
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
  if (t === 'POSTGRESQL') {
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
        return await oracleTablespaces(conn);
      } catch {
        return [];
      }
    } finally {
      await conn.close();
    }
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
    `SELECT s.SID, s.SERIAL#, s.USERNAME, s.MACHINE, s.PROGRAM, s.STATUS,
            s.LAST_CALL_ET, s.WAIT_CLASS, s.EVENT,
            ROUND(s.LAST_CALL_ET/60,1) WAIT_MIN,
            q.SQL_TEXT
     FROM V$SESSION s
     LEFT JOIN V$SQL q ON s.SQL_ID=q.SQL_ID AND s.SQL_CHILD_NUMBER=q.CHILD_NUMBER
     ${where}
     ORDER BY s.STATUS, s.LAST_CALL_ET DESC NULLS LAST
     FETCH FIRST 200 ROWS ONLY`,
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

async function pgSessions(client, { onlyActive, status, username }) {
  let sql = `SELECT pid AS SID, 0 AS SERIAL_NUM, usename AS USERNAME, host(client_addr) AS MACHINE,
                    application_name AS PROGRAM, state AS STATUS,
                    COALESCE(EXTRACT(epoch FROM (now() - state_change))::int, 0) AS LAST_CALL_ET,
                    wait_event_type AS WAIT_CLASS, wait_event AS EVENT,
                    ROUND(EXTRACT(epoch FROM (now() - state_change))/60.0, 1) AS WAIT_MIN,
                    LEFT(query, 4000) AS SQL_TEXT
             FROM pg_stat_activity WHERE pid <> pg_backend_pid()`;
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
  const r = await client.query(sql, params);
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
  if (t === 'POSTGRESQL') {
    const client = await connectPostgres(inst);
    try {
      return await pgSessions(client, opts);
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
  if (t === 'POSTGRESQL') {
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
  if (t === 'POSTGRESQL') {
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
  return [];
}

module.exports = {
  getPerformanceBundle,
  getSysinfoBundle,
  getTablespaces,
  getSessions,
  getTopSql,
  getWaits,
};
