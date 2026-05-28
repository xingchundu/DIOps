const router = require('express').Router();
const crypto = require('crypto');
const db = require('../config/db');
const { authMiddleware, requireRole } = require('../middleware/auth');

router.use(authMiddleware);
const adminDba = requireRole('ADMIN', 'DBA');

function sqlHash(sql) { return crypto.createHash('md5').update(sql.trim().replace(/\s+/g, ' ')).digest('hex'); }

// ─── SQL 评审工单 CRUD ──────────────────────────────────────

// GET /api/sql-review/tickets — 评审工单列表
router.get('/tickets', async (req, res) => {
  try {
    const { status, source, priority, submittedBy, page = 1, size = 20 } = req.query;
    let where = ['1=1']; let binds = []; let bi = 1;
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
                        i.INSTANCE_NAME,
                        (SELECT COUNT(*) FROM SQL_REVIEW_COMMENT c WHERE c.TICKET_ID = t.TICKET_ID) AS COMMENT_COUNT
                 FROM SQL_REVIEW_TICKET t
                 LEFT JOIN SYS_USER su ON t.SUBMITTED_BY = su.USER_ID
                 LEFT JOIN SYS_USER ru ON t.REVIEWED_BY = ru.USER_ID
                 LEFT JOIN CMDB_INSTANCE i ON t.INSTANCE_ID = i.INSTANCE_ID
                 WHERE ${where.join(' AND ')}
                 ORDER BY t.CREATED_AT DESC`;
    const data = await db.queryPage(sql, binds, page, size);
    res.json({ code: 200, data });
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
    const hash = sqlHash(sqlText);

    // 创建工单
    const result = await db.execute(
      `INSERT INTO SQL_REVIEW_TICKET (TITLE, SQL_TEXT, SQL_HASH, INSTANCE_ID, DB_TYPE, ENVIRONMENT, SOURCE, PRIORITY, SUBMITTED_BY, ASSIGNED_TO)
       VALUES (:1, :2, :3, :4, :5, :6, :7, :8, :9, :10)`,
      [title, sqlText, hash, instanceId || null, dbType || null, environment || 'DEV',
       source || 'ONLINE', priority || 'NORMAL', req.user.userId, assignedTo || null]);

    // 获取新建工单 ID
    const idRes = await db.execute(
      `SELECT MAX(TICKET_ID) AS ID FROM SQL_REVIEW_TICKET WHERE SUBMITTED_BY = :1 AND SQL_HASH = :2`,
      [req.user.userId, hash]);
    const ticketId = idRes.rows[0]?.ID;

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
      `SELECT TICKET_ID, SQL_TEXT, INSTANCE_ID, STATUS FROM SQL_REVIEW_TICKET WHERE TICKET_ID = :1`,
      [req.params.id]);
    if (!ticketRes.rows.length) return res.json({ code: 404, msg: '工单不存在' });
    const ticket = ticketRes.rows[0];
    if (ticket.STATUS === 'APPROVED' || ticket.STATUS === 'REJECTED')
      return res.json({ code: 400, msg: '该工单已审核完毕' });

    // 调用已有审核逻辑
    const http = require('http');
    const aiAgentUrl = process.env.AI_OPS_AGENT_URL || 'http://127.0.0.1:8001';

    // 使用内部审核逻辑
    const auditResult = await runInternalAudit(ticket.SQL_TEXT, ticket.INSTANCE_ID);

    // 更新工单
    await db.execute(
      `UPDATE SQL_REVIEW_TICKET SET SCORE=:1, RISK_LEVEL=:2, STATUS='IN_REVIEW', UPDATED_AT=SYSTIMESTAMP WHERE TICKET_ID=:3`,
      [auditResult.score, auditResult.risk, req.params.id]);

    // 写入 SQL_AUDIT_RECORD
    await db.execute(
      `INSERT INTO SQL_AUDIT_RECORD (INSTANCE_ID, SQL_TEXT, SQL_HASH, AUDIT_RESULT, SCORE, RISK_LEVEL, SOURCE, SUBMITTED_BY)
       VALUES (:1, :2, :3, :4, :5, :6, 'MANUAL', :7)`,
      [ticket.INSTANCE_ID, ticket.SQL_TEXT, sqlHash(ticket.SQL_TEXT),
       JSON.stringify(auditResult), auditResult.score, auditResult.risk, req.user.userId]);

    // 获取 audit_id
    const auditIdRes = await db.execute(
      `SELECT MAX(AUDIT_ID) AS ID FROM SQL_AUDIT_RECORD WHERE SQL_HASH = :1`,
      [sqlHash(ticket.SQL_TEXT)]);
    const auditId = auditIdRes.rows[0]?.ID;

    if (auditId) {
      await db.execute(`UPDATE SQL_REVIEW_TICKET SET AUDIT_ID=:1 WHERE TICKET_ID=:2`, [auditId, req.params.id]);
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
    const { action, comment } = req.body; // APPROVE / REJECT / REQUEST_CHANGE
    if (!['APPROVE', 'REJECT', 'REQUEST_CHANGE'].includes(action))
      return res.json({ code: 400, msg: '无效的审核操作' });

    const ticketRes = await db.execute(
      `SELECT STATUS, SUBMITTED_BY FROM SQL_REVIEW_TICKET WHERE TICKET_ID = :1`, [req.params.id]);
    if (!ticketRes.rows.length) return res.json({ code: 404, msg: '工单不存在' });
    const ticket = ticketRes.rows[0];
    if (ticket.STATUS === 'APPROVED' || ticket.STATUS === 'REJECTED' || ticket.STATUS === 'CANCELLED')
      return res.json({ code: 400, msg: '该工单已完结' });

    // PROD 环境限制 DBA/ADMIN 审核
    const ticketEnv = await db.execute(`SELECT ENVIRONMENT FROM SQL_REVIEW_TICKET WHERE TICKET_ID=:1`, [req.params.id]);
    if (ticketEnv.rows[0]?.ENVIRONMENT === 'PROD' && !['ADMIN', 'DBA'].includes(req.user.role))
      return res.json({ code: 403, msg: 'PROD 环境仅 DBA/ADMIN 可审核' });

    const newStatus = action === 'APPROVE' ? 'APPROVED' : action === 'REJECT' ? 'REJECTED' : 'CHANGES_REQUESTED';
    const statusComment = { APPROVE: '审核通过', REJECT: '审核拒绝', REQUEST_CHANGE: '要求修改' }[action];

    await db.execute(
      `UPDATE SQL_REVIEW_TICKET SET STATUS=:1, REVIEWED_BY=:2, REVIEWED_AT=SYSTIMESTAMP,
       REVIEW_COMMENT=:3, UPDATED_AT=SYSTIMESTAMP WHERE TICKET_ID=:4`,
      [newStatus, req.user.userId, comment || statusComment, req.params.id]);

    // 插入审核评论
    await db.execute(
      `INSERT INTO SQL_REVIEW_COMMENT (TICKET_ID, USER_ID, COMMENT_TEXT, COMMENT_TYPE)
       VALUES (:1, :2, :3, :4)`,
      [req.params.id, req.user.userId, comment || statusComment, action]);

    res.json({ code: 200, msg: `审核${statusComment}` });
  } catch (err) { res.json({ code: 500, msg: err.message }); }
});

// POST /api/sql-review/tickets/:id/cancel — 取消工单
router.post('/tickets/:id/cancel', async (req, res) => {
  try {
    const ticketRes = await db.execute(
      `SELECT STATUS, SUBMITTED_BY FROM SQL_REVIEW_TICKET WHERE TICKET_ID = :1`, [req.params.id]);
    if (!ticketRes.rows.length) return res.json({ code: 404, msg: '工单不存在' });
    if (ticketRes.rows[0].STATUS !== 'PENDING' && ticketRes.rows[0].STATUS !== 'CHANGES_REQUESTED')
      return res.json({ code: 400, msg: '仅待审核/需修改状态可取消' });
    // 只有提交人或管理员可取消
    if (ticketRes.rows[0].SUBMITTED_BY !== req.user.userId && !['ADMIN', 'DBA'].includes(req.user.role))
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
    const [byStatus, bySource, byRisk, avgScore] = await Promise.all([
      db.execute(`SELECT STATUS, COUNT(*) AS CNT FROM SQL_REVIEW_TICKET GROUP BY STATUS`, []),
      db.execute(`SELECT SOURCE, COUNT(*) AS CNT FROM SQL_REVIEW_TICKET GROUP BY SOURCE`, []),
      db.execute(`SELECT RISK_LEVEL, COUNT(*) AS CNT FROM SQL_REVIEW_TICKET WHERE STATUS IN ('PENDING','IN_REVIEW') GROUP BY RISK_LEVEL`, []),
      db.execute(`SELECT ROUND(AVG(SCORE),1) AS AVG_SCORE FROM SQL_REVIEW_TICKET WHERE SCORE IS NOT NULL`, []),
    ]);
    const pendingCount = await db.execute(
      `SELECT COUNT(*) AS CNT FROM SQL_REVIEW_TICKET WHERE STATUS IN ('PENDING','IN_REVIEW')`, []);
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

// ─── 内部审核逻辑（复用 automation.js 的规则引擎） ────────────

async function runInternalAudit(sql, instanceId) {
  // 输入校验
  const inputIssues = [];
  if (!sql || sql.trim().length < 5) inputIssues.push({ code: 'TOO_SHORT', severity: 'ERROR', message: 'SQL 内容过短' });

  // 动态规则
  let dynamicRules = [];
  try {
    const { rows } = await db.execute(`SELECT * FROM DDL_AUDIT_RULE WHERE ENABLED = 1`, []);
    dynamicRules = rows;
  } catch { /* table may not exist */ }

  const builtinRules = [
    { code: 'NO_SELECT_STAR', pattern: /SELECT\s+\*/i, severity: 'ERROR', message: '禁止使用 SELECT *，请明确列名' },
    { code: 'WHERE_REQUIRED', pattern: /(DELETE|UPDATE)\s+\w+(?![\s\S]*WHERE)/i, severity: 'ERROR', message: 'DELETE/UPDATE 必须携带 WHERE 条件' },
    { code: 'NO_DROP_TABLE', pattern: /DROP\s+TABLE/i, severity: 'CRITICAL', message: '禁止直接 DROP TABLE' },
    { code: 'NO_TRUNCATE', pattern: /TRUNCATE\s+TABLE/i, severity: 'CRITICAL', message: '禁止 TRUNCATE TABLE' },
    { code: 'NO_IMPLICIT_CONVERT', pattern: /WHERE\s+\w+\s*=\s*'\d+'/i, severity: 'WARNING', message: 'WHERE 条件存在隐式类型转换' },
    { code: 'NO_CARTESIAN', pattern: /FROM\s+\w+\s*,\s*\w+\s+WHERE/i, severity: 'WARNING', message: '可能的笛卡尔积' },
    { code: 'LIMIT_WITHOUT_ORDER', pattern: /LIMIT\s+\d+(?![\s\S]*ORDER)/i, severity: 'INFO', message: 'LIMIT 建议配合 ORDER BY' },
  ];

  const activeRules = dynamicRules.length > 0
    ? dynamicRules.map(r => ({ code: r.RULE_CODE, pattern: new RegExp(r.RULE_PATTERN, 'i'), severity: r.SEVERITY, message: r.MESSAGE }))
    : builtinRules;

  const issues = [...inputIssues];
  for (const r of activeRules) {
    try { if (r.pattern.test(sql)) issues.push({ code: r.code, severity: r.severity, message: r.message }); } catch {}
  }

  const hints = [];
  if (/IN\s*\([^)]{200,}\)/i.test(sql)) hints.push('IN 列表过长，建议改用临时表');
  if (/LIKE\s+'%/i.test(sql)) hints.push('前缀 % 无法使用索引');

  const score = Math.max(0, 100
    - issues.filter(i => i.severity === 'CRITICAL').length * 40
    - issues.filter(i => i.severity === 'ERROR').length * 20
    - issues.filter(i => i.severity === 'WARNING').length * 8
    - issues.filter(i => i.severity === 'INFO').length * 2);
  const risk = score >= 90 ? 'LOW' : score >= 70 ? 'MEDIUM' : score >= 50 ? 'HIGH' : 'CRITICAL';

  return { issues, hints, score, risk };
}

module.exports = router;
