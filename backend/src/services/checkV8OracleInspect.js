/**
 * Oracle 深度巡检（对齐外部 CheckV8.py 的检查项，无许可证/无加密/无邮件）。
 * 在目标库执行；部分 SQL 需 DBA 视图权限，失败时记入 skipped。
 */
const oracledb = require('oracledb');

async function safeExec(conn, sql, binds = []) {
  try {
    const r = await conn.execute(sql, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT });
    return { ok: true, rows: r.rows || [] };
  } catch (e) {
    return { ok: false, rows: [], error: e.message };
  }
}

function firstCell(rows, def = null) {
  if (!rows || !rows.length) return def;
  const row = rows[0];
  const k = Object.keys(row)[0];
  return row[k] != null ? row[k] : def;
}

/**
 * @returns {Promise<object>}
 */
async function runCheckV8Inspection(conn) {
  const skipped = [];
  const note = (name, err) => skipped.push({ section: name, error: err });

  // —— 基础信息（CheckV8 get_basic_info）
  const basic = {};
  const basicSqls = [
    ['db_name', 'SELECT name AS v FROM v$database'],
    ['db_version', 'SELECT version AS v FROM v$instance'],
    ['instance_name', 'SELECT instance_name AS v FROM v$instance'],
    ['host_name', 'SELECT host_name AS v FROM v$instance'],
    ['os_version', 'SELECT platform_name AS v FROM v$database'],
    ['startup_time', "SELECT TO_CHAR(startup_time, 'YYYY-MM-DD HH24:MI:SS') AS v FROM v$instance"],
    ['db_unique_name', "SELECT value AS v FROM v$parameter WHERE name = 'db_unique_name'"],
    ['database_role', 'SELECT database_role AS v FROM v$database'],
  ];
  for (const [key, sql] of basicSqls) {
    const r = await safeExec(conn, sql);
    if (r.ok) basic[key] = firstCell(r.rows, 'N/A');
    else {
      basic[key] = 'N/A';
      note(`basic.${key}`, r.error);
    }
  }

  // —— 运行状态
  const dbStatus = {};
  const st1 = await safeExec(conn, 'SELECT status AS v FROM v$instance');
  dbStatus.instance_status = st1.ok ? firstCell(st1.rows, 'N/A') : 'N/A';
  if (!st1.ok) note('db_status.instance', st1.error);

  const st2 = await safeExec(conn, 'SELECT log_mode AS v FROM v$database');
  dbStatus.log_mode = st2.ok ? firstCell(st2.rows, 'N/A') : 'N/A';
  if (!st2.ok) note('db_status.log_mode', st2.error);

  const st3 = await safeExec(conn, `SELECT COUNT(*) AS total_sessions,
    COUNT(CASE WHEN status='ACTIVE' THEN 1 END) AS active_sessions,
    COUNT(CASE WHEN status='INACTIVE' THEN 1 END) AS inactive_sessions
    FROM v$session`);
  if (st3.ok && st3.rows[0]) {
    dbStatus.total_sessions = st3.rows[0].TOTAL_SESSIONS;
    dbStatus.active_sessions = st3.rows[0].ACTIVE_SESSIONS;
    dbStatus.inactive_sessions = st3.rows[0].INACTIVE_SESSIONS;
  } else {
    note('db_status.sessions', st3.error);
  }

  const st4 = await safeExec(conn, "SELECT value AS v FROM v$parameter WHERE name='sessions'");
  dbStatus.max_sessions = st4.ok ? firstCell(st4.rows, '0') : 'N/A';
  if (!st4.ok) note('db_status.max_sessions', st4.error);

  const st5 = await safeExec(conn, "SELECT COUNT(*) AS c FROM v$datafile WHERE status NOT IN ('SYSTEM','ONLINE')");
  dbStatus.offline_datafiles = st5.ok ? Number(firstCell(st5.rows, 0)) : 0;
  if (!st5.ok) note('db_status.datafiles', st5.error);

  const st6 = await safeExec(conn, "SELECT COUNT(*) AS c FROM v$tempfile WHERE status != 'ONLINE'");
  dbStatus.offline_tempfiles = st6.ok ? Number(firstCell(st6.rows, 0)) : 0;
  if (!st6.ok) note('db_status.tempfiles', st6.error);

  // —— 关键参数（CheckV8 important_params 子集）
  const paramNames = ['processes', 'sessions', 'sga_target', 'pga_aggregate_target', 'open_cursors'];
  const parameters = [];
  for (const name of paramNames) {
    const pr = await safeExec(conn, `SELECT value FROM v$parameter WHERE name = :1`, [name]);
    if (pr.ok) {
      parameters.push({ name, value: pr.rows[0]?.VALUE ?? 'N/A' });
    } else {
      parameters.push({ name, value: 'N/A', _error: pr.error });
      note(`parameter.${name}`, pr.error);
    }
  }

  // —— 性能指标（简化）
  const performance = {};
  const buf = await safeExec(conn, `SELECT ROUND((1 - (phy.value / NULLIF(ses.value, 0))) * 100, 2) AS hit_ratio
    FROM v$sysstat ses, v$sysstat phy
    WHERE ses.name = 'session logical reads' AND phy.name = 'physical reads' AND ses.value > 0`);
  if (buf.ok && buf.rows[0]?.HIT_RATIO != null) {
    performance.buffer_cache_hit = buf.rows[0].HIT_RATIO;
    performance.buffer_cache_status = buf.rows[0].HIT_RATIO >= 95 ? 'good' : 'warning';
  } else {
    performance.buffer_cache_hit = null;
    performance.buffer_cache_status = 'unknown';
    if (!buf.ok) note('performance.buffer_cache', buf.error);
  }

  const lib = await safeExec(conn, `SELECT ROUND((SUM(pinhits) / NULLIF(SUM(pins), 0)) * 100, 2) AS r
    FROM v$librarycache WHERE pins > 0`);
  if (lib.ok && lib.rows[0]?.R != null) {
    performance.library_cache_hit = lib.rows[0].R;
    performance.library_cache_status = lib.rows[0].R >= 95 ? 'good' : 'warning';
  } else {
    performance.library_cache_hit = null;
    performance.library_cache_status = 'unknown';
    if (!lib.ok) note('performance.library_cache', lib.error);
  }

  const inv = await safeExec(conn, "SELECT COUNT(*) AS c FROM dba_objects WHERE status != 'VALID'");
  if (inv.ok) {
    performance.invalid_objects = Number(firstCell(inv.rows, 0));
    performance.invalid_objects_status = performance.invalid_objects > 0 ? 'warning' : 'good';
  } else {
    performance.invalid_objects = null;
    performance.invalid_objects_status = 'unknown';
    note('performance.invalid_objects', inv.error);
  }

  // —— 表空间（dba_tablespace_usage_metrics，10g+）
  let tablespaces = [];
  const ts = await safeExec(conn, `SELECT tablespace_name, used_percent AS used_pct, max_bytes / 1024 / 1024 / 1024 AS max_gb
    FROM dba_tablespace_usage_metrics ORDER BY used_percent DESC FETCH FIRST 40 ROWS ONLY`);
  if (ts.ok) {
    tablespaces = ts.rows.map((row) => {
      const pct = Number(row.USED_PCT) || 0;
      let status = 'good';
      if (pct >= 90) status = 'critical';
      else if (pct >= 85) status = 'warning';
      return {
        name: row.TABLESPACE_NAME,
        used_pct: pct,
        max_gb: row.MAX_GB,
        status,
      };
    });
  } else {
    note('tablespaces', ts.error);
  }

  // —— 大对象 >1GB
  let large_objects = [];
  const lo = await safeExec(conn, `SELECT owner, segment_name, segment_type,
    ROUND(bytes / (1024*1024*1024), 2) AS size_gb, tablespace_name
    FROM (SELECT * FROM dba_segments WHERE bytes > 1073741824 ORDER BY bytes DESC) WHERE ROWNUM <= 15`);
  if (lo.ok) {
    large_objects = lo.rows.map((row) => ({
      owner: row.OWNER,
      name: row.SEGMENT_NAME,
      type: row.SEGMENT_TYPE,
      size_gb: row.SIZE_GB,
      tablespace: row.TABLESPACE_NAME,
    }));
  } else {
    note('large_objects', lo.error);
  }

  // —— 备份（RMAN 近 7 天）
  const backup = {};
  const bk = await safeExec(conn, `SELECT TO_CHAR(end_time, 'YYYY-MM-DD HH24:MI:SS') AS last_backup,
    status AS backup_status, input_type AS backup_type
    FROM v$rman_backup_job_details WHERE end_time > SYSDATE - 7
    ORDER BY end_time DESC FETCH FIRST 1 ROW ONLY`);
  if (bk.ok && bk.rows[0]) {
    backup.last_backup = bk.rows[0].LAST_BACKUP || 'N/A';
    backup.backup_status = bk.rows[0].BACKUP_STATUS || 'N/A';
    backup.backup_type = bk.rows[0].BACKUP_TYPE || 'N/A';
    backup.backup_health = bk.rows[0].BACKUP_STATUS === 'COMPLETED' ? 'good' : 'warning';
  } else {
    backup.last_backup = 'N/A';
    backup.backup_status = 'N/A';
    backup.backup_type = 'N/A';
    backup.backup_health = 'unknown';
    if (!bk.ok) note('backup.rman', bk.error);
  }

  const ar = await safeExec(conn, 'SELECT log_mode AS v FROM v$database');
  backup.archive_mode = ar.ok ? firstCell(ar.rows, 'N/A') : 'N/A';
  backup.archive_status = ar.ok && String(backup.archive_mode || '').includes('ARCHIVELOG') ? 'good' : 'warning';

  // —— 告警日志 24h（需诊断权限）
  let alerts = [];
  const al = await safeExec(conn, `SELECT message_text, TO_CHAR(originating_timestamp, 'YYYY-MM-DD HH24:MI:SS') AS alert_time
    FROM v$diag_alert_ext
    WHERE (message_text LIKE '%ORA-%' OR UPPER(message_text) LIKE '%ERROR%')
    AND originating_timestamp > SYSDATE - 1
    ORDER BY originating_timestamp DESC FETCH FIRST 20 ROWS ONLY`);
  if (al.ok) {
    alerts = al.rows.map((row) => ({
      message: String(row.MESSAGE_TEXT || '').slice(0, 500),
      time: row.ALERT_TIME,
    }));
  } else {
    note('alerts.diag', al.error);
  }

  // —— 安全（默认账户未锁定等）
  const security = {};
  const su = await safeExec(conn, `SELECT username, account_status FROM dba_users
    WHERE username IN ('SYS','SYSTEM','SCOTT','HR','OE','SH') AND account_status != 'LOCKED'`);
  if (su.ok) {
    security.unlocked_default_users = su.rows;
  } else {
    security.unlocked_default_users = [];
    note('security.default_users', su.error);
  }

  const au = await safeExec(conn, "SELECT value AS v FROM v$parameter WHERE name='audit_trail'");
  security.audit_trail = au.ok ? firstCell(au.rows, 'N/A') : 'N/A';
  if (!au.ok) note('security.audit', au.error);

  // —— 综合评分
  let score = 100;
  const issues = [];
  for (const tsr of tablespaces) {
    if (tsr.status === 'critical') {
      score -= 15;
      issues.push(`表空间 ${tsr.name} 使用率 ${tsr.used_pct}%`);
    } else if (tsr.status === 'warning') {
      score -= 5;
      issues.push(`表空间 ${tsr.name} 偏高 ${tsr.used_pct}%`);
    }
  }
  if (dbStatus.instance_status && dbStatus.instance_status !== 'OPEN') {
    score -= 30;
    issues.push(`实例状态异常: ${dbStatus.instance_status}`);
  }
  if ((performance.invalid_objects ?? 0) > 0) {
    score -= 5;
    issues.push(`无效对象 ${performance.invalid_objects} 个`);
  }
  if (backup.backup_health === 'warning' && backup.backup_status !== 'N/A') {
    score -= 10;
    issues.push('近期 RMAN 备份状态需关注');
  }
  if (security.unlocked_default_users?.length) {
    score -= 10;
    issues.push('存在未锁定示例/管理账户');
  }
  if (alerts.length > 5) {
    score -= 5;
    issues.push('24h 内告警条目较多');
  }
  score = Math.max(0, Math.min(100, Math.round(score)));

  let overallStatus = 'PASS';
  if (score < 60) overallStatus = 'FAIL';
  else if (score < 85) overallStatus = 'WARN';

  return {
    engine: 'checkv8-node',
    generatedAt: new Date().toISOString(),
    basic_info: basic,
    db_status: dbStatus,
    parameters,
    performance,
    tablespaces,
    large_objects,
    backup,
    alerts,
    security,
    skipped,
    overallScore: score,
    overallStatus,
    issues,
  };
}

module.exports = { runCheckV8Inspection };
