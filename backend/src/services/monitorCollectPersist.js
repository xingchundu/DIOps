/**
 * 真实连通被管库、采集 Exporter 风格指标并写入平台库（MONITOR_METRIC_SAMPLE + 更新 CMDB_INSTANCE）。
 */
const db = require('../config/db');
const exporter = require('./monitorExporterCollect');
const { fetchCmdbInstance, normalizeDbType } = require('../utils/monitorTargetConn');

function metricVal(metrics, name) {
  const r = (metrics || []).find((m) => m.METRIC_NAME === name);
  if (r == null || r.VALUE === undefined || r.VALUE === null) return null;
  const n = Number(r.VALUE);
  return Number.isFinite(n) ? n : null;
}

function extractTrendNumbers(engine, metrics) {
  const e = String(engine || '').toUpperCase();
  if (e === 'ORACLE' || e === 'DAMENG') {
    return {
      cpu: metricVal(metrics, 'Host CPU Usage Per Sec') ?? metricVal(metrics, 'CPU Usage Per Sec'),
      conn: metricVal(metrics, 'Current Logons Count') ?? metricVal(metrics, 'Active Sessions'),
    };
  }
  if (e === 'MYSQL') {
    return {
      cpu: metricVal(metrics, 'mysql_global_status_threads_running'),
      conn: metricVal(metrics, 'mysql_global_status_threads_connected'),
    };
  }
  if (e === 'POSTGRESQL') {
    return {
      cpu: null,
      conn: metricVal(metrics, 'pg_stat_database_numbackends'),
    };
  }
  return { cpu: null, conn: null };
}

function computeHealthScore(engine, metrics) {
  const e = String(engine || '').toUpperCase();
  let s = 100;
  if (e === 'ORACLE' || e === 'DAMENG') {
    const hit = metricVal(metrics, 'Buffer Cache Hit Ratio');
    if (hit != null && hit < 90) s -= 25;
    else if (hit != null && hit < 95) s -= 10;
    const active = metricVal(metrics, 'Active Sessions');
    if (active != null && active > 200) s -= 15;
  } else if (e === 'MYSQL') {
    const hit = metricVal(metrics, 'mysql_innodb_buffer_pool_hit_ratio');
    if (hit != null && hit < 90) s -= 25;
    else if (hit != null && hit < 95) s -= 10;
    const run = metricVal(metrics, 'mysql_global_status_threads_running');
    if (run != null && run > 150) s -= 10;
  } else if (e === 'POSTGRESQL') {
    const hit = metricVal(metrics, 'pg_buffer_cache_hit_ratio');
    if (hit != null && hit < 90) s -= 25;
    else if (hit != null && hit < 95) s -= 10;
  }
  return Math.max(25, Math.min(100, Math.round(s)));
}

async function safeInsertSample(row) {
  try {
    await db.execute(
      `INSERT INTO MONITOR_METRIC_SAMPLE (INSTANCE_ID, DB_TYPE, REACHABLE, HEALTH_SCORE, METRIC_CPU, METRIC_CONN, METRICS_JSON, ERR_MSG)
       VALUES (:1, :2, :3, :4, :5, :6, :7, :8)`,
      [
        row.instanceId,
        row.dbType,
        row.reachable,
        row.healthScore,
        row.metricCpu,
        row.metricConn,
        row.metricsJson,
        row.errMsg,
      ]
    );
  } catch (e) {
    const msg = e.message || String(e);
    if (/ORA-00942|942/.test(msg)) {
      console.warn('[monitor-collect] 表 MONITOR_METRIC_SAMPLE 不存在，请执行 sql/init.sql 中 DDL');
      return;
    }
    throw e;
  }
}

async function pruneOldSamples() {
  try {
    await db.execute(
      `DELETE FROM MONITOR_METRIC_SAMPLE WHERE COLLECTED_AT < SYSTIMESTAMP - INTERVAL '8' DAY`,
      []
    );
  } catch (e) {
    if (!/ORA-00942|942/.test(e.message || '')) console.warn('[monitor-collect] prune:', e.message);
  }
}

/**
 * 采集单实例并更新 CMDB（无论入库是否成功都会更新 LAST_CHECK）
 */
