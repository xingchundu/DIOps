'use strict';
/** 数据库巡检中心 API：/api/db-inspect/*  （ADMIN / DBA / OPS 可用；写操作仅 ADMIN / DBA） */
const router = require('express').Router();
const db = require('../config/db');
const { authMiddleware, requireRole } = require('../middleware/auth');
const store = require('../dbinspect/store');
const runner = require('../dbinspect/runner');
const report = require('../dbinspect/report');
const { CATEGORY_LABEL, CATEGORY_ORDER } = require('../dbinspect/catalog');
const { FAMILIES, FAMILY_LABEL } = require('../dbinspect/dialect');

router.use(authMiddleware);
router.use(requireRole('ADMIN', 'DBA', 'OPS', 'REVIEWER'));
const WRITE = requireRole('ADMIN', 'DBA');
const OPERATE = requireRole('ADMIN', 'DBA', 'OPS');

const ok = (res, data) => res.json({ code: 200, data });
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  const code = Number.isInteger(e.code) && e.code >= 400 && e.code < 600 ? e.code : 500;
  if (code === 500) console.error('[db-inspect]', req.method, req.path, e);
  res.status(code).json({ code, msg: code === 500 && /^ORA-00942/.test(e.message || '') ? '数据库巡检表不存在，请先执行 backend/sql/migration_db_inspect.sql' : (e.message || '服务器内部错误') });
});
const uname = (req) => req.user?.username || null;
const uid = (req) => req.user?.userId ?? null;
const int = (v, d, max = 200) => Math.min(max, Math.max(1, parseInt(v, 10) || d));
const idp = (req, k = 'id') => { const n = Number(req.params[k]); if (!Number.isFinite(n)) throw Object.assign(new Error('参数错误'), { code: 400 }); return n; };

router.get('/meta', wrap(async (req, res) => ok(res, {
  categories: CATEGORY_ORDER.map((c) => ({ value: c, label: CATEGORY_LABEL[c] || c })),
  families: FAMILIES.map((f) => ({ value: f, label: FAMILY_LABEL[f] || f })),
  supportedTypes: store.SUPPORTED_TYPES,
  scope: await store.listScopeOptions(),
})));

// ---- 检查项
router.get('/items', wrap(async (req, res) => ok(res, await store.listItems({ category: req.query.category, family: req.query.family, keyword: req.query.keyword }))));
router.get('/items/:id', wrap(async (req, res) => {
  const it = await store.getItem(idp(req));
  if (!it) return res.status(404).json({ code: 404, msg: '检查项不存在' });
  ok(res, it);
}));
router.post('/items', WRITE, wrap(async (req, res) => ok(res, await store.createItem(req.body || {}, uid(req)))));
router.put('/items/:id', WRITE, wrap(async (req, res) => { await store.updateItem(idp(req), req.body || {}); ok(res, true); }));
router.delete('/items/:id', WRITE, wrap(async (req, res) => { await store.deleteItem(idp(req)); ok(res, true); }));
router.put('/items/:id/impl/:family', WRITE, wrap(async (req, res) => { await store.saveImpl(idp(req), String(req.params.family).toUpperCase(), req.body || {}); ok(res, true); }));
router.post('/items/:id/impl/:family/reset', WRITE, wrap(async (req, res) => { await store.resetImpl(idp(req), String(req.params.family).toUpperCase()); ok(res, true); }));
router.delete('/items/:id/impl/:family', WRITE, wrap(async (req, res) => { await store.deleteImpl(idp(req), String(req.params.family).toUpperCase()); ok(res, true); }));
router.get('/items/:id/overrides', wrap(async (req, res) => ok(res, await store.listOverrides(idp(req)))));
router.post('/items/:id/overrides', WRITE, wrap(async (req, res) => ok(res, await store.saveOverride(idp(req), req.body || {}, uid(req)))));
router.delete('/overrides/:oid', WRITE, wrap(async (req, res) => { await store.deleteOverride(idp(req, 'oid')); ok(res, true); }));
router.post('/reseed', WRITE, wrap(async (req, res) => ok(res, await store.reseed())));

