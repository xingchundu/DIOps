/**
 * /api/sql-diag  Oracle SQL_ID 深度诊断（调用 orasqlx）
 * 不在 Java 网关 OWNED_PREFIXES 内，由 Node 处理。
 */
const fs = require('fs');
const path = require('path');
const oracledb = require('oracledb');
const router = require('express').Router();
const db = require('../config/db');
const { authMiddleware, requireRole } = require('../middleware/auth');
const runner = require('../services/orasqlxRunner');
const { fetchCmdbInstance, decodeDbPassword } = require('../utils/monitorTargetConn');
const { getInspectReportsRoot } = require('../services/inspectPythonDocxRunner');

router.use(authMiddleware);
const canRun = requireRole('ADMIN', 'DBA', 'OPS');

const MAX_PARALLEL = Math.max(1, parseInt(process.env.SQLDIAG_MAX_PARALLEL || '2', 10));
let running = 0;

// 进程重启时遗留的 RUNNING 任务不可能再完成：标记失败，避免前端一直转圈
db.execute(`UPDATE SQL_DIAG_JOB SET STATUS='FAILED', ERR_MSG='服务重启，任务中断', FINISHED_AT=SYSTIMESTAMP WHERE STATUS IN ('RUNNING','PENDING')`)
  .catch(() => { /* 表尚未迁移时忽略 */ });

const ok = (res, data) => res.json({ code: 200, data });
const fail = (res, msg, code = 500) => res.json({ code, msg });

router.get('/status', async (req, res) => {
  try { ok(res, { ...(await runner.status()), maxParallel: MAX_PARALLEL, running }); } catch (e) { fail(res, e.message); }
});

router.post('/run', canRun, async (req, res) => {
  try {
    const { instanceId, sqlId, pdb, awrDays, noAwr } = req.body || {};
    if (!instanceId) return fail(res, 'instanceId 不能为空', 400);
    const sid = String(sqlId || '').trim().toLowerCase();
    if (!runner.SQL_ID_RE.test(sid)) return fail(res, 'SQL_ID 应为 13 位字母数字', 400);
    if (running >= MAX_PARALLEL) return fail(res, `当前已有 ${running} 个诊断在运行（上限 ${MAX_PARALLEL}），请稍后再试`, 429);

    const st = await runner.status();
    if (!st.available) return fail(res, st.message || 'orasqlx 不可用', 503);

    const inst = await fetchCmdbInstance(Number(instanceId));
    if (String(inst.DB_TYPE || '').toUpperCase() !== 'ORACLE') return fail(res, 'SQL_ID 深度诊断仅支持 Oracle 实例', 400);

    const options = {
      pdb: pdb || null,
      awrDays: awrDays == null ? null : Number(awrDays),
      noAwr: noAwr !== false, // 默认跳过 AWR/ASH，无需 Diagnostics Pack
    };
    const r = await db.execute(
      `INSERT INTO SQL_DIAG_JOB (INSTANCE_ID, SQL_ID, OPTIONS, STATUS, CREATED_BY) VALUES (:1,:2,:3,'RUNNING',:4) RETURNING JOB_ID INTO :5`,
      [Number(instanceId), sid, JSON.stringify(options), req.user?.userId ?? null, { dir: oracledb.BIND_OUT, type: oracledb.NUMBER }]);
    const jobId = r.outBinds[0][0];

    running += 1;
    ok(res, { jobId, status: 'RUNNING' });

    // 后台执行
    (async () => {
      try {
        const out = await runner.runDiagnosis({
          inst, pwd: decodeDbPassword(inst.DB_PASSWORD), sqlId: sid, pdb: options.pdb,
          awrDays: options.awrDays, noAwr: options.noAwr, jobId,
        });
        const sum = {
          meta: out.snapshot.meta, metrics: out.snapshot.metrics,
          counts: out.findings.reduce((a, f) => { a[f.level] = (a[f.level] || 0) + 1; return a; }, {}),
          findings: out.findings.slice(0, 40),
        };
        await db.execute(
          `UPDATE SQL_DIAG_JOB SET STATUS='DONE', DOCX_FILE=:1, JSON_FILE=:2, SUMMARY=:3, FINDING_CNT=:4, FINISHED_AT=SYSTIMESTAMP WHERE JOB_ID=:5`,
          [out.docxFile ? path.basename(out.docxFile) : null, path.basename(out.jsonFile),
            { val: JSON.stringify(sum), type: oracledb.CLOB }, out.findings.length, jobId]);
        require('../services/kgService').recordDiag({
          jobId, instanceId: inst.INSTANCE_ID, instanceName: inst.INSTANCE_NAME, sqlId: sid,
          findings: out.findings.map((f) => ({ title: f.title, severity: f.level, advice: f.advice })),
          summary: { counts: sum.counts },
        }).catch((e) => console.warn('[kg] recordDiag 失败:', e.message));
      } catch (e) {
        await db.execute(`UPDATE SQL_DIAG_JOB SET STATUS='FAILED', ERR_MSG=:1, FINISHED_AT=SYSTIMESTAMP WHERE JOB_ID=:2`,
          [Buffer.from(String(e.message)).subarray(0, 1900).toString('utf8').replace(/�/g, ''), jobId]).catch(() => {});
      } finally {
        running -= 1;
      }
    })();
  } catch (e) { fail(res, e.message); }
});

