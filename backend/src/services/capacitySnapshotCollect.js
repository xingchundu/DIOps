/**
 * 容量预测 — 实例快照采集（全部受支持库类型走真实监控/表空间数据）
 */
const db = require('../config/db');
const {
  fetchCmdbInstance,
  normalizeDbType,
} = require('../utils/monitorTargetConn');
const { getPerformanceBundle, getTablespaces } = require('./monitorExporterCollect');

const SUPPORTED_TYPES = new Set(['ORACLE', 'MYSQL', 'GOLDENDB', 'POSTGRESQL', 'PANWEI', 'DAMENG', 'SQLSERVER']);

function findMetric(metrics, name) {
  const m = (metrics || []).find((x) => x.METRIC_NAME === name);
  return m != null && m.VALUE != null && !Number.isNaN(Number(m.VALUE)) ? Number(m.VALUE) : null;
}

async function getLatestMonitorSample(instanceId) {
  try {
    const r = await db.execute(
      `SELECT METRIC_CPU, METRIC_CONN FROM MONITOR_METRIC_SAMPLE
       WHERE INSTANCE_ID = :1 ORDER BY COLLECTED_AT DESC FETCH FIRST 1 ROW ONLY`,
      [instanceId]
    );
    return r.rows[0] || null;
  } catch {
    return null;
  }
}

/**
 * 磁盘：已用 = 各表空间 / 库的已用之和；总量只在有上限的库（Oracle / 达梦等）计算，MySQL / PG 没有上限时为 null。
 */
function aggregateDisk(tablespaces) {
  let diskUsed = 0;
  let diskTotal = 0;
  let hasTotal = false;
  for (const ts of tablespaces || []) {
    diskUsed += Number(ts.USED_GB) || 0;
    if (Number(ts.TOTAL_GB) > 0) {
      diskTotal += Number(ts.TOTAL_GB);
      hasTotal = true;
    }
  }
  return { diskUsed, diskTotal: hasTotal ? diskTotal : null };
}

/**
 * 负载指标只取能直接测得的值，测不到时为 null（原先用“CPU 秒 × 8”“运行线程 × 5”“PLE 换算内存”等公式凑数）。
 *  - CPU：主机 CPU（监控采样）
 *  - 连接：当前连接数
 *  - TPS / QPS：Oracle User Calls Per Sec、MySQL 自启动平均 QPS、SQL Server Batch Requests/sec；其它库 null
 *  - 内存：没有主机内存采集时为 null
 */
function deriveLoadMetrics(dbType, metrics, sample) {
  let connAvg = sample?.METRIC_CONN != null ? Number(sample.METRIC_CONN) : null;
  let tps = null;
  let qps = null;
  switch (dbType) {
    case 'ORACLE':
    case 'DAMENG':
      connAvg = connAvg ?? findMetric(metrics, 'Current Logons Count');
      tps = dbType === 'ORACLE' ? findMetric(metrics, 'User Calls Per Sec') : null;
      qps = tps;
      break;
    case 'MYSQL':
    case 'GOLDENDB': {
      connAvg = connAvg ?? findMetric(metrics, 'mysql_global_status_threads_connected');
      const questions = findMetric(metrics, 'mysql_global_status_questions_total');
      const uptime = findMetric(metrics, 'mysql_global_status_uptime_seconds');
      qps = questions != null && uptime > 0 ? questions / uptime : null;
      break;
    }
    case 'POSTGRESQL':
    case 'PANWEI':
      connAvg = connAvg ?? findMetric(metrics, 'pg_stat_database_numbackends');
      break;
    case 'SQLSERVER':
      connAvg = connAvg ?? findMetric(metrics, 'mssql_user_connections');
      tps = findMetric(metrics, 'mssql_batch_requests_per_sec');
      qps = tps;
      break;
    default:
  }
  const cpu = sample?.METRIC_CPU != null && Number(sample.METRIC_CPU) >= 0 && Number(sample.METRIC_CPU) <= 100 ? Number(sample.METRIC_CPU) : null;
  return { connAvg, cpuAvg: cpu, tpsAvg: tps, tpsPeak: null, qpsAvg: qps };
}

async function collectRealCapacitySnapshot(instanceId) {
  const inst = await fetchCmdbInstance(instanceId);
  const dbType = normalizeDbType(inst);
  if (!SUPPORTED_TYPES.has(dbType)) {
    throw new Error(`容量采集不支持类型「${dbType}」，支持: ${[...SUPPORTED_TYPES].join(' / ')}`);
  }

  const [bundle, tablespaces, sample] = await Promise.all([
    getPerformanceBundle(instanceId),
    getTablespaces(instanceId).catch(() => []),
    getLatestMonitorSample(instanceId),
  ]);

  const { diskUsed, diskTotal } = aggregateDisk(tablespaces);
  const { connAvg, cpuAvg, tpsAvg, tpsPeak, qpsAvg } = deriveLoadMetrics(dbType, bundle.metrics || [], sample);
  const r2 = v => (v == null || Number.isNaN(Number(v)) ? null : Number(Number(v).toFixed(2)));
  return {
    diskUsed: r2(diskUsed),
    diskTotal: r2(diskTotal),
    tpsAvg: r2(tpsAvg),
    tpsPeak: r2(tpsPeak),
    qpsAvg: r2(qpsAvg),
    connAvg: connAvg == null ? null : Math.round(connAvg),
    cpuAvg: r2(cpuAvg),
    memAvg: null,
  };
}

async function collectCapacitySnapshot(instanceId) {
  return collectRealCapacitySnapshot(instanceId);
}

module.exports = { collectCapacitySnapshot };
