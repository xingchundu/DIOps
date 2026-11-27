/**
 * Oracle / 磐维 阶段1扩展指标（统一 engineMetrics[]，供 METRICS_JSON 与告警评估）
 */
const oracledb = require('oracledb');
const exporter = require('./monitorExporterCollect');
// [dxc][2026-10-08][新增] 阶段2深度指标模块 — 原因：争用/TOP SQL/告警日志摘要，与阶段1解耦
const phase2Collect = require('./monitorEngineMetricsPhase2');
const {
  connectOracle,
  connectPostgres,
  normalizeDbType,
} = require('../utils/monitorTargetConn');

function push(out, key, value, unit = '', labels = null) {
  if (value == null || !Number.isFinite(Number(value))) return;
  const row = { key, value: Number(value), unit };
  if (labels && Object.keys(labels).length) row.labels = labels;
  out.push(row);
}

async function collectOracleEngineMetrics(inst) {
  const out = [];
  const conn = await connectOracle(inst);
  try {
    const opts = { outFormat: oracledb.OUT_FORMAT_OBJECT };

    const instRow = await conn.execute(
      `SELECT STATUS, STARTUP_TIME FROM V$INSTANCE`,
      [],
      opts
    );
    const st = instRow.rows?.[0];
    if (st) {
      const open = String(st.STATUS || '').toUpperCase() === 'OPEN' ? 1 : 0;
      push(out, 'oracle_instance_up', open, '');
      if (st.STARTUP_TIME) {
        const hours = (Date.now() - new Date(st.STARTUP_TIME).getTime()) / 3600000;
        push(out, 'oracle_uptime_hours', hours, 'h');
      }
    }

    try {
      const rl = await conn.execute(
        `SELECT RESOURCE_NAME, CURRENT_UTILIZATION, LIMIT_VALUE
         FROM V$RESOURCE_LIMIT
         WHERE RESOURCE_NAME IN ('sessions','processes') AND LIMIT_VALUE > 0`,
        [],
        opts
      );
      for (const row of rl.rows || []) {
        const name = String(row.RESOURCE_NAME || '').toLowerCase();
        const pct = (Number(row.CURRENT_UTILIZATION) / Number(row.LIMIT_VALUE)) * 100;
        if (name === 'sessions') push(out, 'oracle_sessions_used_pct', pct, '%');
        if (name === 'processes') push(out, 'oracle_processes_used_pct', pct, '%');
      }
    } catch { /* ignore */ }

    try {
      const ts = await exporter.getTablespaces(inst.INSTANCE_ID ?? inst.instance_id);
      let maxPct = null;
      for (const row of ts || []) {
        const p = Number(row.USED_PCT ?? row.used_pct);
        const name = String(row.TABLESPACE_NAME ?? row.tablespace_name ?? '').trim().toUpperCase();
        if (Number.isFinite(p)) {
          maxPct = maxPct == null ? p : Math.max(maxPct, p);
          // [v6] 每个表空间单独一条带维度指标，告警规则可只盯某个业务表空间
          if (name) push(out, `tablespace_pct@${name}`, p, '%');
        }
      }
      push(out, 'oracle_tablespace_max_used_pct', maxPct, '%');
    } catch { /* ignore */ }

    try {
      const fra = await conn.execute(
        `SELECT ROUND(SPACE_USED / NULLIF(SPACE_LIMIT,0) * 100, 2) AS PCT FROM V$RECOVERY_FILE_DEST`,
        [],
        opts
      );
      push(out, 'oracle_fra_used_pct', fra.rows?.[0]?.PCT, '%');
    } catch { /* ignore */ }
  } finally {
    await conn.close();
  }
  return out;
}