router.get('/jobs', async (req, res) => {
  try {
    const where = []; const binds = [];
    if (req.query.instanceId) { binds.push(Number(req.query.instanceId)); where.push(`INSTANCE_ID = :${binds.length}`); }
    if (req.query.sqlId) { binds.push(String(req.query.sqlId).toLowerCase()); where.push(`SQL_ID = :${binds.length}`); }
    const data = await db.queryPage(
      `SELECT JOB_ID, INSTANCE_ID, SQL_ID, STATUS, FINDING_CNT, ERR_MSG, DOCX_FILE, CREATED_AT, FINISHED_AT
         FROM SQL_DIAG_JOB ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY JOB_ID DESC`,
      binds, req.query.page || 1, req.query.size || 20);
    ok(res, data);
  } catch (e) { fail(res, e.message); }
});

router.get('/jobs/:id', async (req, res) => {
  try {
    const r = await db.execute(`SELECT * FROM SQL_DIAG_JOB WHERE JOB_ID = :1`, [Number(req.params.id)]);
    if (!r.rows.length) return fail(res, '任务不存在', 404);
    const row = r.rows[0];
    let summary = null; try { summary = row.SUMMARY ? JSON.parse(row.SUMMARY) : null; } catch (_) { /* ignore */ }
    ok(res, { ...row, SUMMARY: summary });
  } catch (e) { fail(res, e.message); }
});

async function sendFile(req, res, col, contentType) {
  try {
    const r = await db.execute(`SELECT SQL_ID, ${col} F FROM SQL_DIAG_JOB WHERE JOB_ID = :1`, [Number(req.params.id)]);
    const row = r.rows[0];
    if (!row || !row.F) return fail(res, '文件不存在', 404);
    const dir = path.join(getInspectReportsRoot(), 'sqldiag', String(Number(req.params.id)));
    const file = path.join(dir, path.basename(row.F)); // basename 防路径穿越
    if (!file.startsWith(dir + path.sep) || !fs.existsSync(file)) return fail(res, '文件已被清理', 404);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${row.SQL_ID}_${path.basename(file)}"`);
    fs.createReadStream(file).pipe(res);
  } catch (e) { fail(res, e.message); }
}
router.get('/jobs/:id/docx', (req, res) => sendFile(req, res, 'DOCX_FILE', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'));
router.get('/jobs/:id/json', (req, res) => sendFile(req, res, 'JSON_FILE', 'application/json'));

module.exports = router;
