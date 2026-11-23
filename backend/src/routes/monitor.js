const router = require('express').Router();
const oracledb = require('oracledb');
const db = require('../config/db');
const { authMiddleware, requireRole } = require('../middleware/auth');
const {
  fetchCmdbInstance,
  connectOracle,
  normalizeDbType,
} = require('../utils/monitorTargetConn');
const exporter = require('../services/monitorExporterCollect');
const collectPersist = require('../services/monitorCollectPersist');

router.use(authMiddleware);
const adminDba = requireRole('ADMIN', 'DBA');

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
              CASE WHEN UPPER(i.DB_TYPE) IN ('ORACLE','MYSQL','POSTGRESQL','DAMENG','GOLDENDB','PANWEI','SQLSERVER') AND NVL(i.STATUS,'X') <> 'STOPPED'
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
                CASE WHEN UPPER(i.DB_TYPE) IN ('ORACLE','MYSQL','POSTGRESQL','DAMENG','GOLDENDB','PANWEI','SQLSERVER') AND NVL(i.STATUS,'X') <> 'STOPPED'
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

// [dxc][2026-10-17][新增] 实例级自动采集间隔（秒）；0=关闭，仅参与全局限频任务
router.put('/instances/:id/collect-schedule', adminDba, async (req, res) => {
  const intervalSec = req.body?.intervalSec ?? req.body?.collectIntervalSec;
  let sec = parseInt(intervalSec, 10);
  if (!Number.isFinite(sec) || sec < 0) {
    return res.json({ code: 400, msg: 'intervalSec 须为 >= 0 的整数（秒）' });
  }
  if (sec > 0 && sec < 60) {
    return res.json({ code: 400, msg: '自动采集间隔不能小于 60 秒' });
  }
  if (sec > 86400) sec = 86400;
  try {
    await db.execute(
      `UPDATE CMDB_INSTANCE SET COLLECT_INTERVAL_SEC = :1, UPDATED_AT = SYSTIMESTAMP WHERE INSTANCE_ID = :2`,
      [sec, req.params.id]
    );
    res.json({
      code: 200,
      msg: sec > 0 ? `已设置本实例每 ${sec} 秒自动采集` : '已关闭本实例单独自动采集',
      data: { intervalSec: sec },
    });
  } catch (err) {
    if (/ORA-00904|904/.test(err.message || '')) {
      return res.json({
        code: 500,
        msg: '缺少 COLLECT_INTERVAL_SEC 字段，请先执行 migration_monitor_instance_collect.sql',
      });
    }
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
      `INSERT INTO SYS_AUDIT_LOG(USER_ID,USERNAME,ACTION,"RESOURCE",RESOURCE_ID,STATUS,DETAIL) VALUES(:1,:2,:3,:4,:5,:6,:7)`,
      [
        req.user.userId,
        req.user.username,
        'KILL_SESSION',
        'CMDB_INSTANCE',
        String(req.params.id),
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
         WHERE DBID = (SELECT DBID FROM V$DATABASE)
           AND INSTANCE_NUMBER = (SELECT INSTANCE_NUMBER FROM V$INSTANCE)
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

/** [dxc][2026-10-17][修改] AWR 报告：TEXT/HTML 均为 PIPELINED 表函数，须 TABLE() 逐行拼接 */
async function resolveAwrDbInst(conn, dbidOpt, instNumOpt) {
  let dbid = dbidOpt != null ? Number(dbidOpt) : null;
  let instNum = instNumOpt != null ? Number(instNumOpt) : null;
  if (!Number.isFinite(dbid) || !Number.isFinite(instNum)) {
    const meta = await conn.execute(
      `SELECT (SELECT DBID FROM V$DATABASE) AS DBID,
              (SELECT INSTANCE_NUMBER FROM V$INSTANCE) AS INSTANCE_NUMBER
       FROM DUAL`,
      [],
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    dbid = Number(meta.rows?.[0]?.DBID);
    instNum = Number(meta.rows?.[0]?.INSTANCE_NUMBER);
  }
  return { dbid, instNum };
}

async function awrLineToString(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v.getData === 'function') return await v.getData();
  return String(v);
}

function awrLineFromRow(row) {
  if (!row || typeof row !== 'object') return null;
  for (const key of ['LINE', 'OUTPUT', 'output', 'COLUMN_VALUE', 'VALUE', 'value']) {
    if (row[key] != null) return row[key];
  }
  const vals = Object.values(row);
  return vals.length ? vals[0] : null;
}

/** 修复误用 t.* 时整行 toString 成 [SYS.AWRRPT_HTML_TYPE]{OUTPUT:...} 的脏数据 */
function repairAwrHtmlGarbage(report) {
  const s = String(report || '');
  if (!s.includes('[SYS.AWRRPT_HTML_TYPE]')) return s;
  const chunks = [];
  const re = /OUTPUT:\s*('(?:''|[^'])*'|`(?:\\.|[^`])*`)/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const token = m[1];
    if (token.startsWith('`')) {
      chunks.push(token.slice(1, -1).replace(/\\`/g, '`'));
    } else {
      chunks.push(token.slice(1, -1).replace(/''/g, "'"));
    }
  }
  return chunks.length ? chunks.join('') : s;
}

/**
 * HTML：AWRRPT_HTML_TYPE 对象行，须 SELECT t.OUTPUT（不可用 t.* / COLUMN_VALUE）
 * TEXT：AWRRPT_TEXT_TYPE_TABLE 标量行，用 VALUE(t) 等
 */
async function fetchAwrReport(conn, beginSnap, endSnap, dbidOpt, instNumOpt, format) {
  const { dbid, instNum } = await resolveAwrDbInst(conn, dbidOpt, instNumOpt);
  const html = String(format || 'html').toLowerCase() === 'html';
  const binds = { dbid, instNum, beginSnap, endSnap };
  const execOpts = { outFormat: oracledb.OUT_FORMAT_OBJECT, fetchAsString: [oracledb.CLOB] };
  const sqlVariants = html
    ? [
      `SELECT t.OUTPUT AS LINE FROM TABLE(DBMS_WORKLOAD_REPOSITORY.AWR_REPORT_HTML(:dbid, :instNum, :beginSnap, :endSnap)) t`,
      `SELECT output AS line FROM TABLE(DBMS_WORKLOAD_REPOSITORY.AWR_REPORT_HTML(:dbid, :instNum, :beginSnap, :endSnap))`,
    ]
    : [
      `SELECT VALUE(t) AS LINE FROM TABLE(DBMS_WORKLOAD_REPOSITORY.AWR_REPORT_TEXT(:dbid, :instNum, :beginSnap, :endSnap)) t`,
      `SELECT t.COLUMN_VALUE AS LINE FROM TABLE(DBMS_WORKLOAD_REPOSITORY.AWR_REPORT_TEXT(:dbid, :instNum, :beginSnap, :endSnap)) t`,
    ];

  let lastErr;
  for (const sql of sqlVariants) {
    try {
      const r = await conn.execute(sql, binds, execOpts);
      const parts = [];
      for (const row of r.rows || []) {
        const raw = awrLineFromRow(row);
        if (raw == null) continue;
        const piece = await awrLineToString(raw);
        if (piece === '' || piece === 'null') continue;
        parts.push(piece);
      }
      if (parts.length) {
        let out = html ? parts.join('') : parts.join('\n');
        if (html) out = repairAwrHtmlGarbage(out);
        return out;
      }
    } catch (e) {
      lastErr = e;
      if (!/ORA-00904|00904|ORA-00932|00932/.test(e.message || '')) throw e;
    }
  }
  throw lastErr || new Error('无法读取 AWR 报告行（TABLE 函数列名不兼容）');
}

// POST /api/monitor/instances/:id/awr-report  生成 AWR 报告（format=html|text，默认 html）
router.post('/instances/:id/awr-report', adminDba, async (req, res) => {
  const beginSnap = Number(req.body?.beginSnap);
  const endSnap = Number(req.body?.endSnap);
  const dbid = req.body?.dbid;
  const instanceNumber = req.body?.instanceNumber;
  const formatRaw = String(req.body?.format || 'html').toLowerCase();
  const format = formatRaw === 'text' ? 'text' : 'html';
  if (!Number.isInteger(beginSnap) || !Number.isInteger(endSnap) || beginSnap <= 0 || endSnap <= 0 || endSnap <= beginSnap) {
    return res.json({ code: 400, msg: 'beginSnap/endSnap 必须为正整数且 endSnap > beginSnap' });
  }
  try {
    const report = await withOracleConn(req.params.id, async (conn) =>
      fetchAwrReport(conn, beginSnap, endSnap, dbid, instanceNumber, format)
    );
    if (!report || !String(report).trim()) {
      return res.json({
        code: 500,
        msg: 'AWR 报告为空：请确认快照区间有效，且监控账号具备 DBA_HIST 访问及 DBMS_WORKLOAD_REPOSITORY 执行权限（Diagnostics 许可）',
      });
    }
    res.json({ code: 200, data: { beginSnap, endSnap, format, report } });
  } catch (err) {
    const msg = err.message || String(err);
    let hint = msg;
    if (/ORA-01031|insufficient privileges/i.test(msg)) {
      hint = `${msg} — 请授予 SELECT_CATALOG_ROLE 或对 DBA_HIST_* 的 SELECT，以及 DBMS_WORKLOAD_REPOSITORY 的 EXECUTE`;
    } else if (/ORA-06512|AWR_REPORT/i.test(msg)) {
      hint = `${msg} — 请确认 Diagnostics Pack 许可及快照 ID 属于当前连接实例`;
    }
    res.json({ code: 500, msg: hint });
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

// [dxc][2026-10-08][新增] GET /api/monitor/instances/:id/engine-phase2 — 最近样本 摘要（TOP SQL/等待事件等）
router.get('/instances/:id/engine-phase2', async (req, res) => {
  try {
    const r = await db.execute(
      `SELECT METRICS_JSON, COLLECTED_AT FROM MONITOR_METRIC_SAMPLE
       WHERE INSTANCE_ID = :1 ORDER BY COLLECTED_AT DESC FETCH FIRST 1 ROWS ONLY`,
      [req.params.id]
    );
    if (!r.rows.length || !r.rows[0].METRICS_JSON) {
      return res.json({ code: 200, data: { phase2: null, collectedAt: null } });
    }
    let parsed = {};
    try {
      parsed = JSON.parse(r.rows[0].METRICS_JSON);
    } catch {
      parsed = {};
    }
    res.json({
      code: 200,
      data: {
        collectedAt: r.rows[0].COLLECTED_AT,
        engineMetrics: parsed.engineMetrics || [],
        enginePhase2Summary: parsed.enginePhase2Summary || null,
        hostMetrics: parsed.hostMetrics || [],
        hostSummary: parsed.hostSummary || null,
      },
    });
  } catch (err) {
    res.json({ code: 500, msg: err.message });
  }
});

// [dxc][2026-10-08][新增] GET /api/monitor/instances/:id/host-checks —  SSH 主机摘要
router.get('/instances/:id/host-checks', async (req, res) => {
  try {
    const r = await db.execute(
      `SELECT METRICS_JSON, COLLECTED_AT FROM MONITOR_METRIC_SAMPLE
       WHERE INSTANCE_ID = :1 ORDER BY COLLECTED_AT DESC FETCH FIRST 1 ROWS ONLY`,
      [req.params.id]
    );
    if (!r.rows.length || !r.rows[0].METRICS_JSON) {
      return res.json({ code: 200, data: { hostMetrics: [], hostSummary: null, collectedAt: null } });
    }
    let parsed = {};
    try {
      parsed = JSON.parse(r.rows[0].METRICS_JSON);
    } catch {
      parsed = {};
    }
    res.json({
      code: 200,
      data: {
        collectedAt: r.rows[0].COLLECTED_AT,
        hostMetrics: parsed.hostMetrics || [],
        hostSummary: parsed.hostSummary || null,
      },
    });
  } catch (err) {
    res.json({ code: 500, msg: err.message });
  }
});

// GET /api/monitor/catalog  监控项目录（Oracle/磐维 Excel 导入）
router.get('/catalog', async (req, res) => {
  try {
    const { dbType, mode, page = 1, size = 50 } = req.query;
    const where = ['ENABLED = 1'];
    const binds = [];
    let bi = 1;
    if (dbType) {
      where.push(`DB_TYPE = :${bi}`);
      binds.push(String(dbType).toUpperCase());
      bi += 1;
    }
    if (mode) {
      where.push(`COLLECT_MODE = :${bi}`);
      binds.push(String(mode).toUpperCase());
      bi += 1;
    }
    const sql = `SELECT CATALOG_ID, SOURCE_FILE, ITEM_NO, DB_TYPE, CATEGORY, SUBCATEGORY, ITEM_NAME,
                        COLLECT_MODE, METRIC_KEY, THRESHOLD_TEXT, SEVERITY_LABEL
                 FROM DB_MONITOR_CATALOG WHERE ${where.join(' AND ')} ORDER BY DB_TYPE, ITEM_NO`;
    const data = await db.queryPage(sql, binds, page, size);
    res.json({ code: 200, data });
  } catch (err) {
    if (/ORA-00942|942/.test(err.message || '')) {
      return res.json({ code: 200, data: { list: [], total: 0, msg: '请先执行 migration_monitor_catalog.sql' } });
    }
    res.json({ code: 500, msg: err.message });
  }
});

module.exports = router;
