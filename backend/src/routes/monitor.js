const router = require('express').Router();
const oracledb = require('oracledb');
const db = require('../config/db');
const { authMiddleware } = require('../middleware/auth');
const {
  fetchCmdbInstance,
  connectOracle,
  normalizeDbType,
} = require('../utils/monitorTargetConn');
const exporter = require('../services/monitorExporterCollect');
const collectPersist = require('../services/monitorCollectPersist');

router.use(authMiddleware);

/** 与 app.js 定时任务一致的周期（毫秒），仅用于观测页展示 */
function getCollectIntervalMs() {
  const rawMs = parseInt(process.env.MONITOR_COLLECT_INTERVAL_MS || '90000', 10);
  return Number.isFinite(rawMs) ? Math.max(60000, rawMs) : 90000;
}

const COLLECT_SCHEDULER_INITIAL_DELAY_MS = 8000;

// GET /api/monitor/collect-scheduler/status  定时采集观测（每实例最近样本 + 周期说明）
router.get('/collect-scheduler/status', async (req, res) => {
  const intervalMs = getCollectIntervalMs();
  try {
    const r = await db.execute(
      `SELECT i.INSTANCE_ID, i.INSTANCE_NAME, i.DB_TYPE, i.HOST_IP, i.PORT, i.STATUS,
              i.LAST_CHECK, i.HEALTH_SCORE,
              s.COLLECTED_AT AS LAST_SAMPLE_TIME, s.REACHABLE AS LAST_SAMPLE_OK, s.ERR_MSG AS LAST_SAMPLE_ERR,
              CASE WHEN UPPER(i.DB_TYPE) IN ('ORACLE','MYSQL','POSTGRESQL','DAMENG','GOLDENDB') AND NVL(i.STATUS,'X') <> 'STOPPED'
                   THEN 1 ELSE 0 END AS IN_SCHEDULER
       FROM CMDB_INSTANCE i
       LEFT JOIN (
         SELECT INSTANCE_ID, COLLECTED_AT, REACHABLE, ERR_MSG
         FROM (
           SELECT m.INSTANCE_ID, m.COLLECTED_AT, m.REACHABLE, m.ERR_MSG,
                  ROW_NUMBER() OVER (PARTITION BY m.INSTANCE_ID ORDER BY m.COLLECTED_AT DESC) AS rn
           FROM MONITOR_METRIC_SAMPLE m
         ) t WHERE rn = 1
       ) s ON i.INSTANCE_ID = s.INSTANCE_ID
       ORDER BY i.INSTANCE_ID`,
      []
    );
    res.json({
      code: 200,
      data: {
        scheduler: {
          intervalMs,
          intervalSeconds: Math.round(intervalMs / 1000),
          initialDelayMs: COLLECT_SCHEDULER_INITIAL_DELAY_MS,
          envKey: 'MONITOR_COLLECT_INTERVAL_MS',
        },
        serverTime: new Date().toISOString(),
        instances: r.rows || [],
      },
    });
  } catch (err) {
    if (/ORA-00942|942/.test(err.message || '')) {
      const r2 = await db.execute(
        `SELECT i.INSTANCE_ID, i.INSTANCE_NAME, i.DB_TYPE, i.HOST_IP, i.PORT, i.STATUS,
                i.LAST_CHECK, i.HEALTH_SCORE,
                NULL AS LAST_SAMPLE_TIME, NULL AS LAST_SAMPLE_OK, NULL AS LAST_SAMPLE_ERR,
                CASE WHEN UPPER(i.DB_TYPE) IN ('ORACLE','MYSQL','POSTGRESQL','DAMENG','GOLDENDB') AND NVL(i.STATUS,'X') <> 'STOPPED'
                     THEN 1 ELSE 0 END AS IN_SCHEDULER
         FROM CMDB_INSTANCE i ORDER BY i.INSTANCE_ID`,
        []
      );
      return res.json({
        code: 200,
        data: {
          scheduler: {
            intervalMs,
            intervalSeconds: Math.round(intervalMs / 1000),
            initialDelayMs: COLLECT_SCHEDULER_INITIAL_DELAY_MS,
            envKey: 'MONITOR_COLLECT_INTERVAL_MS',
          },
          serverTime: new Date().toISOString(),
          instances: r2.rows || [],
          sampleTableMissing: true,
        },
      });
    }
    res.json({ code: 500, msg: err.message });
  }
});

