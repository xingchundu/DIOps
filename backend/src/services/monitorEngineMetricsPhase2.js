/**
 * [dxc][2026-10-08][新增] Oracle/磐维 监控阶段2：争用、告警日志摘要、TOP SQL/WAL/复制等（仅监控采集用）
 * 原因：对齐 Excel 阶段2项，不改动巡检/CMDB 等其他模块
 */
const oracledb = require('oracledb');
const {
  connectOracle,
  connectPostgres,
  normalizeDbType,
} = require('../utils/monitorTargetConn');

function push(out, key, value, unit = '') {
  if (value == null || !Number.isFinite(Number(value))) return;
  out.push({ key, value: Number(value), unit });
}

async function collectOraclePhase2(inst) {
  const metrics = [];
  const summary = { engine: 'ORACLE', topWaits: [], alertHits: [], topSql: [] };
  const conn = await connectOracle(inst);
  const opts = { outFormat: oracledb.OUT_FORMAT_OBJECT, maxRows: 50 };
  try {
    // [dxc][2026-10-08][新增] 阻塞链最大等待秒数 / >60s 会话数 — 阶段2 Excel 锁等待
    try {
      const blk = await conn.execute(
        `SELECT MAX(SECONDS_IN_WAIT) AS MAX_SEC,
                SUM(CASE WHEN SECONDS_IN_WAIT > 60 THEN 1 ELSE 0 END) AS CNT_60
         FROM V$SESSION
         WHERE BLOCKING_SESSION IS NOT NULL`,
        [],
        opts
      );
      const b = blk.rows?.[0];
      push(metrics, 'oracle_blocking_session_max_sec', b?.MAX_SEC, 's');
      push(metrics, 'oracle_blocking_session_over_60s', b?.CNT_60, '');
    } catch { /* ignore */ }

    // [dxc][2026-10-08][新增] 最近24h 告警日志 ORA-00060 / ORA-4031 / checkpoint not complete 计数
    try {
      const al = await conn.execute(
        `SELECT
           SUM(CASE WHEN MESSAGE_TEXT LIKE '%ORA-00060%' THEN 1 ELSE 0 END) AS ORA_60,
           SUM(CASE WHEN MESSAGE_TEXT LIKE '%ORA-04031%' THEN 1 ELSE 0 END) AS ORA_4031,
           SUM(CASE WHEN LOWER(MESSAGE_TEXT) LIKE '%checkpoint not complete%' THEN 1 ELSE 0 END) AS CKPT
         FROM V$DIAG_ALERT_EXT
         WHERE ORIGINATING_TIMESTAMP >= SYSTIMESTAMP - 1`,
        [],
        opts
      );
      const a = al.rows?.[0];
      push(metrics, 'oracle_alert_ora_00060_24h', a?.ORA_60, '');
      push(metrics, 'oracle_alert_ora_4031_24h', a?.ORA_4031, '');
      push(metrics, 'oracle_alert_checkpoint_incomplete_24h', a?.CKPT, '');
      if (Number(a?.ORA_60) > 0) summary.alertHits.push('ORA-00060');
      if (Number(a?.ORA_4031) > 0) summary.alertHits.push('ORA-04031');
    } catch { /* ignore */ }

    // [dxc][2026-10-08][新增] log file sync 等待（ms）— 阶段2 提交延迟
    try {
      const lfs = await conn.execute(
        `SELECT ROUND(VALUE, 2) AS VAL
         FROM V$SYSMETRIC
         WHERE GROUP_ID = 2 AND METRIC_NAME = 'Log File Sync Time'`,
        [],
        opts
      );
      push(metrics, 'oracle_log_file_sync_ms', lfs.rows?.[0]?.VAL, 'ms');
    } catch { /* ignore */ }

    // [dxc][2026-10-08][新增] Top 等待事件（非 Idle，按 time_waited 前5）
    try {
      const w = await conn.execute(
        `SELECT EVENT, WAIT_CLASS, TIME_WAITED_MICRO
         FROM V$SYSTEM_EVENT
         WHERE WAIT_CLASS <> 'Idle' AND TIME_WAITED_MICRO > 0
         ORDER BY TIME_WAITED_MICRO DESC
         FETCH FIRST 5 ROWS ONLY`,
        [],
        opts
      );
      summary.topWaits = (w.rows || []).map((r) => ({
        event: r.EVENT,
        waitClass: r.WAIT_CLASS,
        timeWaitedMicro: Number(r.TIME_WAITED_MICRO),
      }));
      if (summary.topWaits[0]) {
        push(metrics, 'oracle_top_wait_time_micro', summary.topWaits[0].timeWaitedMicro, 'us');
      }
    } catch { /* ignore */ }

    // [dxc][2026-10-08][新增] Top SQL 摘要（按 elapsed_time，V$SQLSTATS）
    try {
      const sql = await conn.execute(
        `SELECT SQL_ID, ROUND(ELAPSED_TIME/1e6, 2) AS ELAPSED_SEC, EXECUTIONS
         FROM V$SQLSTATS
         WHERE EXECUTIONS > 0
         ORDER BY ELAPSED_TIME DESC
         FETCH FIRST 5 ROWS ONLY`,
        [],
        opts
      );
      summary.topSql = (sql.rows || []).map((r) => ({
        sqlId: r.SQL_ID,
        elapsedSec: Number(r.ELAPSED_SEC),
        executions: Number(r.EXECUTIONS),
      }));
    } catch { /* ignore */ }

    // [dxc][2026-10-08][新增] DG/库角色（主库=1 便于规则判断）
    try {
      const dg = await conn.execute(
        `SELECT DATABASE_ROLE, LOG_MODE FROM V$DATABASE`,
        [],
        opts
      );
      const role = String(dg.rows?.[0]?.DATABASE_ROLE || '').toUpperCase();
      summary.databaseRole = role;
      summary.logMode = dg.rows?.[0]?.LOG_MODE;
      push(metrics, 'oracle_is_primary_role', role === 'PRIMARY' ? 1 : 0, '');
      push(metrics, 'oracle_is_archivelog', String(dg.rows?.[0]?.LOG_MODE || '').includes('ARCHIVE') ? 1 : 0, '');
    } catch { /* ignore */ }

    // [dxc][2026-10-08][新增] 最近成功 RMAN 全备距今天数（无则 -1）
    try {
      const rman = await conn.execute(
        `SELECT MIN(SYSDATE - END_TIME) * 24 AS HOURS_AGO
         FROM V$RMAN_BACKUP_JOB_DETAILS
         WHERE STATUS = 'COMPLETED' AND INPUT_TYPE IN ('DB FULL','DATABASE FULL')`,
        [],
        opts
      );
      const hrs = rman.rows?.[0]?.HOURS_AGO;
      if (hrs != null && Number.isFinite(Number(hrs))) {
        push(metrics, 'oracle_rman_full_backup_hours_ago', Number(hrs), 'h');
      }
    } catch { /* ignore */ }
  } finally {
    await conn.close();
  }
  return { metrics, summary };
}