// ---- 模板
router.get('/templates', wrap(async (req, res) => ok(res, await store.listTemplates())));
router.get('/templates/:id', wrap(async (req, res) => {
  const t = await store.getTemplate(idp(req));
  if (!t) return res.status(404).json({ code: 404, msg: '模板不存在' });
  ok(res, t);
}));
router.post('/templates', WRITE, wrap(async (req, res) => ok(res, await store.saveTemplate(null, req.body || {}, uid(req)))));
router.put('/templates/:id', WRITE, wrap(async (req, res) => ok(res, await store.saveTemplate(idp(req), req.body || {}, uid(req)))));
router.delete('/templates/:id', WRITE, wrap(async (req, res) => { await store.deleteTemplate(idp(req)); ok(res, true); }));

// ---- 计划
router.get('/plans', wrap(async (req, res) => ok(res, await store.listPlans())));
router.post('/plans', WRITE, wrap(async (req, res) => ok(res, await store.savePlan(null, req.body || {}, uid(req)))));
router.put('/plans/:id', WRITE, wrap(async (req, res) => ok(res, await store.savePlan(idp(req), req.body || {}, uid(req)))));
router.delete('/plans/:id', WRITE, wrap(async (req, res) => { await store.deletePlan(idp(req)); ok(res, true); }));
router.post('/plans/:id/run', OPERATE, wrap(async (req, res) => {
  const p = await store.getPlan(idp(req));
  if (!p) return res.status(404).json({ code: 404, msg: '计划不存在' });
  const r = await runner.startRun({ templateId: p.templateId, planId: p.planId, planName: p.name, scope: p.scope, triggerType: 'MANUAL', user: { userId: uid(req), username: uname(req) } });
  ok(res, { runId: r.runId, total: r.total });
}));

// ---- 立即巡检（不依赖计划）
router.post('/runs', OPERATE, wrap(async (req, res) => {
  const b = req.body || {};
  const r = await runner.startRun({
    templateId: Number(b.templateId), scope: b.scope, instanceIds: Array.isArray(b.instanceIds) ? b.instanceIds.map(Number).filter(Number.isFinite) : undefined,
    triggerType: 'MANUAL', user: { userId: uid(req), username: uname(req) },
  });
  ok(res, { runId: r.runId, total: r.total });
}));

