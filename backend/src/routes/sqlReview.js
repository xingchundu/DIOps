const router = require('express').Router();
const crypto = require('crypto');
const db = require('../config/db');
const { authMiddleware, requireRole } = require('../middleware/auth');
// 审核统一由 Java SQL 洞察执行（原 runInternalAudit 是 automation.js 正则规则的复制粘贴，已删除）
const sqlInsight = require('../utils/sqlInsightClient');
const { insertAuditRecord } = require('../utils/sqlAuditRecord');
const { createPublishTicketFromAudit } = require('../utils/publishTicket');

router.use(authMiddleware);
const adminDba = requireRole('ADMIN', 'DBA');

const OPEN_STATUSES = ['PENDING', 'IN_REVIEW', 'CHANGES_REQUESTED'];
const REVIEWER_ROLES = ['ADMIN', 'DBA', 'REVIEWER'];

function sqlHash(sql) { return crypto.createHash('md5').update(sql.trim().replace(/\s+/g, ' ')).digest('hex'); }

function parseScope(req) {
  let scope = req.query.scope || 'mine';
  if (scope === 'all' && !['ADMIN', 'DBA'].includes(req.user.role)) scope = 'mine';
  return scope;
}

/** 列表/统计可见范围（方案 2：未指派待审单仅 ADMIN/DBA 池可见） */
function appendVisibility(user, scope, where, binds, bi) {
  const uid = Number(user.userId);
  if (scope === 'all' && ['ADMIN', 'DBA'].includes(user.role)) return bi;
  if (scope === 'submitted') {
    where.push(`t.SUBMITTED_BY = :${bi}`);
    binds.push(uid);
    return bi + 1;
  }
  if (scope === 'assigned') {
    where.push(`t.ASSIGNED_TO = :${bi}`);
    binds.push(uid);
    return bi + 1;
  }
  if (['ADMIN', 'DBA'].includes(user.role)) {
    where.push(`(t.SUBMITTED_BY = :${bi} OR t.ASSIGNED_TO = :${bi + 1} OR (t.ASSIGNED_TO IS NULL AND t.STATUS IN ('PENDING','IN_REVIEW','CHANGES_REQUESTED')))`);
    binds.push(uid, uid);
    return bi + 2;
  }
  where.push(`(t.SUBMITTED_BY = :${bi} OR t.ASSIGNED_TO = :${bi + 1})`);
  binds.push(uid, uid);
  return bi + 2;
}

function ticketVisibleToUser(user, ticket) {
  const uid = Number(user.userId);
  if (user.role === 'ADMIN') return true;
  if (Number(ticket.SUBMITTED_BY) === uid) return true;
  if (ticket.ASSIGNED_TO != null && Number(ticket.ASSIGNED_TO) === uid) return true;
  if (ticket.ASSIGNED_TO == null && OPEN_STATUSES.includes(ticket.STATUS) && ['ADMIN', 'DBA'].includes(user.role)) return true;
  return false;
}

function canAssignTicket(user, ticket) {
  if (!OPEN_STATUSES.includes(ticket.STATUS)) return false;
  const uid = Number(user.userId);
  if (user.role === 'ADMIN') return true;
  if (Number(ticket.SUBMITTED_BY) === uid) return true;
  if (ticket.ASSIGNED_TO != null && Number(ticket.ASSIGNED_TO) === uid) return true;
  if (ticket.ASSIGNED_TO == null && user.role === 'DBA') return true;
  return false;
}

function canHumanReview(user, ticket) {
  if (!OPEN_STATUSES.includes(ticket.STATUS)) return false;
  if (!REVIEWER_ROLES.includes(user.role)) return false;
  const uid = Number(user.userId);
  const assigned = ticket.ASSIGNED_TO != null ? Number(ticket.ASSIGNED_TO) : null;
  if (assigned != null) {
    if (user.role === 'ADMIN') return true;
    return uid === assigned;
  }
  return ['ADMIN', 'DBA'].includes(user.role);
}

async function validateAssigneeUser(assigneeId) {
  if (assigneeId == null) return null;
  const res = await db.execute(
    `SELECT USER_ID, USERNAME, REAL_NAME, ROLE FROM SYS_USER WHERE USER_ID = :1 AND STATUS = 1`, [assigneeId]);
  if (!res.rows.length) {
    const err = new Error('指定审核人不存在或已禁用');
    err.code = 400;
    throw err;
  }
  if (!REVIEWER_ROLES.includes(res.rows[0].ROLE)) {
    const err = new Error('审核人须为 ADMIN / DBA / REVIEWER');
    err.code = 400;
    throw err;
  }
  return res.rows[0];
}

