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

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, Math.round(v))); }

/** 评分单维度：根据指标值和阈值映射到 0-100 */
function scoreByThresholds(val, thresholds) {
  // thresholds: [{ below: number, score: number }, ...] 从严格到宽松排序
  if (val == null) return 50; // 无数据给中间分
  for (const t of thresholds) {
    if (val < t.below) return t.score;
  }
  return 100;
}

/** 性能维度评分 */
function scorePerformance(engine, metrics) {
  const e = String(engine || '').toUpperCase();
  let hitName, hit;
  if (e === 'ORACLE' || e === 'DAMENG') hitName = 'Buffer Cache Hit Ratio';
  else if (e === 'MYSQL') hitName = 'mysql_innodb_buffer_pool_hit_ratio';
  else if (e === 'POSTGRESQL') hitName = 'pg_buffer_cache_hit_ratio';
  else return { score: 50, detail: '未知引擎' };

  hit = hitName ? metricVal(metrics, hitName) : null;
  const score = scoreByThresholds(hit, [
    { below: 80, score: 10 },
    { below: 90, score: 40 },
    { below: 95, score: 70 },
  ]);
  const detail = hit != null ? `缓存命中率 ${hit.toFixed(1)}%` : '缓存命中率无数据';
  return { score, detail };
}

/** 负载维度评分 */
function scoreLoad(engine, metrics) {
  const e = String(engine || '').toUpperCase();
  let val, maxThresh, label;
  if (e === 'ORACLE' || e === 'DAMENG') {
    val = metricVal(metrics, 'Active Sessions');
    maxThresh = 200; label = '活跃会话';
  } else if (e === 'MYSQL') {
    val = metricVal(metrics, 'mysql_global_status_threads_running');
    maxThresh = 150; label = '运行线程';
  } else if (e === 'POSTGRESQL') {
    val = metricVal(metrics, 'pg_stat_database_numbackends');
    maxThresh = 100; label = '后端连接';
  } else {
    return { score: 50, detail: '未知引擎' };
  }

  let score;
  if (val == null) score = 50;
  else if (val <= 0) score = 100;
  else score = clamp(100 - (val / maxThresh) * 100, 0, 100);

  const detail = val != null ? `${label} ${Math.round(val)}` : `${label} 无数据`;
  return { score, detail };
}

/** 资源维度评分 */
function scoreResource(engine, metrics) {
  const e = String(engine || '').toUpperCase();
  if (e === 'ORACLE' || e === 'DAMENG') {
    const pool = metricVal(metrics, 'Shared Pool Free %');
    const score = scoreByThresholds(pool, [
      { below: 10, score: 10 },
      { below: 20, score: 40 },
      { below: 30, score: 70 },
    ]);
    const detail = pool != null ? `Shared Pool 空闲 ${pool.toFixed(1)}%` : 'Shared Pool 无数据';
    return { score, detail };
  }
  if (e === 'MYSQL') {
    const slow = metricVal(metrics, 'mysql_global_status_slow_queries');
    let score;
    if (slow == null) score = 50;
    else if (slow === 0) score = 100;
    else if (slow < 10) score = 80;
    else if (slow < 100) score = 50;
    else score = 20;
    return { score, detail: `慢查询 ${slow ?? '无数据'}` };
  }
  if (e === 'POSTGRESQL') {
    const rollback = metricVal(metrics, 'pg_stat_database_xact_rollback');
    const commit = metricVal(metrics, 'pg_stat_database_xact_commit');
    let score;
    if (rollback == null || commit == null) score = 50;
    else if (commit === 0) score = rollback > 0 ? 60 : 100;
    else {
      const ratio = rollback / (commit + rollback);
      score = clamp(100 - ratio * 500, 0, 100);
    }
    return { score, detail: `回滚事务 ${rollback ?? '无数据'}` };
  }
  return { score: 50, detail: '未知引擎' };
}

/**
 * 多维度健康评分：连通性(20%) + 性能(30%) + 负载(25%) + 资源(25%)
 * @returns {{ score: number, dimensions: object }}
 */
