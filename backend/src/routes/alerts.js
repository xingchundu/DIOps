const router = require('express').Router();
const db = require('../config/db');
const { authMiddleware, requireRole } = require('../middleware/auth');

router.use(authMiddleware);
const adminDba = requireRole('ADMIN', 'DBA');

// GET /api/alerts  告警列表
router.get('/', async (req, res) => {
  const { status, severity, instanceId, page=1, size=20 } = req.query;
  try {
    let where = ['1=1']; let binds=[]; let bi=1;
    if (status)     { where.push(`STATUS=:${bi}`);      binds.push(status); bi++; }
    if (severity)   { where.push(`SEVERITY=:${bi}`);    binds.push(severity); bi++; }
    if (instanceId) { where.push(`INSTANCE_ID=:${bi}`); binds.push(Number(instanceId)); bi++; }
    const sql = `SELECT * FROM ALERT_RECORD WHERE ${where.join(' AND ')} ORDER BY TRIGGER_TIME DESC`;
    const data = await db.queryPage(sql, binds, page, size);
    res.json({ code:200, data });
  } catch(err){ res.json({code:500,msg:err.message}); }
});

// GET /api/alerts/stats
router.get('/stats', async (req, res) => {
  try {
    const [byStatus, bySeverity, trend] = await Promise.all([
      db.execute(`SELECT STATUS, COUNT(*) CNT FROM ALERT_RECORD GROUP BY STATUS`,[]),
      db.execute(`SELECT SEVERITY, COUNT(*) CNT FROM ALERT_RECORD WHERE STATUS='OPEN' GROUP BY SEVERITY`,[]),
      db.execute(`SELECT TO_CHAR(TRIGGER_TIME,'YYYY-MM-DD') DT, COUNT(*) CNT
                  FROM ALERT_RECORD WHERE TRIGGER_TIME >= SYSDATE-7 GROUP BY TO_CHAR(TRIGGER_TIME,'YYYY-MM-DD')
                  ORDER BY DT`,[]),
    ]);
    res.json({ code:200, data:{ byStatus:byStatus.rows, bySeverity:bySeverity.rows, trend:trend.rows }});
  } catch(err){ res.json({code:500,msg:err.message}); }
});

// POST /api/alerts/:id/ack  确认告警
router.post('/:id/ack', async (req, res) => {
  try {
    const check = await db.execute(`SELECT STATUS FROM ALERT_RECORD WHERE ALERT_ID=:1`, [req.params.id]);
    if (!check.rows.length) return res.json({ code:404, msg:'告警不存在' });
    if (check.rows[0].STATUS === 'RESOLVED') return res.json({ code:400, msg:'告警已解决，无需确认' });
    await db.execute(
      `UPDATE ALERT_RECORD SET STATUS='ACKNOWLEDGED',ACK_TIME=SYSTIMESTAMP,ACK_BY=:1 WHERE ALERT_ID=:2 AND STATUS<>'RESOLVED'`,
      [req.user.username, req.params.id]
    );
    res.json({ code:200, msg:'告警已确认' });
  } catch(err){ res.json({code:500,msg:err.message}); }
});

// GET /api/alerts/rules  告警规则
router.get('/rules', async (req, res) => {
  try {
    const r = await db.execute(`SELECT * FROM ALERT_RULE ORDER BY RULE_ID`,[]);
    res.json({ code:200, data: r.rows });
  } catch(err){ res.json({code:500,msg:err.message}); }
});

// POST /api/alerts/rules  创建告警规则
router.post('/rules', async (req, res) => {
  const { ruleName,ruleType,metric,operator,threshold,duration,severity,dbType,instanceId,promql,notifyChan,notifyTo } = req.body;
  if (!ruleName || !metric) return res.json({ code:400, msg:'规则名称和监控指标不能为空' });
  if (operator && !['gt','lt','gte','lte'].includes(operator)) return res.json({ code:400, msg:'运算符无效' });
  if (threshold != null && isNaN(Number(threshold))) return res.json({ code:400, msg:'阈值必须为数字' });
  try {
    await db.execute(
      `INSERT INTO ALERT_RULE(RULE_NAME,RULE_TYPE,METRIC,OPERATOR,THRESHOLD,DURATION,SEVERITY,DB_TYPE,INSTANCE_ID,PROMQL,NOTIFY_CHAN,NOTIFY_TO,CREATED_BY)
       VALUES(:1,:2,:3,:4,:5,:6,:7,:8,:9,:10,:11,:12,:13)`,
      [ruleName,ruleType||'THRESHOLD',metric,operator,threshold,duration||5,severity||'P3',dbType,instanceId,promql,notifyChan,notifyTo,req.user.userId]
    );
    res.json({ code:200, msg:'告警规则创建成功' });
  } catch(err){ res.json({code:500,msg:err.message}); }
});

// DELETE /api/alerts/rules/:id
router.delete('/rules/:id', async (req, res) => {
  try {
    const r = await db.execute(`DELETE FROM ALERT_RULE WHERE RULE_ID=:1`, [req.params.id]);
    if (r.rowsAffected === 0) return res.json({ code:404, msg:'规则不存在' });
    res.json({ code:200, msg:'规则已删除' });
  } catch(err){ res.json({code:500,msg:err.message}); }
});

// PUT /api/alerts/rules/:id
router.put('/rules/:id', async (req, res) => {
  const { ruleName,operator,threshold,duration,severity,enabled,notifyChan,notifyTo } = req.body;
  try {
    await db.execute(
      `UPDATE ALERT_RULE SET RULE_NAME=:1,OPERATOR=:2,THRESHOLD=:3,DURATION=:4,SEVERITY=:5,ENABLED=:6,NOTIFY_CHAN=:7,NOTIFY_TO=:8 WHERE RULE_ID=:9`,
      [ruleName,operator,threshold,duration,severity,enabled?1:0,notifyChan,notifyTo,req.params.id]
    );
    res.json({ code:200, msg:'更新成功' });
  } catch(err){ res.json({code:500,msg:err.message}); }
});

// ─── F-17 告警抑制规则 CRUD ─────────────────────────────────

