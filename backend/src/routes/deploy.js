/**
 * F-45 自动安装部署 API
 * 模板管理 + 部署任务执行
 */
const router = require('express').Router();
const oracledb = require('oracledb');
const db = require('../config/db');
const { authMiddleware, requireRole } = require('../middleware/auth');
const { executeDeployJob, setCancelFlag, clearCancelFlag, isCancelled } = require('../services/deployRunner');

router.use(authMiddleware);
const adminDba = requireRole('ADMIN', 'DBA');
const adminDbaOps = requireRole('ADMIN', 'DBA', 'OPS');

// ── 模板 API ────────────────────────────────────────────────

/** 模板列表 */
router.get('/templates', async (req, res) => {
  try {
    const r = await db.execute(
      `SELECT TEMPLATE_ID, TEMPLATE_NAME, DEPLOY_MODE, DEPLOY_TYPE, DB_TYPE, DESCRIPTION,
              PARAM_SCHEMA, STEPS_JSON, ENABLED, SORT_ORDER, CREATED_AT, UPDATED_AT
       FROM DEPLOY_TEMPLATE ORDER BY SORT_ORDER, TEMPLATE_ID`
    );
    res.json({ code: 200, data: r.rows });
  } catch (e) { res.json({ code: 500, msg: e.message }); }
});

/** 模板详情 */
router.get('/templates/:id', async (req, res) => {
  try {
    const r = await db.execute(
      `SELECT * FROM DEPLOY_TEMPLATE WHERE TEMPLATE_ID=:1`, [req.params.id]
    );
    if (!r.rows.length) return res.json({ code: 404, msg: '模板不存在' });
    res.json({ code: 200, data: r.rows[0] });
  } catch (e) { res.json({ code: 500, msg: e.message }); }
});

/** 新增模板 */
router.post('/templates', adminDba, async (req, res) => {
  const { templateName, deployMode, deployType, dbType, description, paramSchema, stepsJson, enabled, sortOrder } = req.body;
  if (!templateName) return res.json({ code: 400, msg: '模板名称必填' });
  try {
    await db.execute(
      `INSERT INTO DEPLOY_TEMPLATE (TEMPLATE_NAME, DEPLOY_MODE, DEPLOY_TYPE, DB_TYPE, DESCRIPTION, PARAM_SCHEMA, STEPS_JSON, ENABLED, SORT_ORDER)
       VALUES (:1, :2, :3, :4, :5, :6, :7, :8, :9)`,
      [templateName, deployMode || 'SINGLE', deployType || 'INSTALL', dbType || 'ALL',
       description || '', typeof paramSchema === 'object' ? JSON.stringify(paramSchema) : (paramSchema || null),
       typeof stepsJson === 'object' ? JSON.stringify(stepsJson) : (stepsJson || null),
       enabled === false ? 0 : 1, sortOrder || 0],
      { autoCommit: true }
    );
    res.json({ code: 200, msg: '模板已创建' });
  } catch (e) { res.json({ code: 500, msg: e.message }); }
});

/** 编辑模板 */
router.put('/templates/:id', adminDba, async (req, res) => {
  const { templateName, deployMode, deployType, dbType, description, paramSchema, stepsJson, enabled, sortOrder } = req.body;
  try {
    const sets = []; const binds = []; let idx = 1;
    if (templateName !== undefined) { sets.push(`TEMPLATE_NAME=:${idx++}`); binds.push(templateName); }
    if (deployMode !== undefined) { sets.push(`DEPLOY_MODE=:${idx++}`); binds.push(deployMode); }
    if (deployType !== undefined) { sets.push(`DEPLOY_TYPE=:${idx++}`); binds.push(deployType); }
    if (dbType !== undefined) { sets.push(`DB_TYPE=:${idx++}`); binds.push(dbType); }
    if (description !== undefined) { sets.push(`DESCRIPTION=:${idx++}`); binds.push(description); }
    if (paramSchema !== undefined) { sets.push(`PARAM_SCHEMA=:${idx++}`); binds.push(typeof paramSchema === 'object' ? JSON.stringify(paramSchema) : paramSchema); }
    if (stepsJson !== undefined) { sets.push(`STEPS_JSON=:${idx++}`); binds.push(typeof stepsJson === 'object' ? JSON.stringify(stepsJson) : stepsJson); }
    if (enabled !== undefined) { sets.push(`ENABLED=:${idx++}`); binds.push(enabled ? 1 : 0); }
    if (sortOrder !== undefined) { sets.push(`SORT_ORDER=:${idx++}`); binds.push(sortOrder); }
    if (!sets.length) return res.json({ code: 400, msg: '无更新字段' });
    sets.push(`UPDATED_AT=SYSTIMESTAMP`);
    binds.push(req.params.id);
    await db.execute(`UPDATE DEPLOY_TEMPLATE SET ${sets.join(',')} WHERE TEMPLATE_ID=:${idx}`, binds, { autoCommit: true });
    res.json({ code: 200, msg: '模板已更新' });
  } catch (e) { res.json({ code: 500, msg: e.message }); }
});

