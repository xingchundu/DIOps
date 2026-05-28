/**
 * /api/custom-metrics/* — F-10 自定义监控项 API
 * 面板 CRUD + 指标 CRUD + 执行查询
 */
const router = require('express').Router();
const db = require('../config/db');
const { authMiddleware } = require('../middleware/auth');
const { evaluateExpression, executeCustomSql, executePanelMetrics } = require('../services/customMetricService');

router.use(authMiddleware);

// ─── 面板 CRUD ────────────────────────────────────────────────────

// GET /api/custom-metrics/panels — 面板列表
router.get('/panels', async (req, res) => {
  try {
    const { rows } = await db.execute(
      `SELECT p.*,
        (SELECT COUNT(*) FROM MONITOR_CUSTOM_METRIC m WHERE m.PANEL_ID = p.PANEL_ID) AS METRIC_COUNT
       FROM MONITOR_CUSTOM_PANEL p ORDER BY p.SORT_ORDER, p.CREATED_AT DESC`,
      []
    );
    res.json({ code: 200, data: rows });
  } catch (err) {
    if (/ORA-00942|942/.test(err.message || '')) return res.json({ code: 200, data: [] });
    res.json({ code: 500, msg: err.message });
  }
});

// GET /api/custom-metrics/panels/:id — 面板详情（含指标）
router.get('/panels/:id', async (req, res) => {
  try {
    const pRes = await db.execute(
      `SELECT * FROM MONITOR_CUSTOM_PANEL WHERE PANEL_ID = :1`, [req.params.id]
    );
    if (!pRes.rows.length) return res.json({ code: 404, msg: '面板不存在' });
    const mRes = await db.execute(
      `SELECT * FROM MONITOR_CUSTOM_METRIC WHERE PANEL_ID = :1 ORDER BY SORT_ORDER`, [req.params.id]
    );
    res.json({ code: 200, data: { ...pRes.rows[0], metrics: mRes.rows || [] } });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// POST /api/custom-metrics/panels — 创建面板
router.post('/panels', async (req, res) => {
  try {
    const { panelName, description, dbType, layoutJson, enabled, sortOrder } = req.body;
    if (!panelName) return res.json({ code: 400, msg: '面板名称必填' });
    const userId = req.user?.userId || req.user?.USER_ID || null;
    const r = await db.execute(
      `INSERT INTO MONITOR_CUSTOM_PANEL (PANEL_NAME, DESCRIPTION, DB_TYPE, LAYOUT_JSON, ENABLED, SORT_ORDER, CREATED_BY)
       VALUES (:1, :2, :3, :4, :5, :6, :7) RETURNING PANEL_ID INTO :8`,
      [panelName, description || null, dbType || null, layoutJson || null,
       enabled != null ? (enabled ? 1 : 0) : 1, sortOrder || 0, userId,
       { dir: require('oracledb').BIND_OUT, type: require('oracledb').NUMBER }]
    );
    res.json({ code: 200, data: { panelId: r.outBinds[0][0] }, msg: '创建成功' });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// PUT /api/custom-metrics/panels/:id — 更新面板
router.put('/panels/:id', async (req, res) => {
  try {
    const { panelName, description, dbType, layoutJson, enabled, sortOrder } = req.body;
    await db.execute(
      `UPDATE MONITOR_CUSTOM_PANEL SET PANEL_NAME=NVL(:1,PANEL_NAME), DESCRIPTION=:2, DB_TYPE=:3,
       LAYOUT_JSON=:4, ENABLED=NVL(:5,ENABLED), SORT_ORDER=NVL(:6,SORT_ORDER), UPDATED_AT=SYSTIMESTAMP
       WHERE PANEL_ID=:7`,
      [panelName || null, description != null ? description : null, dbType || null,
       layoutJson || null, enabled != null ? (enabled ? 1 : 0) : null, sortOrder != null ? sortOrder : null,
       req.params.id]
    );
    res.json({ code: 200, msg: '更新成功' });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// DELETE /api/custom-metrics/panels/:id — 删除面板（级联删除指标）
router.delete('/panels/:id', async (req, res) => {
  try {
    await db.execute(`DELETE FROM MONITOR_CUSTOM_PANEL WHERE PANEL_ID = :1`, [req.params.id]);
    res.json({ code: 200, msg: '删除成功' });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// ─── 指标 CRUD ────────────────────────────────────────────────────

// POST /api/custom-metrics/metrics — 创建指标
router.post('/metrics', async (req, res) => {
  try {
    const { panelId, metricName, metricLabel, metricType, sqlText, dbType, expression,
            instanceId, chartType, unit, thresholdWarn, thresholdCrit, color, sortOrder } = req.body;
    if (!panelId || !metricName) return res.json({ code: 400, msg: '面板ID和指标名必填' });
    const r = await db.execute(
      `INSERT INTO MONITOR_CUSTOM_METRIC
       (PANEL_ID, METRIC_NAME, METRIC_LABEL, METRIC_TYPE, SQL_TEXT, DB_TYPE, EXPRESSION,
        INSTANCE_ID, CHART_TYPE, UNIT, THRESHOLD_WARN, THRESHOLD_CRIT, COLOR, SORT_ORDER)
       VALUES (:1,:2,:3,:4,:5,:6,:7,:8,:9,:10,:11,:12,:13,:14)
       RETURNING METRIC_ID INTO :15`,
      [panelId, metricName, metricLabel || null, metricType || 'SQL',
       sqlText || null, dbType || null, expression || null,
       instanceId || null, chartType || 'gauge', unit || null,
       thresholdWarn || null, thresholdCrit || null, color || null, sortOrder || 0,
       { dir: require('oracledb').BIND_OUT, type: require('oracledb').NUMBER }]
    );
    res.json({ code: 200, data: { metricId: r.outBinds[0][0] }, msg: '创建成功' });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// PUT /api/custom-metrics/metrics/:id — 更新指标
router.put('/metrics/:id', async (req, res) => {
  try {
    const { metricName, metricLabel, metricType, sqlText, dbType, expression,
            instanceId, chartType, unit, thresholdWarn, thresholdCrit, color, sortOrder, enabled } = req.body;
    await db.execute(
      `UPDATE MONITOR_CUSTOM_METRIC SET
       METRIC_NAME=NVL(:1,METRIC_NAME), METRIC_LABEL=:2, METRIC_TYPE=NVL(:3,METRIC_TYPE),
       SQL_TEXT=:4, DB_TYPE=:5, EXPRESSION=:6, INSTANCE_ID=:7,
       CHART_TYPE=NVL(:8,CHART_TYPE), UNIT=:9,
       THRESHOLD_WARN=:10, THRESHOLD_CRIT=:11, COLOR=:12,
       SORT_ORDER=NVL(:13,SORT_ORDER), ENABLED=NVL(:14,ENABLED)
       WHERE METRIC_ID=:15`,
      [metricName || null, metricLabel || null, metricType || null,
       sqlText || null, dbType || null, expression || null, instanceId || null,
       chartType || null, unit || null,
       thresholdWarn != null ? thresholdWarn : null, thresholdCrit != null ? thresholdCrit : null,
       color || null, sortOrder != null ? sortOrder : null,
       enabled != null ? (enabled ? 1 : 0) : null, req.params.id]
    );
    res.json({ code: 200, msg: '更新成功' });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// DELETE /api/custom-metrics/metrics/:id — 删除指标
router.delete('/metrics/:id', async (req, res) => {
  try {
    await db.execute(`DELETE FROM MONITOR_CUSTOM_METRIC WHERE METRIC_ID = :1`, [req.params.id]);
    res.json({ code: 200, msg: '删除成功' });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// ─── 执行查询 ─────────────────────────────────────────────────────

// POST /api/custom-metrics/execute — 执行单个指标
router.post('/execute', async (req, res) => {
  try {
    const { metricType, sqlText, expression, instanceId, dbType } = req.body;
    if (metricType === 'EXPRESSION') {
      if (!expression || !instanceId) return res.json({ code: 400, msg: 'EXPRESSION 类型需要 expression 和 instanceId' });
      const result = await evaluateExpression(instanceId, expression, req.body.hours || 24);
      res.json({ code: 200, data: result });
    } else if (metricType === 'SQL') {
      if (!sqlText || !instanceId) return res.json({ code: 400, msg: 'SQL 类型需要 sqlText 和 instanceId' });
      const result = await executeCustomSql(instanceId, sqlText);
      res.json({ code: 200, data: result });
    } else {
      res.json({ code: 400, msg: 'metricType 必须为 SQL 或 EXPRESSION' });
    }
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// GET /api/custom-metrics/panels/:id/execute — 执行面板所有指标
router.get('/panels/:id/execute', async (req, res) => {
  try {
    const results = await executePanelMetrics(req.params.id);
    res.json({ code: 200, data: results });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// GET /api/custom-metrics/instances — 可用实例列表（用于指标配置选择）
router.get('/instances', async (req, res) => {
  try {
    const { rows } = await db.execute(
      `SELECT INSTANCE_ID, INSTANCE_NAME, DB_TYPE, HOST_IP, PORT, STATUS
       FROM CMDB_INSTANCE ORDER BY INSTANCE_NAME`, []
    );
    res.json({ code: 200, data: rows });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// GET /api/custom-metrics/available-metrics — 采集指标名列表（供表达式配置选择）
router.get('/available-metrics', async (req, res) => {
  try {
    // 顶层列指标
    const columnMetrics = [
      { name: 'METRIC_CPU', label: 'CPU (归一化)', dbType: 'ALL' },
      { name: 'METRIC_CONN', label: '连接数 (归一化)', dbType: 'ALL' },
      { name: 'HEALTH_SCORE', label: '健康分', dbType: 'ALL' },
    ];
    // 从最近采样中提取 METRICS_JSON 里的指标名
    let jsonMetrics = [];
    try {
      const r = await db.execute(
        `SELECT DISTINCT METRIC_NAME FROM (
           SELECT m.METRICS_JSON, ROW_NUMBER() OVER (ORDER BY COLLECTED_AT DESC) AS rn
           FROM MONITOR_METRIC_SAMPLE m WHERE m.METRICS_JSON IS NOT NULL
         ) t, JSON_TABLE(t.METRICS_JSON, '$.metrics[*]' COLUMNS (METRIC_NAME VARCHAR2(128) PATH '$.METRIC_NAME'))
         WHERE rn <= 20 AND METRIC_NAME IS NOT NULL`,
        []
      );
      jsonMetrics = (r.rows || []).map(r => ({ name: r.METRIC_NAME, label: r.METRIC_NAME, dbType: 'JSON' }));
    } catch {
      // JSON_TABLE 可能不支持，回退到应用层解析
      try {
        const r = await db.execute(
          `SELECT METRICS_JSON FROM (
             SELECT METRICS_JSON, ROW_NUMBER() OVER (ORDER BY COLLECTED_AT DESC) AS rn
             FROM MONITOR_METRIC_SAMPLE WHERE METRICS_JSON IS NOT NULL
           ) WHERE rn <= 5`, []
        );
        const names = new Set();
        for (const row of (r.rows || [])) {
          try {
            const parsed = JSON.parse(row.METRICS_JSON);
            (parsed.metrics || []).forEach(m => { if (m.METRIC_NAME) names.add(m.METRIC_NAME); });
          } catch {}
        }
        jsonMetrics = [...names].map(n => ({ name: n, label: n, dbType: 'JSON' }));
      } catch {}
    }

    res.json({ code: 200, data: { columnMetrics, jsonMetrics } });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

module.exports = router;