async function withOracleConn(instanceId, fn) {
  const inst = await fetchCmdbInstance(instanceId);
  if (normalizeDbType(inst) !== 'ORACLE') {
    const e = new Error('该操作仅支持 Oracle 实例');
    e.code = 'NOT_ORACLE';
    throw e;
  }
  const conn = await connectOracle(inst);
  try {
    return await fn(conn);
  } finally {
    await conn.close();
  }
}

// GET /api/monitor/overview  总览卡片
router.get('/overview', async (req, res) => {
  try {
    const [total, alerts, running, healthy] = await Promise.all([
      db.execute(`SELECT COUNT(*) C FROM CMDB_INSTANCE`, []),
      db.execute(`SELECT COUNT(*) C FROM ALERT_RECORD WHERE STATUS='OPEN'`, []),
      db.execute(`SELECT COUNT(*) C FROM CMDB_INSTANCE WHERE STATUS='RUNNING'`, []),
      db.execute(`SELECT COUNT(*) C FROM CMDB_INSTANCE WHERE HEALTH_SCORE>=80 AND STATUS='RUNNING'`, []),
    ]);
    res.json({
      code: 200,
      data: {
        totalInstances: total.rows[0].C,
        openAlerts: alerts.rows[0].C,
        runningInstances: running.rows[0].C,
        healthyInstances: healthy.rows[0].C,
      },
    });
  } catch (err) {
    res.json({ code: 500, msg: err.message });
  }
});

// GET /api/monitor/instances  监控实例列表
router.get('/instances', async (req, res) => {
  try {
    const r = await db.execute(
      `SELECT i.INSTANCE_ID,i.INSTANCE_NAME,i.DB_TYPE,i.HOST_IP,i.PORT,i.STATUS,
              i.HEALTH_SCORE,i.ENVIRONMENT,i.BIZ_LINE,i.ROLE,i.LAST_CHECK,
              (SELECT COUNT(*) FROM ALERT_RECORD a WHERE a.INSTANCE_ID=i.INSTANCE_ID AND a.STATUS='OPEN') AS OPEN_ALERTS
       FROM CMDB_INSTANCE i ORDER BY i.INSTANCE_ID`,
      []
    );
    res.json({ code: 200, data: r.rows });
  } catch (err) {
    res.json({ code: 500, msg: err.message });
  }
});

// GET /api/monitor/instances/:id/basic  实例基本信息
router.get('/instances/:id/basic', async (req, res) => {
  try {
    const r = await db.execute(
      `SELECT i.*,h.HOSTNAME,h.OS_TYPE,h.OS_VERSION,h.CPU_CORES,h.MEMORY_GB,h.DATACENTER,
              (SELECT COUNT(*) FROM ALERT_RECORD a WHERE a.INSTANCE_ID=i.INSTANCE_ID AND a.STATUS='OPEN') OPEN_ALERTS
       FROM CMDB_INSTANCE i LEFT JOIN CMDB_HOST h ON i.HOST_ID=h.HOST_ID
       WHERE i.INSTANCE_ID=:1`,
      [req.params.id]
    );
    if (!r.rows.length) return res.json({ code: 404, msg: '实例不存在' });
    const d = { ...r.rows[0] };
    delete d.DB_PASSWORD;
    res.json({ code: 200, data: d });
  } catch (err) {
    res.json({ code: 500, msg: err.message });
  }
});

// POST /api/monitor/instances/:id/collect  即时连通采集并写入 MONITOR_METRIC_SAMPLE、刷新 CMDB 健康分
router.post('/instances/:id/collect', async (req, res) => {
  try {
    const data = await collectPersist.collectInstance(req.params.id);
    res.json({
      code: 200,
      data,
      msg: data.ok ? '采集已入库' : (data.err || '采集失败'),
    });
  } catch (err) {
    res.json({ code: 500, msg: err.message });
  }
});

// GET /api/monitor/instances/:id/trend  历史趋势（周期采集样本）
router.get('/instances/:id/trend', async (req, res) => {
  try {
    const range = req.query.range || '1h';
    const series = await collectPersist.getTrendSeries(req.params.id, range);
    res.json({ code: 200, data: { range, series } });
  } catch (err) {
    res.json({ code: 500, msg: err.message });
  }
});