// ── 任务 API ────────────────────────────────────────────────

/** 任务列表（分页+筛选） */
router.get('/jobs', async (req, res) => {
  const { page = 1, pageSize = 20, status, templateId } = req.query;
  try {
    let where = '1=1'; const binds = []; let idx = 1;
    if (status) { where += ` AND j.STATUS=:${idx++}`; binds.push(status); }
    if (templateId) { where += ` AND j.TEMPLATE_ID=:${idx++}`; binds.push(templateId); }

    const countR = await db.execute(`SELECT COUNT(*) CNT FROM DEPLOY_JOB j WHERE ${where}`, binds);
    const total = countR.rows[0]?.CNT || 0;

    const offset = (Number(page) - 1) * Number(pageSize);
    binds.push(Number(pageSize)); binds.push(offset);
    const r = await db.execute(
      `SELECT j.JOB_ID, j.TEMPLATE_ID, j.INSTANCE_ID, j.HOST_ID, j.TARGET_IP, j.STATUS,
              j.LOG_SUMMARY, j.START_TIME, j.END_TIME, j.CREATED_BY, j.CREATED_AT,
              t.TEMPLATE_NAME, t.DEPLOY_TYPE, t.DB_TYPE,
              i.INSTANCE_NAME, u.USERNAME AS CREATED_BY_NAME
       FROM DEPLOY_JOB j
       LEFT JOIN DEPLOY_TEMPLATE t ON j.TEMPLATE_ID = t.TEMPLATE_ID
       LEFT JOIN CMDB_INSTANCE i ON j.INSTANCE_ID = i.INSTANCE_ID
       LEFT JOIN SYS_USER u ON j.CREATED_BY = u.USER_ID
       WHERE ${where}
       ORDER BY j.CREATED_AT DESC
       OFFSET :${idx++} ROWS FETCH NEXT :${idx - 2} ROWS ONLY`, binds
    );
    res.json({ code: 200, data: { list: r.rows, total } });
  } catch (e) { res.json({ code: 500, msg: e.message }); }
});

/** 任务详情 */
router.get('/jobs/:id', async (req, res) => {
  try {
    const r = await db.execute(
      `SELECT j.*, t.TEMPLATE_NAME, t.DEPLOY_TYPE, t.DB_TYPE, t.STEPS_JSON,
              i.INSTANCE_NAME, u.USERNAME AS CREATED_BY_NAME
       FROM DEPLOY_JOB j
       LEFT JOIN DEPLOY_TEMPLATE t ON j.TEMPLATE_ID = t.TEMPLATE_ID
       LEFT JOIN CMDB_INSTANCE i ON j.INSTANCE_ID = i.INSTANCE_ID
       LEFT JOIN SYS_USER u ON j.CREATED_BY = u.USER_ID
       WHERE j.JOB_ID=:1`, [req.params.id]
    );
    if (!r.rows.length) return res.json({ code: 404, msg: '任务不存在' });
    res.json({ code: 200, data: r.rows[0] });
  } catch (e) { res.json({ code: 500, msg: e.message }); }
});