function computeHealthScore(engine, metrics, reachable) {
  const connScore = reachable === 0 ? 0 : 100;
  const perf = scorePerformance(engine, metrics);
  const load = scoreLoad(engine, metrics);
  const res  = scoreResource(engine, metrics);

  const dimensions = {
    connectivity: { score: connScore, weight: 20, label: '连通性', detail: reachable === 0 ? '连接失败' : '连接正常' },
    performance:  { score: perf.score, weight: 30, label: '性能', detail: perf.detail },
    load:         { score: load.score, weight: 25, label: '负载', detail: load.detail },
    resource:     { score: res.score,  weight: 25, label: '资源', detail: res.detail },
  };

  const total = connScore * 0.2 + perf.score * 0.3 + load.score * 0.25 + res.score * 0.25;
  const score = clamp(total, 0, 100);

  return { score, dimensions };
}

async function safeInsertSample(row) {
  try {
    await db.execute(
      `INSERT INTO MONITOR_METRIC_SAMPLE (INSTANCE_ID, DB_TYPE, REACHABLE, HEALTH_SCORE, HEALTH_DETAIL, METRIC_CPU, METRIC_CONN, METRICS_JSON, ERR_MSG)
       VALUES (:1, :2, :3, :4, :5, :6, :7, :8, :9)`,
      [
        row.instanceId,
        row.dbType,
        row.reachable,
        row.healthScore,
        row.healthDetail || null,
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
    const sysConfig = require('./systemConfig');
    const metricDays = await sysConfig.getNumber('retention.metric_sample_days', 8);
    await db.execute(
      `DELETE FROM MONITOR_METRIC_SAMPLE WHERE COLLECTED_AT < SYSTIMESTAMP - NUMTODSINTERVAL(:1, 'DAY')`,
      [metricDays]
    );
    // 清理已关闭的告警记录
    const alertDays = await sysConfig.getNumber('retention.alert_record_days', 90);
    if (alertDays > 0) {
      await db.execute(
        `DELETE FROM ALERT_RECORD WHERE STATUS IN ('RESOLVED','CLOSED') AND TRIGGER_TIME < SYSTIMESTAMP - NUMTODSINTERVAL(:1, 'DAY')`,
        [alertDays]
      ).catch(() => {});
    }
    // 清理审计日志
    const auditDays = await sysConfig.getNumber('retention.audit_log_days', 180);
    if (auditDays > 0) {
      await db.execute(
        `DELETE FROM SYS_AUDIT_LOG WHERE CREATED_AT < SYSTIMESTAMP - NUMTODSINTERVAL(:1, 'DAY')`,
        [auditDays]
      ).catch(() => {});
    }
    // 清理 SQL 工作台历史
    const sqlDays = await sysConfig.getNumber('retention.sql_history_days', 30);
    await db.execute(
      `DELETE FROM SQL_WORKBENCH_HISTORY WHERE CREATED_AT < SYSTIMESTAMP - NUMTODSINTERVAL(:1, 'DAY')`,
      [sqlDays]
    ).catch(() => {});
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
    const { score: health, dimensions } = computeHealthScore(metricEngine, bundle.metrics, 1);
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
      healthDetail: JSON.stringify(dimensions),
      metricCpu: cpu,
      metricConn: conn,
      metricsJson: jsonStr,
      errMsg: null,
    });
    await db.execute(
      `UPDATE CMDB_INSTANCE SET LAST_CHECK = SYSTIMESTAMP, STATUS = 'RUNNING', HEALTH_SCORE = :1, UPDATED_AT = SYSTIMESTAMP WHERE INSTANCE_ID = :2`,
      [health, instanceId]
    );
    return { ok: true, healthScore: health, dimensions, instanceId };
  } catch (e) {
    const errMsg = (e.message || String(e)).slice(0, 500);
    const { score: health, dimensions } = computeHealthScore(dbType, [], 0);
    await safeInsertSample({
      instanceId,
      dbType,
      reachable: 0,
      healthScore: health,
      healthDetail: JSON.stringify(dimensions),
      metricCpu: null,
      metricConn: null,
      metricsJson: null,
      errMsg,
    });
    await db.execute(
      `UPDATE CMDB_INSTANCE SET LAST_CHECK = SYSTIMESTAMP, STATUS = 'ERROR', HEALTH_SCORE = :1, UPDATED_AT = SYSTIMESTAMP WHERE INSTANCE_ID = :2`,
      [health, instanceId]
    );
    return { ok: false, err: errMsg, dimensions, instanceId };
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