async function collectPanweiEngineMetrics(inst) {
  const out = [];
  const client = await connectPostgres(inst);
  try {
    const r1 = await client.query(`
      SELECT count(*)::float AS cnt,
             (SELECT setting::int FROM pg_settings WHERE name = 'max_connections') AS max_conn
      FROM pg_stat_activity`);
    const row = r1.rows[0];
    if (row?.max_conn > 0) {
      push(out, 'panwei_conn_used_pct', (Number(row.cnt) / Number(row.max_conn)) * 100, '%');
    }

    const r2 = await client.query(`SELECT pg_postmaster_start_time() AS st`);
    if (r2.rows[0]?.st) {
      const hours = (Date.now() - new Date(r2.rows[0].st).getTime()) / 3600000;
      push(out, 'panwei_uptime_hours', hours, 'h');
      push(out, 'panwei_instance_up', 1, '');
    }

    try {
      let lag = 0;
      try {
        const r3 = await client.query(`
          SELECT COALESCE(MAX(pg_wal_lsn_diff(sent_lsn, replay_lsn)), 0) AS lag
          FROM pg_stat_replication`);
        lag = r3.rows[0]?.lag ?? 0;
      } catch {
        const r3b = await client.query(`
          SELECT COALESCE(MAX(pg_xlog_location_diff(sent_lsn, replay_lsn)), 0) AS lag
          FROM pg_stat_replication`);
        lag = r3b.rows[0]?.lag ?? 0;
      }
      push(out, 'panwei_replication_lag_bytes', lag, 'bytes');
    } catch {
      push(out, 'panwei_replication_lag_bytes', 0, 'bytes');
    }

    try {
      const r4 = await client.query(`
        SELECT ROUND(sum(pg_database_size(datname)) / 1024.0 / 1024 / 1024, 2) AS gb
        FROM pg_database WHERE datallowconn`);
      push(out, 'panwei_database_total_gb', r4.rows[0]?.gb, 'GB');
    } catch { /* ignore */ }
  } finally {
    await client.end();
  }
  return out;
}

/** 从 exporter metrics 数组补充标准 hit ratio key */
function augmentFromExporterMetrics(dbType, exporterMetrics, engineMetrics) {
  const out = [...engineMetrics];
  const findVal = (name) => {
    const r = (exporterMetrics || []).find((m) => m.METRIC_NAME === name);
    return r != null ? Number(r.VALUE) : null;
  };
  const t = normalizeDbType({ DB_TYPE: dbType });
  if (t === 'ORACLE') {
    push(out, 'oracle_buffer_cache_hit_pct', findVal('Buffer Cache Hit Ratio'), '%');
  }
  if (t === 'PANWEI') {
    push(out, 'panwei_buffer_hit_pct', findVal('pg_buffer_cache_hit_ratio'), '%');
  }
  return out;
}

async function collectEngineMetrics(inst, dbType, exporterMetrics) {
  const t = normalizeDbType(inst) || dbType;
  let base = [];
  if (t === 'ORACLE') {
    try {
      base = await collectOracleEngineMetrics(inst);
    } catch (e) {
      push(base, 'oracle_instance_up', 0, '');
      base.push({ key: '_engine_error', value: 0, unit: '', error: (e.message || String(e)).slice(0, 200) });
    }
  } else if (t === 'PANWEI') {
    try {
      base = await collectPanweiEngineMetrics(inst);
    } catch (e) {
      push(base, 'panwei_instance_up', 0, '');
      base.push({ key: '_engine_error', value: 0, unit: '', error: (e.message || String(e)).slice(0, 200) });
    }
  }

  // [dxc][2026-10-08][新增] 合并阶段2指标与摘要 — 原因：写入 METRICS_JSON.enginePhase2Summary
  let phase2Summary = null;
  if (t === 'ORACLE' || t === 'PANWEI') {
    const p2 = await phase2Collect.collectPhase2Metrics(inst, t);
    if (p2.metrics?.length) base = base.concat(p2.metrics);
    phase2Summary = p2.summary || null;
  }

  const engineMetrics = augmentFromExporterMetrics(t, exporterMetrics, base);
  return { engineMetrics, phase2Summary };
}

module.exports = {
  collectEngineMetrics,
  augmentFromExporterMetrics,
};
