const router = require('express').Router();
const db = require('../config/db');
const { authMiddleware } = require('../middleware/auth');

router.use(authMiddleware);

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
    await db.execute(
      `UPDATE ALERT_RECORD SET STATUS='ACKNOWLEDGED',ACK_TIME=SYSTIMESTAMP,ACK_BY=:1 WHERE ALERT_ID=:2`,
      [req.user.username, req.params.id]
    );
    res.json({ code:200, msg:'告警已确认' });
  } catch(err){ res.json({code:500,msg:err.message}); }
});

// POST /api/alerts/:id/resolve
router.post('/:id/resolve', async (req, res) => {
  try {
    await db.execute(
      `UPDATE ALERT_RECORD SET STATUS='RESOLVED',RESOLVE_TIME=SYSTIMESTAMP,RESOLVE_BY=:1 WHERE ALERT_ID=:2`,
      [req.user.username, req.params.id]
    );
    res.json({ code:200, msg:'告警已解决' });
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
  try {
    await db.execute(
      `INSERT INTO ALERT_RULE(RULE_NAME,RULE_TYPE,METRIC,OPERATOR,THRESHOLD,DURATION,SEVERITY,DB_TYPE,INSTANCE_ID,PROMQL,NOTIFY_CHAN,NOTIFY_TO,CREATED_BY)
       VALUES(:1,:2,:3,:4,:5,:6,:7,:8,:9,:10,:11,:12,:13)`,
      [ruleName,ruleType||'THRESHOLD',metric,operator,threshold,duration||5,severity||'P3',dbType,instanceId,promql,notifyChan,notifyTo,req.user.userId]
    );
    res.json({ code:200, msg:'告警规则创建成功' });
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

module.exports = router;
