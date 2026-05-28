const router = require('express').Router();
const db = require('../config/db');
const { authMiddleware, requireRole } = require('../middleware/auth');

router.use(authMiddleware);
const adminDba = requireRole('ADMIN', 'DBA');
const adminDbaOps = requireRole('ADMIN', 'DBA', 'OPS');

// 工单状态流转规则
const VALID_TRANSITIONS = {
  OPEN: ['IN_PROGRESS', 'REJECTED'],
  IN_PROGRESS: ['PENDING_REVIEW', 'RESOLVED'],
  PENDING_REVIEW: ['RESOLVED', 'IN_PROGRESS'],
  RESOLVED: ['CLOSED', 'IN_PROGRESS'],
  CLOSED: [],
  REJECTED: [],
};

// ======================== 统计 ========================

// GET /api/service-catalog/stats
router.get('/stats', async (req, res) => {
  try {
    const [byStatus, byPriority, total] = await Promise.all([
      db.execute(`SELECT STATUS, COUNT(*) CNT FROM OPS_SERVICE_ORDER GROUP BY STATUS`, []),
      db.execute(`SELECT PRIORITY, COUNT(*) CNT FROM OPS_SERVICE_ORDER GROUP BY PRIORITY`, []),
      db.execute(`SELECT COUNT(*) CNT FROM OPS_SERVICE_ORDER`, []),
    ]);
    res.json({
      code: 200,
      data: {
        total: total.rows[0]?.CNT || 0,
        byStatus: byStatus.rows || [],
        byPriority: byPriority.rows || [],
      },
    });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// ======================== 服务目录 CRUD ========================

// GET /api/service-catalog/catalogs
router.get('/catalogs', async (req, res) => {
  const { page = 1, size = 50, keyword } = req.query;
  try {
    let where = ['1=1'], binds = [], bi = 1;
    if (keyword) { where.push(`(SERVICE_NAME LIKE :${bi} OR CATEGORY LIKE :${bi})`); binds.push(`%${keyword}%`); bi++; }
    where.push(`NVL(ENABLED,1)=1`);
    const sql = `SELECT * FROM OPS_SERVICE_CATALOG WHERE ${where.join(' AND ')} ORDER BY SORT_ORDER, CATALOG_ID`;
    const data = await db.queryPage(sql, binds, Number(page), Number(size));
    res.json({ code: 200, data });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// GET /api/service-catalog/catalogs/:id
router.get('/catalogs/:id', async (req, res) => {
  try {
    const r = await db.execute(`SELECT * FROM OPS_SERVICE_CATALOG WHERE CATALOG_ID=:1`, [req.params.id]);
    if (!r.rows.length) return res.json({ code: 404, msg: '服务不存在' });
    res.json({ code: 200, data: r.rows[0] });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// POST /api/service-catalog/catalogs
router.post('/catalogs', adminDba, async (req, res) => {
  const { serviceName, category, description, needApproval, icon, sortOrder, slaHours, assigneeRole } = req.body;
  if (!serviceName) return res.json({ code: 400, msg: '服务名称不能为空' });
  try {
    const r = await db.execute(
      `INSERT INTO OPS_SERVICE_CATALOG (SERVICE_NAME, CATEGORY, DESCRIPTION, NEED_APPROVAL, ICON, SORT_ORDER, ENABLED, SLA_HOURS, ASSIGNEE_ROLE)
       VALUES (:1, :2, :3, :4, :5, :6, 1, :7, :8)`,
      [serviceName, category || null, description || null, needApproval ? 1 : 0, icon || null, sortOrder || 0, slaHours || null, assigneeRole || null]
    );
    await db.execute(
      `INSERT INTO SYS_AUDIT_LOG(USER_ID,USERNAME,ACTION,"RESOURCE",STATUS,DETAIL) VALUES(:1,:2,:3,:4,:5,:6)`,
      [req.user.userId, req.user.username, 'CREATE_CATALOG', 'ServiceCatalog', 'SUCCESS', serviceName]
    );
    res.json({ code: 200, msg: '创建成功' });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// PUT /api/service-catalog/catalogs/:id
router.put('/catalogs/:id', adminDba, async (req, res) => {
  const { serviceName, category, description, needApproval, icon, sortOrder, enabled, slaHours, assigneeRole } = req.body;
  try {
    await db.execute(
      `UPDATE OPS_SERVICE_CATALOG SET SERVICE_NAME=NVL(:1,SERVICE_NAME), CATEGORY=NVL(:2,CATEGORY),
       DESCRIPTION=:3, NEED_APPROVAL=NVL(:4,NEED_APPROVAL), ICON=NVL(:5,ICON),
       SORT_ORDER=NVL(:6,SORT_ORDER), ENABLED=NVL(:7,ENABLED), SLA_HOURS=:8, ASSIGNEE_ROLE=:9,
       UPDATED_AT=SYSTIMESTAMP WHERE CATALOG_ID=:10`,
      [serviceName, category, description, needApproval != null ? (needApproval ? 1 : 0) : null,
       icon, sortOrder, enabled != null ? (enabled ? 1 : 0) : null,
       slaHours, assigneeRole, req.params.id]
    );
    res.json({ code: 200, msg: '更新成功' });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// DELETE /api/service-catalog/catalogs/:id
router.delete('/catalogs/:id', adminDba, async (req, res) => {
  try {
    const cnt = await db.execute(
      `SELECT COUNT(*) C FROM OPS_SERVICE_ORDER WHERE CATALOG_ID=:1 AND STATUS NOT IN ('CLOSED','REJECTED')`,
      [req.params.id]
    );
    if (cnt.rows[0]?.C > 0) return res.json({ code: 400, msg: '该服务下有未关闭工单，无法删除' });
    await db.execute(`DELETE FROM OPS_SERVICE_CATALOG WHERE CATALOG_ID=:1`, [req.params.id]);
    res.json({ code: 200, msg: '删除成功' });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// ======================== 工单 CRUD ========================

// GET /api/service-catalog/orders  工单列表（分页+筛选）
router.get('/orders', async (req, res) => {
  const { page = 1, size = 20, status, priority, catalogId, keyword, assignee } = req.query;
  try {
    let where = ['1=1'], binds = [], bi = 1;
    if (status) { where.push(`o.STATUS=:${bi}`); binds.push(status); bi++; }
    if (priority) { where.push(`o.PRIORITY=:${bi}`); binds.push(priority); bi++; }
    if (catalogId) { where.push(`o.CATALOG_ID=:${bi}`); binds.push(Number(catalogId)); bi++; }
    if (assignee) { where.push(`o.ASSIGNED_TO=:${bi}`); binds.push(Number(assignee)); bi++; }
    if (keyword) {
      where.push(`(o.TITLE LIKE :${bi} OR o.REMARK LIKE :${bi})`);
      binds.push(`%${keyword}%`); bi++;
    }
    const sql = `SELECT o.ORDER_ID, o.TITLE, o.CATALOG_ID, o.INSTANCE_ID, o.STATUS, o.PRIORITY,
       o.TICKET_REF, o.REMARK, o.CREATED_BY, o.CREATED_AT, o.ASSIGNED_TO, o.UPDATED_AT,
       o.RESOLVED_AT, o.CLOSED_AT, o.FEEDBACK_SCORE, o.ALERT_ID,
       c.SERVICE_NAME, c.CATEGORY, c.SLA_HOURS,
       u1.USERNAME AS CREATOR_NAME, u2.USERNAME AS ASSIGNEE_NAME,
       i.INSTANCE_NAME
    FROM OPS_SERVICE_ORDER o
    LEFT JOIN OPS_SERVICE_CATALOG c ON o.CATALOG_ID = c.CATALOG_ID
    LEFT JOIN SYS_USER u1 ON o.CREATED_BY = u1.USER_ID
    LEFT JOIN SYS_USER u2 ON o.ASSIGNED_TO = u2.USER_ID
    LEFT JOIN CMDB_INSTANCE i ON o.INSTANCE_ID = i.INSTANCE_ID
    WHERE ${where.join(' AND ')}
    ORDER BY CASE o.PRIORITY WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END,
             o.CREATED_AT DESC`;
    const data = await db.queryPage(sql, binds, Number(page), Number(size));
    res.json({ code: 200, data });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// GET /api/service-catalog/my-orders  我的工单
router.get('/my-orders', async (req, res) => {
  const { page = 1, size = 20, type = 'created' } = req.query;
  try {
    let where;
    if (type === 'assigned') {
      where = `o.ASSIGNED_TO = :1`;
    } else {
      where = `o.CREATED_BY = :1`;
    }
    const sql = `SELECT o.ORDER_ID, o.TITLE, o.CATALOG_ID, o.INSTANCE_ID, o.STATUS, o.PRIORITY,
       o.TICKET_REF, o.REMARK, o.CREATED_BY, o.CREATED_AT, o.ASSIGNED_TO,
       c.SERVICE_NAME, c.CATEGORY,
       u1.USERNAME AS CREATOR_NAME, u2.USERNAME AS ASSIGNEE_NAME,
       i.INSTANCE_NAME
    FROM OPS_SERVICE_ORDER o
    LEFT JOIN OPS_SERVICE_CATALOG c ON o.CATALOG_ID = c.CATALOG_ID
    LEFT JOIN SYS_USER u1 ON o.CREATED_BY = u1.USER_ID
    LEFT JOIN SYS_USER u2 ON o.ASSIGNED_TO = u2.USER_ID
    LEFT JOIN CMDB_INSTANCE i ON o.INSTANCE_ID = i.INSTANCE_ID
    WHERE ${where}
    ORDER BY o.CREATED_AT DESC`;
    const data = await db.queryPage(sql, [req.user.userId], Number(page), Number(size));
    res.json({ code: 200, data });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// GET /api/service-catalog/orders/:id  工单详情（含评论）
router.get('/orders/:id', async (req, res) => {
  try {
    const r = await db.execute(
      `SELECT o.*, c.SERVICE_NAME, c.CATEGORY, c.SLA_HOURS, c.ASSIGNEE_ROLE,
              u1.USERNAME AS CREATOR_NAME, u2.USERNAME AS ASSIGNEE_NAME,
              i.INSTANCE_NAME
       FROM OPS_SERVICE_ORDER o
       LEFT JOIN OPS_SERVICE_CATALOG c ON o.CATALOG_ID = c.CATALOG_ID
       LEFT JOIN SYS_USER u1 ON o.CREATED_BY = u1.USER_ID
       LEFT JOIN SYS_USER u2 ON o.ASSIGNED_TO = u2.USER_ID
       LEFT JOIN CMDB_INSTANCE i ON o.INSTANCE_ID = i.INSTANCE_ID
       WHERE o.ORDER_ID=:1`,
      [req.params.id]
    );
    if (!r.rows.length) return res.json({ code: 404, msg: '工单不存在' });

    const comments = await db.execute(
      `SELECT oc.*, u.USERNAME AS AUTHOR_NAME
       FROM OPS_ORDER_COMMENT oc
       LEFT JOIN SYS_USER u ON oc.CREATED_BY = u.USER_ID
       WHERE oc.ORDER_ID=:1 ORDER BY oc.CREATED_AT ASC`,
      [req.params.id]
    );
    res.json({ code: 200, data: { ...r.rows[0], comments: comments.rows || [] } });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// POST /api/service-catalog/orders  创建工单
router.post('/orders', async (req, res) => {
  const { catalogId, instanceId, title, remark, priority, alertId } = req.body;
  if (!catalogId || !title) return res.json({ code: 400, msg: '服务类型和标题不能为空' });
  try {
    const cat = await db.execute(`SELECT NEED_APPROVAL, SERVICE_NAME FROM OPS_SERVICE_CATALOG WHERE CATALOG_ID=:1`, [catalogId]);
    if (!cat.rows.length) return res.json({ code: 400, msg: '服务类型不存在' });

    const initialStatus = cat.rows[0].NEED_APPROVAL ? 'OPEN' : 'IN_PROGRESS';
    const oracledb = require('oracledb');
    const r = await db.execute(
      `INSERT INTO OPS_SERVICE_ORDER (CATALOG_ID, INSTANCE_ID, TITLE, STATUS, PRIORITY, REMARK, CREATED_BY, ALERT_ID)
       VALUES (:1, :2, :3, :4, :5, :6, :7, :8)
       RETURNING ORDER_ID INTO :9`,
      [catalogId, instanceId || null, title, initialStatus, priority || 'MEDIUM', remark || null, req.user.userId, alertId || null,
       { dir: oracledb.BIND_OUT, type: oracledb.NUMBER }]
    );
    const orderId = r.outBinds?.[0];

    // 自动添加创建记录
    if (orderId) {
      await db.execute(
        `INSERT INTO OPS_ORDER_COMMENT (ORDER_ID, COMMENT_TYPE, CONTENT, CREATED_BY) VALUES (:1, 'STATUS_CHANGE', :2, :3)`,
        [orderId, `工单已创建，状态：${initialStatus}`, req.user.userId]
      );
    }

    await db.execute(
      `INSERT INTO SYS_AUDIT_LOG(USER_ID,USERNAME,ACTION,"RESOURCE",RESOURCE_ID,STATUS,DETAIL) VALUES(:1,:2,:3,:4,:5,:6,:7)`,
      [req.user.userId, req.user.username, 'CREATE_ORDER', 'ServiceOrder', String(orderId), 'SUCCESS', title]
    );
    res.json({ code: 200, msg: '工单创建成功', data: { orderId } });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// PUT /api/service-catalog/orders/:id  更新工单
router.put('/orders/:id', async (req, res) => {
  const { title, remark, priority } = req.body;
  try {
    const r = await db.execute(`SELECT CREATED_BY, STATUS FROM OPS_SERVICE_ORDER WHERE ORDER_ID=:1`, [req.params.id]);
    if (!r.rows.length) return res.json({ code: 404, msg: '工单不存在' });
    const order = r.rows[0];
    // 仅创建者或管理员可编辑
    if (order.CREATED_BY !== req.user.userId && !['ADMIN', 'DBA'].includes(req.user.role)) {
      return res.json({ code: 403, msg: '无权编辑此工单' });
    }
    if (['CLOSED', 'REJECTED'].includes(order.STATUS)) {
      return res.json({ code: 400, msg: '已关闭/已拒绝的工单不可编辑' });
    }
    await db.execute(
      `UPDATE OPS_SERVICE_ORDER SET TITLE=NVL(:1,TITLE), REMARK=:2, PRIORITY=NVL(:3,PRIORITY), UPDATED_AT=SYSTIMESTAMP WHERE ORDER_ID=:4`,
      [title, remark, priority, req.params.id]
    );
    res.json({ code: 200, msg: '更新成功' });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// POST /api/service-catalog/orders/:id/assign  指派工单
router.post('/orders/:id/assign', adminDbaOps, async (req, res) => {
  const { assigneeId } = req.body;
  if (!assigneeId) return res.json({ code: 400, msg: '指派人不能为空' });
  try {
    const r = await db.execute(`SELECT STATUS, TITLE FROM OPS_SERVICE_ORDER WHERE ORDER_ID=:1`, [req.params.id]);
    if (!r.rows.length) return res.json({ code: 404, msg: '工单不存在' });
    if (['CLOSED', 'REJECTED'].includes(r.rows[0].STATUS)) {
      return res.json({ code: 400, msg: '已关闭/已拒绝的工单不可指派' });
    }
    await db.execute(
      `UPDATE OPS_SERVICE_ORDER SET ASSIGNED_TO=:1, UPDATED_AT=SYSTIMESTAMP WHERE ORDER_ID=:2`,
      [assigneeId, req.params.id]
    );
    // 自动变为 IN_PROGRESS
    if (r.rows[0].STATUS === 'OPEN') {
      await db.execute(
        `UPDATE OPS_SERVICE_ORDER SET STATUS='IN_PROGRESS', UPDATED_AT=SYSTIMESTAMP WHERE ORDER_ID=:1 AND STATUS='OPEN'`,
        [req.params.id]
      );
    }
    const assigneeUser = await db.execute(`SELECT USERNAME FROM SYS_USER WHERE USER_ID=:1`, [assigneeId]);
    await db.execute(
      `INSERT INTO OPS_ORDER_COMMENT (ORDER_ID, COMMENT_TYPE, CONTENT, CREATED_BY) VALUES (:1, 'ASSIGN', :2, :3)`,
      [req.params.id, `工单已指派给 ${assigneeUser.rows[0]?.USERNAME || assigneeId}`, req.user.userId]
    );
    res.json({ code: 200, msg: '指派成功' });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// POST /api/service-catalog/orders/:id/status  变更状态
router.post('/orders/:id/status', async (req, res) => {
  const { status: newStatus } = req.body;
  if (!newStatus) return res.json({ code: 400, msg: '状态不能为空' });
  try {
    const r = await db.execute(
      `SELECT STATUS, CREATED_BY, ASSIGNED_TO, TITLE FROM OPS_SERVICE_ORDER WHERE ORDER_ID=:1`,
      [req.params.id]
    );
    if (!r.rows.length) return res.json({ code: 404, msg: '工单不存在' });
    const order = r.rows[0];

    // 权限检查：创建者、指派人、管理员可变更
    const isAllowed = order.CREATED_BY === req.user.userId
      || order.ASSIGNED_TO === req.user.userId
      || ['ADMIN', 'DBA'].includes(req.user.role);
    if (!isAllowed) return res.json({ code: 403, msg: '无权变更此工单状态' });

    // REJECTED 仅管理员
    if (newStatus === 'REJECTED' && !['ADMIN', 'DBA'].includes(req.user.role)) {
      return res.json({ code: 403, msg: '仅管理员可拒绝工单' });
    }

    // 状态流转校验
    const allowed = VALID_TRANSITIONS[order.STATUS] || [];
    if (!allowed.includes(newStatus)) {
      return res.json({ code: 400, msg: `不允许从 ${order.STATUS} 变更为 ${newStatus}` });
    }

    const updates = ['STATUS=:1', 'UPDATED_AT=SYSTIMESTAMP'];
    const binds = [newStatus];
    if (newStatus === 'RESOLVED') updates.push('RESOLVED_AT=SYSTIMESTAMP');
    if (newStatus === 'CLOSED') updates.push('CLOSED_AT=SYSTIMESTAMP');

    await db.execute(
      `UPDATE OPS_SERVICE_ORDER SET ${updates.join(', ')} WHERE ORDER_ID=:${binds.length + 1}`,
      [...binds, req.params.id]
    );

    const statusLabel = { IN_PROGRESS: '处理中', PENDING_REVIEW: '待审核', RESOLVED: '已解决', CLOSED: '已关闭', REJECTED: '已拒绝' };
    await db.execute(
      `INSERT INTO OPS_ORDER_COMMENT (ORDER_ID, COMMENT_TYPE, CONTENT, CREATED_BY) VALUES (:1, 'STATUS_CHANGE', :2, :3)`,
      [req.params.id, `状态变更为：${statusLabel[newStatus] || newStatus}`, req.user.userId]
    );
    res.json({ code: 200, msg: '状态变更成功' });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// POST /api/service-catalog/orders/:id/comment  添加评论
router.post('/orders/:id/comment', async (req, res) => {
  const { content } = req.body;
  if (!content) return res.json({ code: 400, msg: '评论内容不能为空' });
  try {
    const r = await db.execute(`SELECT ORDER_ID FROM OPS_SERVICE_ORDER WHERE ORDER_ID=:1`, [req.params.id]);
    if (!r.rows.length) return res.json({ code: 404, msg: '工单不存在' });
    await db.execute(
      `INSERT INTO OPS_ORDER_COMMENT (ORDER_ID, COMMENT_TYPE, CONTENT, CREATED_BY) VALUES (:1, 'COMMENT', :2, :3)`,
      [req.params.id, content, req.user.userId]
    );
    await db.execute(
      `UPDATE OPS_SERVICE_ORDER SET UPDATED_AT=SYSTIMESTAMP WHERE ORDER_ID=:1`,
      [req.params.id]
    );
    res.json({ code: 200, msg: '评论成功' });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// POST /api/service-catalog/orders/:id/feedback  提交满意度
router.post('/orders/:id/feedback', async (req, res) => {
  const { score, comment } = req.body;
  if (!score || score < 1 || score > 5) return res.json({ code: 400, msg: '评分 1-5' });
  try {
    const r = await db.execute(
      `SELECT CREATED_BY, STATUS FROM OPS_SERVICE_ORDER WHERE ORDER_ID=:1`,
      [req.params.id]
    );
    if (!r.rows.length) return res.json({ code: 404, msg: '工单不存在' });
    if (r.rows[0].CREATED_BY !== req.user.userId) return res.json({ code: 403, msg: '仅创建者可评价' });
    if (r.rows[0].STATUS !== 'RESOLVED' && r.rows[0].STATUS !== 'CLOSED') {
      return res.json({ code: 400, msg: '仅已解决/已关闭的工单可评价' });
    }
    await db.execute(
      `UPDATE OPS_SERVICE_ORDER SET FEEDBACK_SCORE=:1, FEEDBACK_COMMENT=:2, UPDATED_AT=SYSTIMESTAMP WHERE ORDER_ID=:3`,
      [score, comment || null, req.params.id]
    );
    await db.execute(
      `INSERT INTO OPS_ORDER_COMMENT (ORDER_ID, COMMENT_TYPE, CONTENT, CREATED_BY) VALUES (:1, 'COMMENT', :2, :3)`,
      [req.params.id, `满意度评价：${'★'.repeat(score)}${'☆'.repeat(5 - score)} ${comment || ''}`, req.user.userId]
    );
    res.json({ code: 200, msg: '评价成功' });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

module.exports = router;
