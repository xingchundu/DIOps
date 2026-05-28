/**
 * /api/reports/* — 报表中心服务端分析 API（F-58~64）
 * 从多张表聚合真实数据，替代客户端模板拼接
 */
const router = require('express').Router();
const db = require('../config/db');
const { authMiddleware } = require('../middleware/auth');

router.use(authMiddleware);

// ─── F-58 综合概览 ───────────────────────────────────────────────
// GET /api/reports/overview
router.get('/overview', async (req, res) => {
  try {
    const [instStats, alertStats, topAlerts, healthDist] = await Promise.all([
      // 实例统计
      db.execute(`SELECT
        COUNT(*) TOTAL,
        SUM(CASE WHEN STATUS='RUNNING' THEN 1 ELSE 0 END) RUNNING,
        SUM(CASE WHEN STATUS='ERROR' THEN 1 ELSE 0 END) ERRORED,
        SUM(CASE WHEN HEALTH_SCORE>=80 AND STATUS='RUNNING' THEN 1 ELSE 0 END) HEALTHY,
        ROUND(AVG(HEALTH_SCORE),1) AVG_SCORE
        FROM CMDB_INSTANCE`, []),
      // 告警统计
      db.execute(`SELECT
        COUNT(*) TOTAL,
        SUM(CASE WHEN STATUS='OPEN' THEN 1 ELSE 0 END) OPEN_CNT,
        SUM(CASE WHEN STATUS='ACKNOWLEDGED' THEN 1 ELSE 0 END) ACKED,
        SUM(CASE WHEN STATUS='RESOLVED' THEN 1 ELSE 0 END) RESOLVED,
        SUM(CASE WHEN SEVERITY='P1' AND STATUS='OPEN' THEN 1 ELSE 0 END) P1_OPEN
        FROM ALERT_RECORD`, []),
      // 最近 24h 未处理告警 Top 5
      db.execute(`SELECT ALERT_ID, INSTANCE_ID, SEVERITY, CONTENT, TRIGGER_TIME
        FROM ALERT_RECORD WHERE STATUS='OPEN'
        ORDER BY CASE SEVERITY WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 WHEN 'P3' THEN 3 ELSE 4 END, TRIGGER_TIME DESC
        FETCH FIRST 5 ROWS ONLY`, []),
      // 健康分分布
      db.execute(`SELECT
        CASE WHEN HEALTH_SCORE>=80 THEN '健康(≥80)'
             WHEN HEALTH_SCORE>=60 THEN '关注(60-79)'
             ELSE '异常(<60)' END AS GRADE,
        COUNT(*) CNT
        FROM CMDB_INSTANCE GROUP BY CASE WHEN HEALTH_SCORE>=80 THEN '健康(≥80)' WHEN HEALTH_SCORE>=60 THEN '关注(60-79)' ELSE '异常(<60)' END`, []),
    ]);
    res.json({
      code: 200,
      data: {
        instance: instStats.rows[0] || {},
        alert: alertStats.rows[0] || {},
        topAlerts: topAlerts.rows || [],
        healthDist: healthDist.rows || [],
      },
    });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// ─── F-59 SLA 可用性报表 ──────────────────────────────────────────
// GET /api/reports/sla?range=7d|30d|90d
router.get('/sla', async (req, res) => {
  try {
    const range = req.query.range || '7d';
    const days = range === '90d' ? 90 : range === '30d' ? 30 : 7;
    // 实例级 SLA：基于健康分采样计算可用率
    const slaSql = `SELECT i.INSTANCE_ID, i.INSTANCE_NAME, i.DB_TYPE, i.ENVIRONMENT, i.HEALTH_SCORE, i.STATUS,
      (SELECT COUNT(*) FROM ALERT_RECORD a WHERE a.INSTANCE_ID=i.INSTANCE_ID AND a.STATUS='OPEN') AS OPEN_ALERTS,
      (SELECT COUNT(*) FROM MONITOR_METRIC_SAMPLE m WHERE m.INSTANCE_ID=i.INSTANCE_ID
        AND m.COLLECTED_AT>=SYSDATE-${days} AND m.REACHABLE=1) AS UP_SAMPLES,
      (SELECT COUNT(*) FROM MONITOR_METRIC_SAMPLE m WHERE m.INSTANCE_ID=i.INSTANCE_ID
        AND m.COLLECTED_AT>=SYSDATE-${days}) AS TOTAL_SAMPLES
      FROM CMDB_INSTANCE i ORDER BY i.INSTANCE_ID`;
    const { rows } = await db.execute(slaSql, []);
    const slaData = rows.map(r => ({
      ...r,
      SLA_PCT: r.TOTAL_SAMPLES > 0 ? Math.round((r.UP_SAMPLES / r.TOTAL_SAMPLES) * 10000) / 100 : null,
    }));
    // 全局 SLA
    const totalUp = slaData.reduce((s, r) => s + (r.UP_SAMPLES || 0), 0);
    const totalSamples = slaData.reduce((s, r) => s + (r.TOTAL_SAMPLES || 0), 0);
    const globalSla = totalSamples > 0 ? Math.round((totalUp / totalSamples) * 10000) / 100 : null;
    // MTTR（平均恢复时间，小时）
    const mttrRes = await db.execute(
      `SELECT ROUND(AVG(EXTRACT(HOUR FROM (RESOLVED_TIME - TRIGGER_TIME)) + EXTRACT(MINUTE FROM (RESOLVED_TIME - TRIGGER_TIME))/60), 1) AS MTTR_HOURS
       FROM ALERT_RECORD WHERE RESOLVED_TIME IS NOT NULL AND TRIGGER_TIME >= SYSDATE-${days}`, []);
    res.json({
      code: 200,
      data: {
        range, days, globalSla, mttrHours: mttrRes.rows[0]?.MTTR_HOURS || null,
        instances: slaData,
      },
    });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// ─── F-60 告警趋势分析 ───────────────────────────────────────────
// GET /api/reports/alert-trend?days=7
router.get('/alert-trend', async (req, res) => {
  try {
    const days = Number(req.query.days) || 7;
    const [byDay, bySeverity, byInstance, resolution] = await Promise.all([
      // 每日告警数
      db.execute(`SELECT TO_CHAR(TRIGGER_TIME,'YYYY-MM-DD') DT, COUNT(*) CNT
        FROM ALERT_RECORD WHERE TRIGGER_TIME >= SYSDATE-${days}
        GROUP BY TO_CHAR(TRIGGER_TIME,'YYYY-MM-DD') ORDER BY DT`, []),
      // 按级别分布
      db.execute(`SELECT SEVERITY, COUNT(*) CNT FROM ALERT_RECORD
        WHERE TRIGGER_TIME >= SYSDATE-${days} GROUP BY SEVERITY
        ORDER BY CASE SEVERITY WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 WHEN 'P3' THEN 3 ELSE 4 END`, []),
      // Top 5 告警实例
      db.execute(`SELECT i.INSTANCE_NAME, COUNT(*) CNT FROM ALERT_RECORD a
        LEFT JOIN CMDB_INSTANCE i ON a.INSTANCE_ID=i.INSTANCE_ID
        WHERE a.TRIGGER_TIME >= SYSDATE-${days}
        GROUP BY i.INSTANCE_NAME ORDER BY CNT DESC FETCH FIRST 5 ROWS ONLY`, []),
      // 解决率
      db.execute(`SELECT
        COUNT(*) TOTAL,
        SUM(CASE WHEN STATUS='RESOLVED' THEN 1 ELSE 0 END) RESOLVED,
        ROUND(SUM(CASE WHEN STATUS='RESOLVED' THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0)*100, 1) RESOLVE_RATE
        FROM ALERT_RECORD WHERE TRIGGER_TIME >= SYSDATE-${days}`, []),
    ]);
    res.json({
      code: 200,
      data: {
        days,
        byDay: byDay.rows || [],
        bySeverity: bySeverity.rows || [],
        byInstance: byInstance.rows || [],
        resolution: resolution.rows[0] || {},
      },
    });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// ─── F-61 容量分析 ───────────────────────────────────────────────
// GET /api/reports/capacity
router.get('/capacity', async (req, res) => {
  try {
    // 表空间 Top 10（最近采样）
    const tsSql = `SELECT * FROM (
      SELECT m.INSTANCE_ID, i.INSTANCE_NAME, m.TABLESPACE_NAME, m.TOTAL_GB, m.USED_GB, m.FREE_GB, m.USED_PCT, m.COLLECTED_AT,
        ROW_NUMBER() OVER (PARTITION BY m.INSTANCE_ID ORDER BY m.COLLECTED_AT DESC) RN
      FROM MONITOR_TABLESPACE_SAMPLE m
      LEFT JOIN CMDB_INSTANCE i ON m.INSTANCE_ID=i.INSTANCE_ID
      WHERE m.COLLECTED_AT >= SYSDATE-1
    ) WHERE RN=1 AND ROWNUM<=50`;
    let tablespaces = [];
    try {
      const r = await db.execute(tsSql, []);
      tablespaces = r.rows || [];
    } catch { /* table may not exist */ }

    // 实例连接数汇总
    const connSql = `SELECT i.INSTANCE_ID, i.INSTANCE_NAME, i.DB_TYPE,
      (SELECT MAX(TO_NUMBER(m.METRIC_VALUE)) FROM MONITOR_METRIC_SAMPLE m
        WHERE m.INSTANCE_ID=i.INSTANCE_ID AND m.COLLECTED_AT>=SYSDATE-1
        AND m.METRIC_NAME IN ('Current Logons Count','Threads_connected','pg_stat_database_numbackends')
      ) AS CONNECTIONS
      FROM CMDB_INSTANCE i WHERE i.STATUS='RUNNING'`;
    const connRes = await db.execute(connSql, []);

    // 高使用率表空间警告（>80%）
    const highUsage = tablespaces.filter(t => (t.USED_PCT || 0) >= 80)
      .sort((a, b) => (b.USED_PCT || 0) - (a.USED_PCT || 0));

    res.json({
      code: 200,
      data: {
        tablespaces,
        connections: connRes.rows || [],
        highUsage,
      },
    });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// ─── F-62 SQL 质量报表 ───────────────────────────────────────────
// GET /api/reports/sql-quality
router.get('/sql-quality', async (req, res) => {
  try {
    const [topSql, reviewStats, reviewByStatus] = await Promise.all([
      // Top 10 慢 SQL（来自 SQL_OPT_HISTORY）
      db.execute(`SELECT SQL_ID, SQL_TEXT, INSTANCE_ID, EXECUTIONS, ELAPSED_TIME_TOTAL, AVG_ELAPSED_MS, PARSING_SCHEMA_NAME
        FROM (SELECT * FROM SQL_OPT_HISTORY ORDER BY CREATED_AT DESC FETCH FIRST 20 ROWS)`, []).catch(() => ({ rows: [] })),
      // SQL 评审统计
      db.execute(`SELECT
        COUNT(*) TOTAL,
        SUM(CASE WHEN STATUS='APPROVED' THEN 1 ELSE 0 END) APPROVED,
        SUM(CASE WHEN STATUS='REJECTED' THEN 1 ELSE 0 END) REJECTED,
        ROUND(AVG(SCORE),1) AVG_SCORE
        FROM SQL_REVIEW_TICKET`, []).catch(() => ({ rows: [{}] })),
      // 评审状态分布
      db.execute(`SELECT STATUS, COUNT(*) CNT FROM SQL_REVIEW_TICKET GROUP BY STATUS`, []).catch(() => ({ rows: [] })),
    ]);
    res.json({
      code: 200,
      data: {
        topSql: topSql.rows || [],
        review: reviewStats.rows[0] || {},
        reviewByStatus: reviewByStatus.rows || [],
      },
    });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// ─── F-63 巡检报告汇总 ───────────────────────────────────────────
// GET /api/reports/inspect-summary
router.get('/inspect-summary', async (req, res) => {
  try {
    const [recent, byStatus] = await Promise.all([
      // 最近 10 份巡检报告
      db.execute(`SELECT REPORT_ID, TASK_ID, INSTANCE_ID, SCORE, RISK_LEVEL, CREATED_AT
        FROM INSPECT_REPORT ORDER BY CREATED_AT DESC FETCH FIRST 10 ROWS`, []).catch(() => ({ rows: [] })),
      // 巡检状态分布
      db.execute(`SELECT STATUS, COUNT(*) CNT FROM INSPECT_TASK GROUP BY STATUS`, []).catch(() => ({ rows: [] })),
    ]);
    res.json({
      code: 200,
      data: {
        recentReports: recent.rows || [],
        taskByStatus: byStatus.rows || [],
      },
    });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// ─── F-64 AI 分析报表 ────────────────────────────────────────────
// GET /api/reports/ai-stats
router.get('/ai-stats', async (req, res) => {
  try {
    const [rcaStats, anomalyStats, clusterStats, chatStats] = await Promise.all([
      // RCA 统计
      db.execute(`SELECT COUNT(*) TOTAL, ROUND(AVG(CONFIDENCE),1) AVG_CONFIDENCE
        FROM AI_RCA_RESULT`, []).catch(() => ({ rows: [{}] })),
      // 异常检测统计
      db.execute(`SELECT COUNT(*) TOTAL, SUM(CASE WHEN SEVERITY='CRITICAL' THEN 1 ELSE 0 END) CRITICAL_CNT
        FROM AI_ANOMALY_RECORD`, []).catch(() => ({ rows: [{}] })),
      // 聚类统计
      db.execute(`SELECT COUNT(*) TOTAL, SUM(CASE WHEN STATUS='ACTIVE' THEN 1 ELSE 0 END) ACTIVE_CNT
        FROM AI_ALERT_CLUSTER`, []).catch(() => ({ rows: [{}] })),
      // ChatOps 统计
      db.execute(`SELECT COUNT(DISTINCT SESSION_ID) SESSIONS, COUNT(*) MESSAGES
        FROM AI_CHAT_HISTORY`, []).catch(() => ({ rows: [{}] })),
    ]);
    // 最近 RCA 结果
    const recentRca = await db.execute(
      `SELECT RCA_ID, INSTANCE_ID, ROOT_CAUSE, CONFIDENCE, ANALYSIS_TIME
       FROM AI_RCA_RESULT ORDER BY ANALYSIS_TIME DESC FETCH FIRST 5 ROWS`, []).catch(() => ({ rows: [] }));
    res.json({
      code: 200,
      data: {
        rca: rcaStats.rows[0] || {},
        anomaly: anomalyStats.rows[0] || {},
        cluster: clusterStats.rows[0] || {},
        chat: chatStats.rows[0] || {},
        recentRca: recentRca.rows || [],
      },
    });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

module.exports = router;