async function collectPanweiPhase2(inst) {
  const metrics = [];
  const summary = { engine: 'PANWEI', topSql: [], replication: [] };
  const client = await connectPostgres(inst);
  try {
    // [dxc][2026-10-08][新增] idle in transaction >5min 连接数
    try {
      const idle = await client.query(`
        SELECT count(*)::int AS cnt
        FROM pg_stat_activity
        WHERE state = 'idle in transaction'
          AND now() - state_change > interval '5 minutes'`);
      push(metrics, 'panwei_idle_in_txn_over_5min', idle.rows[0]?.cnt, '');
    } catch { /* ignore */ }

    // [dxc][2026-10-08][新增] 未授予锁数量
    try {
      const lk = await client.query(`SELECT count(*)::int AS cnt FROM pg_locks WHERE NOT granted`);
      push(metrics, 'panwei_lock_wait_count', lk.rows[0]?.cnt, '');
    } catch { /* ignore */ }

    // [dxc][2026-10-08][新增] 死锁累计（库级）
    try {
      const dl = await client.query(`
        SELECT COALESCE(sum(deadlocks), 0)::bigint AS cnt FROM pg_stat_database`);
      push(metrics, 'panwei_deadlocks_total', dl.rows[0]?.cnt, '');
    } catch { /* ignore */ }

    // [dxc][2026-10-08][新增] 复制状态非 streaming 的条目数
    try {
      const rep = await client.query(`
        SELECT client_addr::text AS addr, state, sync_state
        FROM pg_stat_replication`);
      summary.replication = rep.rows || [];
      const bad = (rep.rows || []).filter((r) => String(r.state || '').toLowerCase() !== 'streaming').length;
      push(metrics, 'panwei_replication_not_streaming_count', bad, '');
    } catch {
      push(metrics, 'panwei_replication_not_streaming_count', 0, '');
    }

    // [dxc][2026-10-08][新增] WAL 目录占用（需 superuser，失败则跳过）
    try {
      const wal = await client.query(`
        SELECT count(*)::int AS wal_files FROM pg_ls_waldir()`);
      push(metrics, 'panwei_wal_file_count', wal.rows[0]?.wal_files, '');
    } catch { /* ignore */ }

    // [dxc][2026-10-08][新增] dbe_perf.statement TOP SQL（磐维/openGauss）
    try {
      const top = await client.query(`
        SELECT queryid, calls, mean_time, total_elapsed_time
        FROM dbe_perf.statement
        ORDER BY total_elapsed_time DESC NULLS LAST
        LIMIT 5`);
      summary.topSql = (top.rows || []).map((r) => ({
        queryId: r.queryid,
        calls: r.calls,
        meanTimeMs: r.mean_time,
        totalElapsed: r.total_elapsed_time,
      }));
      if (summary.topSql[0]?.meanTimeMs != null) {
        push(metrics, 'panwei_top_sql_mean_ms', Number(summary.topSql[0].meanTimeMs), 'ms');
      }
    } catch {
      try {
        const pgTop = await client.query(`
          SELECT queryid, calls, mean_exec_time AS mean_time, total_exec_time AS total_elapsed_time
          FROM pg_stat_statements
          ORDER BY total_exec_time DESC NULLS LAST
          LIMIT 5`);
        summary.topSql = (pgTop.rows || []).map((r) => ({
          queryId: r.queryid,
          calls: r.calls,
          meanTimeMs: r.mean_time,
          totalElapsed: r.total_elapsed_time,
        }));
        if (summary.topSql[0]?.meanTimeMs != null) {
          push(metrics, 'panwei_top_sql_mean_ms', Number(summary.topSql[0].meanTimeMs), 'ms');
        }
      } catch { /* ignore */ }
    }

    // [dxc][2026-10-08][新增] 表膨胀粗略指标：dead tuples 比例高表数量
    try {
      const bloat = await client.query(`
        SELECT count(*)::int AS cnt
        FROM pg_stat_user_tables
        WHERE n_live_tup > 0 AND n_dead_tup > n_live_tup * 0.2`);
      push(metrics, 'panwei_tables_high_dead_tup', bloat.rows[0]?.cnt, '');
    } catch { /* ignore */ }
  } finally {
    await client.end();
  }
  return { metrics, summary };
}

async function collectPhase2Metrics(inst, dbType) {
  const t = normalizeDbType(inst) || dbType;
  if (t === 'ORACLE') {
    try {
      return await collectOraclePhase2(inst);
    } catch (e) {
      return {
        metrics: [{ key: '_phase2_error', value: 0, unit: '', error: (e.message || String(e)).slice(0, 200) }],
        summary: { engine: 'ORACLE', error: (e.message || String(e)).slice(0, 200) },
      };
    }
  }
  if (t === 'PANWEI') {
    try {
      return await collectPanweiPhase2(inst);
    } catch (e) {
      return {
        metrics: [{ key: '_phase2_error', value: 0, unit: '', error: (e.message || String(e)).slice(0, 200) }],
        summary: { engine: 'PANWEI', error: (e.message || String(e)).slice(0, 200) },
      };
    }
  }
  return { metrics: [], summary: null };
}

module.exports = { collectPhase2Metrics };