/** 创建部署任务 */
router.post('/jobs', adminDbaOps, async (req, res) => {
  const { templateId, instanceId, hostId, targetIp, params } = req.body;
  if (!templateId) return res.json({ code: 400, msg: '请选择部署模板' });
  try {
    const tplR = await db.execute(`SELECT TEMPLATE_ID FROM DEPLOY_TEMPLATE WHERE TEMPLATE_ID=:1 AND ENABLED=1`, [templateId]);
    if (!tplR.rows.length) return res.json({ code: 404, msg: '模板不存在或已禁用' });

    const paramsStr = typeof params === 'object' ? JSON.stringify(params) : (params || '{}');
    const r = await db.execute(
      `INSERT INTO DEPLOY_JOB (TEMPLATE_ID, INSTANCE_ID, HOST_ID, TARGET_IP, PARAMS, STATUS, CREATED_BY)
       VALUES (:1, :2, :3, :4, :5, 'PENDING', :6)
       RETURNING JOB_ID INTO :7`,
      [templateId, instanceId || null, hostId || null, targetIp || null, paramsStr, req.user.userId,
       { dir: oracledb.BIND_OUT, type: oracledb.NUMBER }],
      { autoCommit: true }
    );
    const jobId = r.outBinds[0][0];
    res.json({ code: 200, msg: '任务已创建', data: { jobId } });
  } catch (e) { res.json({ code: 500, msg: e.message }); }
});

/** 执行/重试任务 */
router.post('/jobs/:id/execute', adminDbaOps, async (req, res) => {
  const jobId = Number(req.params.id);
  try {
    const jobR = await db.execute(`SELECT STATUS FROM DEPLOY_JOB WHERE JOB_ID=:1`, [jobId]);
    if (!jobR.rows.length) return res.json({ code: 404, msg: '任务不存在' });

    // 异步执行，立即返回
    clearCancelFlag(jobId);
    executeDeployJob(jobId, {
      cancelCheck: () => isCancelled(jobId),
    }).catch(e => console.error(`[deploy-runner] job ${jobId} error:`, e.message));

    res.json({ code: 200, msg: '任务开始执行' });
  } catch (e) { res.json({ code: 500, msg: e.message }); }
});

/** 取消任务 */
router.post('/jobs/:id/cancel', adminDbaOps, async (req, res) => {
  const jobId = Number(req.params.id);
  try {
    const jobR = await db.execute(`SELECT STATUS FROM DEPLOY_JOB WHERE JOB_ID=:1`, [jobId]);
    if (!jobR.rows.length) return res.json({ code: 404, msg: '任务不存在' });
    const status = jobR.rows[0].STATUS;
    if (status !== 'PENDING' && status !== 'RUNNING') {
      return res.json({ code: 400, msg: `状态为 ${status}，无法取消` });
    }

    if (status === 'RUNNING') {
      setCancelFlag(jobId);
    }

    await db.execute(
      `UPDATE DEPLOY_JOB SET STATUS='CANCELLED', CANCELLED_BY=:1, CANCELLED_AT=SYSTIMESTAMP,
       UPDATED_AT=SYSTIMESTAMP, END_TIME=SYSTIMESTAMP WHERE JOB_ID=:2`,
      [req.user.userId, jobId],
      { autoCommit: true }
    );
    res.json({ code: 200, msg: '任务已取消' });
  } catch (e) { res.json({ code: 500, msg: e.message }); }
});

/** 实时日志 */
router.get('/jobs/:id/log', async (req, res) => {
  try {
    const r = await db.execute(
      `SELECT STATUS, STEPS_LOG, LOG_SUMMARY, START_TIME, END_TIME FROM DEPLOY_JOB WHERE JOB_ID=:1`,
      [req.params.id]
    );
    if (!r.rows.length) return res.json({ code: 404, msg: '任务不存在' });
    const row = r.rows[0];
    let steps = [];
    try { steps = JSON.parse(row.STEPS_LOG || '[]'); } catch { steps = []; }
    res.json({
      code: 200,
      data: { status: row.STATUS, steps, summary: row.LOG_SUMMARY, startTime: row.START_TIME, endTime: row.END_TIME },
    });
  } catch (e) { res.json({ code: 500, msg: e.message }); }
});

/** 统计 */
router.get('/stats', async (req, res) => {
  try {
    const statusR = await db.execute(
      `SELECT STATUS, COUNT(*) CNT FROM DEPLOY_JOB GROUP BY STATUS`
    );
    const tplR = await db.execute(`SELECT COUNT(*) CNT FROM DEPLOY_TEMPLATE WHERE ENABLED=1`);
    res.json({
      code: 200,
      data: {
        byStatus: statusR.rows,
        enabledTemplates: tplR.rows[0]?.CNT || 0,
      },
    });
  } catch (e) { res.json({ code: 500, msg: e.message }); }
});

module.exports = router;
