const router = require('express').Router();
const db = require('../config/db');
const { authMiddleware, requireRole } = require('../middleware/auth');

router.use(authMiddleware);
const adminDba = requireRole('ADMIN', 'DBA');

// ─── 应用 CRUD ─────────────────────────────────────────────

// GET /api/app-relation/apps
router.get('/apps', async (req, res) => {
  try {
    const { keyword, appType, status, page = 1, size = 20 } = req.query;
    let where = ['1=1'];
    let binds = [];
    let bi = 1;
    if (keyword) { where.push(`(APP_NAME LIKE :${bi} OR APP_CODE LIKE :${bi+1} OR BIZ_LINE LIKE :${bi+2})`); binds.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`); bi += 3; }
    if (appType) { where.push(`APP_TYPE = :${bi}`); binds.push(appType); bi++; }
    if (status)  { where.push(`STATUS = :${bi}`);  binds.push(status);  bi++; }
    const sql = `SELECT * FROM CMDB_APP WHERE ${where.join(' AND ')} ORDER BY CREATED_AT DESC`;
    const data = await db.queryPage(sql, binds, page, size);
    res.json({ code: 200, data });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// GET /api/app-relation/apps/:id
router.get('/apps/:id', async (req, res) => {
  try {
    const { rows } = await db.execute('SELECT * FROM CMDB_APP WHERE APP_ID = :1', [req.params.id]);
    if (!rows.length) return res.json({ code: 404, msg: '应用不存在' });
    res.json({ code: 200, data: rows[0] });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// POST /api/app-relation/apps
router.post('/apps', async (req, res) => {
  try {
    const { appName, appCode, appType, description, bizLine, owner } = req.body;
    if (!appName) return res.json({ code: 400, msg: '应用名称不能为空' });
    if (appCode) {
      const dup = await db.execute('SELECT 1 FROM CMDB_APP WHERE APP_CODE = :1', [appCode]);
      if (dup.rows.length) return res.json({ code: 409, msg: `应用编码 ${appCode} 已存在` });
    }
    const sql = `INSERT INTO CMDB_APP (APP_NAME, APP_CODE, APP_TYPE, DESCRIPTION, BIZ_LINE, OWNER, CREATED_BY)
                 VALUES (:1, :2, :3, :4, :5, :6, :7)`;
    await db.execute(sql, [appName, appCode || null, appType || 'APP', description || null, bizLine || null, owner || null, req.user.username]);
    await db.execute(`INSERT INTO SYS_AUDIT_LOG (USER_ID, USERNAME, ACTION, RESOURCE, STATUS, DETAIL)
                      VALUES (:1, :2, 'CREATE', 'CMDB_APP', 'SUCCESS', :3)`,
      [req.user.userId, req.user.username, `创建应用: ${appName}`]);
    res.json({ code: 200, msg: '创建成功' });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// PUT /api/app-relation/apps/:id
router.put('/apps/:id', async (req, res) => {
  try {
    const { appName, appCode, appType, description, bizLine, owner, status } = req.body;
    const { rows: existing } = await db.execute('SELECT 1 FROM CMDB_APP WHERE APP_ID = :1', [req.params.id]);
    if (!existing.length) return res.json({ code: 404, msg: '应用不存在' });
    if (appCode) {
      const dup = await db.execute('SELECT 1 FROM CMDB_APP WHERE APP_CODE = :1 AND APP_ID != :2', [appCode, req.params.id]);
      if (dup.rows.length) return res.json({ code: 409, msg: `应用编码 ${appCode} 已被其他应用使用` });
    }
    const sql = `UPDATE CMDB_APP SET APP_NAME=NVL(:1,APP_NAME), APP_CODE=NVL(:2,APP_CODE), APP_TYPE=NVL(:3,APP_TYPE),
                 DESCRIPTION=:4, BIZ_LINE=:5, OWNER=:6, STATUS=NVL(:7,STATUS), UPDATED_AT=SYSTIMESTAMP WHERE APP_ID=:8`;
    await db.execute(sql, [appName, appCode, appType, description || null, bizLine || null, owner || null, status, req.params.id]);
    res.json({ code: 200, msg: '更新成功' });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// DELETE /api/app-relation/apps/:id
router.delete('/apps/:id', adminDba, async (req, res) => {
  try {
    const { rows: existing } = await db.execute('SELECT APP_NAME FROM CMDB_APP WHERE APP_ID = :1', [req.params.id]);
    if (!existing.length) return res.json({ code: 404, msg: '应用不存在' });
    await db.execute('DELETE FROM CMDB_APP_DB_RELATION WHERE APP_ID = :1', [req.params.id]);
    await db.execute('DELETE FROM CMDB_APP WHERE APP_ID = :1', [req.params.id]);
    await db.execute(`INSERT INTO SYS_AUDIT_LOG (USER_ID, USERNAME, ACTION, RESOURCE, RESOURCE_ID, STATUS, DETAIL)
                      VALUES (:1, :2, 'DELETE', 'CMDB_APP', :3, 'SUCCESS', :4)`,
      [req.user.userId, req.user.username, req.params.id, `删除应用: ${existing[0].APP_NAME}`]);
    res.json({ code: 200, msg: '删除成功' });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// ─── 依赖关系 CRUD ─────────────────────────────────────────

// GET /api/app-relation/relations
router.get('/relations', async (req, res) => {
  try {
    const { appId, instanceId, page = 1, size = 50 } = req.query;
    let where = ['1=1'];
    let binds = [];
    let bi = 1;
    if (appId)      { where.push(`r.APP_ID = :${bi}`);      binds.push(Number(appId));      bi++; }
    if (instanceId) { where.push(`r.INSTANCE_ID = :${bi}`);  binds.push(Number(instanceId));  bi++; }
    const sql = `SELECT r.RELATION_ID, r.APP_ID, r.INSTANCE_ID, r.RELATION_TYPE, r.DEPENDENCY, r.DESCRIPTION,
                        a.APP_NAME, a.APP_CODE, a.APP_TYPE, a.BIZ_LINE,
                        i.INSTANCE_NAME, i.DB_TYPE, i.HOST_IP, i.PORT, i.STATUS AS INST_STATUS
                 FROM CMDB_APP_DB_RELATION r
                 JOIN CMDB_APP a ON r.APP_ID = a.APP_ID
                 JOIN CMDB_INSTANCE i ON r.INSTANCE_ID = i.INSTANCE_ID
                 WHERE ${where.join(' AND ')}
                 ORDER BY a.APP_NAME, i.INSTANCE_NAME`;
    const data = await db.queryPage(sql, binds, page, size);
    res.json({ code: 200, data });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// POST /api/app-relation/relations
router.post('/relations', async (req, res) => {
  try {
    const { appId, instanceId, relationType, dependency, description } = req.body;
    if (!appId || !instanceId) return res.json({ code: 400, msg: '应用和实例不能为空' });
    const dup = await db.execute('SELECT 1 FROM CMDB_APP_DB_RELATION WHERE APP_ID=:1 AND INSTANCE_ID=:2', [appId, instanceId]);
    if (dup.rows.length) return res.json({ code: 409, msg: '该依赖关系已存在' });
    const sql = `INSERT INTO CMDB_APP_DB_RELATION (APP_ID, INSTANCE_ID, RELATION_TYPE, DEPENDENCY, DESCRIPTION, CREATED_BY)
                 VALUES (:1, :2, :3, :4, :5, :6)`;
    await db.execute(sql, [appId, instanceId, relationType || 'DEPENDS_ON', dependency || 'STRONG', description || null, req.user.username]);
    res.json({ code: 200, msg: '创建成功' });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// DELETE /api/app-relation/relations/:id
router.delete('/relations/:id', async (req, res) => {
  try {
    await db.execute('DELETE FROM CMDB_APP_DB_RELATION WHERE RELATION_ID = :1', [req.params.id]);
    res.json({ code: 200, msg: '删除成功' });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// ─── 拓扑图与爆炸半径分析 ──────────────────────────────────

// GET /api/app-relation/topology — 全量拓扑数据（nodes + edges）
router.get('/topology', async (req, res) => {
  try {
    const apps = (await db.execute('SELECT APP_ID, APP_NAME, APP_CODE, APP_TYPE, BIZ_LINE, STATUS FROM CMDB_APP')).rows;
    const instances = (await db.execute(`SELECT INSTANCE_ID, INSTANCE_NAME, DB_TYPE, HOST_IP, STATUS, HEALTH_SCORE
                                         FROM CMDB_INSTANCE`)).rows;
    const relations = (await db.execute(`SELECT RELATION_ID, APP_ID, INSTANCE_ID, RELATION_TYPE, DEPENDENCY
                                         FROM CMDB_APP_DB_RELATION`)).rows;

    const nodes = [];
    const edges = [];

    for (const a of apps) {
      nodes.push({ id: `app_${a.APP_ID}`, label: a.APP_NAME, type: 'app', subType: a.APP_TYPE, bizLine: a.BIZ_LINE, status: a.STATUS });
    }
    for (const i of instances) {
      nodes.push({ id: `inst_${i.INSTANCE_ID}`, label: i.INSTANCE_NAME, type: 'instance', subType: i.DB_TYPE, host: i.HOST_IP, status: i.STATUS, health: i.HEALTH_SCORE });
    }
    for (const r of relations) {
      edges.push({ id: r.RELATION_ID, source: `app_${r.APP_ID}`, target: `inst_${r.INSTANCE_ID}`, relType: r.RELATION_TYPE, dependency: r.DEPENDENCY });
    }

    res.json({ code: 200, data: { nodes, edges } });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// GET /api/app-relation/blast-radius/:instanceId — 爆炸半径分析
router.get('/blast-radius/:instanceId', async (req, res) => {
  try {
    const instId = Number(req.params.instanceId);
    // 1. 获取实例信息
    const { rows: instRows } = await db.execute('SELECT * FROM CMDB_INSTANCE WHERE INSTANCE_ID = :1', [instId]);
    if (!instRows.length) return res.json({ code: 404, msg: '实例不存在' });
    const instance = instRows[0];

    // 2. 获取直接依赖该实例的所有应用
    const { rows: affectedApps } = await db.execute(
      `SELECT a.APP_ID, a.APP_NAME, a.APP_CODE, a.APP_TYPE, a.BIZ_LINE, a.OWNER, a.STATUS,
              r.RELATION_TYPE, r.DEPENDENCY
       FROM CMDB_APP_DB_RELATION r
       JOIN CMDB_APP a ON r.APP_ID = a.APP_ID
       WHERE r.INSTANCE_ID = :1`, [instId]);

    // 3. 同集群的其他实例
    const { rows: clusterMembers } = await db.execute(
      `SELECT i.INSTANCE_ID, i.INSTANCE_NAME, i.DB_TYPE, i.STATUS
       FROM CMDB_CLUSTER_MEMBER cm
       JOIN CMDB_INSTANCE i ON cm.INSTANCE_ID = i.INSTANCE_ID
       WHERE cm.CLUSTER_ID IN (SELECT CLUSTER_ID FROM CMDB_CLUSTER_MEMBER WHERE INSTANCE_ID = :1)
         AND i.INSTANCE_ID != :1`, [instId]);

    // 4. 该实例的活跃告警
    const { rows: activeAlerts } = await db.execute(
      `SELECT ALERT_ID, RULE_NAME, SEVERITY, CONTENT, STATUS, TRIGGER_TIME
       FROM ALERT_RECORD WHERE INSTANCE_ID = :1 AND STATUS != 'RESOLVED'
       ORDER BY TRIGGER_TIME DESC FETCH FIRST 10 ROWS ONLY`, [instId]);

    // 5. 统计影响面
    const strongDeps = affectedApps.filter(a => a.DEPENDENCY === 'STRONG').length;
    const weakDeps = affectedApps.filter(a => a.DEPENDENCY !== 'STRONG').length;
    const bizLines = [...new Set(affectedApps.map(a => a.BIZ_LINE).filter(Boolean))];

    res.json({
      code: 200,
      data: {
        instance: { id: instance.INSTANCE_ID, name: instance.INSTANCE_NAME, dbType: instance.DB_TYPE, host: instance.HOST_IP, status: instance.STATUS, health: instance.HEALTH_SCORE },
        affectedApps,
        clusterMembers,
        activeAlerts,
        summary: { totalApps: affectedApps.length, strongDeps, weakDeps, affectedBizLines: bizLines }
      }
    });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// GET /api/app-relation/app-impact/:appId — 应用影响分析（反向：某应用挂了影响哪些实例）
router.get('/app-impact/:appId', async (req, res) => {
  try {
    const appId = Number(req.params.appId);
    const { rows: appRows } = await db.execute('SELECT * FROM CMDB_APP WHERE APP_ID = :1', [appId]);
    if (!appRows.length) return res.json({ code: 404, msg: '应用不存在' });
    const app = appRows[0];

    const { rows: dependentInstances } = await db.execute(
      `SELECT i.INSTANCE_ID, i.INSTANCE_NAME, i.DB_TYPE, i.HOST_IP, i.STATUS, i.HEALTH_SCORE,
              r.RELATION_TYPE, r.DEPENDENCY
       FROM CMDB_APP_DB_RELATION r
       JOIN CMDB_INSTANCE i ON r.INSTANCE_ID = i.INSTANCE_ID
       WHERE r.APP_ID = :1`, [appId]);

    res.json({
      code: 200,
      data: {
        app: { id: app.APP_ID, name: app.APP_NAME, type: app.APP_TYPE, bizLine: app.BIZ_LINE },
        dependentInstances,
        summary: { totalInstances: dependentInstances.length, strongDeps: dependentInstances.filter(i => i.DEPENDENCY === 'STRONG').length }
      }
    });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// GET /api/app-relation/stats — 统计概览
router.get('/stats', async (req, res) => {
  try {
    const [appCount, relCount, byType] = await Promise.all([
      db.execute('SELECT COUNT(*) AS CNT FROM CMDB_APP'),
      db.execute('SELECT COUNT(*) AS CNT FROM CMDB_APP_DB_RELATION'),
      db.execute(`SELECT APP_TYPE, COUNT(*) AS CNT FROM CMDB_APP GROUP BY APP_TYPE ORDER BY CNT DESC`),
    ]);
    const orphanApps = await db.execute(
      `SELECT COUNT(*) AS CNT FROM CMDB_APP a WHERE NOT EXISTS (SELECT 1 FROM CMDB_APP_DB_RELATION r WHERE r.APP_ID = a.APP_ID)`);
    const unlinkedInst = await db.execute(
      `SELECT COUNT(*) AS CNT FROM CMDB_INSTANCE i WHERE NOT EXISTS (SELECT 1 FROM CMDB_APP_DB_RELATION r WHERE r.INSTANCE_ID = i.INSTANCE_ID)`);
    res.json({
      code: 200,
      data: {
        totalApps: appCount.rows[0].CNT,
        totalRelations: relCount.rows[0].CNT,
        byType: byType.rows,
        orphanApps: orphanApps.rows[0].CNT,
        unlinkedInstances: unlinkedInst.rows[0].CNT,
      }
    });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

module.exports = router;