// ─── SQL 评审工单 CRUD ──────────────────────────────────────

// GET /api/sql-review/reviewers — 可选审核人（指定指派用）
router.get('/reviewers', async (req, res) => {
  try {
    const { rows } = await db.execute(
      `SELECT USER_ID, USERNAME, REAL_NAME, ROLE FROM SYS_USER WHERE STATUS = 1 AND ROLE IN ('ADMIN','DBA','REVIEWER') ORDER BY ROLE, USERNAME`);
    res.json({ code: 200, data: rows });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// GET /api/sql-review/tickets — 评审工单列表
router.get('/tickets', async (req, res) => {
  try {
    const { status, source, priority, submittedBy, page = 1, size = 20 } = req.query;
    const scope = parseScope(req);
    let where = ['1=1']; let binds = []; let bi = 1;
    bi = appendVisibility(req.user, scope, where, binds, bi);
    if (status)      { where.push(`t.STATUS = :${bi}`); binds.push(status); bi++; }
    if (source)      { where.push(`t.SOURCE = :${bi}`); binds.push(source); bi++; }
    if (priority)    { where.push(`t.PRIORITY = :${bi}`); binds.push(priority); bi++; }
    if (submittedBy) { where.push(`t.SUBMITTED_BY = :${bi}`); binds.push(Number(submittedBy)); bi++; }
    const sql = `SELECT t.TICKET_ID, t.TITLE, t.SQL_TEXT, t.INSTANCE_ID, t.DB_TYPE, t.ENVIRONMENT,
                        t.SOURCE, t.STATUS, t.SCORE, t.RISK_LEVEL, t.PRIORITY,
                        t.SUBMITTED_BY, t.ASSIGNED_TO, t.REVIEWED_BY, t.REVIEW_COMMENT,
                        t.SUBMITTED_AT, t.REVIEWED_AT, t.CREATED_AT,
                        su.USERNAME AS SUBMITTER_NAME, su.REAL_NAME AS SUBMITTER_REAL_NAME,
                        ru.USERNAME AS REVIEWER_NAME, ru.REAL_NAME AS REVIEWER_REAL_NAME,
                        au.USERNAME AS ASSIGNED_NAME, au.REAL_NAME AS ASSIGNED_REAL_NAME,
                        i.INSTANCE_NAME,
                        (SELECT COUNT(*) FROM SQL_REVIEW_COMMENT c WHERE c.TICKET_ID = t.TICKET_ID) AS COMMENT_COUNT
                 FROM SQL_REVIEW_TICKET t
                 LEFT JOIN SYS_USER su ON t.SUBMITTED_BY = su.USER_ID
                 LEFT JOIN SYS_USER ru ON t.REVIEWED_BY = ru.USER_ID
                 LEFT JOIN SYS_USER au ON t.ASSIGNED_TO = au.USER_ID
                 LEFT JOIN CMDB_INSTANCE i ON t.INSTANCE_ID = i.INSTANCE_ID
                 WHERE ${where.join(' AND ')}
                 ORDER BY t.CREATED_AT DESC`;
    const data = await db.queryPage(sql, binds, page, size);
    res.json({ code: 200, data: { ...data, scope } });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// GET /api/sql-review/tickets/:id — 评审工单详情
router.get('/tickets/:id', async (req, res) => {
  try {
    const { rows } = await db.execute(
      `SELECT t.*,
              su.USERNAME AS SUBMITTER_NAME, su.REAL_NAME AS SUBMITTER_REAL_NAME,
              ru.USERNAME AS REVIEWER_NAME, ru.REAL_NAME AS REVIEWER_REAL_NAME,
              au.USERNAME AS ASSIGNED_NAME, au.REAL_NAME AS ASSIGNED_REAL_NAME,
              i.INSTANCE_NAME, i.DB_TYPE AS INST_DB_TYPE
       FROM SQL_REVIEW_TICKET t
       LEFT JOIN SYS_USER su ON t.SUBMITTED_BY = su.USER_ID
       LEFT JOIN SYS_USER ru ON t.REVIEWED_BY = ru.USER_ID
       LEFT JOIN SYS_USER au ON t.ASSIGNED_TO = au.USER_ID
       LEFT JOIN CMDB_INSTANCE i ON t.INSTANCE_ID = i.INSTANCE_ID
       WHERE t.TICKET_ID = :1`, [req.params.id]);
    if (!rows.length) return res.json({ code: 404, msg: '评审工单不存在' });
    if (!ticketVisibleToUser(req.user, rows[0])) return res.json({ code: 403, msg: '无权查看该工单' });

    // 获取自动审核结果
    let auditResult = null;
    if (rows[0].AUDIT_ID) {
      const auditRes = await db.execute(
        `SELECT * FROM SQL_AUDIT_RECORD WHERE AUDIT_ID = :1`, [rows[0].AUDIT_ID]);
      if (auditRes.rows.length) auditResult = auditRes.rows[0];
    }

    res.json({ code: 200, data: { ...rows[0], auditResult } });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// POST /api/sql-review/tickets — 创建评审工单
router.post('/tickets', async (req, res) => {
  try {
    const { title, sqlText, instanceId, dbType, environment, source, priority, assignedTo } = req.body;
    if (!title || !sqlText) return res.json({ code: 400, msg: '标题和 SQL 内容不能为空' });
    if (assignedTo) {
      try {
        await validateAssigneeUser(Number(assignedTo));
      } catch (e) {
        return res.json({ code: e.code || 400, msg: e.message });
      }
    }
    const hash = sqlHash(sqlText);

    // 创建工单
    const oracledb = require('oracledb');
    const result = await db.execute(
      `INSERT INTO SQL_REVIEW_TICKET (TITLE, SQL_TEXT, SQL_HASH, INSTANCE_ID, DB_TYPE, ENVIRONMENT, SOURCE, PRIORITY, SUBMITTED_BY, ASSIGNED_TO)
       VALUES (:1, :2, :3, :4, :5, :6, :7, :8, :9, :10)
       RETURNING TICKET_ID INTO :11`,
      [title, sqlText, hash, instanceId || null, dbType || null, environment || 'DEV',
       source || 'ONLINE', priority || 'NORMAL', req.user.userId, assignedTo || null,
       { dir: oracledb.BIND_OUT, type: oracledb.NUMBER }]);
    const ticketId = result.outBinds?.[0]?.[0];

    // 插入系统评论
    if (ticketId) {
      await db.execute(
        `INSERT INTO SQL_REVIEW_COMMENT (TICKET_ID, USER_ID, COMMENT_TEXT, COMMENT_TYPE)
         VALUES (:1, :2, :3, 'SYSTEM')`,
        [ticketId, req.user.userId, `工单创建，来源: ${source || 'ONLINE'}`]);
    }

    res.json({ code: 200, msg: '创建成功', data: { ticketId } });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// POST /api/sql-review/tickets/:id/auto-audit — 触发自动审核
router.post('/tickets/:id/auto-audit', async (req, res) => {
  try {
    const ticketRes = await db.execute(
      `SELECT TICKET_ID, SQL_TEXT, INSTANCE_ID, STATUS, SUBMITTED_BY, ASSIGNED_TO FROM SQL_REVIEW_TICKET WHERE TICKET_ID = :1`,
      [req.params.id]);
    if (!ticketRes.rows.length) return res.json({ code: 404, msg: '工单不存在' });
    const ticket = ticketRes.rows[0];
    if (!ticketVisibleToUser(req.user, ticket)) return res.json({ code: 403, msg: '无权操作该工单' });
    if (ticket.STATUS === 'APPROVED' || ticket.STATUS === 'REJECTED' || ticket.STATUS === 'CANCELLED')
      return res.json({ code: 400, msg: '该工单已审核完毕或已取消' });

    // 统一审核引擎（Druid AST + 规则中心 + 目标实例检查），与治理中心/发布预审结论一致
    let auditResult;
    try {
      auditResult = await sqlInsight.audit(req, { sqlText: ticket.SQL_TEXT, instanceId: ticket.INSTANCE_ID, instanceCheck: !!ticket.INSTANCE_ID });
    } catch (e) {
      return res.json({ code: 503, msg: `SQL 审核服务不可用：${e.message}` });
    }
    auditResult.risk = auditResult.risk || 'MEDIUM';

    // 写入 SQL_AUDIT_RECORD（附 ASSET_ID）并关联工单
    // [fix] 原来 INSERT 后用 SELECT MAX(AUDIT_ID) WHERE SQL_HASH 取回，同一 SQL 并发审核会串单
    const auditId = await insertAuditRecord({
      instanceId: ticket.INSTANCE_ID, sqlText: ticket.SQL_TEXT, result: auditResult, source: 'MANUAL', userId: req.user.userId,
    });
    const assetId = sqlInsight.assetIdOf(auditResult);
    try {
      await db.execute(
        `UPDATE SQL_REVIEW_TICKET SET SCORE=:1, RISK_LEVEL=:2, STATUS='IN_REVIEW', AUDIT_ID=:3, ASSET_ID=:4, UPDATED_AT=SYSTIMESTAMP WHERE TICKET_ID=:5`,
        [auditResult.score, auditResult.risk, auditId, assetId, req.params.id]);
    } catch (e) {
      if (!/ORA-00904/.test(String(e.message))) throw e;   // 未执行 migration_sql_insight.sql（无 ASSET_ID 列）
      await db.execute(
        `UPDATE SQL_REVIEW_TICKET SET SCORE=:1, RISK_LEVEL=:2, STATUS='IN_REVIEW', AUDIT_ID=:3, UPDATED_AT=SYSTIMESTAMP WHERE TICKET_ID=:4`,
        [auditResult.score, auditResult.risk, auditId, req.params.id]);
    }

    // 插入系统评论
    await db.execute(
      `INSERT INTO SQL_REVIEW_COMMENT (TICKET_ID, USER_ID, COMMENT_TEXT, COMMENT_TYPE)
       VALUES (:1, :2, :3, 'SYSTEM')`,
      [req.params.id, req.user.userId,
       `自动审核完成: 评分 ${auditResult.score}, 风险 ${auditResult.risk}, ${auditResult.issues?.length || 0} 个问题`]);

    res.json({ code: 200, msg: '自动审核完成', data: auditResult });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// POST /api/sql-review/tickets/:id/review — 审核操作
router.post('/tickets/:id/review', async (req, res) => {
  try {
    const { action, comment, selfApprove } = req.body; // APPROVE / REJECT / REQUEST_CHANGE
    if (!['APPROVE', 'REJECT', 'REQUEST_CHANGE'].includes(action))
      return res.json({ code: 400, msg: '无效的审核操作' });

    const ticketRes = await db.execute(
      `SELECT STATUS, SUBMITTED_BY, ENVIRONMENT, ASSIGNED_TO FROM SQL_REVIEW_TICKET WHERE TICKET_ID = :1`, [req.params.id]);
    if (!ticketRes.rows.length) return res.json({ code: 404, msg: '工单不存在' });
    const ticket = ticketRes.rows[0];
    if (!ticketVisibleToUser(req.user, ticket)) return res.json({ code: 403, msg: '无权操作该工单' });
    if (!canHumanReview(req.user, ticket)) return res.json({ code: 403, msg: '您不是该工单的指定审核人，或未开放审核权限' });
    if (!OPEN_STATUSES.includes(ticket.STATUS))
      return res.json({ code: 400, msg: '该工单已完结' });
    // [fix] 原来对「提交人 = 当前用户」一律拒绝 APPROVE，前端把「通过」按钮整个隐藏，
    //       界面只剩「拒绝 / 要求修改」，用户以为功能缺失。现在保留职责分离：默认仍禁止，
    //       但 ADMIN/DBA 在前端二次确认后带 selfApprove=true 可以自审通过，并留痕。
    const selfSubmitted = Number(ticket.SUBMITTED_BY) === Number(req.user.userId);
    const selfApproveAllowed = selfApprove === true && ['ADMIN', 'DBA'].includes(req.user.role);
    if (action === 'APPROVE' && selfSubmitted && !selfApproveAllowed)
      return res.json({ code: 403, msg: '不能审核通过自己提交的工单，请由其他 DBA 审核；如确需自审，请在弹窗中二次确认' });

    const newStatus = action === 'APPROVE' ? 'APPROVED' : action === 'REJECT' ? 'REJECTED' : 'CHANGES_REQUESTED';
    const statusComment = { APPROVE: '审核通过', REJECT: '审核拒绝', REQUEST_CHANGE: '要求修改' }[action];
    const reviewNote = selfSubmitted && action === 'APPROVE' && selfApproveAllowed
      ? `${statusComment}（提交人自审通过，已二次确认）${comment ? '：' + comment : ''}`
      : (comment || statusComment);

    // 以当前状态为条件更新，避免两人同时审核时后者覆盖前者
    const upd = await db.execute(
      `UPDATE SQL_REVIEW_TICKET SET STATUS=:1, REVIEWED_BY=:2, REVIEWED_AT=SYSTIMESTAMP,
       REVIEW_COMMENT=:3, UPDATED_AT=SYSTIMESTAMP WHERE TICKET_ID=:4 AND STATUS=:5`,
      [newStatus, req.user.userId, reviewNote, req.params.id, ticket.STATUS]);
    const affected = upd.rowsAffected ?? 0;
    if (affected < 1) return res.json({ code: 409, msg: '工单状态已变化，请刷新后重试' });

    // 插入审核评论（与主状态更新保持同一份文案）
    await db.execute(
      `INSERT INTO SQL_REVIEW_COMMENT (TICKET_ID, USER_ID, COMMENT_TEXT, COMMENT_TYPE)
       VALUES (:1, :2, :3, :4)`,
      [req.params.id, req.user.userId, reviewNote, action]);

    res.json({ code: 200, msg: `审核${statusComment}` });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// POST /api/sql-review/tickets/:id/push-to-publish — 评审通过的工单推送到自动发布（原 SQL 治理中心“推送发布”并入此处）
router.post('/tickets/:id/push-to-publish', async (req, res) => {
  try {
    if (!['ADMIN', 'DBA', 'OPS'].includes(req.user.role)) return res.json({ code: 403, msg: '无权限' });
    const t = await db.execute(`SELECT TICKET_ID, TITLE, SQL_TEXT, INSTANCE_ID, STATUS, AUDIT_ID, SUBMITTED_BY, ASSIGNED_TO FROM SQL_REVIEW_TICKET WHERE TICKET_ID=:1`,
      [req.params.id], { fetchAsString: [require('oracledb').CLOB] });
    if (!t.rows.length) return res.json({ code: 404, msg: '工单不存在' });
    const ticket = t.rows[0];
    if (!ticketVisibleToUser(req.user, ticket)) return res.json({ code: 403, msg: '无权操作该工单' });
    if (ticket.STATUS !== 'APPROVED') return res.json({ code: 400, msg: '只有评审通过（APPROVED）的工单可以推送发布' });
    if (!ticket.AUDIT_ID) return res.json({ code: 400, msg: '工单没有审核记录，请先执行自动审核' });
    // [fix] 网络重试 / 双击会重复生成发布工单：先查已推送记录，命中则直接返回原单号（幂等）
    const pushed = await db.execute(
      `SELECT COMMENT_TEXT FROM SQL_REVIEW_COMMENT
        WHERE TICKET_ID=:1 AND COMMENT_TYPE='SYSTEM' AND COMMENT_TEXT LIKE '已推送发布工单%'
        ORDER BY CREATED_AT DESC`, [req.params.id]);
    const pushedRow = pushed.rows?.[0];
    if (pushedRow) {
      const text = typeof pushedRow.COMMENT_TEXT === 'string' ? pushedRow.COMMENT_TEXT : String(pushedRow.COMMENT_TEXT || '');
      const ticketNo = (text.match(/已推送发布工单\s*(\S+)/) || [])[1] || '';
      return res.json({ code: 200, msg: '该工单已推送过发布流程，未重复生成', data: { ticketNo, duplicated: true } });
    }
    const r = await createPublishTicketFromAudit({
      auditId: ticket.AUDIT_ID, sqlText: ticket.SQL_TEXT, instanceId: req.body?.instanceId || ticket.INSTANCE_ID,
      title: req.body?.title || `[SQL评审#${ticket.TICKET_ID}] ${ticket.TITLE}`, ticketType: req.body?.ticketType, userId: req.user.userId,
    });
    await db.execute(`INSERT INTO SQL_REVIEW_COMMENT (TICKET_ID, USER_ID, COMMENT_TEXT, COMMENT_TYPE) VALUES (:1, :2, :3, 'SYSTEM')`,
      [ticket.TICKET_ID, req.user.userId, `已推送发布工单 ${r.ticketNo}`]).catch(() => {});
    res.json({ code: 200, msg: r.fullScanDetected ? '已推送至发布流程（附带全表扫描优化建议）' : '已推送至发布工单审核流程', data: r });
  } catch (err) { res.json({ code: err.code === 400 || err.code === 404 ? err.code : 500, msg: err.message }); }
});

// 指定 / 改派审核人（允许空指派进入 DBA 待审池）
// [fix] 现场报「接口不存在: PATCH /api/sql-review/tickets/21/assign」：部署态的 Java 网关 /
//       旧 Node 构建可能只放行 POST。这里同时注册 PATCH / POST / PUT 三种方法，
//       Java 侧另有同路径 Controller 兜底，保证升级后无论走到哪一层都能命中。
async function assignHandler(req, res) {
  try {
    const assigneeRaw = req.body?.assignedTo;
    const assignedTo = assigneeRaw === null || assigneeRaw === '' || assigneeRaw === undefined
      ? null
      : Number(assigneeRaw);
    if (assignedTo != null && (!Number.isSafeInteger(assignedTo) || assignedTo <= 0)) {
      return res.json({ code: 400, msg: 'assignedTo 必须为正整数或空' });
    }
    const ticketRes = await db.execute(
      `SELECT TICKET_ID, STATUS, SUBMITTED_BY, ASSIGNED_TO, TITLE FROM SQL_REVIEW_TICKET WHERE TICKET_ID = :1`, [req.params.id]);
    if (!ticketRes.rows.length) return res.json({ code: 404, msg: '工单不存在' });
    const ticket = ticketRes.rows[0];
    if (!ticketVisibleToUser(req.user, ticket)) return res.json({ code: 403, msg: '无权操作该工单' });
    if (!canAssignTicket(req.user, ticket)) return res.json({ code: 403, msg: '当前状态或角色不允许改派' });
    let assigneeUser = null;
    if (assignedTo != null) {
      try {
        assigneeUser = await validateAssigneeUser(assignedTo);
      } catch (e) {
        return res.json({ code: e.code || 400, msg: e.message });
      }
    }
    await db.execute(
      `UPDATE SQL_REVIEW_TICKET SET ASSIGNED_TO=:1, UPDATED_AT=SYSTIMESTAMP WHERE TICKET_ID=:2`,
      [assignedTo, req.params.id]);
    const label = assigneeUser
      ? `${assigneeUser.REAL_NAME || assigneeUser.USERNAME}（${assigneeUser.USERNAME}）`
      : '未指派（DBA 待审池）';
    await db.execute(
      `INSERT INTO SQL_REVIEW_COMMENT (TICKET_ID, USER_ID, COMMENT_TEXT, COMMENT_TYPE) VALUES (:1, :2, :3, 'SYSTEM')`,
      [req.params.id, req.user.userId, `审核人已更新为：${label}${req.body?.comment ? '；' + req.body.comment : ''}`]);
    res.json({ code: 200, msg: '审核人已更新', data: { assignedTo } });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
}
router.patch('/tickets/:id/assign', assignHandler);
router.post('/tickets/:id/assign', assignHandler);
router.put('/tickets/:id/assign', assignHandler);

// POST /api/sql-review/tickets/:id/cancel — 取消工单
router.post('/tickets/:id/cancel', async (req, res) => {
  try {
    const ticketRes = await db.execute(
      `SELECT STATUS, SUBMITTED_BY, ASSIGNED_TO FROM SQL_REVIEW_TICKET WHERE TICKET_ID = :1`, [req.params.id]);
    if (!ticketRes.rows.length) return res.json({ code: 404, msg: '工单不存在' });
    if (!ticketVisibleToUser(req.user, ticketRes.rows[0])) return res.json({ code: 403, msg: '无权操作该工单' });
    if (ticketRes.rows[0].STATUS !== 'PENDING' && ticketRes.rows[0].STATUS !== 'CHANGES_REQUESTED')
      return res.json({ code: 400, msg: '仅待审核/需修改状态可取消' });
    // 只有提交人或管理员可取消
    if (Number(ticketRes.rows[0].SUBMITTED_BY) !== Number(req.user.userId) && !['ADMIN', 'DBA'].includes(req.user.role))
      return res.json({ code: 403, msg: '无权限取消' });

    await db.execute(
      `UPDATE SQL_REVIEW_TICKET SET STATUS='CANCELLED', UPDATED_AT=SYSTIMESTAMP WHERE TICKET_ID=:1`,
      [req.params.id]);
    await db.execute(
      `INSERT INTO SQL_REVIEW_COMMENT (TICKET_ID, USER_ID, COMMENT_TEXT, COMMENT_TYPE) VALUES (:1, :2, '工单已取消', 'SYSTEM')`,
      [req.params.id, req.user.userId]);

    res.json({ code: 200, msg: '已取消' });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// ─── 评论 ───────────────────────────────────────────────────

// GET /api/sql-review/tickets/:id/comments — 获取评论列表
router.get('/tickets/:id/comments', async (req, res) => {
  try {
    const t = await db.execute(`SELECT SUBMITTED_BY, ASSIGNED_TO, STATUS FROM SQL_REVIEW_TICKET WHERE TICKET_ID = :1`, [req.params.id]);
    if (!t.rows.length) return res.json({ code: 404, msg: '工单不存在' });
    if (!ticketVisibleToUser(req.user, t.rows[0])) return res.json({ code: 403, msg: '无权查看该工单' });
    const { rows } = await db.execute(
      `SELECT c.*, u.USERNAME, u.REAL_NAME
       FROM SQL_REVIEW_COMMENT c
       LEFT JOIN SYS_USER u ON c.USER_ID = u.USER_ID
       WHERE c.TICKET_ID = :1 ORDER BY c.CREATED_AT ASC`, [req.params.id]);
    res.json({ code: 200, data: rows });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// POST /api/sql-review/tickets/:id/comments — 添加评论
router.post('/tickets/:id/comments', async (req, res) => {
  try {
    const t = await db.execute(`SELECT SUBMITTED_BY, ASSIGNED_TO, STATUS FROM SQL_REVIEW_TICKET WHERE TICKET_ID = :1`, [req.params.id]);
    if (!t.rows.length) return res.json({ code: 404, msg: '工单不存在' });
    if (!ticketVisibleToUser(req.user, t.rows[0])) return res.json({ code: 403, msg: '无权操作该工单' });
    const { commentText } = req.body;
    if (!commentText) return res.json({ code: 400, msg: '评论内容不能为空' });
    await db.execute(
      `INSERT INTO SQL_REVIEW_COMMENT (TICKET_ID, USER_ID, COMMENT_TEXT, COMMENT_TYPE)
       VALUES (:1, :2, :3, 'COMMENT')`,
      [req.params.id, req.user.userId, commentText]);
    res.json({ code: 200, msg: '评论成功' });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// ─── 统计 ───────────────────────────────────────────────────

// GET /api/sql-review/stats — 评审统计
router.get('/stats', async (req, res) => {
  try {
    const scope = parseScope(req);
    const where = ['1=1'];
    const binds = [];
    appendVisibility(req.user, scope, where, binds, 1);
    const w = where.join(' AND ');
    const [byStatus, bySource, byRisk, avgScore] = await Promise.all([
      db.execute(`SELECT t.STATUS, COUNT(*) AS CNT FROM SQL_REVIEW_TICKET t WHERE ${w} GROUP BY t.STATUS`, binds),
      db.execute(`SELECT t.SOURCE, COUNT(*) AS CNT FROM SQL_REVIEW_TICKET t WHERE ${w} GROUP BY t.SOURCE`, binds),
      db.execute(`SELECT t.RISK_LEVEL, COUNT(*) AS CNT FROM SQL_REVIEW_TICKET t WHERE ${w} AND t.STATUS IN ('PENDING','IN_REVIEW') GROUP BY t.RISK_LEVEL`, binds),
      db.execute(`SELECT ROUND(AVG(t.SCORE),1) AS AVG_SCORE FROM SQL_REVIEW_TICKET t WHERE ${w} AND t.SCORE IS NOT NULL`, binds),
    ]);
    const pendingCount = await db.execute(
      `SELECT COUNT(*) AS CNT FROM SQL_REVIEW_TICKET t WHERE ${w} AND t.STATUS IN ('PENDING','IN_REVIEW')`, binds);
    res.json({
      code: 200,
      data: {
        byStatus: byStatus.rows,
        bySource: bySource.rows,
        byRisk: byRisk.rows,
        avgScore: avgScore.rows[0]?.AVG_SCORE || 0,
        pendingCount: pendingCount.rows[0]?.CNT || 0,
      }
    });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

module.exports = router;