// GET /api/alerts/suppression-rules
router.get('/suppression-rules', async (req, res) => {
  try {
    const { rows } = await db.execute(
      `SELECT r.*,
              (SELECT COUNT(*) FROM ALERT_SUPPRESSION s WHERE s.RULE_ID = r.RULE_ID AND s.STATUS = 'ACTIVE') AS ACTIVE_COUNT
       FROM ALERT_SUPPRESSION_RULE r ORDER BY r.RULE_ID`, []);
    res.json({ code: 200, data: rows });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// POST /api/alerts/suppression-rules
router.post('/suppression-rules', async (req, res) => {
  try {
    const { ruleName, ruleType, description, parentLevels, childLevels, suppressWindow, autoRelease } = req.body;
    if (!ruleName || !ruleType) return res.json({ code: 400, msg: '规则名称和类型不能为空' });
    await db.execute(
      `INSERT INTO ALERT_SUPPRESSION_RULE (RULE_NAME, RULE_TYPE, DESCRIPTION, PARENT_LEVELS, CHILD_LEVELS, SUPPRESS_WINDOW, AUTO_RELEASE, CREATED_BY)
       VALUES (:1, :2, :3, :4, :5, :6, :7, :8)`,
      [ruleName, ruleType, description || null, parentLevels || 'P1,P2', childLevels || 'P2,P3,P4', suppressWindow || 60, autoRelease != null ? autoRelease : 1, req.user.username]);
    res.json({ code: 200, msg: '创建成功' });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// PUT /api/alerts/suppression-rules/:id
router.put('/suppression-rules/:id', async (req, res) => {
  try {
    const { ruleName, description, parentLevels, childLevels, suppressWindow, autoRelease, enabled } = req.body;
    await db.execute(
      `UPDATE ALERT_SUPPRESSION_RULE SET
         RULE_NAME=NVL(:1,RULE_NAME), DESCRIPTION=:2, PARENT_LEVELS=NVL(:3,PARENT_LEVELS),
         CHILD_LEVELS=NVL(:4,CHILD_LEVELS), SUPPRESS_WINDOW=NVL(:5,SUPPRESS_WINDOW),
         AUTO_RELEASE=NVL(:6,AUTO_RELEASE), ENABLED=NVL(:7,ENABLED),
         UPDATED_AT=SYSTIMESTAMP WHERE RULE_ID=:8`,
      [ruleName, description || null, parentLevels, childLevels, suppressWindow, autoRelease, enabled, req.params.id]);
    res.json({ code: 200, msg: '更新成功' });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// DELETE /api/alerts/suppression-rules/:id
router.delete('/suppression-rules/:id', adminDba, async (req, res) => {
  try {
    await db.execute('DELETE FROM ALERT_SUPPRESSION_RULE WHERE RULE_ID = :1', [req.params.id]);
    res.json({ code: 200, msg: '删除成功' });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// ─── F-17 告警抑制核心逻辑 ─────────────────────────────────

/**
 * 检查新告警是否应被抑制
 * 调用时机：新告警创建后
 * 逻辑：
 *  1. 查找该告警所属实例的 HOST_ID
 *  2. 查找该主机上是否有活跃的高级别告警（TOPOLOGY: host→instance）
 *  3. 查找依赖该实例的应用，以及这些应用是否有活跃告警（TOPOLOGY: instance→app 反向）
 *  4. 查找同集群的 PRIMARY 节点是否有活跃告警（CLUSTER）
 *  5. 查找同实例是否有更高级别的活跃告警（SEVERITY）
 */
async function checkSuppressionForAlert(alertId) {
  try {
    // 获取告警详情
    const alertRes = await db.execute(
      `SELECT ALERT_ID, INSTANCE_ID, INSTANCE_NAME, SEVERITY, RULE_NAME, TRIGGER_TIME FROM ALERT_RECORD WHERE ALERT_ID = :1`, [alertId]);
    if (!alertRes.rows.length) return;
    const alert = alertRes.rows[0];
    if (!alert.INSTANCE_ID) return;

    // 获取实例的主机信息
    const instRes = await db.execute(
      `SELECT HOST_IP, HOST_ID FROM CMDB_INSTANCE WHERE INSTANCE_ID = :1`, [alert.INSTANCE_ID]);
    if (!instRes.rows.length) return;
    const instance = instRes.rows[0];

    // 获取所有启用的抑制规则
    const rulesRes = await db.execute(
      `SELECT * FROM ALERT_SUPPRESSION_RULE WHERE ENABLED = 1`, []);
    const rules = rulesRes.rows;

    for (const rule of rules) {
      const parentLevels = (rule.PARENT_LEVELS || '').split(',').map(s => s.trim());
      const childLevels = (rule.CHILD_LEVELS || '').split(',').map(s => s.trim());

      // 当前告警必须在 childLevels 中才可能被抑制
      if (!childLevels.includes(alert.SEVERITY)) continue;

      const sysConfig = require('../services/systemConfig');
      const defaultSuppressionWindow = await sysConfig.getNumber('alert.suppression.default_window_min', 60);
      const windowMinutes = rule.SUPPRESS_WINDOW || defaultSuppressionWindow;
      let parentAlerts = [];

      if (rule.RULE_TYPE === 'TOPOLOGY') {
        // 拓扑级联：主机→实例 或 实例→应用
        // 查找同一主机上更早的活跃高级别告警
        const { rows } = await db.execute(
          `SELECT ALERT_ID, SEVERITY, CONTENT, INSTANCE_NAME
           FROM ALERT_RECORD
           WHERE INSTANCE_ID IN (SELECT INSTANCE_ID FROM CMDB_INSTANCE WHERE HOST_IP = :1)
             AND ALERT_ID <> :2
             AND STATUS IN ('OPEN', 'ACKNOWLEDGED', 'SUPPRESSED')
             AND SEVERITY IN (${parentLevels.map((_, i) => ':' + (i + 3)).join(',')})
             AND TRIGGER_TIME >= SYSTIMESTAMP - NUMTODSINTERVAL(:${parentLevels.length + 3}, 'MINUTE')
           ORDER BY TRIGGER_TIME DESC`,
          [instance.HOST_IP, alertId, ...parentLevels, windowMinutes]);
        parentAlerts = rows;

        // 如果主机级没找到，查找依赖该实例的父实例告警（instance→app反向）
        if (!parentAlerts.length && alert.INSTANCE_ID) {
          // 查找该实例作为被依赖方，依赖方实例是否有活跃告警
          const { rows: appRows } = await db.execute(
            `SELECT ar.ALERT_ID, ar.SEVERITY, ar.CONTENT, ar.INSTANCE_NAME
             FROM CMDB_APP_DB_RELATION rel
             JOIN ALERT_RECORD ar ON ar.INSTANCE_ID = rel.INSTANCE_ID
             WHERE rel.INSTANCE_ID <> :1
               AND ar.STATUS IN ('OPEN', 'ACKNOWLEDGED', 'SUPPRESSED')
               AND ar.SEVERITY IN (${parentLevels.map((_, i) => ':' + (i + 2)).join(',')})
               AND ar.TRIGGER_TIME >= SYSTIMESTAMP - NUMTODSINTERVAL(:${parentLevels.length + 2}, 'MINUTE')
               AND ar.ALERT_ID <> :${parentLevels.length + 3}`,
            [alert.INSTANCE_ID, ...parentLevels, windowMinutes, alertId]);
          parentAlerts = appRows;
        }
      } else if (rule.RULE_TYPE === 'CLUSTER') {
        // 集群抑制：查找同集群 PRIMARY 节点的活跃告警
        const { rows } = await db.execute(
          `SELECT ar.ALERT_ID, ar.SEVERITY, ar.CONTENT, ar.INSTANCE_NAME
           FROM CMDB_CLUSTER_MEMBER cm1
           JOIN CMDB_CLUSTER_MEMBER cm2 ON cm1.CLUSTER_ID = cm2.CLUSTER_ID
           JOIN ALERT_RECORD ar ON ar.INSTANCE_ID = cm2.INSTANCE_ID
           WHERE cm1.INSTANCE_ID = :1
             AND cm2.NODE_ROLE = 'PRIMARY'
             AND cm2.INSTANCE_ID <> :1
             AND ar.STATUS IN ('OPEN', 'ACKNOWLEDGED', 'SUPPRESSED')
             AND ar.SEVERITY IN (${parentLevels.map((_, i) => ':' + (i + 2)).join(',')})
             AND ar.TRIGGER_TIME >= SYSTIMESTAMP - NUMTODSINTERVAL(:${parentLevels.length + 2}, 'MINUTE')
             AND ar.ALERT_ID <> :${parentLevels.length + 3}`,
          [alert.INSTANCE_ID, ...parentLevels, windowMinutes, alertId]);
        parentAlerts = rows;
      } else if (rule.RULE_TYPE === 'SEVERITY') {
        // 级别抑制：同实例更高级别的活跃告警
        const { rows } = await db.execute(
          `SELECT ALERT_ID, SEVERITY, CONTENT, INSTANCE_NAME
           FROM ALERT_RECORD
           WHERE INSTANCE_ID = :1
             AND ALERT_ID <> :2
             AND STATUS IN ('OPEN', 'ACKNOWLEDGED', 'SUPPRESSED')
             AND SEVERITY IN (${parentLevels.map((_, i) => ':' + (i + 3)).join(',')})
             AND TRIGGER_TIME >= SYSTIMESTAMP - NUMTODSINTERVAL(:${parentLevels.length + 3}, 'MINUTE')
           ORDER BY TRIGGER_TIME DESC`,
          [alert.INSTANCE_ID, alertId, ...parentLevels, windowMinutes]);
        parentAlerts = rows;
      } else if (rule.RULE_TYPE === 'INSTANCE') {
        // 同实例抑制：同实例的任何活跃高级别告警
        const { rows } = await db.execute(
          `SELECT ALERT_ID, SEVERITY, CONTENT, INSTANCE_NAME
           FROM ALERT_RECORD
           WHERE INSTANCE_ID = :1
             AND ALERT_ID <> :2
             AND STATUS IN ('OPEN', 'ACKNOWLEDGED', 'SUPPRESSED')
             AND SEVERITY IN (${parentLevels.map((_, i) => ':' + (i + 3)).join(',')})
             AND TRIGGER_TIME >= SYSTIMESTAMP - NUMTODSINTERVAL(:${parentLevels.length + 3}, 'MINUTE')
           ORDER BY TRIGGER_TIME DESC`,
          [alert.INSTANCE_ID, alertId, ...parentLevels, windowMinutes]);
        parentAlerts = rows;
      }

      // 找到父告警，执行抑制
      if (parentAlerts.length > 0) {
        const parentId = parentAlerts[0].ALERT_ID;
        // 更新子告警状态
        await db.execute(
          `UPDATE ALERT_RECORD SET STATUS='SUPPRESSED', SUPPRESSED_BY_ID=:1, SUPPRESSED_AT=SYSTIMESTAMP, SUPPRESSION_RULE=:2
           WHERE ALERT_ID=:3 AND STATUS NOT IN ('RESOLVED')`,
          [parentId, rule.RULE_NAME, alertId]);
        // 插入抑制记录（忽略重复）
        try {
          await db.execute(
            `INSERT INTO ALERT_SUPPRESSION (PARENT_ALERT_ID, CHILD_ALERT_ID, RULE_ID, SUPPRESSION_TYPE)
             SELECT :1, :2, :3, :4 FROM DUAL
             WHERE NOT EXISTS (SELECT 1 FROM ALERT_SUPPRESSION WHERE PARENT_ALERT_ID=:1 AND CHILD_ALERT_ID=:2)`,
            [parentId, alertId, rule.RULE_ID, rule.RULE_TYPE]);
        } catch { /* duplicate skip */ }
        return; // 命中第一条规则即停止
      }
    }
  } catch (err) {
    console.error('[alert-suppression] checkSuppressionForAlert error:', err.message);
  }
}

/**
 * 父告警解决时，自动解除被其抑制的子告警
 */
async function releaseSuppressedChildren(parentAlertId) {
  try {
    // 查找被此父告警抑制的子告警
    const { rows } = await db.execute(
      `SELECT s.ID, s.CHILD_ALERT_ID, s.RULE_ID
       FROM ALERT_SUPPRESSION s
       WHERE s.PARENT_ALERT_ID = :1 AND s.STATUS = 'ACTIVE'`, [parentAlertId]);

    for (const sup of rows) {
      // 检查子告警是否还被其他父告警抑制
      const otherParent = await db.execute(
        `SELECT COUNT(*) AS CNT FROM ALERT_SUPPRESSION
         WHERE CHILD_ALERT_ID = :1 AND STATUS = 'ACTIVE' AND PARENT_ALERT_ID <> :2`,
        [sup.CHILD_ALERT_ID, parentAlertId]);

      if (otherParent.rows[0].CNT === 0) {
        // 没有其他父告警，解除抑制，恢复为 OPEN
        await db.execute(
          `UPDATE ALERT_RECORD SET STATUS='OPEN', SUPPRESSED_BY_ID=NULL, SUPPRESSED_AT=NULL, SUPPRESSION_RULE=NULL
           WHERE ALERT_ID=:1 AND STATUS='SUPPRESSED'`,
          [sup.CHILD_ALERT_ID]);
      }

      // 标记抑制记录为已释放
      await db.execute(
        `UPDATE ALERT_SUPPRESSION SET STATUS='RELEASED', RELEASED_AT=SYSTIMESTAMP WHERE ID=:1`,
        [sup.ID]);
    }
  } catch (err) {
    console.error('[alert-suppression] releaseSuppressedChildren error:', err.message);
  }
}

// POST /api/alerts/check-suppression — 检查指定告警是否应被抑制
router.post('/check-suppression', async (req, res) => {
  try {
    const { alertId } = req.body;
    if (!alertId) return res.json({ code: 400, msg: 'alertId 不能为空' });
    await checkSuppressionForAlert(alertId);
    res.json({ code: 200, msg: '抑制检查完成' });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// POST /api/alerts/batch-check-suppression — 批量检查所有 OPEN 告警的抑制状态
router.post('/batch-check-suppression', async (req, res) => {
  try {
    const { rows } = await db.execute(
      `SELECT ALERT_ID FROM ALERT_RECORD WHERE STATUS = 'OPEN' ORDER BY TRIGGER_TIME DESC`, []);
    let checked = 0;
    for (const row of rows) {
      await checkSuppressionForAlert(row.ALERT_ID);
      checked++;
    }
    res.json({ code: 200, msg: `批量检查完成: ${checked} 条`, data: { checked } });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// GET /api/alerts/:id/suppressed-by — 获取抑制此告警的父告警
router.get('/:id/suppressed-by', async (req, res) => {
  try {
    const { rows } = await db.execute(
      `SELECT s.*, ar.RULE_NAME AS PARENT_RULE_NAME, ar.SEVERITY AS PARENT_SEVERITY,
              ar.CONTENT AS PARENT_CONTENT, ar.INSTANCE_NAME AS PARENT_INSTANCE,
              ar.STATUS AS PARENT_STATUS, ar.TRIGGER_TIME AS PARENT_TRIGGER_TIME
       FROM ALERT_SUPPRESSION s
       JOIN ALERT_RECORD ar ON s.PARENT_ALERT_ID = ar.ALERT_ID
       WHERE s.CHILD_ALERT_ID = :1 AND s.STATUS = 'ACTIVE'`, [req.params.id]);
    res.json({ code: 200, data: rows });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// GET /api/alerts/:id/suppressing — 获取此告警正在抑制的子告警
router.get('/:id/suppressing', async (req, res) => {
  try {
    const { rows } = await db.execute(
      `SELECT s.*, ar.RULE_NAME AS CHILD_RULE_NAME, ar.SEVERITY AS CHILD_SEVERITY,
              ar.CONTENT AS CHILD_CONTENT, ar.INSTANCE_NAME AS CHILD_INSTANCE,
              ar.STATUS AS CHILD_STATUS, ar.TRIGGER_TIME AS CHILD_TRIGGER_TIME
       FROM ALERT_SUPPRESSION s
       JOIN ALERT_RECORD ar ON s.CHILD_ALERT_ID = ar.ALERT_ID
       WHERE s.PARENT_ALERT_ID = :1 AND s.STATUS = 'ACTIVE'`, [req.params.id]);
    res.json({ code: 200, data: rows });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// POST /api/alerts/:id/unsuppress — 手动解除抑制
router.post('/:id/unsuppress', async (req, res) => {
  try {
    const check = await db.execute(
      `SELECT STATUS, SUPPRESSED_BY_ID FROM ALERT_RECORD WHERE ALERT_ID = :1`, [req.params.id]);
    if (!check.rows.length) return res.json({ code: 404, msg: '告警不存在' });
    if (check.rows[0].STATUS !== 'SUPPRESSED') return res.json({ code: 400, msg: '该告警未被抑制' });

    const reason = req.body?.reason || '手动解除';
    // 恢复告警状态
    await db.execute(
      `UPDATE ALERT_RECORD SET STATUS='OPEN', SUPPRESSED_BY_ID=NULL, SUPPRESSED_AT=NULL, SUPPRESSION_RULE=NULL
       WHERE ALERT_ID=:1`, [req.params.id]);
    // 标记抑制记录为已释放
    await db.execute(
      `UPDATE ALERT_SUPPRESSION SET STATUS='RELEASED', RELEASED_AT=SYSTIMESTAMP, RELEASED_BY=:1, RELEASE_REASON=:2
       WHERE CHILD_ALERT_ID=:3 AND STATUS='ACTIVE'`,
      [req.user.username, reason, req.params.id]);

    res.json({ code: 200, msg: '抑制已解除' });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// GET /api/alerts/suppression-stats — 告警抑制统计
router.get('/suppression-stats', async (req, res) => {
  try {
    const [active, released, byType, topParents] = await Promise.all([
      db.execute(`SELECT COUNT(*) AS CNT FROM ALERT_SUPPRESSION WHERE STATUS = 'ACTIVE'`, []),
      db.execute(`SELECT COUNT(*) AS CNT FROM ALERT_SUPPRESSION WHERE STATUS = 'RELEASED'`, []),
      db.execute(
        `SELECT SUPPRESSION_TYPE, COUNT(*) AS CNT FROM ALERT_SUPPRESSION WHERE STATUS = 'ACTIVE' GROUP BY SUPPRESSION_TYPE`, []),
      db.execute(
        `SELECT s.PARENT_ALERT_ID, ar.RULE_NAME, ar.SEVERITY, ar.INSTANCE_NAME, ar.CONTENT,
                COUNT(*) AS CHILD_COUNT
         FROM ALERT_SUPPRESSION s
         JOIN ALERT_RECORD ar ON s.PARENT_ALERT_ID = ar.ALERT_ID
         WHERE s.STATUS = 'ACTIVE'
         GROUP BY s.PARENT_ALERT_ID, ar.RULE_NAME, ar.SEVERITY, ar.INSTANCE_NAME, ar.CONTENT
         ORDER BY CHILD_COUNT DESC FETCH FIRST 5 ROWS ONLY`, []),
    ]);
    res.json({
      code: 200,
      data: {
        activeSuppressions: active.rows[0].CNT,
        releasedSuppressions: released.rows[0].CNT,
        byType: byType.rows,
        topParents: topParents.rows,
      }
    });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// 修改 POST /api/alerts/:id/resolve — 解决告警时自动解除被抑制的子告警
router.post('/:id/resolve', async (req, res) => {
  try {
    const check = await db.execute(`SELECT STATUS FROM ALERT_RECORD WHERE ALERT_ID=:1`, [req.params.id]);
    if (!check.rows.length) return res.json({ code:404, msg:'告警不存在' });
    await db.execute(
      `UPDATE ALERT_RECORD SET STATUS='RESOLVED',RESOLVE_TIME=SYSTIMESTAMP,RESOLVE_BY=:1 WHERE ALERT_ID=:2`,
      [req.user.username, req.params.id]
    );
    // 自动解除被此告警抑制的子告警
    await releaseSuppressedChildren(req.params.id);
    res.json({ code:200, msg:'告警已解决' });
  } catch(err){ res.json({code:500,msg:err.message}); }
});

// ─── F-22 智能优先级排序 ─────────────────────────────────────

// GET /api/alerts/smart-priority — 计算告警智能优先级分数
// 因素：严重度(40%) + 业务影响(20%) + 持续时长(20%) + 实例健康分(10%) + 依赖影响(10%)
router.get('/smart-priority', async (req, res) => {
  try {
    const { alertIds } = req.query; // 逗号分隔的 alert ID
    let alerts;
    if (alertIds) {
      const ids = String(alertIds).split(',').map(Number).filter(Boolean);
      if (!ids.length) return res.json({ code: 400, msg: 'alertIds 格式错误' });
      const { rows } = await db.execute(
        `SELECT ALERT_ID, INSTANCE_ID, SEVERITY, STATUS, TRIGGER_TIME, RULE_NAME, CONTENT
         FROM ALERT_RECORD WHERE ALERT_ID IN (${ids.map((_, i) => ':' + (i + 1)).join(',')})`, ids);
      alerts = rows;
    } else {
      const { rows } = await db.execute(
        `SELECT ALERT_ID, INSTANCE_ID, SEVERITY, STATUS, TRIGGER_TIME, RULE_NAME, CONTENT
         FROM ALERT_RECORD WHERE STATUS IN ('OPEN', 'ACKNOWLEDGED', 'SUPPRESSED')
         ORDER BY TRIGGER_TIME DESC FETCH FIRST 50 ROWS ONLY`, []);
      alerts = rows;
    }

    const results = [];
    for (const alert of alerts) {
      let score = 0;
      const factors = {};

      // 1. 严重度基础分 (40%)
      const severityScore = { P1: 100, P2: 75, P3: 50, P4: 25 }[alert.SEVERITY] || 30;
      score += severityScore * 0.4;
      factors.severity = { score: severityScore, weight: '40%', level: alert.SEVERITY };

      // 2. 业务影响 (20%) - 基于标签中的核心/重要标记
      let bizScore = 50; // 默认中等
      if (alert.INSTANCE_ID) {
        try {
          const tagRes = await db.execute(
            `SELECT t.TAG_NAME FROM CMDB_INSTANCE_TAG it
             JOIN CMDB_TAG t ON it.TAG_ID = t.TAG_ID
             WHERE it.INSTANCE_ID = :1`, [alert.INSTANCE_ID]);
          const tagNames = tagRes.rows.map(r => r.TAG_NAME);
          if (tagNames.includes('核心')) bizScore = 100;
          else if (tagNames.includes('重要')) bizScore = 75;
          else if (tagNames.includes('一般')) bizScore = 30;
          factors.businessTags = tagNames;
        } catch { /* tag table may not exist */ }
      }
      score += bizScore * 0.2;
      factors.business = { score: bizScore, weight: '20%' };

      // 3. 持续时长 (20%) - 越久优先级越高
      let durationScore = 50;
      if (alert.TRIGGER_TIME) {
        const minutes = (Date.now() - new Date(alert.TRIGGER_TIME).getTime()) / 60000;
        if (minutes > 120) durationScore = 100;
        else if (minutes > 60) durationScore = 80;
        else if (minutes > 30) durationScore = 60;
        else if (minutes > 10) durationScore = 40;
        else durationScore = 20;
        factors.durationMinutes = Math.round(minutes);
      }
      score += durationScore * 0.2;
      factors.duration = { score: durationScore, weight: '20%' };

      // 4. 实例健康分 (10%) - 健康分越低优先级越高
      let healthScore = 50;
      if (alert.INSTANCE_ID) {
        try {
          const instRes = await db.execute(
            `SELECT HEALTH_SCORE FROM CMDB_INSTANCE WHERE INSTANCE_ID = :1`, [alert.INSTANCE_ID]);
          if (instRes.rows.length) {
            const hs = instRes.rows[0].HEALTH_SCORE || 100;
            healthScore = Math.max(0, 100 - hs); // 健康分低 → 优先级高
            factors.instanceHealth = hs;
          }
        } catch {}
      }
      score += healthScore * 0.1;
      factors.health = { score: healthScore, weight: '10%' };

      // 5. 依赖影响 (10%) - 受影响的应用数
      let impactScore = 30;
      if (alert.INSTANCE_ID) {
        try {
          const depRes = await db.execute(
            `SELECT COUNT(DISTINCT APP_ID) AS APP_COUNT FROM CMDB_APP_DB_RELATION WHERE INSTANCE_ID = :1`,
            [alert.INSTANCE_ID]);
          const appCount = depRes.rows[0]?.APP_COUNT || 0;
          impactScore = Math.min(100, 30 + appCount * 15);
          factors.affectedApps = appCount;
        } catch {}
      }
      score += impactScore * 0.1;
      factors.impact = { score: impactScore, weight: '10%' };

      // 最终分数
      const finalScore = Math.round(score);
      let priorityLevel;
      if (finalScore >= 80) priorityLevel = 'CRITICAL';
      else if (finalScore >= 60) priorityLevel = 'HIGH';
      else if (finalScore >= 40) priorityLevel = 'MEDIUM';
      else priorityLevel = 'LOW';

      results.push({
        ALERT_ID: alert.ALERT_ID,
        INSTANCE_ID: alert.INSTANCE_ID,
        SEVERITY: alert.SEVERITY,
        STATUS: alert.STATUS,
        RULE_NAME: alert.RULE_NAME,
        CONTENT: alert.CONTENT,
        TRIGGER_TIME: alert.TRIGGER_TIME,
        PRIORITY_SCORE: finalScore,
        PRIORITY_LEVEL: priorityLevel,
        FACTORS: factors,
      });
    }

    // 按分数降序排列
    results.sort((a, b) => b.PRIORITY_SCORE - a.PRIORITY_SCORE);
    res.json({ code: 200, data: results });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// ─── F-16 告警聚合去重 ───────────────────────────────────────────

/**
 * 执行告警聚合去重
 * 规则：同 RULE_NAME + INSTANCE_ID + SEVERITY 在时间窗口内的 OPEN 告警合并为一组
 * 窗口内最早触发的告警为代表告警，其余标记为 IS_MERGED=1
 */
async function aggregateAlerts(windowMinutes) {
  if (!windowMinutes) {
    const sysConfig = require('../services/systemConfig');
    windowMinutes = await sysConfig.getNumber('alert.aggregation.window_min', 10);
  }
  // 1. 查找窗口内所有 OPEN/ACKNOWLEDGED 告警
  const { rows: candidates } = await db.execute(
    `SELECT ALERT_ID, RULE_NAME, INSTANCE_ID, INSTANCE_NAME, SEVERITY, TRIGGER_TIME, CONTENT
     FROM ALERT_RECORD
     WHERE STATUS IN ('OPEN', 'ACKNOWLEDGED')
       AND (IS_MERGED = 0 OR IS_MERGED IS NULL)
       AND TRIGGER_TIME >= SYSTIMESTAMP - NUMTODSINTERVAL(:1, 'MINUTE')
     ORDER BY RULE_NAME, INSTANCE_ID, SEVERITY, TRIGGER_TIME ASC`,
    [windowMinutes]
  );

  if (!candidates.length) return { groups: 0, merged: 0 };

  // 2. 按聚合键分组
  const groups = {};
  for (const a of candidates) {
    const key = `${a.RULE_NAME || ''}|${a.INSTANCE_ID || 0}|${a.SEVERITY || ''}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(a);
  }

  let groupsCreated = 0;
  let alertsMerged = 0;

  // 3. 对每组 > 1 条告警的执行聚合
  for (const [aggKey, alerts] of Object.entries(groups)) {
    if (alerts.length < 2) continue;

    const representative = alerts[0]; // 最早的
    const alertIds = alerts.map(a => a.ALERT_ID);
    const firstTrigger = alerts[0].TRIGGER_TIME;
    const lastTrigger = alerts[alerts.length - 1].TRIGGER_TIME;

    // 检查是否已有该聚合键的活跃聚合组
    const existing = await db.execute(
      `SELECT AGG_ID FROM ALERT_AGGREGATION WHERE AGG_KEY = :1 AND STATUS = 'ACTIVE'`,
      [aggKey]
    );

    let aggId;
    if (existing.rows.length) {
      // 更新已有聚合组
      aggId = existing.rows[0].AGG_ID;
      // 获取当前组内已有的告警 ID
      const currentRes = await db.execute(
        `SELECT ALERT_IDS FROM ALERT_AGGREGATION WHERE AGG_ID = :1`, [aggId]
      );
      let existingIds = [];
      try { existingIds = JSON.parse(currentRes.rows[0]?.ALERT_IDS || '[]'); } catch {}
      // 合并新 ID（去重）
      const mergedIds = [...new Set([...existingIds, ...alertIds])];
      await db.execute(
        `UPDATE ALERT_AGGREGATION SET
         ALERT_COUNT = :1, ALERT_IDS = :2,
         LAST_TRIGGER = :3, UPDATED_AT = SYSTIMESTAMP
         WHERE AGG_ID = :4`,
        [mergedIds.length, JSON.stringify(mergedIds), lastTrigger, aggId]
      );
    } else {
      // 创建新聚合组
      const r = await db.execute(
        `INSERT INTO ALERT_AGGREGATION
         (AGG_KEY, RULE_NAME, INSTANCE_ID, INSTANCE_NAME, SEVERITY,
          REPRESENTATIVE_ID, ALERT_COUNT, ALERT_IDS, WINDOW_MINUTES, FIRST_TRIGGER, LAST_TRIGGER)
         VALUES (:1, :2, :3, :4, :5, :6, :7, :8, :9, :10, :11)
         RETURNING AGG_ID INTO :12`,
        [aggKey, representative.RULE_NAME, representative.INSTANCE_ID,
         representative.INSTANCE_NAME, representative.SEVERITY,
         representative.ALERT_ID, alertIds.length, JSON.stringify(alertIds),
         windowMinutes, firstTrigger, lastTrigger,
         { dir: require('oracledb').BIND_OUT, type: require('oracledb').NUMBER }]
      );
      aggId = r.outBinds[0][0];
      groupsCreated++;
    }

    // 4. 标记非代表告警为 MERGED
    const nonRepresentativeIds = alertIds.filter(id => id !== representative.ALERT_ID);
    for (const id of nonRepresentativeIds) {
      await db.execute(
        `UPDATE ALERT_RECORD SET IS_MERGED = 1, AGG_GROUP_ID = :1
         WHERE ALERT_ID = :2 AND IS_MERGED = 0`,
        [aggId, id]
      );
      alertsMerged++;
    }
    // 确保代表告警关联到聚合组但不标记为 MERGED
    await db.execute(
      `UPDATE ALERT_RECORD SET AGG_GROUP_ID = :1 WHERE ALERT_ID = :2 AND AGG_GROUP_ID IS NULL`,
      [aggId, representative.ALERT_ID]
    );
  }

  return { groups: groupsCreated, merged: alertsMerged, totalCandidates: candidates.length };
}

/**
 * 解散聚合组，恢复被合并的告警
 */
async function splitAggregation(aggId) {
  const aggRes = await db.execute(
    `SELECT ALERT_IDS, REPRESENTATIVE_ID FROM ALERT_AGGREGATION WHERE AGG_ID = :1`, [aggId]
  );
  if (!aggRes.rows.length) throw new Error('聚合组不存在');
  const agg = aggRes.rows[0];

  // 恢复被合并的告警
  await db.execute(
    `UPDATE ALERT_RECORD SET IS_MERGED = 0, AGG_GROUP_ID = NULL
     WHERE AGG_GROUP_ID = :1 AND IS_MERGED = 1`,
    [aggId]
  );
  // 清除代表告警的聚合组关联
  await db.execute(
    `UPDATE ALERT_RECORD SET AGG_GROUP_ID = NULL WHERE AGG_GROUP_ID = :1`,
    [aggId]
  );
  // 标记聚合组为已解散
  await db.execute(
    `UPDATE ALERT_AGGREGATION SET STATUS = 'EXPIRED', UPDATED_AT = SYSTIMESTAMP WHERE AGG_ID = :1`,
    [aggId]
  );
}

// POST /api/alerts/aggregate — 执行告警聚合去重
router.post('/aggregate', async (req, res) => {
  try {
    const windowMinutes = Number(req.body?.windowMinutes) || 10;
    const result = await aggregateAlerts(windowMinutes);
    res.json({ code: 200, msg: `聚合完成: 新建 ${result.groups} 组, 合并 ${result.merged} 条`, data: result });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// GET /api/alerts/aggregation-groups — 聚合组列表
router.get('/aggregation-groups', async (req, res) => {
  try {
    const { status, severity, instanceId, page = 1, size = 20 } = req.query;
    let where = ['1=1']; let binds = []; let bi = 1;
    if (status)     { where.push(`a.STATUS=:${bi}`);      binds.push(status); bi++; }
    if (severity)   { where.push(`a.SEVERITY=:${bi}`);     binds.push(severity); bi++; }
    if (instanceId) { where.push(`a.INSTANCE_ID=:${bi}`);  binds.push(Number(instanceId)); bi++; }
    const sql = `SELECT a.*,
      (SELECT CONTENT FROM ALERT_RECORD WHERE ALERT_ID = a.REPRESENTATIVE_ID) AS REPR_CONTENT,
      (SELECT TRIGGER_TIME FROM ALERT_RECORD WHERE ALERT_ID = a.REPRESENTATIVE_ID) AS REPR_TRIGGER_TIME
      FROM ALERT_AGGREGATION a WHERE ${where.join(' AND ')}
      ORDER BY a.LAST_TRIGGER DESC`;
    const data = await db.queryPage(sql, binds, page, size);
    res.json({ code: 200, data });
  } catch (err) {
    if (/ORA-00942|942/.test(err.message || '')) return res.json({ code: 200, data: { rows: [], total: 0 } });
    res.json({ code: 500, msg: err.message });
  }
});

// GET /api/alerts/aggregation-groups/stats — 聚合统计
router.get('/aggregation-groups/stats', async (req, res) => {
  try {
    const [active, totalMerged, bySeverity, topGroups] = await Promise.all([
      db.execute(`SELECT COUNT(*) AS CNT FROM ALERT_AGGREGATION WHERE STATUS = 'ACTIVE'`, []),
      db.execute(`SELECT COUNT(*) AS CNT FROM ALERT_RECORD WHERE IS_MERGED = 1`, []),
      db.execute(
        `SELECT SEVERITY, COUNT(*) AS CNT, SUM(ALERT_COUNT) AS TOTAL_ALERTS
         FROM ALERT_AGGREGATION WHERE STATUS = 'ACTIVE' GROUP BY SEVERITY`, []),
      db.execute(
        `SELECT AGG_ID, AGG_KEY, RULE_NAME, INSTANCE_NAME, SEVERITY, ALERT_COUNT, LAST_TRIGGER
         FROM ALERT_AGGREGATION WHERE STATUS = 'ACTIVE'
         ORDER BY ALERT_COUNT DESC FETCH FIRST 5 ROWS ONLY`, []),
    ]);
    res.json({
      code: 200,
      data: {
        activeGroups: active.rows[0]?.CNT || 0,
        totalMerged: totalMerged.rows[0]?.CNT || 0,
        bySeverity: bySeverity.rows || [],
        topGroups: topGroups.rows || [],
      }
    });
  } catch (err) {
    if (/ORA-00942|942/.test(err.message || '')) return res.json({ code: 200, data: { activeGroups: 0, totalMerged: 0, bySeverity: [], topGroups: [] } });
    res.json({ code: 500, msg: err.message });
  }
});

// GET /api/alerts/aggregation-groups/:id — 聚合组详情（含成员告警）
router.get('/aggregation-groups/:id', async (req, res) => {
  try {
    const aggRes = await db.execute(
      `SELECT * FROM ALERT_AGGREGATION WHERE AGG_ID = :1`, [req.params.id]);
    if (!aggRes.rows.length) return res.json({ code: 404, msg: '聚合组不存在' });
    const agg = aggRes.rows[0];
    let alertIds = [];
    try { alertIds = JSON.parse(agg.ALERT_IDS || '[]'); } catch {}
    let members = [];
    if (alertIds.length) {
      const { rows } = await db.execute(
        `SELECT ALERT_ID, RULE_NAME, INSTANCE_NAME, SEVERITY, CONTENT, STATUS,
                TRIGGER_TIME, IS_MERGED, AGG_GROUP_ID
         FROM ALERT_RECORD WHERE ALERT_ID IN (${alertIds.map((_, i) => ':' + (i + 1)).join(',')})
         ORDER BY TRIGGER_TIME ASC`,
        alertIds
      );
      members = rows;
    }
    res.json({ code: 200, data: { ...agg, members } });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// POST /api/alerts/aggregation-groups/:id/resolve — 解决聚合组所有告警
router.post('/aggregation-groups/:id/resolve', async (req, res) => {
  try {
    const aggRes = await db.execute(
      `SELECT ALERT_IDS FROM ALERT_AGGREGATION WHERE AGG_ID = :1`, [req.params.id]);
    if (!aggRes.rows.length) return res.json({ code: 404, msg: '聚合组不存在' });
    let alertIds = [];
    try { alertIds = JSON.parse(aggRes.rows[0].ALERT_IDS || '[]'); } catch {}
    if (alertIds.length) {
      await db.execute(
        `UPDATE ALERT_RECORD SET STATUS='RESOLVED', RESOLVE_TIME=SYSTIMESTAMP, RESOLVE_BY=:1
         WHERE ALERT_ID IN (${alertIds.map((_, i) => ':' + (i + 2)).join(',')}) AND STATUS <> 'RESOLVED'`,
        [req.user.username, ...alertIds]);
    }
    await db.execute(
      `UPDATE ALERT_AGGREGATION SET STATUS='RESOLVED', UPDATED_AT=SYSTIMESTAMP WHERE AGG_ID=:1`,
      [req.params.id]);
    res.json({ code: 200, msg: `已解决 ${alertIds.length} 条告警` });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// POST /api/alerts/aggregation-groups/:id/split — 解散聚合组
router.post('/aggregation-groups/:id/split', async (req, res) => {
  try {
    await splitAggregation(req.params.id);
    res.json({ code: 200, msg: '聚合组已解散' });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// ─── F-18 告警静默（维护窗口） ───────────────────────────────────

/**
 * 检查告警是否命中静默规则
 * @param {object} alert - { ALERT_ID, INSTANCE_ID, SEVERITY, RULE_NAME, TRIGGER_TIME }
 * @returns {object|null} 命中的静默规则，或 null
 */
async function checkSilenceForAlert(alert) {
  try {
    const { rows: rules } = await db.execute(
      `SELECT * FROM ALERT_SILENCE_RULE WHERE ENABLED = 1`, []);

    for (const rule of rules) {
      let matched = false;

      if (rule.SILENCE_TYPE === 'ONCE') {
        // 一次性静默：检查当前时间是否在 [START_TIME, END_TIME] 区间内
        if (rule.START_TIME && rule.END_TIME) {
          const now = new Date();
          const start = new Date(rule.START_TIME);
          const end = new Date(rule.END_TIME);
          if (now >= start && now <= end) matched = true;
        }
      } else if (rule.SILENCE_TYPE === 'RECURRING' && rule.CRON_EXPR && rule.DURATION_MIN) {
        // 周期性静默：检查当前时间是否在最近一次 cron 触发 + duration 窗口内
        if (isInRecurringWindow(rule.CRON_EXPR, rule.DURATION_MIN, rule.TIMEZONE)) {
          matched = true;
        }
      }

      if (!matched) continue;

      // 检查匹配条件
      // 实例匹配
      if (rule.INSTANCE_ID && alert.INSTANCE_ID !== rule.INSTANCE_ID) continue;
      // 严重度匹配
      if (rule.SEVERITY) {
        const allowedSeverities = rule.SEVERITY.split(',').map(s => s.trim());
        if (!allowedSeverities.includes(alert.SEVERITY)) continue;
      }
      // 规则名匹配
      if (rule.RULE_NAME_MATCH && alert.RULE_NAME !== rule.RULE_NAME_MATCH) continue;

      return rule; // 命中第一条规则即返回
    }
    return null;
  } catch (err) {
    console.error('[alert-silence] checkSilenceForAlert error:', err.message);
    return null;
  }
}

/**
 * 简单的周期性窗口判断
 * 支持 cron 格式: "分钟 小时 日 月 星期"
 * 只判断最近一次触发点 + duration 是否包含当前时间
 */
function isInRecurringWindow(cronExpr, durationMin, timezone) {
  try {
    const parts = cronExpr.split(/\s+/);
    if (parts.length < 5) return false;

    const [cronMin, cronHour, , , cronDow] = parts;
    const now = new Date();

    // 简化处理：只支持 "每天 HH:MM" 和 "每周X HH:MM" 模式
    const targetMin = cronMin === '*' ? now.getMinutes() : parseInt(cronMin, 10);
    const targetHour = cronHour === '*' ? now.getHours() : parseInt(cronHour, 10);

    if (isNaN(targetMin) || isNaN(targetHour)) return false;

    // 构造今天的触发时间
    const triggerToday = new Date(now);
    triggerToday.setHours(targetHour, targetMin, 0, 0);

    // 检查星期
    if (cronDow !== '*') {
      const allowedDays = cronDow.split(',').map(d => {
        const n = parseInt(d, 10);
        return isNaN(n) ? -1 : n;
      }).filter(n => n >= 0 && n <= 6);
      if (allowedDays.length && !allowedDays.includes(now.getDay())) return false;
    }

    // 检查当前时间是否在 [triggerToday, triggerToday + durationMin] 内
    const windowEnd = new Date(triggerToday.getTime() + durationMin * 60000);
    if (now >= triggerToday && now <= windowEnd) return true;

    // 如果当前时间在 trigger 之前，检查昨天的窗口（跨零点场景）
    const triggerYesterday = new Date(triggerToday);
    triggerYesterday.setDate(triggerYesterday.getDate() - 1);
    const windowEndYesterday = new Date(triggerYesterday.getTime() + durationMin * 60000);
    if (now >= triggerYesterday && now <= windowEndYesterday) return true;

    return false;
  } catch {
    return false;
  }
}

/**
 * 批量检查所有 OPEN 告警的静默状态
 */
async function batchCheckSilence() {
  const { rows: openAlerts } = await db.execute(
    `SELECT ALERT_ID, INSTANCE_ID, INSTANCE_NAME, SEVERITY, RULE_NAME, TRIGGER_TIME
     FROM ALERT_RECORD WHERE STATUS = 'OPEN'`, []);

  let silenced = 0;
  for (const alert of openAlerts) {
    const rule = await checkSilenceForAlert(alert);
    if (rule) {
      await db.execute(
        `UPDATE ALERT_RECORD SET STATUS='SILENCED', SILENCE_RULE_ID=:1, SILENCED_AT=SYSTIMESTAMP
         WHERE ALERT_ID=:2 AND STATUS='OPEN'`,
        [rule.RULE_ID, alert.ALERT_ID]);
      try {
        await db.execute(
          `INSERT INTO ALERT_SILENCE_LOG (RULE_ID, ALERT_ID, SILENCE_REASON)
           SELECT :1, :2, :3 FROM DUAL
           WHERE NOT EXISTS (SELECT 1 FROM ALERT_SILENCE_LOG WHERE RULE_ID=:1 AND ALERT_ID=:2)`,
          [rule.RULE_ID, alert.ALERT_ID, `匹配规则: ${rule.RULE_NAME}`]);
      } catch { /* duplicate skip */ }
      silenced++;
    }
  }
  return { checked: openAlerts.length, silenced };
}

// GET /api/alerts/silence-rules — 静默规则列表
router.get('/silence-rules', async (req, res) => {
  try {
    const { rows } = await db.execute(
      `SELECT r.*,
        (SELECT COUNT(*) FROM ALERT_SILENCE_LOG l WHERE l.RULE_ID = r.RULE_ID) AS SILENCED_COUNT,
        CASE WHEN r.SILENCE_TYPE = 'ONCE' AND r.END_TIME < SYSTIMESTAMP THEN 1 ELSE 0 END AS EXPIRED
       FROM ALERT_SILENCE_RULE r ORDER BY r.CREATED_AT DESC`, []);
    res.json({ code: 200, data: rows });
  } catch (err) {
    if (/ORA-00942|942/.test(err.message || '')) return res.json({ code: 200, data: [] });
    res.json({ code: 500, msg: err.message });
  }
});

// POST /api/alerts/silence-rules — 创建静默规则
router.post('/silence-rules', async (req, res) => {
  try {
    const { ruleName, description, instanceId, severity, ruleNameMatch,
            silenceType, startTime, endTime, cronExpr, durationMin, timezone } = req.body;
    if (!ruleName) return res.json({ code: 400, msg: '规则名称必填' });
    if (silenceType === 'ONCE' && (!startTime || !endTime))
      return res.json({ code: 400, msg: '一次性静默需要开始和结束时间' });
    if (silenceType === 'RECURRING' && (!cronExpr || !durationMin))
      return res.json({ code: 400, msg: '周期性静默需要 cron 表达式和持续时长' });

    const r = await db.execute(
      `INSERT INTO ALERT_SILENCE_RULE
       (RULE_NAME, DESCRIPTION, INSTANCE_ID, SEVERITY, RULE_NAME_MATCH,
        SILENCE_TYPE, START_TIME, END_TIME, CRON_EXPR, DURATION_MIN, TIMEZONE, CREATED_BY)
       VALUES (:1,:2,:3,:4,:5,:6,:7,:8,:9,:10,:11,:12)
       RETURNING RULE_ID INTO :13`,
      [ruleName, description || null, instanceId || null, severity || null, ruleNameMatch || null,
       silenceType || 'ONCE', startTime || null, endTime || null,
       cronExpr || null, durationMin || null, timezone || 'Asia/Shanghai',
       req.user.username,
       { dir: require('oracledb').BIND_OUT, type: require('oracledb').NUMBER }]
    );
    res.json({ code: 200, data: { ruleId: r.outBinds[0][0] }, msg: '创建成功' });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// PUT /api/alerts/silence-rules/:id — 更新静默规则
router.put('/silence-rules/:id', async (req, res) => {
  try {
    const { ruleName, description, instanceId, severity, ruleNameMatch,
            silenceType, startTime, endTime, cronExpr, durationMin, timezone, enabled } = req.body;
    await db.execute(
      `UPDATE ALERT_SILENCE_RULE SET
       RULE_NAME=NVL(:1,RULE_NAME), DESCRIPTION=:2, INSTANCE_ID=:3,
       SEVERITY=:4, RULE_NAME_MATCH=:5, SILENCE_TYPE=NVL(:6,SILENCE_TYPE),
       START_TIME=:7, END_TIME=:8, CRON_EXPR=:9, DURATION_MIN=:10,
       TIMEZONE=NVL(:11,TIMEZONE), ENABLED=NVL(:12,ENABLED),
       UPDATED_AT=SYSTIMESTAMP
       WHERE RULE_ID=:13`,
      [ruleName || null, description != null ? description : null,
       instanceId != null ? instanceId : null, severity != null ? severity : null,
       ruleNameMatch != null ? ruleNameMatch : null, silenceType || null,
       startTime || null, endTime || null, cronExpr || null, durationMin || null,
       timezone || null, enabled != null ? (enabled ? 1 : 0) : null,
       req.params.id]
    );
    res.json({ code: 200, msg: '更新成功' });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// DELETE /api/alerts/silence-rules/:id — 删除静默规则
router.delete('/silence-rules/:id', adminDba, async (req, res) => {
  try {
    await db.execute('DELETE FROM ALERT_SILENCE_LOG WHERE RULE_ID = :1', [req.params.id]);
    await db.execute('DELETE FROM ALERT_SILENCE_RULE WHERE RULE_ID = :1', [req.params.id]);
    res.json({ code: 200, msg: '删除成功' });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// POST /api/alerts/check-silence — 检查单个告警是否应被静默
router.post('/check-silence', async (req, res) => {
  try {
    const { alertId } = req.body;
    if (!alertId) return res.json({ code: 400, msg: 'alertId 不能为空' });
    const alertRes = await db.execute(
      `SELECT ALERT_ID, INSTANCE_ID, INSTANCE_NAME, SEVERITY, RULE_NAME, TRIGGER_TIME
       FROM ALERT_RECORD WHERE ALERT_ID = :1`, [alertId]);
    if (!alertRes.rows.length) return res.json({ code: 404, msg: '告警不存在' });
    const rule = await checkSilenceForAlert(alertRes.rows[0]);
    if (rule) {
      await db.execute(
        `UPDATE ALERT_RECORD SET STATUS='SILENCED', SILENCE_RULE_ID=:1, SILENCED_AT=SYSTIMESTAMP
         WHERE ALERT_ID=:2 AND STATUS='OPEN'`,
        [rule.RULE_ID, alertId]);
      try {
        await db.execute(
          `INSERT INTO ALERT_SILENCE_LOG (RULE_ID, ALERT_ID, SILENCE_REASON) VALUES (:1, :2, :3)`,
          [rule.RULE_ID, alertId, `匹配规则: ${rule.RULE_NAME}`]);
      } catch { /* duplicate skip */ }
      res.json({ code: 200, data: { silenced: true, rule } });
    } else {
      res.json({ code: 200, data: { silenced: false } });
    }
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// POST /api/alerts/batch-check-silence — 批量检查所有 OPEN 告警
router.post('/batch-check-silence', async (req, res) => {
  try {
    const result = await batchCheckSilence();
    res.json({ code: 200, msg: `静默检查完成: ${result.silenced}/${result.checked} 条被静默`, data: result });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// POST /api/alerts/:id/unsilence — 手动解除静默
router.post('/:id/unsilence', async (req, res) => {
  try {
    const check = await db.execute(
      `SELECT STATUS, SILENCE_RULE_ID FROM ALERT_RECORD WHERE ALERT_ID = :1`, [req.params.id]);
    if (!check.rows.length) return res.json({ code: 404, msg: '告警不存在' });
    if (check.rows[0].STATUS !== 'SILENCED') return res.json({ code: 400, msg: '该告警未被静默' });

    await db.execute(
      `UPDATE ALERT_RECORD SET STATUS='OPEN', SILENCE_RULE_ID=NULL, SILENCED_AT=NULL
       WHERE ALERT_ID=:1`, [req.params.id]);
    res.json({ code: 200, msg: '静默已解除' });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// GET /api/alerts/silence-stats — 静默统计
router.get('/silence-stats', async (req, res) => {
  try {
    const [activeRules, silencedAlerts, silencedCount, recentLogs] = await Promise.all([
      db.execute(`SELECT COUNT(*) AS CNT FROM ALERT_SILENCE_RULE WHERE ENABLED = 1`, []),
      db.execute(`SELECT COUNT(*) AS CNT FROM ALERT_RECORD WHERE STATUS = 'SILENCED'`, []),
      db.execute(
        `SELECT r.RULE_NAME, r.SILENCE_TYPE, COUNT(l.LOG_ID) AS CNT
         FROM ALERT_SILENCE_RULE r
         LEFT JOIN ALERT_SILENCE_LOG l ON r.RULE_ID = l.RULE_ID
         GROUP BY r.RULE_NAME, r.SILENCE_TYPE
         ORDER BY CNT DESC FETCH FIRST 5 ROWS ONLY`, []),
      db.execute(
        `SELECT l.LOG_ID, l.ALERT_ID, l.SILENCED_AT, l.SILENCE_REASON,
                ar.CONTENT, ar.INSTANCE_NAME, ar.SEVERITY
         FROM ALERT_SILENCE_LOG l
         JOIN ALERT_RECORD ar ON l.ALERT_ID = ar.ALERT_ID
         ORDER BY l.SILENCED_AT DESC FETCH FIRST 10 ROWS ONLY`, []).catch(() => ({ rows: [] })),
    ]);
    res.json({
      code: 200,
      data: {
        activeRules: activeRules.rows[0]?.CNT || 0,
        silencedAlerts: silencedAlerts.rows[0]?.CNT || 0,
        byRule: silencedCount.rows || [],
        recentLogs: recentLogs.rows || [],
      }
    });
  } catch (err) {
    if (/ORA-00942|942/.test(err.message || ''))
      return res.json({ code: 200, data: { activeRules: 0, silencedAlerts: 0, byRule: [], recentLogs: [] } });
    res.json({ code: 500, msg: err.message });
  }
});

module.exports = router;