async function collectInstance(instanceId) {
  let inst;
  try {
    inst = await fetchCmdbInstance(instanceId);
  } catch (e) {
    return { ok: false, err: e.message || String(e) };
  }
  const dbType = normalizeDbType(inst);
  if (!['ORACLE', 'MYSQL', 'POSTGRESQL', 'DAMENG', 'GOLDENDB'].includes(dbType)) {
    return { ok: false, err: `监控采集不支持类型: ${dbType}` };
  }

  try {
    const bundle = await exporter.getPerformanceBundle(instanceId);
    const metricEngine = dbType === 'GOLDENDB' ? 'MYSQL' : dbType;
    const { cpu, conn } = extractTrendNumbers(metricEngine, bundle.metrics);
    const health = computeHealthScore(metricEngine, bundle.metrics);
    const jsonStr = JSON.stringify({
      exporter: bundle.exporter,
      metrics: bundle.metrics,
      sessions: bundle.sessions,
    });
    await safeInsertSample({
      instanceId,
      dbType,
      reachable: 1,
      healthScore: health,
      metricCpu: cpu,
      metricConn: conn,
      metricsJson: jsonStr,
      errMsg: null,
    });
    await db.execute(
      `UPDATE CMDB_INSTANCE SET LAST_CHECK = SYSTIMESTAMP, STATUS = 'RUNNING', HEALTH_SCORE = :1, UPDATED_AT = SYSTIMESTAMP WHERE INSTANCE_ID = :2`,
      [health, instanceId]
    );
    return { ok: true, healthScore: health, instanceId };
  } catch (e) {
    const errMsg = (e.message || String(e)).slice(0, 500);
    await safeInsertSample({
      instanceId,
      dbType,
      reachable: 0,
      healthScore: 0,
      metricCpu: null,
      metricConn: null,
      metricsJson: null,
      errMsg,
    });
    await db.execute(
      `UPDATE CMDB_INSTANCE SET LAST_CHECK = SYSTIMESTAMP, STATUS = 'ERROR', HEALTH_SCORE = :1, UPDATED_AT = SYSTIMESTAMP WHERE INSTANCE_ID = :2`,
      [0, instanceId]
    );
    return { ok: false, err: errMsg, instanceId };
  }
}

async function collectAllInstances() {
  const r = await db.execute(
    `SELECT INSTANCE_ID FROM CMDB_INSTANCE
     WHERE UPPER(DB_TYPE) IN ('ORACLE','MYSQL','POSTGRESQL','DAMENG','GOLDENDB')
     AND NVL(STATUS,'UNKNOWN') <> 'STOPPED'`,
    []
  );
  const rows = r.rows || [];
  for (const row of rows) {
    try {
      await collectInstance(row.INSTANCE_ID);
    } catch (e) {
      console.error('[monitor-collect] instance', row.INSTANCE_ID, e.message || e);
    }
  }
  await pruneOldSamples();
}

const RANGE_HOURS = { '1h': 1, '6h': 6, '1d': 24, '7d': 168 };

async function getTrendSeries(instanceId, rangeKey) {
  const hours = RANGE_HOURS[rangeKey] || 1;
  try {
    const r = await db.execute(
      `SELECT COLLECTED_AT, METRIC_CPU, METRIC_CONN, REACHABLE, HEALTH_SCORE
       FROM MONITOR_METRIC_SAMPLE
       WHERE INSTANCE_ID = :1
         AND COLLECTED_AT >= SYSTIMESTAMP - NUMTODSINTERVAL(:2, 'HOUR')
       ORDER BY COLLECTED_AT ASC`,
      [instanceId, hours]
    );
    return (r.rows || []).map((row) => ({
      t: row.COLLECTED_AT ? new Date(row.COLLECTED_AT).toISOString() : null,
      cpu: row.METRIC_CPU != null ? Number(row.METRIC_CPU) : null,
      conn: row.METRIC_CONN != null ? Number(row.METRIC_CONN) : null,
      reachable: row.REACHABLE,
      healthScore: row.HEALTH_SCORE,
    }));
  } catch (e) {
    if (/ORA-00942|942/.test(e.message || '')) return [];
    throw e;
  }
}

module.exports = {
  collectInstance,
  collectAllInstances,
  getTrendSeries,
};