// GET /api/monitor/instances/:id/performance  实时性能（类 Exporter 拉取：Oracle / MySQL / PostgreSQL）
router.get('/instances/:id/performance', async (req, res) => {
  try {
    const data = await exporter.getPerformanceBundle(req.params.id);
    res.json({ code: 200, data });
  } catch (err) {
    res.json({ code: 500, msg: err.message });
  }
});

// GET /api/monitor/instances/:id/tablespaces
router.get('/instances/:id/tablespaces', async (req, res) => {
  try {
    const rows = await exporter.getTablespaces(req.params.id);
    res.json({ code: 200, data: rows });
  } catch (err) {
    res.json({ code: 500, msg: err.message });
  }
});

// GET /api/monitor/instances/:id/sessions
router.get('/instances/:id/sessions', async (req, res) => {
  const { status, username, onlyActive } = req.query;
  try {
    const rows = await exporter.getSessions(req.params.id, { status, username, onlyActive });
    res.json({ code: 200, data: rows });
  } catch (err) {
    res.json({ code: 500, msg: err.message });
  }
});

// POST /api/monitor/instances/:id/sessions/kill  Kill会话（Oracle）
router.post('/instances/:id/sessions/kill', async (req, res) => {
  if (!['ADMIN', 'DBA'].includes(req.user.role)) return res.json({ code: 403, msg: '权限不足' });
  const { sid, serial } = req.body;
  if (!sid || serial == null || serial === '') return res.json({ code: 400, msg: 'sid 和 serial 不能为空' });
  const sidNum = Number(sid), serialNum = Number(serial);
  if (!Number.isInteger(sidNum) || sidNum <= 0 || !Number.isInteger(serialNum) || serialNum <= 0) {
    return res.json({ code: 400, msg: 'sid 和 serial 必须为正整数' });
  }
  try {
    await withOracleConn(req.params.id, async (conn) => {
      await conn.execute(`ALTER SYSTEM KILL SESSION '${sidNum},${serialNum}' IMMEDIATE`);
    });
    await db.execute(
      `INSERT INTO SYS_AUDIT_LOG(USER_ID,USERNAME,ACTION,"RESOURCE",STATUS,DETAIL) VALUES(:1,:2,:3,:4,:5,:6)`,
      [
        req.user.userId,
        req.user.username,
        'KILL_SESSION',
        `Instance:${req.params.id}`,
        'SUCCESS',
        `SID=${sid},SERIAL#=${serial}`,
      ]
    );
    res.json({ code: 200, msg: `会话 ${sid},${serial} 已终止` });
  } catch (err) {
    res.json({ code: 500, msg: err.message });
  }
});

// GET /api/monitor/instances/:id/topsql
router.get('/instances/:id/topsql', async (req, res) => {
  const { orderBy = 'elapsed' } = req.query;
  try {
    const rows = await exporter.getTopSql(req.params.id, orderBy);
    res.json({ code: 200, data: rows });
  } catch (err) {
    res.json({ code: 500, msg: err.message });
  }
});

// GET /api/monitor/instances/:id/waits
router.get('/instances/:id/waits', async (req, res) => {
  try {
    const rows = await exporter.getWaits(req.params.id);
    res.json({ code: 200, data: rows });
  } catch (err) {
    res.json({ code: 500, msg: err.message });
  }
});

// GET /api/monitor/instances/:id/locks  锁分析（仅 Oracle）
router.get('/instances/:id/locks', async (req, res) => {
  try {
    const inst = await fetchCmdbInstance(req.params.id);
    if (normalizeDbType(inst) !== 'ORACLE') {
      return res.json({ code: 200, data: [], msg: '仅 Oracle 支持锁分析' });
    }
    const rows = await withOracleConn(req.params.id, async (conn) => {
      const r = await conn.execute(
        `SELECT HOLDER.SID HOLDER_SID, HS.SERIAL# HOLDER_SERIAL,
                HS.USERNAME HOLDER_USER, HS.PROGRAM HOLDER_PROG,
                WAITER.SID WAITER_SID, WS.SERIAL# WAITER_SERIAL,
                WS.USERNAME WAITER_USER, WS.PROGRAM WAITER_PROG,
                ROUND(WS.LAST_CALL_ET/60,1) WAIT_MIN,
                WS.EVENT WAIT_EVENT
         FROM V$LOCK HOLDER
         JOIN V$LOCK WAITER ON HOLDER.ID1=WAITER.ID1 AND HOLDER.ID2=WAITER.ID2
           AND HOLDER.BLOCK=1 AND WAITER.REQUEST>0
         JOIN V$SESSION HS ON HOLDER.SID=HS.SID
         JOIN V$SESSION WS ON WAITER.SID=WS.SID
         ORDER BY WAIT_MIN DESC`,
        [],
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );
      return r.rows || [];
    });
    res.json({ code: 200, data: rows });
  } catch (err) {
    res.json({ code: 500, msg: err.message });
  }
});