// ---- 巡检记录
router.get('/runs', wrap(async (req, res) => {
  const page = int(req.query.page, 1, 100000); const size = int(req.query.size, 20, 100);
  const where = []; const binds = [];
  if (req.query.status) { binds.push(String(req.query.status)); where.push(`STATUS=:${binds.length}`); }
  if (req.query.triggerType) { binds.push(String(req.query.triggerType)); where.push(`TRIGGER_TYPE=:${binds.length}`); }
  if (req.query.keyword) { binds.push(`%${req.query.keyword}%`); where.push(`(TEMPLATE_NAME LIKE :${binds.length} OR PLAN_NAME LIKE :${binds.length})`); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = Number((await db.execute(`SELECT COUNT(*) AS N FROM DBI_RUN ${w}`, binds)).rows[0].N);
  const rows = (await db.execute(`SELECT * FROM DBI_RUN ${w} ORDER BY RUN_ID DESC OFFSET :o ROWS FETCH NEXT :n ROWS ONLY`, [...binds, (page - 1) * size, size])).rows;
  ok(res, { total, list: rows });
}));
router.get('/runs/:id', wrap(async (req, res) => {
  const id = idp(req);
  const run = (await db.execute('SELECT * FROM DBI_RUN WHERE RUN_ID=:1', [id])).rows[0];
  if (!run) return res.status(404).json({ code: 404, msg: '巡检记录不存在' });
  const instances = (await db.execute('SELECT * FROM DBI_RUN_INSTANCE WHERE RUN_ID=:1 ORDER BY INSTANCE_NAME', [id])).rows;
  ok(res, { run, instances });
}));
router.get('/runs/:id/results', wrap(async (req, res) => {
  const id = idp(req);
  const args = [id]; let w = 'RUN_ID=:1';
  if (req.query.instanceId) { args.push(Number(req.query.instanceId)); w += ` AND INSTANCE_ID=:${args.length}`; }
  const rows = (await db.execute(`SELECT RESULT_ID,INSTANCE_ID,ITEM_CODE,ITEM_NAME,CATEGORY,STATUS,WORST_VALUE,THRESHOLD_TEXT,ROW_COUNT,MESSAGE,DURATION_MS FROM DBI_RUN_RESULT WHERE ${w} ORDER BY INSTANCE_ID, RESULT_ID`, args)).rows;
  ok(res, rows);
}));
router.get('/results/:rid/evidence', wrap(async (req, res) => {
  const r = (await db.execute('SELECT EVIDENCE FROM DBI_RUN_RESULT WHERE RESULT_ID=:1', [idp(req, 'rid')])).rows[0];
  let ev = null; try { ev = r && r.EVIDENCE ? JSON.parse(r.EVIDENCE) : null; } catch { /* ignore */ }
  ok(res, ev);
}));
router.get('/runs/:id/sql', wrap(async (req, res) => {
  const d = await report.loadRun(idp(req));
  if (!d) return res.status(404).json({ code: 404, msg: '巡检记录不存在' });
  const by = report.groupSql(d);
  ok(res, FAMILIES.filter((f) => by.has(f)).map((f) => ({
    family: f, label: FAMILY_LABEL[f] || f,
    instances: [...by.get(f).values()].map(({ inst, dims }) => ({
      instanceId: inst?.INSTANCE_ID, instanceName: inst?.INSTANCE_NAME, dbType: inst?.DB_TYPE,
      dimensions: [...dims].map(([dimension, rows]) => ({ dimension, rows })),
    })),
  })));
}));
router.post('/runs/:id/rerun', OPERATE, wrap(async (req, res) => {
  const run = (await db.execute('SELECT TEMPLATE_ID, ONLY_ITEM_CODE FROM DBI_RUN WHERE RUN_ID=:1', [idp(req)])).rows[0];
  if (!run || !run.TEMPLATE_ID) return res.status(400).json({ code: 400, msg: '该记录无法重跑（无模板信息）' });
  const insts = (await db.execute('SELECT INSTANCE_ID FROM DBI_RUN_INSTANCE WHERE RUN_ID=:1', [idp(req)])).rows.map((x) => x.INSTANCE_ID);
  const r = await runner.startRun({ templateId: run.TEMPLATE_ID, instanceIds: insts, onlyItemCode: run.ONLY_ITEM_CODE, triggerType: 'MANUAL', user: { userId: uid(req), username: uname(req) } });
  ok(res, { runId: r.runId, total: r.total });
}));

// ---- 问题项
router.get('/issues', wrap(async (req, res) => {
  const page = int(req.query.page, 1, 100000); const size = int(req.query.size, 20, 200);
  const where = []; const binds = [];
  const add = (cond, v) => { binds.push(v); where.push(cond.replace('?', `:${binds.length}`)); };
  if (req.query.status) add('STATUS=?', String(req.query.status));
  else if (req.query.active === '1') where.push(`STATUS IN ('OPEN','FIXING')`);
  if (req.query.severity) add('SEVERITY=?', String(req.query.severity));
  if (req.query.instanceId) add('INSTANCE_ID=?', Number(req.query.instanceId));
  if (req.query.dbType) add('UPPER(DB_TYPE)=?', String(req.query.dbType).toUpperCase());
  if (req.query.category) add('CATEGORY=?', String(req.query.category));
  if (req.query.itemCode) add('ITEM_CODE=?', String(req.query.itemCode));
  if (req.query.runId) add('LAST_RUN_ID=?', Number(req.query.runId));
  if (req.query.keyword) { binds.push(`%${req.query.keyword}%`); where.push(`(ITEM_NAME LIKE :${binds.length} OR TITLE LIKE :${binds.length} OR OBJECT_KEY LIKE :${binds.length} OR SQL_ID LIKE :${binds.length} OR INSTANCE_NAME LIKE :${binds.length})`); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = Number((await db.execute(`SELECT COUNT(*) AS N FROM DBI_ISSUE ${w}`, binds)).rows[0].N);
  const sum = (await db.execute(`SELECT STATUS, SEVERITY, COUNT(*) AS N FROM DBI_ISSUE GROUP BY STATUS, SEVERITY`)).rows;
  const rows = (await db.execute(
    `SELECT ISSUE_ID,INSTANCE_ID,INSTANCE_NAME,DB_TYPE,HOST_IP,ITEM_CODE,ITEM_NAME,CATEGORY,OBJECT_KEY,SEVERITY,TITLE,CURRENT_VALUE,THRESHOLD_TEXT,ADVICE,SQL_ID,SQL_ID_KIND,SQL_TEXT,STATUS,NOTE,
            FIRST_RUN_ID,LAST_RUN_ID,OCCURRENCES,FIRST_SEEN,LAST_SEEN,FIXED_AT,HANDLED_BY
       FROM DBI_ISSUE ${w} ORDER BY CASE STATUS WHEN 'OPEN' THEN 0 WHEN 'FIXING' THEN 1 ELSE 2 END, CASE SEVERITY WHEN 'CRITICAL' THEN 0 ELSE 1 END, LAST_SEEN DESC
       OFFSET :o ROWS FETCH NEXT :n ROWS ONLY`, [...binds, (page - 1) * size, size])).rows;
  const cnt = (st, sv) => sum.filter((x) => (!st || st.includes(x.STATUS)) && (!sv || x.SEVERITY === sv)).reduce((a, x) => a + Number(x.N), 0);
  ok(res, { total, list: rows, summary: { open: cnt(['OPEN']), fixing: cnt(['FIXING']), fixed: cnt(['FIXED']), ignored: cnt(['IGNORED']), openCritical: cnt(['OPEN', 'FIXING'], 'CRITICAL'), openWarning: cnt(['OPEN', 'FIXING'], 'WARNING') } });
}));
router.get('/issues/:id', wrap(async (req, res) => {
  const r = (await db.execute('SELECT * FROM DBI_ISSUE WHERE ISSUE_ID=:1', [idp(req)])).rows[0];
  if (!r) return res.status(404).json({ code: 404, msg: '问题项不存在' });
  let ev = null; try { ev = r.EVIDENCE ? JSON.parse(r.EVIDENCE) : null; } catch { /* ignore */ }
  ok(res, { ...r, EVIDENCE: ev });
}));
router.put('/issues/:id/status', OPERATE, wrap(async (req, res) => {
  const n = await store.setIssueStatus(idp(req), String(req.body?.status || '').toUpperCase(), uname(req), req.body?.note);
  if (!n) return res.status(404).json({ code: 404, msg: '问题项不存在' });
  ok(res, true);
}));
router.post('/issues/:id/recheck', OPERATE, wrap(async (req, res) => {
  const r = await runner.recheckIssue(idp(req), { userId: uid(req), username: uname(req) });
  ok(res, { runId: r.runId });
}));

// ---- 报告
router.get('/reports', wrap(async (req, res) => {
  const page = int(req.query.page, 1, 100000); const size = int(req.query.size, 20, 100);
  const total = Number((await db.execute('SELECT COUNT(*) AS N FROM DBI_REPORT')).rows[0].N);
  const rows = (await db.execute('SELECT * FROM DBI_REPORT ORDER BY REPORT_ID DESC OFFSET :o ROWS FETCH NEXT :n ROWS ONLY', [(page - 1) * size, size])).rows;
  ok(res, { total, list: rows });
}));
const send = (res, buf, name, mime) => {
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.send(Buffer.from(buf));
};
router.get('/runs/:id/report/word', wrap(async (req, res) => send(res, await report.buildWord(idp(req)), `数据库巡检报告-${req.params.id}.docx`, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')));
router.get('/runs/:id/report/excel', wrap(async (req, res) => send(res, await report.buildExcel(idp(req)), `数据库巡检报告-${req.params.id}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')));

module.exports = router;