// GET /api/monitor/instances/:id/awr-snapshots  AWR（仅 Oracle）
router.get('/instances/:id/awr-snapshots', async (req, res) => {
  try {
    const inst = await fetchCmdbInstance(req.params.id);
    if (normalizeDbType(inst) !== 'ORACLE') {
      return res.json({ code: 200, data: [] });
    }
    const rows = await withOracleConn(req.params.id, async (conn) => {
      const r = await conn.execute(
        `SELECT SNAP_ID, DBID, INSTANCE_NUMBER,
                TO_CHAR(BEGIN_INTERVAL_TIME,'YYYY-MM-DD HH24:MI') BEGIN_TIME,
                TO_CHAR(END_INTERVAL_TIME,'YYYY-MM-DD HH24:MI') END_TIME
         FROM DBA_HIST_SNAPSHOT
         ORDER BY SNAP_ID DESC
         FETCH FIRST 48 ROWS ONLY`,
        [],
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );
      return r.rows || [];
    });
    res.json({ code: 200, data: rows });
  } catch (err) {
    res.json({ code: 500, msg: err.message });
  }
});

// GET /api/monitor/instances/:id/alerts
router.get('/instances/:id/alerts', async (req, res) => {
  try {
    const r = await db.execute(
      `SELECT * FROM ALERT_RECORD WHERE INSTANCE_ID=:1 ORDER BY TRIGGER_TIME DESC FETCH FIRST 50 ROWS ONLY`,
      [req.params.id]
    );
    res.json({ code: 200, data: r.rows });
  } catch (err) {
    res.json({ code: 500, msg: err.message });
  }
});

// GET /api/monitor/instances/:id/audit
router.get('/instances/:id/audit', async (req, res) => {
  try {
    const r = await db.execute(
      `SELECT * FROM SYS_AUDIT_LOG WHERE RESOURCE_ID=:1 OR DETAIL LIKE :2
       ORDER BY CREATED_AT DESC FETCH FIRST 100 ROWS ONLY`,
      [String(req.params.id), `%Instance:${req.params.id}%`]
    );
    res.json({ code: 200, data: r.rows });
  } catch (err) {
    res.json({ code: 500, msg: err.message });
  }
});

// GET /api/monitor/instances/:id/sysinfo
router.get('/instances/:id/sysinfo', async (req, res) => {
  try {
    const data = await exporter.getSysinfoBundle(req.params.id);
    res.json({ code: 200, data });
  } catch (err) {
    res.json({ code: 500, msg: err.message });
  }
});

// GET /api/monitor/instances/:id/health-detail  多维度健康评分详情
router.get('/instances/:id/health-detail', async (req, res) => {
  try {
    const r = await db.execute(
      `SELECT HEALTH_SCORE, HEALTH_DETAIL, COLLECTED_AT, REACHABLE
       FROM MONITOR_METRIC_SAMPLE
       WHERE INSTANCE_ID = :1
       ORDER BY COLLECTED_AT DESC
       FETCH FIRST 1 ROWS ONLY`,
      [req.params.id]
    );
    if (!r.rows.length) {
      return res.json({ code: 200, data: { score: null, dimensions: null, collectedAt: null } });
    }
    const row = r.rows[0];
    let dimensions = null;
    try { dimensions = row.HEALTH_DETAIL ? JSON.parse(row.HEALTH_DETAIL) : null; } catch {}
    res.json({
      code: 200,
      data: {
        score: row.HEALTH_SCORE,
        reachable: row.REACHABLE,
        dimensions,
        collectedAt: row.COLLECTED_AT,
      },
    });
  } catch (err) {
    res.json({ code: 500, msg: err.message });
  }
});

module.exports = router;
