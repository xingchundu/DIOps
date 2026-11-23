/**
 * 自动化运维 Pro API v2
 * 模块：自动巡检/故障处理/自动发布/SQL治理/HA管理/容量预测/备份恢复中心
 */
const fs = require('fs');
const path = require('path');
const oracledb = require('oracledb');
const router = require('express').Router();
const multer = require('multer');
const db = require('../config/db');
const { authMiddleware, requireRole } = require('../middleware/auth');
const { automationLog } = require('../services/automationExecLog');
const {
  executeBackupPolicy,
  executeRestoreTask,
  extractOracleOutBindNumber,
  normalizePolicyStoragePath,
  resolveStorageRoot,
} = require('../services/backupRestoreRunner');
const { getSchedulerStatusPayload } = require('../services/automationScheduler');
const { runInspectTaskById, scopeByCategory } = require('../services/inspectTaskRun');
const { buildInspectWordBuffer } = require('../services/inspectWordReport');
const { parseInspectScript, readOnlyViolation } = require('../utils/inspectScriptParser');
const { buildGenericInspectDocxBuffer } = require('../services/inspectGenericReportDocx');
const { getInspectReportsRoot, detectPython } = require('../services/inspectPythonDocxRunner');
// SQL 审核 / 执行计划 / 实例检查 统一由 Java SQL 洞察提供（原 sqlGovernanceInstanceCheck.js 与本文件内的正则规则已删除）
const sqlInsight = require('../utils/sqlInsightClient');
const { toPlainJson, insertAuditRecord } = require('../utils/sqlAuditRecord');
const { genTicketNo } = require('../utils/publishTicket');
const { runScript } = require('../utils/sqlScript');
const { runOnInstanceHost } = require('../utils/sshRun');
const { createReviewTicket } = require('../utils/sqlReviewTicket');
const { collectCapacitySnapshot } = require('../services/capacitySnapshotCollect');
const {
  fetchCmdbInstance,
  connectOracle,
  connectMysql,
  connectPostgres,
  connectDameng,
  connectSqlServer,
  normalizeDbType,
} = require('../utils/monitorTargetConn');

router.use(authMiddleware);

function resolveInspectStoredDocxPath(storedPath) {
  if (!storedPath || typeof storedPath !== 'string') return null;
  const resolved = path.resolve(storedPath);
  const root = getInspectReportsRoot();
  const normRoot = root.endsWith(path.sep) ? root.slice(0, -1) : root;
  const normRes = resolved.endsWith(path.sep) ? resolved.slice(0, -1) : resolved;
  if (normRes !== normRoot && !resolved.startsWith(root + path.sep)) return null;
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return null;
  return resolved;
}
const adminDba    = requireRole('ADMIN', 'DBA');
const adminDbaOps = requireRole('ADMIN', 'DBA', 'OPS');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/\.(sql|sh|py|xlsx)$/i.test(file.originalname || '')) return cb(null, true);
    cb(new Error('仅支持 .sql/.sh/.py/.xlsx'));
  },
});

/** 巡检脚本「下载模版」文件目录（默认 backend/src/templates/inspect；可通过 env INSPECT_LOCAL_TEMPLATE_DIR 覆盖） */
const INSPECT_LOCAL_TEMPLATE_DIR =
  process.env.INSPECT_LOCAL_TEMPLATE_DIR || path.join(__dirname, '../templates/inspect');

function inspectLocalTemplateDir() {
  return path.normalize(INSPECT_LOCAL_TEMPLATE_DIR);
}

/** 仅允许单层文件名，防止目录穿越 */
function safeInspectTemplateFileName(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const base = path.basename(s);
  if (base !== s || base === '.' || base === '..') return null;
  if (/[<>:"|?*\x00-\x1f]/.test(base)) return null;
  return base;
}

function isResolvedPathInsideDir(resolvedFile, resolvedDir) {
  const rel = path.relative(resolvedDir, resolvedFile);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function safeJson(str) {
  try { return typeof str === 'string' ? JSON.parse(str) : str; } catch { return null; }
}

/** 解析策略/拓扑中的实例 ID 列表，精确匹配（避免 INSTR 子串误命中） */
function parseInstanceIdList(raw) {
  if (raw == null || raw === '') return null;
  const parsed = safeJson(raw);
  if (Array.isArray(parsed)) return parsed.map(Number).filter(Number.isFinite);
  if (typeof raw === 'string') {
    return raw.split(',').map((s) => Number(String(s).trim())).filter(Number.isFinite);
  }
  return null;
}

function instanceIdsMatch(instanceIdsRaw, instanceId) {
  const ids = parseInstanceIdList(instanceIdsRaw);
  if (!ids || !ids.length) return true;
  return ids.some((id) => Number(id) === Number(instanceId));
}

function topologyIncludesInstance(topo, instanceId) {
  if (Number(topo.PRIMARY_ID) === Number(instanceId)) return true;
  const members = safeJson(topo.MEMBER_IDS);
  if (Array.isArray(members)) return members.some((id) => Number(id) === Number(instanceId));
  return false;
}

async function readActionScript(val) {
  if (val == null) return '';
  if (typeof val === 'string') return val.trim();
  return (await publishTicketSqlText(val)).trim();
}

// §1 调度器
router.get('/scheduler/status', (req, res) => {
  try { res.json({ code:200, data: getSchedulerStatusPayload() }); }
  catch { res.json({ code:200, data: { disabled:true, running:false, jobs:[] } }); }
});

// §2 巡检脚本库
// 列表不包含 SCRIPT_CONTENT（CLOB），避免 node-oracledb 返回的 Lob 无法被 res.json 序列化导致接口失败、前端列表空白
router.get('/inspect/scripts', async (req, res) => {
  const {dbType,category}=req.query; const binds=[]; let sql=`SELECT SCRIPT_ID, SCRIPT_NAME, DB_TYPE, CATEGORY, VERSION, IS_TEMPLATE, ENABLED, CREATED_BY, CREATED_AT, UPDATED_AT FROM INSPECT_SCRIPT WHERE 1=1`;
  if(dbType){sql+=` AND DB_TYPE=:${binds.length+1}`;binds.push(dbType);}
  if(category){sql+=` AND CATEGORY=:${binds.length+1}`;binds.push(category);}
  sql+=` ORDER BY SCRIPT_ID DESC`;
  try{const r=await db.execute(sql,binds);res.json({code:200,data:r.rows});}
  catch(e){res.json({code:500,msg:e.message});}
});
router.post('/inspect/scripts', adminDba, async (req,res) => {
  const{scriptName,dbType,category,scriptContent,version,isTemplate,enabled}=req.body;
  if(!scriptName||!dbType||!category)return res.json({code:400,msg:'名称/数据库类型/分类必填'});
  try{
    await db.execute(`INSERT INTO INSPECT_SCRIPT (SCRIPT_NAME,DB_TYPE,CATEGORY,SCRIPT_CONTENT,VERSION,IS_TEMPLATE,ENABLED,CREATED_BY) VALUES (:1,:2,:3,:4,:5,:6,:7,:8)`,
      [scriptName,dbType,category,scriptContent||'',version||'1.0',isTemplate?1:0,enabled===false?0:1,req.user.userId]);
    await automationLog(req,'INSPECT',null,'CREATE_SCRIPT','SUCCESS',scriptName);
    res.json({code:200,msg:'脚本已创建'});
  }catch(e){res.json({code:500,msg:e.message});}
});
router.post('/inspect/scripts/upload', adminDba, upload.single('file'), async (req,res) => {
  const file=req.file; if(!file)return res.json({code:400,msg:'请上传脚本文件'});
  const{dbType,category,scriptName}=req.body;
  if(!dbType||!category)return res.json({code:400,msg:'dbType/category必填'});
  const content=file.buffer.toString('utf8'); const name=scriptName||file.originalname;
  try{
    await db.execute(`INSERT INTO INSPECT_SCRIPT (SCRIPT_NAME,DB_TYPE,CATEGORY,SCRIPT_CONTENT,IS_TEMPLATE,ENABLED,CREATED_BY) VALUES (:1,:2,:3,:4,1,1,:5)`,
      [name,dbType,category,content,req.user.userId]);
    await automationLog(req,'INSPECT',null,'UPLOAD_SCRIPT','SUCCESS',name);
    res.json({code:200,msg:'脚本上传成功',data:{name,dbType,category}});
  }catch(e){res.json({code:500,msg:e.message});}
});
router.get('/inspect/scripts/templates', (req, res) => {
  try {
    const dir = inspectLocalTemplateDir();
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      return res.json({ code: 200, data: [], msg: `模板目录不可用: ${dir}` });
    }
    const names = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b));
    const data = names.map((fileName) => ({ fileName }));
    res.json({ code: 200, data });
  } catch (e) {
    res.json({ code: 500, msg: e.message });
  }
});
router.get('/inspect/scripts/template', (req, res) => {
  const name = safeInspectTemplateFileName(req.query.file || req.query.name);
  if (!name) {
    return res.status(400).json({ code: 400, msg: '请使用 file 参数指定文件名（不可含路径）' });
  }
  const dir = inspectLocalTemplateDir();
  const resolvedDir = path.resolve(dir);
  const filePath = path.join(dir, name);
  const resolvedFile = path.resolve(filePath);
  if (!isResolvedPathInsideDir(resolvedFile, resolvedDir)) {
    return res.status(400).json({ code: 400, msg: '非法文件路径' });
  }
  try {
    const body = fs.readFileSync(resolvedFile);
    const ext = path.extname(name).toLowerCase();
    const ct =
      ext === '.sql' ? 'text/plain; charset=utf-8' : 'application/octet-stream';
    res.setHeader('Content-Type', ct);
    const safe = name.replace(/[^\w.-]+/g, '_');
    res.setHeader('Content-Disposition', `attachment; filename="${safe}"`);
    res.send(body);
  } catch (e) {
    res.status(404).json({ code: 404, msg: `模板文件不存在或无法读取: ${name}` });
  }
});
router.get('/inspect/scripts/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.json({ code: 400, msg: '非法脚本 ID' });
  try {
    const r = await db.execute(
      `SELECT SCRIPT_ID, SCRIPT_NAME, DB_TYPE, CATEGORY, SCRIPT_CONTENT, VERSION, IS_TEMPLATE, ENABLED, CREATED_BY, CREATED_AT, UPDATED_AT FROM INSPECT_SCRIPT WHERE SCRIPT_ID = :1`,
      [id],
      {
        fetchInfo: {
          SCRIPT_CONTENT: { type: oracledb.STRING, maxSize: 52 * 1024 * 1024 },
        },
      }
    );
    const row = r.rows?.[0];
    if (!row) return res.json({ code: 404, msg: '脚本不存在' });
    res.json({ code: 200, data: row });
  } catch (e) {
    res.json({ code: 500, msg: e.message });
  }
});
router.put('/inspect/scripts/:id', adminDba, async (req,res) => {
  const { scriptName, scriptContent, version, enabled } = req.body;
  try {
    const id = req.params.id;
    const en = enabled===undefined ? null : (enabled ? 1 : 0);
    // CLOB 列不能与 VARCHAR2 绑定混用 COALESCE（ORA-00932），scriptContent 有传则单独 SET
    if (scriptContent !== undefined) {
      await db.execute(
        `UPDATE INSPECT_SCRIPT SET SCRIPT_NAME=COALESCE(:1,SCRIPT_NAME),SCRIPT_CONTENT=:2,VERSION=COALESCE(:3,VERSION),ENABLED=COALESCE(:4,ENABLED),UPDATED_AT=SYSTIMESTAMP WHERE SCRIPT_ID=:5`,
        [scriptName || null, scriptContent, version || null, en, id],
      );
    } else {
      await db.execute(
        `UPDATE INSPECT_SCRIPT SET SCRIPT_NAME=COALESCE(:1,SCRIPT_NAME),VERSION=COALESCE(:2,VERSION),ENABLED=COALESCE(:3,ENABLED),UPDATED_AT=SYSTIMESTAMP WHERE SCRIPT_ID=:4`,
        [scriptName || null, version || null, en, id],
      );
    }
    res.json({ code: 200, msg: '已更新' });
  } catch (e) { res.json({ code: 500, msg: e.message }); }
});
router.delete('/inspect/scripts/:id', adminDba, async (req,res) => {
  try{await db.execute(`DELETE FROM INSPECT_SCRIPT WHERE SCRIPT_ID=:1`,[req.params.id]);res.json({code:200,msg:'已删除'});}
  catch(e){res.json({code:500,msg:e.message});}
});

// §2 巡检任务
router.get('/inspect/tasks', async (req,res) => {
  try{const r=await db.execute(`SELECT * FROM INSPECT_TASK ORDER BY TASK_ID DESC`,[]);res.json({code:200,data:r.rows});}
  catch(e){res.json({code:500,msg:e.message});}
});
router.post('/inspect/tasks', adminDbaOps, async (req,res) => {
  const{taskName,dbType,instanceIds,scriptIds,cronExpr}=req.body;
  if(!taskName)return res.json({code:400,msg:'任务名称必填'});
  try{
    await db.execute(`INSERT INTO INSPECT_TASK (TASK_NAME,DB_TYPE,INSTANCE_IDS,SCRIPT_IDS,CRON_EXPR,STATUS,CREATED_BY) VALUES (:1,:2,:3,:4,:5,'IDLE',:6)`,
      [taskName,dbType||null,JSON.stringify(instanceIds||[]),JSON.stringify(scriptIds||[]),cronExpr||null,req.user.userId]);
    await automationLog(req,'INSPECT',null,'CREATE_TASK','SUCCESS',taskName);
    res.json({code:200,msg:'巡检任务已创建'});
  }catch(e){res.json({code:500,msg:e.message});}
});
router.post('/inspect/tasks/:id/run', adminDbaOps, async (req,res) => {
  const taskId = Number(req.params.id);
  if (!Number.isFinite(taskId)) return res.json({ code: 400, msg: '非法任务 ID' });
  try {
    const out = await runInspectTaskById(req, taskId, { verboseLog: true, collectLogs: true });
    res.json({
      code: 200,
      msg: `巡检完成：成功 ${out.okInstances}/${out.instances} 个实例，生成 ${out.reports} 条报告${out.failedInstances ? `，${out.failedInstances} 个实例失败` : ''}${out.excelFile ? '，已生成批量 Excel 汇总' : ''}`,
      data: out,
    });
  } catch (e) {
    const code =
      e.code === 'NOT_FOUND'
        ? 404
        : e.code === 'BAD_TASK' || e.code === 'BAD_SCRIPTS'
          ? 400
          : e.code === 'BUSY'
            ? 409
            : 500;
    res.json({
      code,
      msg: e.message || String(e),
      data: {
        logs: e.inspectLogs || [],
        sqlErrors: e.inspectSqlErrors || [],
        reportIds: e.inspectReportIds || [],
        reports: 0,
        instances: 0,
      },
    });
  }
});
router.delete('/inspect/tasks/:id', adminDbaOps, async (req, res) => {
  const taskId = Number(req.params.id);
  if (!Number.isFinite(taskId)) return res.json({ code: 400, msg: '非法任务 ID' });
  try {
    const tr = await db.execute(`SELECT TASK_ID, STATUS FROM INSPECT_TASK WHERE TASK_ID=:1`, [taskId]);
    if (!tr.rows.length) return res.json({ code: 404, msg: '任务不存在' });
    if (String(tr.rows[0].STATUS || '').toUpperCase() === 'RUNNING') {
      return res.json({ code: 409, msg: '任务正在执行中，请稍后再删除' });
    }
    await db.execute(`DELETE FROM INSPECT_TASK WHERE TASK_ID=:1`, [taskId]);
    await automationLog(req, 'INSPECT', taskId, 'DELETE_TASK', 'SUCCESS', `task#${taskId}`);
    res.json({ code: 200, msg: '任务已删除' });
  } catch (e) {
    res.json({ code: 500, msg: e.message });
  }
});

// §2 巡检报告
router.get('/inspect/reports', async (req,res) => {
  const{instanceId,reportType,page=1,pageSize=20}=req.query;
  try{
    let sql=`SELECT r.REPORT_ID,r.TASK_ID,r.INSTANCE_ID,r.DB_TYPE,r.REPORT_TYPE,r.OVERALL_SCORE,r.OVERALL_STATUS,r.SUMMARY,r.CREATED_AT,i.INSTANCE_NAME FROM INSPECT_REPORT r LEFT JOIN CMDB_INSTANCE i ON r.INSTANCE_ID=i.INSTANCE_ID WHERE 1=1`;
    const binds=[];
    if(instanceId){sql+=` AND r.INSTANCE_ID=:${binds.length+1}`;binds.push(instanceId);}
    if(reportType){sql+=` AND r.REPORT_TYPE=:${binds.length+1}`;binds.push(reportType);}
    const pg = db.toPageInt(page, 1, 1, 100000);
    const ps = db.toPageInt(pageSize, 20, 1, 200);
    sql+=` ORDER BY r.CREATED_AT DESC OFFSET ${(pg - 1) * ps} ROWS FETCH NEXT ${ps} ROWS ONLY`;
    const r=await db.execute(sql,binds);res.json({code:200,data:r.rows});
  }catch(e){res.json({code:500,msg:e.message});}
});
router.get('/inspect/reports/:id', async (req,res) => {
  try{
    const r=await db.execute(`SELECT r.*,i.INSTANCE_NAME FROM INSPECT_REPORT r LEFT JOIN CMDB_INSTANCE i ON r.INSTANCE_ID=i.INSTANCE_ID WHERE r.REPORT_ID=:1`,[req.params.id]);
    if(!r.rows.length)return res.json({code:404,msg:'报告不存在'});
    const row=r.rows[0];
    try{row.PAYLOAD_JSON=JSON.parse(row.PAYLOAD);}catch{}
    res.json({code:200,data:row});
  }catch(e){res.json({code:500,msg:e.message});}
});
router.get('/inspect/reports/:id/docx', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.json({ code: 400, msg: '非法报告 ID' });
  const LOB = { fetchInfo: { PAYLOAD: { type: oracledb.STRING, maxSize: 52 * 1024 * 1024 } } };
  const sendDocx = (buf, fname) => {
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${fname.replace(/[^\w.-]+/g, '_')}"`);
    res.send(Buffer.from(buf));
  };
  try {
    const r = await db.execute(
      `SELECT r.INSTANCE_ID, r.DB_TYPE, r.REPORT_TYPE, r.PAYLOAD, i.INSTANCE_NAME
       FROM INSPECT_REPORT r LEFT JOIN CMDB_INSTANCE i ON r.INSTANCE_ID = i.INSTANCE_ID WHERE r.REPORT_ID = :1`,
      [id], LOB);
    if (!r.rows.length) return res.json({ code: 404, msg: '报告不存在' });
    const row = r.rows[0];
    let payload;
    try { payload = JSON.parse(row.PAYLOAD || '{}'); } catch { payload = {}; }
    payload.instanceName = row.INSTANCE_NAME || payload.instanceName;
    payload.dbType = row.DB_TYPE || payload.dbType;
    payload.reportType = row.REPORT_TYPE || payload.reportType;

    // 1) 已落盘的 Word（综合报告 / Python 旧版五类报告）
    const stored = resolveInspectStoredDocxPath(payload.inspectDocxFile);
    if (stored) {
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.setHeader('Content-Disposition', `attachment; filename="${path.basename(stored).replace(/[^\w.-]+/g, '_')}"`);
      return void res.sendFile(stored, (sendErr) => {
        if (sendErr && !res.headersSent) res.json({ code: 500, msg: sendErr.message || String(sendErr) });
      });
    }
    const baseName = `inspect_${row.INSTANCE_NAME || row.INSTANCE_ID}_${row.REPORT_TYPE || 'rpt'}_${id}.docx`;

    // 2) 分类行：从综合报告取数据，按分类即时生成“分类版”（总结 + 详细）
    if (payload.parentReportId) {
      const pr = await db.execute(`SELECT PAYLOAD FROM INSPECT_REPORT WHERE REPORT_ID=:1`, [payload.parentReportId], LOB);
      if (pr.rows.length) {
        let parent = {};
        try { parent = JSON.parse(pr.rows[0].PAYLOAD || '{}'); } catch { parent = {}; }
        parent.instanceName = payload.instanceName; parent.dbType = payload.dbType;
        const scoped = scopeByCategory(parent, row.REPORT_TYPE);
        scoped.overallScore = payload.overallScore; scoped.overallStatus = payload.overallStatus;
        scoped.counts = payload.counts;
        scoped.conclusion = `${payload.instanceName || ''} ${row.REPORT_TYPE} 分类：共 ${scoped.sections.length} 个检查项，评分 ${payload.overallScore}。`;
        return sendDocx(await buildInspectWordBuffer(scoped), baseName);
      }
    }
    // 3) 综合报告文件丢失：用库里保存的数据重建（每表最多保留 300 行）
    if (Array.isArray(payload.sections)) return sendDocx(await buildInspectWordBuffer(payload), baseName);

    // 4) 旧版 JSON 报告（scriptSections）
    return sendDocx(await buildGenericInspectDocxBuffer(payload), baseName);
  } catch (e) {
    res.json({ code: 500, msg: e.message || String(e) });
  }
});

// 批量巡检 Excel 汇总（最近一次执行）
function readInspectManifest(taskId) {
  const f = path.join(getInspectReportsRoot(), 'inspect', String(taskId), 'latest.json');
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}
router.get('/inspect/tasks/:id/latest', (req, res) => {
  const taskId = Number(req.params.id);
  if (!Number.isFinite(taskId)) return res.json({ code: 400, msg: '非法任务 ID' });
  const m = readInspectManifest(taskId);
  if (!m) return res.json({ code: 200, data: null });
  res.json({ code: 200, data: { ...m, excelFile: m.excelFile ? path.basename(m.excelFile) : null, instances: (m.instances || []).map((x) => ({ ...x, wordFile: x.wordFile ? path.basename(x.wordFile) : null })) } });
});
router.get('/inspect/tasks/:id/excel', (req, res) => {
  const taskId = Number(req.params.id);
  if (!Number.isFinite(taskId)) return res.json({ code: 400, msg: '非法任务 ID' });
  const m = readInspectManifest(taskId);
  const abs = m && resolveInspectStoredDocxPath(m.excelFile);   // 复用“必须在报告目录内且是文件”的校验
  if (!abs) return res.json({ code: 404, msg: '没有可下载的批量汇总（任务含 2 个以上实例并执行后生成）' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(abs))}`);
  res.sendFile(abs, (e) => { if (e && !res.headersSent) res.json({ code: 500, msg: e.message }); });
});

// 脚本预检：不连库，只解析——看会拆成几个检查项、分类、@rule 指令是否合法、有没有非只读语句
router.post('/inspect/scripts/validate', adminDba, (req, res) => {
  const { dbType, scriptContent, category } = req.body || {};
  if (!scriptContent || !String(scriptContent).trim()) return res.json({ code: 400, msg: '脚本内容为空' });
  try {
    const dt = String(dbType || 'ORACLE').toUpperCase();
    const p = parseInspectScript(String(scriptContent), dt, { defaultCategory: category });
    const violations = [];
    for (const sec of p.sections) for (const q of sec.sqls) {
      const v = readOnlyViolation(q);
      if (v) violations.push({ section: sec.title, error: v, sql: q.replace(/\s+/g, ' ').slice(0, 160) });
    }
    for (const q of p.preamble) { const v = readOnlyViolation(q); if (v) violations.push({ section: '脚本准备', error: v, sql: q.slice(0, 160) }); }
    res.json({
      code: 200,
      data: {
        marked: p.marked, sectionCount: p.sections.length,
        sections: p.sections.map((s) => ({ no: s.no, title: s.title, category: s.category, statements: s.sqls.length })),
        rules: p.rules, ruleErrors: p.ruleErrors, violations, ok: !violations.length && !p.ruleErrors.length && p.sections.length > 0,
      },
    });
  } catch (e) { res.json({ code: 500, msg: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════
// 闭环设计说明
// ─────────────────────────────────────────────────────────────────
//  [监控告警] ──触发──→ §3 故障自动处理 ──HA_FAILOVER──→ §6 高可用与容灾
//                          │ SLOW_QUERY                        │
//                          ↓ 推送审核                    切换后同步CMDB
//               §5 SQL治理中心 ──高分SQL推送──→ §4 自动发布
//                    ↑ 审核拦截 CRITICAL              │ 发布成功
//                    └────── 基线锚点/变更窗口 ←──────┘
//               SQL 洞察(Java) 波动检测 ──→ 告警中心「SQL异常波动」
// ═══════════════════════════════════════════════════════════════════


/**
 * SQL 审核核心 → Java 统一审核引擎（Druid AST 规则 + DI_SQL_RULE 阈值 + DDL_AUDIT_RULE 自定义正则策略）。
 * 原 loadDdlRules / validateSqlInput / calcSqlAuditScore / calcSqlAuditRisk / 9 条内置正则 已删除：
 * 正则对注释、字符串、子查询、多语句误判，且与 sqlReview.js / sql.js / Python 各有一份、结论互相矛盾。
 * 返回结构不变：{ issues:[{code,severity,message}], hints, score, risk, instanceCheck?, assetId?, fingerprint }
 */
async function sqlAuditCheckDynamic(sql, req, { instanceId, dbType, instanceCheck = false, operatorId } = {}) {
  return sqlInsight.audit(req || null, { sqlText: sql, instanceId, dbType, instanceCheck, linkAsset: true }, { operatorId });
}

/** 解析 MONITOR_METRIC_SAMPLE.METRICS_JSON（COLLECTED_AT + 指标数组） */
function parseMonitorMetricsJson(metricsJson) {
  if (!metricsJson) return { metrics: [], sessions: [] };
  try {
    const parsed = typeof metricsJson === 'string' ? JSON.parse(metricsJson) : metricsJson;
    return { metrics: parsed.metrics || [], sessions: parsed.sessions || [] };
  } catch {
    return { metrics: [], sessions: [] };
  }
}

function metricFromList(metrics, names) {
  for (const name of names) {
    const m = (metrics || []).find((x) => x.METRIC_NAME === name);
    if (m != null && m.VALUE != null && !Number.isNaN(Number(m.VALUE))) return Number(m.VALUE);
  }
  return null;
}

/** 将单条采样行映射为故障自动化使用的指标键 */
function buildFaultMetricsMap(sampleRow) {
  const map = {};
  if (!sampleRow) return map;
  if (sampleRow.METRIC_CONN != null && !Number.isNaN(Number(sampleRow.METRIC_CONN))) {
    map.connection_count = Number(sampleRow.METRIC_CONN);
  }
  const { metrics } = parseMonitorMetricsJson(sampleRow.METRICS_JSON);

  const activeSessions = metricFromList(metrics, [
    'Active Sessions', 'mysql_global_status_threads_running',
    'pg_stat_activity_active', 'mssql_active_sessions',
  ]);
  if (activeSessions != null) map.active_sessions = activeSessions;

  const conn = metricFromList(metrics, [
    'Current Logons Count', 'mysql_global_status_threads_connected',
    'pg_stat_database_numbackends', 'mssql_user_connections',
  ]);
  if (conn != null) map.connection_count = conn;

  const slow = metricFromList(metrics, ['mysql_global_status_slow_queries']);
  if (slow != null) map.slow_queries_per_min = slow;

  for (const m of metrics) {
    const name = String(m.METRIC_NAME || '');
    const lower = name.toLowerCase();
    const val = Number(m.VALUE);
    if (!Number.isFinite(val)) continue;
    if (name === 'replication_delay' || lower.includes('replication_delay')
      || lower.includes('replica_lag') || lower.includes('replication_lag')) {
      map.replication_delay = val;
    }
    if (name === 'replication_running' || lower.includes('replication_running')
      || lower.includes('slave_io_running') || lower.includes('repl_running')) {
      map.replication_running = val;
    }
    if (lower.includes('disk_used') || (lower.includes('tablespace') && lower.includes('used'))) {
      map.disk_used_pct = Math.max(map.disk_used_pct || 0, val);
    }
    if (lower.includes('temp') && (lower.includes('used') || lower.includes('pct'))) {
      map.temp_used_pct = Math.max(map.temp_used_pct || 0, val);
    }
    if ((lower.includes('fra') || lower.includes('recovery area')) && (lower.includes('used') || lower.includes('pct'))) {
      map.fra_used_pct = Math.max(map.fra_used_pct || 0, val);
    }
  }

  if (sampleRow.REACHABLE === 0) map.replication_running = 0;
  return map;
}

async function fetchLatestMonitorSample(instanceId) {
  try {
    const r = await db.execute(
      `SELECT METRIC_CPU, METRIC_CONN, METRICS_JSON, COLLECTED_AT, REACHABLE
       FROM MONITOR_METRIC_SAMPLE
       WHERE INSTANCE_ID=:1
       ORDER BY COLLECTED_AT DESC FETCH FIRST 1 ROW ONLY`,
      [instanceId],
      { fetchAsString: [oracledb.CLOB] }
    );
    return r.rows[0] || null;
  } catch {
    return null;
  }
}

/** 从容灾目标实例最新采样获取复制延迟（秒），无数据返回 null */
async function getReplicationDelaySec(instanceId) {
  const sample = await fetchLatestMonitorSample(instanceId);
  if (!sample) return null;
  const delay = buildFaultMetricsMap(sample).replication_delay;
  return delay != null ? delay : null;
}

/** 从监控采样表获取实例最新指标快照（用于故障条件判断） */
async function getInstanceMetrics(instanceId) {
  try {
    const r = await db.execute(
      `SELECT METRIC_CPU, METRIC_CONN, METRICS_JSON, COLLECTED_AT, REACHABLE
       FROM MONITOR_METRIC_SAMPLE
       WHERE INSTANCE_ID=:1 AND COLLECTED_AT >= SYSTIMESTAMP - INTERVAL '10' MINUTE
       ORDER BY COLLECTED_AT DESC FETCH FIRST 5 ROWS ONLY`,
      [instanceId],
      { fetchAsString: [oracledb.CLOB] }
    );
    const map = {};
    for (const row of r.rows || []) {
      const partial = buildFaultMetricsMap(row);
      for (const [k, v] of Object.entries(partial)) {
        if (map[k] === undefined) map[k] = v;
        else if (k.endsWith('_pct') || k === 'replication_delay') map[k] = Math.max(map[k], v);
      }
    }
    return map;
  } catch { return {}; }
}

/** 根据故障类型和实例指标判断条件是否触发 */
function evaluateFaultCondition(faultType, conditionJson, metrics) {
  const cond = safeJson(conditionJson) || {};
  const checks = {
    REPL_DELAY:       () => (metrics['replication_delay']     || 0)  > (cond.delayThreshold    || 30),
    REPL_BROKEN:      () => (metrics['replication_running']   ?? 1)  === 0,
    DISK_FULL:        () => (metrics['disk_used_pct']         || 0)  > (cond.diskThreshold     || 85),
    TEMP_FULL:        () => (metrics['temp_used_pct']         || 0)  > (cond.tempThreshold     || 80),
    FRA_FULL:         () => (metrics['fra_used_pct']          || 0)  > (cond.fraThreshold      || 85),
    SESSION_ABNORMAL: () => (metrics['active_sessions']       || 0)  > (cond.sessionThreshold  || 200),
    SLOW_QUERY:       () => (metrics['slow_queries_per_min']  || 0)  > (cond.slowQueryThreshold|| 10),
    CONN_SURGE:       () => (metrics['connection_count']      || 0)  > (cond.connThreshold     || 500),
  };
  const fn = checks[faultType];
  return fn ? fn() : false;
}

/** HA 节点健康检查（检查 CMDB 状态 + 最新监控心跳） */
async function checkNodeHealth(instanceId) {
  try {
    const instRes = await db.execute(
      `SELECT STATUS, INSTANCE_NAME, DB_TYPE FROM CMDB_INSTANCE WHERE INSTANCE_ID=:1`, [instanceId]
    );
    if (!instRes.rows.length) return { healthy: false, reason: '实例不存在于 CMDB' };
    const inst = instRes.rows[0];
    // CMDB 状态：RUNNING 运行中 / STOPPED / ERROR / UNKNOWN（ACTIVE、NORMAL 为历史值）
    if (!['RUNNING', 'ACTIVE', 'NORMAL'].includes(String(inst.STATUS || '').toUpperCase())) {
      return { healthy: false, reason: `实例状态: ${inst.STATUS}` };
    }
    // 检查最近心跳（10 分钟内有采样记录）
    const beatRes = await db.execute(
      `SELECT COUNT(*) CNT FROM MONITOR_METRIC_SAMPLE
       WHERE INSTANCE_ID=:1 AND COLLECTED_AT >= SYSTIMESTAMP - INTERVAL '10' MINUTE`,
      [instanceId]
    );
    const hasBeat = Number(beatRes.rows[0]?.CNT || 0) > 0;
    return { healthy: true, hasBeat, instanceName: inst.INSTANCE_NAME, status: inst.STATUS };
  } catch (e) {
    // 检查本身失败时不能当作“健康”放行切换
    return { healthy: false, hasBeat: false, reason: `健康检查异常: ${e.message}` };
  }
}

/** 执行 HA 拓扑切换（真实执行 switchCommand / ACTION_SCRIPT 后更新元数据） */
async function performHaTopologySwitch({
  topoId, switchType, toNode, operatorId, actionScript, reason, triggeredBy,
}) {
  const startMs = Date.now();
  const tr = await db.execute(`SELECT * FROM HA_TOPOLOGY WHERE TOPO_ID=:1`, [topoId]);
  if (!tr.rows.length) return { ok: false, status: 'FAILED', detail: '拓扑不存在' };
  const topo = tr.rows[0];
  const fromNode = topo.PRIMARY_ID;
  const isDrill = switchType === 'DRILL';

  const targetHealth = await checkNodeHealth(toNode);
  if (!targetHealth.healthy && !isDrill) {
    return { ok: false, status: 'FAILED', detail: `目标节点 ${toNode} 不可用（${targetHealth.reason}）`, targetHealth };
  }

  const config = safeJson(topo.CONFIG_JSON) || {};
  const switchCmd = (await readActionScript(actionScript))
    || String(config.switchCommand || config.failoverSql || config.switchSql || '').trim();
  if (!switchCmd) {
    return {
      ok: false, status: 'FAILED',
      detail: '未配置切换命令（请在策略 ACTION_SCRIPT 或拓扑 CONFIG_JSON.switchCommand 中填写）',
    };
  }

  // 切换命令在目标节点（新主库）上执行：故障切换时旧主库已经不可用。
  // CONFIG_JSON.switchMode = 'SHELL' 或命令以 #! 开头时通过 SSH 在目标主机执行脚本，否则按 SQL 执行；
  // CONFIG_JSON.execOn = 'SOURCE' 时（仅计划内切换）在旧主库执行。
  const execOn = String(config.execOn || 'TARGET').toUpperCase();
  const execNode = execOn === 'SOURCE' && switchType !== 'FAILOVER' && fromNode ? fromNode : toNode;
  const isShell = String(config.switchMode || '').toUpperCase() === 'SHELL' || /^#!/.test(switchCmd);
  let run;
  if (isShell) {
    try {
      const r = await runOnInstanceHost(execNode, switchCmd, {
        timeoutMs: Number(config.timeoutSec || 600) * 1000,
        env: { DIOPS_FROM_NODE: fromNode || '', DIOPS_TO_NODE: toNode, DIOPS_SWITCH_TYPE: switchType },
      });
      run = r.code === 0
        ? { ok: true, rowsAffected: 0, output: r.stdout.slice(-2000) }
        : { ok: false, error: `脚本退出码 ${r.code}：${(r.stderr || r.stdout).slice(-500)}` };
    } catch (e) {
      run = { ok: false, error: e.message };
    }
  } else {
    run = await executePublishSql(execNode, switchCmd);
  }
  if (!run.ok) {
    await db.execute(
      `INSERT INTO HA_SWITCH_RECORD (TOPO_ID,SWITCH_TYPE,FROM_NODE,TO_NODE,STATUS,RESULT,OPERATED_BY,FINISHED_AT)
       VALUES (:1,:2,:3,:4,'FAILED',:5,:6,SYSTIMESTAMP)`,
      [topoId, switchType, String(fromNode), String(toNode), JSON.stringify({ error: run.error, execNode, mode: isShell ? 'SHELL' : 'SQL' }), operatorId || null]
    ).catch(() => {});
    return { ok: false, status: 'FAILED', detail: `切换命令执行失败: ${run.error}`, execNode, switchCmdPreview: switchCmd.slice(0, 200) };
  }

  const duration = `${((Date.now() - startMs) / 1000).toFixed(1)}s`;
  const result = {
    switchType, fromNode, toNode, duration, status: 'SUCCESS',
    isDrill, preCheck: targetHealth, reason: reason || '', triggeredBy: triggeredBy || 'MANUAL',
    rowsAffected: run.rowsAffected, execNode, mode: isShell ? 'SHELL' : 'SQL', output: run.output,
  };

  await db.execute(
    `INSERT INTO HA_SWITCH_RECORD (TOPO_ID,SWITCH_TYPE,FROM_NODE,TO_NODE,STATUS,RESULT,OPERATED_BY,FINISHED_AT)
     VALUES (:1,:2,:3,:4,'SUCCESS',:5,:6,SYSTIMESTAMP)`,
    [topoId, switchType, String(fromNode), String(toNode), JSON.stringify(result), operatorId || null]
  );

  if (!isDrill) {
    await db.execute(
      `UPDATE HA_TOPOLOGY SET PRIMARY_ID=:1,STATUS='NORMAL',UPDATED_AT=SYSTIMESTAMP WHERE TOPO_ID=:2`,
      [toNode, topoId]
    );
    if (fromNode) {
      await db.execute(`UPDATE CMDB_INSTANCE SET INSTANCE_ROLE='REPLICA',ROLE='STANDBY',UPDATED_AT=SYSTIMESTAMP WHERE INSTANCE_ID=:1`, [fromNode])
        .catch(e => console.warn('[ha] 更新旧主库角色失败:', e.message));
    }
    await db.execute(`UPDATE CMDB_INSTANCE SET INSTANCE_ROLE='PRIMARY',ROLE='PRIMARY',UPDATED_AT=SYSTIMESTAMP WHERE INSTANCE_ID=:1`, [toNode])
      .catch(e => console.warn('[ha] 更新新主库角色失败:', e.message));
  }

  return { ok: true, status: 'SUCCESS', detail: `${fromNode}→${toNode}，耗时 ${duration}`, result, haTopoId: topoId };
}

function defaultAutoFixSql(faultType, dbType) {
  const db = String(dbType || '').toUpperCase();
  if (faultType === 'REPL_DELAY' && (db === 'MYSQL' || db === 'GOLDENDB')) {
    return 'STOP SLAVE; START SLAVE;';
  }
  if (faultType === 'TEMP_FULL' && (db === 'ORACLE' || db === 'DAMENG')) {
    return 'ALTER TABLESPACE TEMP ADD TEMPFILE SIZE 2G AUTOEXTEND ON;';
  }
  return null;
}

/** 执行故障修复动作，支持 AUTO_FIX / HA_FAILOVER / NOTIFY / MANUAL */
async function executeFaultAction(policy, instanceId, triggerSource, operatorId) {
  const startMs = Date.now();
  let status = 'SUCCESS';
  let detail = '';
  let haTopoId = null;

  try {
    if (policy.ACTION_TYPE === 'HA_FAILOVER') {
      const topoRes = await db.execute(
        `SELECT TOPO_ID, TOPO_NAME, PRIMARY_ID, MEMBER_IDS, CONFIG_JSON
         FROM HA_TOPOLOGY WHERE ENABLED=1`,
        []
      );
      const topo = (topoRes.rows || []).find((row) => topologyIncludesInstance(row, instanceId));
      if (!topo) {
        status = 'SKIPPED';
        detail = `HA_FAILOVER 跳过：实例 ${instanceId} 未绑定 HA 拓扑`;
      } else {
        const members = parseInstanceIdList(topo.MEMBER_IDS) || [];
        const allNodes = [...new Set([topo.PRIMARY_ID, ...members].map(Number).filter(Number.isFinite))];
        const toNode = allNodes.find((id) => Number(id) !== Number(topo.PRIMARY_ID));
        if (!toNode) {
          status = 'FAILED';
          detail = `HA FAILOVER 失败：拓扑 [${topo.TOPO_NAME}] 无可用备节点`;
        } else {
          const actionScript = await readActionScript(policy.ACTION_SCRIPT);
          const sw = await performHaTopologySwitch({
            topoId: topo.TOPO_ID,
            switchType: 'FAILOVER',
            toNode,
            operatorId,
            actionScript,
            reason: `故障策略 ${policy.POLICY_NAME}`,
            triggeredBy: triggerSource,
          });
          status = sw.status;
          detail = sw.detail;
          haTopoId = sw.haTopoId || null;
          if (!sw.ok) status = 'FAILED';
        }
      }
    } else if (policy.ACTION_TYPE === 'AUTO_FIX') {
      if (policy.FAULT_TYPE === 'SLOW_QUERY') {
        // [改] 原来插入一条“-- 慢查询自动收录”占位文本、审核分写死 60；
        //      现在触发 SQL 洞察即时采集，把该实例当前真实的 Top 问题 SQL 生成「SQL评审」工单（同一 SQL 已有未结工单时不重复建）
        try {
          const snap = await sqlInsight.collectNow(null, instanceId, { operatorId });
          let created = 0;
          let reused = 0;
          const uid = operatorId || await sqlInsight.systemUserId();
          for (const p of (snap.topProblems || []).slice(0, 5)) {
            const sqlText = String(p.SQL_TEXT || '').trim();
            if (!sqlText) continue;
            const audit = await sqlAuditCheckDynamic(sqlText, null, { instanceId, operatorId }).catch(() => null);
            const r = await createReviewTicket({
              title: `[故障自愈·慢SQL] ${p.RULE_CODE || ''} SQL#${p.ASSET_ID || ''}`.trim(), sqlText, instanceId,
              source: 'SLOW_QUERY', priority: p.SEVERITY === 'CRITICAL' ? 'URGENT' : 'HIGH', userId: uid, audit,
              note: `故障自愈触发：${p.DETAIL || ''}`,
            });
            if (r.created) created++; else reused++;
          }
          detail = created || reused
            ? `已触发 SQL 洞察采集：新建 ${created} 张 SQL 评审工单${reused ? `，${reused} 条已有未结工单` : ''}`
            : `已触发 SQL 洞察采集，当前无运行时问题 SQL${snap.error ? `（${snap.error}）` : ''}`;
        } catch (e) {
          status = 'FAILED';
          detail = `SLOW_QUERY 处理失败：${e.message}`;
        }
      } else {
        const actionScript = (await readActionScript(policy.ACTION_SCRIPT))
          || defaultAutoFixSql(policy.FAULT_TYPE, policy.DB_TYPE);
        if (!actionScript) {
          status = 'FAILED';
          detail = `AUTO_FIX 失败：策略 [${policy.POLICY_NAME}] 未配置 ACTION_SCRIPT，且无内置修复 SQL（${policy.FAULT_TYPE}）`;
        } else {
          const run = await executePublishSql(instanceId, actionScript);
          if (!run.ok) {
            status = 'FAILED';
            detail = `AUTO_FIX 执行失败: ${run.error}`;
          } else {
            detail = `已执行修复脚本（${policy.FAULT_TYPE}），耗时 ${run.durationMs}ms，影响行数 ${run.rowsAffected}`;
          }
        }
      }
    } else {
      detail = `策略 [${policy.POLICY_NAME}] 触发，动作类型 ${policy.ACTION_TYPE}，等待人工处理`;
    }

    const elapsed = `${((Date.now() - startMs) / 1000).toFixed(2)}s`;
    detail += `（耗时 ${elapsed}，触发源: ${triggerSource}${haTopoId ? '，关联HA拓扑:' + haTopoId : ''}）`;

    await db.execute(
      `INSERT INTO FAULT_EXEC_LOG (POLICY_ID,INSTANCE_ID,FAULT_TYPE,TRIGGER_SOURCE,STATUS,DETAIL,HA_CORRELATION_ID,FINISHED_AT,CREATED_BY)
       VALUES (:1,:2,:3,:4,:5,:6,:7,SYSTIMESTAMP,:8)`,
      [policy.POLICY_ID, instanceId, policy.FAULT_TYPE, triggerSource, status, detail, haTopoId, operatorId || null]
    );
    return { status, detail, haTopoId };

  } catch (e) {
    const errMsg = `执行异常: ${e.message}`;
    await db.execute(
      `INSERT INTO FAULT_EXEC_LOG (POLICY_ID,INSTANCE_ID,FAULT_TYPE,TRIGGER_SOURCE,STATUS,DETAIL,FINISHED_AT,CREATED_BY)
       VALUES (:1,:2,:3,:4,'FAILED',:5,SYSTIMESTAMP,:6)`,
      [policy.POLICY_ID, instanceId, policy.FAULT_TYPE, triggerSource, errMsg, operatorId || null]
    ).catch(() => {});
    return { status: 'FAILED', detail: errMsg };
  }
}

// ══════════════════════════════════════════════
// §3  故障自动处理
// ══════════════════════════════════════════════

/** 故障处理仪表盘：各状态计数、最活跃故障类型 */
router.get('/fault/dashboard', async (req, res) => {
  try {
    const stats = await db.execute(
      `SELECT STATUS, COUNT(*) CNT FROM FAULT_EXEC_LOG
       WHERE CREATED_AT >= SYSDATE - 7 GROUP BY STATUS`, []
    );
    const topTypes = await db.execute(
      `SELECT FAULT_TYPE, COUNT(*) CNT FROM FAULT_EXEC_LOG
       WHERE CREATED_AT >= SYSDATE - 7 GROUP BY FAULT_TYPE ORDER BY CNT DESC FETCH NEXT 5 ROWS ONLY`, []
    );
    const haLinked = await db.execute(
      `SELECT COUNT(*) CNT FROM FAULT_EXEC_LOG WHERE HA_CORRELATION_ID IS NOT NULL AND CREATED_AT>=SYSDATE-7`, []
    );
    const avgDur = await db.execute(
      `SELECT ROUND(AVG(EXTRACT(SECOND FROM (FINISHED_AT - STARTED_AT))
        + EXTRACT(MINUTE FROM (FINISHED_AT - STARTED_AT))*60),1) AVG_SEC
       FROM FAULT_EXEC_LOG WHERE FINISHED_AT IS NOT NULL AND CREATED_AT>=SYSDATE-7`, []
    );
    res.json({ code:200, data: {
      statusSummary: stats.rows,
      topFaultTypes: topTypes.rows,
      haFailoverCount: Number(haLinked.rows[0]?.CNT || 0),
      avgResolutionSec: Number(avgDur.rows[0]?.AVG_SEC || 0),
    }});
  } catch (e) { res.json({ code:500, msg: e.message }); }
});

/** 故障策略列表（CLOB 由全局 fetchAsString 读成完整字符串；原先截断到 4000 字符，编辑保存后脚本被截断） */
router.get('/fault/policies', async (req, res) => {
  const { dbType } = req.query;
  const binds = [];
  let sql = `SELECT p.POLICY_ID, p.POLICY_NAME, p.DB_TYPE, p.FAULT_TYPE, p.ACTION_TYPE, p.ENABLED,
                    p.INSTANCE_IDS, p.CREATED_BY, p.CREATED_AT, p.UPDATED_AT,
                    p.CONDITION_JSON, p.ACTION_SCRIPT
             FROM FAULT_POLICY p WHERE 1=1`;
  if (dbType) { sql += ` AND p.DB_TYPE=:${binds.length + 1}`; binds.push(dbType); }
  sql += ` ORDER BY p.POLICY_ID DESC`;
  try { const r = await db.execute(sql, binds); res.json({ code:200, data:r.rows }); }
  catch (e) { res.json({ code:500, msg:e.message }); }
});

/** 创建故障策略 */
router.post('/fault/policies', adminDba, async (req, res) => {
  const { policyName, dbType, faultType, conditionJson, actionType, actionScript, enabled, instanceIds } = req.body;
  if (!policyName || !dbType || !faultType || !actionType) return res.json({ code:400, msg:'必填字段缺失' });
  if (actionType === 'HA_FAILOVER' && (!instanceIds || !instanceIds.length))
    return res.json({ code:400, msg:'HA_FAILOVER 策略必须指定适用实例' });
  try {
    await db.execute(
      `INSERT INTO FAULT_POLICY (POLICY_NAME,DB_TYPE,FAULT_TYPE,CONDITION_JSON,ACTION_TYPE,ACTION_SCRIPT,ENABLED,INSTANCE_IDS,CREATED_BY)
       VALUES (:1,:2,:3,:4,:5,:6,:7,:8,:9)`,
      [policyName, dbType, faultType,
       conditionJson ? JSON.stringify(conditionJson) : null,
       actionType, actionScript || null, enabled === false ? 0 : 1,
       instanceIds ? JSON.stringify(instanceIds) : null, req.user.userId]
    );
    await automationLog(req, 'FAULT', null, 'CREATE_POLICY', 'SUCCESS', policyName);
    res.json({ code:200, msg:'策略已创建' });
  } catch (e) { res.json({ code:500, msg:e.message }); }
});

/** 更新故障策略 */
router.put('/fault/policies/:id', adminDba, async (req, res) => {
  const { policyName, actionType, actionScript, enabled, conditionJson, instanceIds, faultType } = req.body;
  if (actionType === 'HA_FAILOVER' && Array.isArray(instanceIds) && !instanceIds.length)
    return res.json({ code:400, msg:'HA_FAILOVER 策略必须指定适用实例' });
  try {
    // 适用实例原来编辑时无法修改（只在创建时写入）
    const hasInst = Array.isArray(instanceIds);
    await db.execute(
      `UPDATE FAULT_POLICY
         SET POLICY_NAME     = COALESCE(:1, POLICY_NAME),
             ACTION_TYPE     = COALESCE(:2, ACTION_TYPE),
             ACTION_SCRIPT   = COALESCE(:3, ACTION_SCRIPT),
             CONDITION_JSON  = COALESCE(:4, CONDITION_JSON),
             ENABLED         = COALESCE(:5, ENABLED),
             INSTANCE_IDS    = CASE WHEN :6 = 1 THEN :7 ELSE INSTANCE_IDS END,
             FAULT_TYPE      = COALESCE(:8, FAULT_TYPE),
             UPDATED_AT      = SYSTIMESTAMP
       WHERE POLICY_ID=:9`,
      [policyName || null, actionType || null, actionScript || null,
       conditionJson ? JSON.stringify(conditionJson) : null,
       enabled === undefined ? null : (enabled ? 1 : 0),
       hasInst ? 1 : 0, hasInst && instanceIds.length ? JSON.stringify(instanceIds.map(Number)) : null,
       faultType || null, req.params.id]
    );
    res.json({ code:200, msg:'已更新' });
  } catch (e) { res.json({ code:500, msg:e.message }); }
});

/** 删除故障策略 */
router.delete('/fault/policies/:id', adminDba, async (req, res) => {
  try {
    await db.execute(`DELETE FROM FAULT_POLICY WHERE POLICY_ID=:1`, [req.params.id]);
    res.json({ code:200, msg:'已删除' });
  } catch (e) { res.json({ code:500, msg:e.message }); }
});

/** 手动触发故障策略（携带实时指标预检） */
router.post('/fault/policies/:id/trigger', adminDbaOps, async (req, res) => {
  const { instanceId, force } = req.body;
  if (!instanceId) return res.json({ code:400, msg:'instanceId 必填' });
  try {
    const pr = await db.execute(`SELECT * FROM FAULT_POLICY WHERE POLICY_ID=:1`, [req.params.id]);
    if (!pr.rows.length) return res.json({ code:404, msg:'策略不存在' });
    const policy = pr.rows[0];
    if (!policy.ENABLED) return res.json({ code:400, msg:'策略已禁用' });

    // 条件预检（非强制时）：读取实例最新指标
    const metrics = await getInstanceMetrics(instanceId);
    const conditionMet = evaluateFaultCondition(policy.FAULT_TYPE, policy.CONDITION_JSON, metrics);
    if (!conditionMet && !force) {
      return res.json({ code:200, msg:'当前指标未达触发阈值，如需强制执行请传入 force:true', data:{ conditionMet, metrics } });
    }

    const result = await executeFaultAction(policy, instanceId, 'MANUAL', req.user.userId);
    await automationLog(req, 'FAULT', Number(req.params.id), 'TRIGGER', result.status, result.detail);
    res.json({ code:200, msg:'故障处理已执行', data:{ ...result, conditionMet, metrics } });
  } catch (e) { res.json({ code:500, msg:e.message }); }
});

/**
 * 告警联动接口：由告警中心在告警触发时调用
 * 根据告警的 faultType + dbType + instanceId 自动匹配最优策略并执行
 */
router.post('/fault/auto-process', adminDbaOps, async (req, res) => {
  const { instanceId, faultType, dbType, alertId, source } = req.body;
  if (!instanceId || !faultType) return res.json({ code:400, msg:'instanceId/faultType 必填' });
  try {
    const pr = await db.execute(
      `SELECT * FROM FAULT_POLICY
       WHERE ENABLED=1 AND FAULT_TYPE=:1 AND (DB_TYPE=:2 OR DB_TYPE='ALL')
       ORDER BY CASE ACTION_TYPE WHEN 'AUTO_FIX' THEN 1 WHEN 'HA_FAILOVER' THEN 2
                                 WHEN 'ALERT_ONLY' THEN 3 ELSE 4 END`,
      [faultType, dbType || 'ALL'],
      { fetchAsString: [oracledb.CLOB] }
    );
    const policy = (pr.rows || []).find((p) => instanceIdsMatch(p.INSTANCE_IDS, instanceId));
    if (!policy) {
      return res.json({ code:200, msg:'无匹配故障策略，需人工处理', data:{ instanceId, faultType, matched:false } });
    }
    const result = await executeFaultAction(policy, instanceId, source || 'ALERT_AUTO', req.user.userId);
    await automationLog(req, 'FAULT', policy.POLICY_ID, 'AUTO_PROCESS', result.status,
      `alertId=${alertId||'-'} ${result.detail}`);
    res.json({ code:200, msg:'告警联动处理完成', data:{ policyName: policy.POLICY_NAME, ...result, matched:true } });
  } catch (e) { res.json({ code:500, msg:e.message }); }
});

/** 故障执行历史（含 HA 关联标注；DETAIL 用 SUBSTR 避免 Lob 序列化失败） */
router.get('/fault/logs', async (req, res) => {
  const { instanceId, status, faultType } = req.query;
  const binds = [];
  let sql = `SELECT l.LOG_ID, l.POLICY_ID, l.INSTANCE_ID, l.FAULT_TYPE, l.TRIGGER_SOURCE, l.STATUS,
                    l.HA_CORRELATION_ID, l.STARTED_AT, l.FINISHED_AT, l.CREATED_BY, l.CREATED_AT,
                    DBMS_LOB.SUBSTR(l.DETAIL, 4000, 1) AS DETAIL,
                    p.POLICY_NAME, p.DB_TYPE, p.ACTION_TYPE, i.INSTANCE_NAME
             FROM FAULT_EXEC_LOG l
             LEFT JOIN FAULT_POLICY p    ON l.POLICY_ID    = p.POLICY_ID
             LEFT JOIN CMDB_INSTANCE i   ON l.INSTANCE_ID  = i.INSTANCE_ID
             WHERE 1=1`;
  if (instanceId) { sql += ` AND l.INSTANCE_ID=:${binds.length+1}`; binds.push(instanceId); }
  if (status)     { sql += ` AND l.STATUS=:${binds.length+1}`;      binds.push(status); }
  if (faultType)  { sql += ` AND l.FAULT_TYPE=:${binds.length+1}`;  binds.push(faultType); }
  sql += ` ORDER BY l.CREATED_AT DESC FETCH NEXT 100 ROWS ONLY`;
  try { const r = await db.execute(sql, binds); res.json({ code:200, data:r.rows }); }
  catch (e) { res.json({ code:500, msg:e.message }); }
});

// ══════════════════════════════════════════════
// §4  自动发布（SQL / DDL 工单流水线）
// ══════════════════════════════════════════════
//
// 状态流转：REVIEWING → APPROVED → EXECUTING → GRAY_TESTING → DONE
//           任意节点可 → REJECTED / ROLLED_BACK
// 创建时强制 SQL 治理预审，CRITICAL 风险默认拦截

function oraMissingColumn(e, names) {
  const m = String(e?.message || '').toUpperCase();
  if (!m.includes('ORA-00904')) return false;
  return names.some((n) => m.includes(String(n).toUpperCase()));
}

function buildPublishTicketListSql({ status, ticketType, instanceId, env }, binds, withEnvCol) {
  const envSel = withEnvCol
    ? 't.ENV,t.GOVERNANCE_AUDIT_ID'
    : `'PROD' AS ENV, CAST(NULL AS NUMBER) AS GOVERNANCE_AUDIT_ID`;
  let sql = `SELECT t.TICKET_ID,t.TICKET_NO,t.TITLE,t.TICKET_TYPE,t.INSTANCE_ID,t.DB_NAME,
                    t.STATUS,t.RISK_LEVEL,t.GRAY_PERCENT,${envSel},
                    t.CREATED_AT,t.REVIEWED_AT,t.EXECUTED_AT,
                    u1.REAL_NAME SUBMITTER, i.INSTANCE_NAME
             FROM PUBLISH_TICKET t
             LEFT JOIN SYS_USER u1     ON t.SUBMITTED_BY   = u1.USER_ID
             LEFT JOIN CMDB_INSTANCE i ON t.INSTANCE_ID    = i.INSTANCE_ID
             WHERE 1=1`;
  if (status)     { sql += ` AND t.STATUS=:${binds.length + 1}`;      binds.push(status); }
  if (ticketType) { sql += ` AND t.TICKET_TYPE=:${binds.length + 1}`; binds.push(ticketType); }
  if (instanceId) { sql += ` AND t.INSTANCE_ID=:${binds.length + 1}`; binds.push(instanceId); }
  if (env && withEnvCol) { sql += ` AND t.ENV=:${binds.length + 1}`; binds.push(env); }
  sql += ` ORDER BY t.TICKET_ID DESC FETCH NEXT 50 ROWS ONLY`;
  return sql;
}

/** 工单列表 */
router.get('/publish/tickets', async (req, res) => {
  try {
    const binds = [];
    let sql = buildPublishTicketListSql(req.query, binds, true);
    try {
      const r = await db.execute(sql, binds);
      return res.json({ code: 200, data: r.rows });
    } catch (e) {
      if (!oraMissingColumn(e, ['ENV', 'GOVERNANCE_AUDIT_ID'])) throw e;
      const binds2 = [];
      sql = buildPublishTicketListSql(req.query, binds2, false);
      const r = await db.execute(sql, binds2);
      return res.json({ code: 200, data: r.rows });
    }
  } catch (e) { res.json({ code: 500, msg: e.message }); }
});

/** 工单详情行映射（CLOB 已 SUBSTR 为字符串） */
function mapPublishTicketRow(row) {
  if (!row) return row;
  const out = { ...row };
  if (out.REVIEW_RESULT != null && out.REVIEW_RESULT !== '') {
    try { out.REVIEW_RESULT_JSON = JSON.parse(String(out.REVIEW_RESULT)); } catch { out.REVIEW_RESULT_JSON = null; }
  }
  if (out.EXEC_RESULT != null && out.EXEC_RESULT !== '') {
    try { out.EXEC_RESULT_JSON = JSON.parse(String(out.EXEC_RESULT)); } catch { out.EXEC_RESULT_JSON = null; }
  }
  return out;
}

function buildPublishTicketDetailSql(withEnvCol) {
  const envSel = withEnvCol
    ? `NVL(t.ENV, 'PROD') AS ENV, t.GOVERNANCE_AUDIT_ID`
    : `'PROD' AS ENV, CAST(NULL AS NUMBER) AS GOVERNANCE_AUDIT_ID`;
  return `SELECT t.TICKET_ID, t.TICKET_NO, t.TITLE, t.TICKET_TYPE, t.INSTANCE_ID, t.DB_NAME,
              t.STATUS, t.GRAY_PERCENT, t.RISK_LEVEL, t.SUBMITTED_BY, t.REVIEWED_BY,
              t.REVIEWED_AT, t.EXECUTED_BY, t.EXECUTED_AT, t.CREATED_AT, t.UPDATED_AT,
              ${envSel},
              t.SQL_CONTENT, t.ROLLBACK_SQL, t.REVIEW_RESULT, t.EXEC_RESULT, t.EXEC_PLAN,
              u1.REAL_NAME AS SUBMITTER, i.INSTANCE_NAME
       FROM PUBLISH_TICKET t
       LEFT JOIN SYS_USER u1     ON t.SUBMITTED_BY = u1.USER_ID
       LEFT JOIN CMDB_INSTANCE i ON t.INSTANCE_ID  = i.INSTANCE_ID
       WHERE t.TICKET_ID=:1`;
}

/** 工单详情（避免 SELECT * 返回 Lob 导致接口失败） */
router.get('/publish/tickets/:id', async (req, res) => {
  const ticketId = req.params.id;
  try {
    let r;
    try {
      r = await db.execute(buildPublishTicketDetailSql(true), [ticketId]);
    } catch (e) {
      if (!oraMissingColumn(e, ['ENV', 'GOVERNANCE_AUDIT_ID'])) throw e;
      r = await db.execute(buildPublishTicketDetailSql(false), [ticketId]);
    }
    if (!r.rows.length) return res.json({ code:404, msg:'工单不存在' });
    const row = mapPublishTicketRow(r.rows[0]);
    const reviews = await db.execute(
      `SELECT rv.REVIEW_ID, rv.TICKET_ID, rv.ACTION, rv."COMMENT", rv.OPERATED_BY, rv.CREATED_AT,
              u.REAL_NAME AS OPERATOR
       FROM PUBLISH_REVIEW rv
       LEFT JOIN SYS_USER u ON rv.OPERATED_BY = u.USER_ID
       WHERE rv.TICKET_ID=:1 ORDER BY rv.CREATED_AT`, [ticketId]
    );
    row.REVIEWS = reviews.rows;
    res.json({ code:200, data:row });
  } catch (e) { res.json({ code:500, msg:e.message }); }
});

/** 发布/回滚 → SQL 洞察（变更窗口 + 基线锚点）。尽力而为，不影响发布结果 */
function linkPublishToSqlInsight(req, ticket, sqlText, { title, startMs, anchor }) {
  const instanceId = ticket.INSTANCE_ID || null;
  sqlInsight.changeWindow(req, {
    instanceId, windowType: 'RELEASE', title, source: 'PUBLISH', refId: String(ticket.TICKET_NO || ticket.TICKET_ID || ''),
    startTime: startMs, endTime: Date.now() + 30 * 60 * 1000,
  }).catch((e) => console.warn('[publish→sql-insight] change window:', e.message));
  // 锚点只对查询/DML 有意义（DDL 本身没有运行时基线）
  if (anchor && sqlText && /^\s*(select|with|insert|update|delete|merge)\b/i.test(sqlText)) {
    sqlInsight.anchor(req, { sqlText, instanceId, reason: 'PUBLISH', note: `发布工单 ${ticket.TICKET_NO || ticket.TICKET_ID}` })
      .catch((e) => console.warn('[publish→sql-insight] anchor:', e.message));
  }
}

/**
 * 创建发布工单
 * ① SQL 治理预审（动态规则）
 * ② CRITICAL 风险默认拦截（除非 allowCritical=true 且操作者为 ADMIN/DBA）
 * ③ 写入 GOVERNANCE_AUDIT_ID 形成治理↔发布关联
 */
router.post('/publish/tickets', async (req, res) => {
  const { title, ticketType, instanceId, dbName, sqlContent, rollbackSql, grayPercent, env, allowCritical } = req.body;
  if (!title || !ticketType || !sqlContent) return res.json({ code:400, msg:'标题/类型/SQL 必填' });

  // ① SQL 治理预审（Java 统一审核；带实例时同时检查表存在性/可执行性/执行计划）
  let audit;
  try {
    audit = await sqlAuditCheckDynamic(sqlContent, req, { instanceId, instanceCheck: !!instanceId });
  } catch (e) {
    // 审核服务不可用时“失败即拦截”，不能在没有审核结论的情况下放行生产发布
    return res.json({ code: 503, msg: `SQL 预审服务不可用，暂不能提交发布：${e.message}` });
  }

  // ② CRITICAL 风险拦截（生产环境强拦截）
  const targetEnv = env || 'PROD';
  if (audit.risk === 'CRITICAL' && !(allowCritical && ['ADMIN','DBA'].includes(req.user.role))) {
    return res.json({
      code: 400,
      msg: `SQL 预审失败：风险等级 CRITICAL，禁止直接提交${targetEnv === 'PROD' ? '（生产环境不允许强制绕过）' : '，DBA/ADMIN 可传 allowCritical:true 覆盖'}`,
      data: { score: audit.score, risk: audit.risk, issues: audit.issues, hints: audit.hints },
    });
  }

  const ticketNo = genTicketNo();
  try {
    // ③ 写入审核记录并关联工单
    // [fix] 原来用 SELECT MAX(AUDIT_ID) 取回 ID，并发提交同一 SQL 时会关联到别人的审核记录
    let auditId = null;
    try {
      auditId = await insertAuditRecord({ instanceId, sqlText: sqlContent, result: audit, source: 'PUBLISH_PRE', userId: req.user.userId });
    } catch { /* audit 表可能未升级，忽略 */ }

    await db.execute(
      `INSERT INTO PUBLISH_TICKET
         (TICKET_NO,TITLE,TICKET_TYPE,INSTANCE_ID,DB_NAME,SQL_CONTENT,ROLLBACK_SQL,GRAY_PERCENT,
          RISK_LEVEL,REVIEW_RESULT,ENV,GOVERNANCE_AUDIT_ID,STATUS,SUBMITTED_BY)
       VALUES (:1,:2,:3,:4,:5,:6,:7,:8,:9,:10,:11,:12,'REVIEWING',:13)`,
      [ticketNo, title, ticketType, instanceId || null, dbName || null, sqlContent,
       rollbackSql || null, grayPercent || 0, audit.risk, JSON.stringify(audit),
       targetEnv, auditId, req.user.userId]
    );
    await automationLog(req, 'PUBLISH', null, 'CREATE_TICKET', 'SUCCESS', ticketNo);
    res.json({
      code: 200, msg: `工单已提交，SQL 治理预审${audit.risk === 'LOW' ? '通过（优质SQL）' : '完成'}`,
      data: { ticketNo, score: audit.score, risk: audit.risk, issues: audit.issues, hints: audit.hints, auditId },
    });
  } catch (e) { res.json({ code:500, msg:e.message }); }
});

/** 审批工单（APPROVE / REJECT） */
router.post('/publish/tickets/:id/review', adminDba, async (req, res) => {
  const { action, comment } = req.body;
  if (!['APPROVE','REJECT'].includes(action)) return res.json({ code:400, msg:'action 须为 APPROVE 或 REJECT' });
  const newStatus = action === 'APPROVE' ? 'APPROVED' : 'REJECTED';
  try {
    const r = await db.execute(`SELECT STATUS, ENV FROM PUBLISH_TICKET WHERE TICKET_ID=:1`, [req.params.id]);
    if (!r.rows.length) return res.json({ code:404, msg:'工单不存在' });
    if (r.rows[0].STATUS !== 'REVIEWING') return res.json({ code:400, msg:`当前状态 ${r.rows[0].STATUS} 不可审批` });
    // PROD 环境审批需 ADMIN 或 DBA
    if (r.rows[0].ENV === 'PROD' && !['ADMIN','DBA'].includes(req.user.role))
      return res.json({ code:403, msg:'生产环境工单审批需要 DBA 或 ADMIN 权限' });
    await db.execute(
      `UPDATE PUBLISH_TICKET SET STATUS=:1,REVIEWED_BY=:2,REVIEWED_AT=SYSTIMESTAMP,UPDATED_AT=SYSTIMESTAMP WHERE TICKET_ID=:3`,
      [newStatus, req.user.userId, req.params.id]
    );
    await db.execute(
      `INSERT INTO PUBLISH_REVIEW (TICKET_ID,ACTION,"COMMENT",OPERATED_BY) VALUES (:1,:2,:3,:4)`,
      [req.params.id, action, comment || null, req.user.userId]
    );
    await automationLog(req, 'PUBLISH', Number(req.params.id), `REVIEW_${action}`, newStatus, comment || '');
    res.json({ code:200, msg: action === 'APPROVE' ? '审批通过' : '已拒绝' });
  } catch (e) { res.json({ code:500, msg:e.message }); }
});

/** 读取工单 SQL 文本（避免 CLOB Lob 导致 sqlHash/substring 失败） */
async function publishTicketSqlText(val) {
  if (val == null) return '';
  if (typeof val === 'string') return val;
  try {
    if (typeof val.getData === 'function') return String(await val.getData());
    if (typeof val.read === 'function') {
      const chunks = [];
      let off = 1;
      const step = 32000;
      while (true) {
        const part = await val.read(off, step);
        if (!part) break;
        chunks.push(part);
        if (part.length < step) break;
        off += step;
      }
      return chunks.join('');
    }
  } catch { /* fall through */ }
  return String(val);
}

/** 在目标实例上真实执行发布 SQL */
/**
 * 在目标实例上执行一段 SQL 脚本：按语句拆分后在同一事务内顺序执行，任一条失败即回滚并停止
 * （Oracle / 达梦 / MySQL 的 DDL 会隐式提交，无法随事务回滚）。
 */
async function executePublishSql(instanceId, sqlText) {
  const startMs = Date.now();
  let conn;
  let dbType = '';
  try {
    if (!instanceId) throw new Error('工单未关联目标实例');
    const inst = await fetchCmdbInstance(instanceId);
    dbType = normalizeDbType(inst);
    const sql = String(sqlText || '').trim();
    if (!sql) throw new Error('SQL 内容为空');
    if (dbType === 'ORACLE') conn = await connectOracle(inst);
    else if (dbType === 'MYSQL' || dbType === 'GOLDENDB') conn = await connectMysql(inst);
    else if (dbType === 'POSTGRESQL' || dbType === 'PANWEI') conn = await connectPostgres(inst);
    else if (dbType === 'DAMENG') conn = await connectDameng(inst);
    else if (dbType === 'SQLSERVER') conn = await connectSqlServer(inst);
    else throw new Error(`不支持的数据库类型: ${dbType}`);
    const r = await runScript(dbType, conn, sql);
    return { ok: true, durationMs: Date.now() - startMs, rowsAffected: r.rowsAffected, statements: r.statements, error: null };
  } catch (e) {
    return { ok: false, durationMs: Date.now() - startMs, rowsAffected: 0, error: e.message, statementIndex: e.statementIndex };
  } finally {
    if (conn) {
      try {
        if (dbType === 'MYSQL' || dbType === 'GOLDENDB' || dbType === 'POSTGRESQL' || dbType === 'PANWEI') await conn.end();
        else await conn.close();
      } catch { /* ignore */ }
    }
  }
}

/** 执行发布（支持灰度→全量两段式） */
router.post('/publish/tickets/:id/execute', adminDbaOps, async (req, res) => {
  const { grayPercent } = req.body;
  const ticketId = req.params.id;
  try {
    const baseSel = `SELECT TICKET_ID, TICKET_NO, STATUS, GRAY_PERCENT, RISK_LEVEL, INSTANCE_ID, SQL_CONTENT`;
    let r;
    try {
      r = await db.execute(
        `${baseSel}, NVL(ENV, 'PROD') AS ENV FROM PUBLISH_TICKET WHERE TICKET_ID=:1`,
        [ticketId],
        { fetchAsString: [oracledb.CLOB] }
      );
    } catch (e) {
      if (!oraMissingColumn(e, ['ENV'])) throw e;
      r = await db.execute(
        `${baseSel}, 'PROD' AS ENV FROM PUBLISH_TICKET WHERE TICKET_ID=:1`,
        [ticketId],
        { fetchAsString: [oracledb.CLOB] }
      );
    }
    if (!r.rows.length) return res.json({ code:404, msg:'工单不存在' });
    const t = r.rows[0];
    if (!['APPROVED','GRAY_TESTING'].includes(t.STATUS))
      return res.json({ code: 400, msg: `当前状态 ${t.STATUS} 不可执行` });

    // 抢占执行权：只有一个请求能把状态从 APPROVED / GRAY_TESTING 改成 EXECUTING，避免并发重复执行同一份 SQL
    const claim = await db.execute(
      `UPDATE PUBLISH_TICKET SET STATUS='EXECUTING', UPDATED_AT=SYSTIMESTAMP WHERE TICKET_ID=:1 AND STATUS=:2`,
      [ticketId, t.STATUS]
    );
    if (!claim.rowsAffected) return res.json({ code: 409, msg: '工单正在执行或状态已变化，请刷新后重试' });

    const pct = grayPercent !== undefined ? Number(grayPercent) : (t.GRAY_PERCENT || 100);
    const isGray = pct < 100;
    const sqlText = await publishTicketSqlText(t.SQL_CONTENT);
    const run = await executePublishSql(t.INSTANCE_ID, sqlText);

    if (!run.ok) {
      const failResult = {
        executedAt: new Date().toISOString(),
        grayPercent: pct,
        env: t.ENV,
        durationMs: run.durationMs,
        rowsAffected: 0,
        phase: isGray ? `灰度${pct}%` : '全量发布',
        success: false,
        error: run.error,
      };
      await db.execute(
        `UPDATE PUBLISH_TICKET SET STATUS='FAILED',GRAY_PERCENT=:1,EXEC_RESULT=:2,EXECUTED_BY=:3,EXECUTED_AT=SYSTIMESTAMP,UPDATED_AT=SYSTIMESTAMP
         WHERE TICKET_ID=:4`,
        [pct, JSON.stringify(failResult), req.user.userId, ticketId]
      );
      await db.execute(
        `INSERT INTO PUBLISH_REVIEW (TICKET_ID,ACTION,"COMMENT",OPERATED_BY) VALUES (:1,'EXECUTE',:2,:3)`,
        [ticketId, `执行失败: ${run.error}`, req.user.userId]
      );
      await automationLog(req, 'PUBLISH', Number(ticketId), 'EXECUTE', 'FAILED', run.error || '');
      return res.json({ code: 500, msg: `发布执行失败: ${run.error}`, data: failResult });
    }

    const newStatus = isGray ? 'GRAY_TESTING' : 'DONE';
    const execResult = {
      executedAt: new Date().toISOString(),
      grayPercent: pct,
      env: t.ENV,
      durationMs: run.durationMs,
      rowsAffected: run.rowsAffected,
      phase: isGray ? `灰度${pct}%` : '全量发布',
      success: true,
    };

    await db.execute(
      `UPDATE PUBLISH_TICKET SET STATUS=:1,GRAY_PERCENT=:2,EXEC_RESULT=:3,EXECUTED_BY=:4,EXECUTED_AT=SYSTIMESTAMP,UPDATED_AT=SYSTIMESTAMP
       WHERE TICKET_ID=:5`,
      [newStatus, pct, JSON.stringify(execResult), req.user.userId, ticketId]
    );
    await db.execute(
      `INSERT INTO PUBLISH_REVIEW (TICKET_ID,ACTION,"COMMENT",OPERATED_BY) VALUES (:1,'EXECUTE',:2,:3)`,
      [ticketId, `${isGray ? `灰度${pct}%` : '全量'}执行成功，耗时 ${execResult.durationMs}ms`, req.user.userId]
    );

    // 发布成功 → SQL 洞察联动：
    //  ① 登记变更窗口（执行开始 ~ 结束后 30 分钟）：窗口内的 SQL 波动只记录不告警，数据不进基线
    //  ② 全量发布写“基线锚点”：该 SQL 的基线从发布时间重新积累（替代原 SQL_BASELINE 候选 —— 那是正则评分，不是运行数据）
    linkPublishToSqlInsight(req, t, sqlText, {
      title: `${isGray ? `灰度${pct}%` : '全量'}发布 ${t.TICKET_NO || ticketId}`,
      startMs: Date.now() - (run.durationMs || 0), anchor: !isGray,
    });

    await automationLog(req, 'PUBLISH', Number(ticketId), 'EXECUTE', newStatus, `gray=${pct}%`);
    res.json({ code:200, msg: isGray ? `灰度 ${pct}% 发布成功` : '全量发布成功', data: execResult });
  } catch (e) { res.json({ code:500, msg:e.message }); }
});

/**
 * 回滚工单：在目标实例上执行回滚 SQL，成功后状态为 ROLLED_BACK；执行失败保持原状态并记录失败原因。
 * 工单没有回滚 SQL 时，只有明确勾选“人工回滚已完成”（manual=true）才会登记为 ROLLED_BACK，且注明未执行 SQL。
 */
router.post('/publish/tickets/:id/rollback', adminDba, async (req, res) => {
  const { reason, manual } = req.body || {};
  const ticketId = req.params.id;
  try {
    const r = await db.execute(
      `SELECT TICKET_ID, TICKET_NO, STATUS, INSTANCE_ID, ROLLBACK_SQL, SQL_CONTENT FROM PUBLISH_TICKET WHERE TICKET_ID=:1`,
      [ticketId], { fetchAsString: [oracledb.CLOB] }
    );
    if (!r.rows.length) return res.json({ code:404, msg:'工单不存在' });
    const t = r.rows[0];
    if (!['DONE','GRAY_TESTING'].includes(t.STATUS))
      return res.json({ code:400, msg:'仅已执行或灰度中的工单可回滚' });
    const rollbackSql = String(t.ROLLBACK_SQL || '').trim();
    if (!rollbackSql && manual !== true) {
      return res.json({ code: 400, msg: '该工单没有回滚 SQL。如已人工完成回滚，请勾选“人工回滚已完成”后再提交', data: { needManual: true } });
    }
    const claim = await db.execute(
      `UPDATE PUBLISH_TICKET SET STATUS='ROLLING_BACK', UPDATED_AT=SYSTIMESTAMP WHERE TICKET_ID=:1 AND STATUS=:2`, [ticketId, t.STATUS]
    );
    if (!claim.rowsAffected) return res.json({ code: 409, msg: '工单状态已变化，请刷新后重试' });

    let run = null;
    if (rollbackSql) {
      run = await executePublishSql(t.INSTANCE_ID, rollbackSql);
      if (!run.ok) {
        await db.execute(`UPDATE PUBLISH_TICKET SET STATUS=:1, UPDATED_AT=SYSTIMESTAMP WHERE TICKET_ID=:2`, [t.STATUS, ticketId]);
        await db.execute(
          `INSERT INTO PUBLISH_REVIEW (TICKET_ID,ACTION,"COMMENT",OPERATED_BY) VALUES (:1,'ROLLBACK',:2,:3)`,
          [ticketId, `回滚失败: ${run.error}`, req.user.userId]
        );
        await automationLog(req, 'PUBLISH', Number(ticketId), 'ROLLBACK', 'FAILED', run.error || '');
        return res.json({ code: 500, msg: `回滚 SQL 执行失败，工单保持原状态：${run.error}` });
      }
    }
    const rollbackResult = {
      rolledBackAt: new Date().toISOString(),
      rollbackSql: rollbackSql ? `已执行（${run.statements} 条语句，影响 ${run.rowsAffected} 行，耗时 ${run.durationMs}ms）` : '未执行 SQL（人工回滚）',
      reason: reason || '人工回滚',
      success: true,
    };
    await db.execute(
      `UPDATE PUBLISH_TICKET SET STATUS='ROLLED_BACK',EXEC_RESULT=:1,UPDATED_AT=SYSTIMESTAMP WHERE TICKET_ID=:2`,
      [JSON.stringify(rollbackResult), ticketId]
    );
    await db.execute(
      `INSERT INTO PUBLISH_REVIEW (TICKET_ID,ACTION,"COMMENT",OPERATED_BY) VALUES (:1,'ROLLBACK',:2,:3)`,
      [ticketId, `${rollbackResult.rollbackSql}；${reason || '人工回滚'}`, req.user.userId]
    );
    // 回滚同样是一次变更：登记变更窗口，回滚后的指标回落不会被当成异常
    linkPublishToSqlInsight(req, t, null, { title: `回滚 ${t.TICKET_NO || ticketId}`, startMs: Date.now() - (run?.durationMs || 0), anchor: false });
    await automationLog(req, 'PUBLISH', Number(ticketId), 'ROLLBACK', 'SUCCESS', reason || '');
    res.json({ code:200, msg: rollbackSql ? '回滚成功' : '已登记人工回滚', data: rollbackResult });
  } catch (e) { res.json({ code:500, msg:e.message }); }
});

// DDL 审核规则：SQL 审核已统一由 SQL 洞察规则引擎执行（规则在“SQL 洞察 → 规则配置”维护），原 DDL_AUDIT_RULE 不再生效，接口已删除

/** 工单流水线概览（各状态数量，用于仪表盘） */
router.get('/publish/pipeline-overview', async (req, res) => {
  try {
    const r = await db.execute(
      `SELECT STATUS, ENV, COUNT(*) CNT FROM PUBLISH_TICKET
       WHERE CREATED_AT >= SYSDATE - 30 GROUP BY STATUS, ENV ORDER BY STATUS`, []
    );
    res.json({ code:200, data: r.rows });
  } catch (e) { res.json({ code:500, msg:e.message }); }
});

// ══════════════════════════════════════════════
// §5  SQL治理中心 —— 已并入「SQL评审」与「SQL洞察」
// ══════════════════════════════════════════════
// 原即时审核 / 审核历史 / 慢查询导入 / 评分维度 / SQL基线 / 回归检测 / 健康度 接口已删除：
//  - 审核与推送发布 → SQL评审（/api/sql-review，评审通过后一键推送发布工单）
//  - 慢 SQL、运行时问题、性能波动、健康度 → SQL洞察（Java /api/sql-insight）
//  - 发布预审仍在本文件 §4，调用 Java 统一审核

// ══════════════════════════════════════════════
// §6  高可用与容灾
// ══════════════════════════════════════════════
//
// 关键闭环联动：
//  ① 故障处理 HA_FAILOVER → 调用本模块执行切换
//  ② 切换完成 → 同步更新 CMDB_INSTANCE 主备角色
//  ③ DR 链路健康 → 读取 MONITOR_METRIC_SAMPLE 实时延迟
//  ④ DR 演练 → 记录演练结果，不影响生产主备关系

/** HA 拓扑列表（附主节点健康状态） */
router.get('/ha/topologies', async (req, res) => {
  try {
    const r = await db.execute(
      `SELECT t.*,
              pi.INSTANCE_NAME PRIMARY_NAME, pi.STATUS PRIMARY_CMDB_STATUS
       FROM HA_TOPOLOGY t
       LEFT JOIN CMDB_INSTANCE pi ON t.PRIMARY_ID = pi.INSTANCE_ID
       WHERE t.ENABLED = 1 ORDER BY t.TOPO_ID DESC`, []
    );
    res.json({ code:200, data:r.rows });
  } catch (e) { res.json({ code:500, msg:e.message }); }
});

/** 创建 HA 拓扑 */
router.post('/ha/topologies', adminDba, async (req, res) => {
  const { topoName, haType, primaryId, memberIds, vip, regionInfo, configJson } = req.body;
  if (!topoName || !haType) return res.json({ code:400, msg:'拓扑名称/类型必填' });
  try {
    await db.execute(
      `INSERT INTO HA_TOPOLOGY (TOPO_NAME,HA_TYPE,PRIMARY_ID,MEMBER_IDS,VIP,STATUS,REGION_INFO,CONFIG_JSON)
       VALUES (:1,:2,:3,:4,:5,'NORMAL',:6,:7)`,
      [topoName, haType, primaryId || null, JSON.stringify(memberIds || []), vip || null,
       regionInfo ? JSON.stringify(regionInfo) : null, configJson ? JSON.stringify(configJson) : null]
    );
    await automationLog(req, 'HA', null, 'CREATE_TOPOLOGY', 'SUCCESS', topoName);
    res.json({ code:200, msg:'HA 拓扑已创建' });
  } catch (e) { res.json({ code:500, msg:e.message }); }
});

/** 更新 HA 拓扑 */
router.put('/ha/topologies/:id', adminDba, async (req, res) => {
  const { topoName, vip, status } = req.body;
  try {
    await db.execute(
      `UPDATE HA_TOPOLOGY SET TOPO_NAME=COALESCE(:1,TOPO_NAME),VIP=COALESCE(:2,VIP),
       STATUS=COALESCE(:3,STATUS),UPDATED_AT=SYSTIMESTAMP WHERE TOPO_ID=:4`,
      [topoName || null, vip || null, status || null, req.params.id]
    );
    res.json({ code:200, msg:'已更新' });
  } catch (e) { res.json({ code:500, msg:e.message }); }
});

/** 切换前节点健康预检 */
router.get('/ha/topologies/:id/health-check', async (req, res) => {
  try {
    const tr = await db.execute(`SELECT * FROM HA_TOPOLOGY WHERE TOPO_ID=:1`, [req.params.id]);
    if (!tr.rows.length) return res.json({ code:404, msg:'拓扑不存在' });
    const topo = tr.rows[0];
    const members = safeJson(topo.MEMBER_IDS) || [];
    const checks = await Promise.all(
      [topo.PRIMARY_ID, ...members].filter(Boolean).map(async (id) => {
        const h = await checkNodeHealth(id);
        return { nodeId: id, ...h };
      })
    );
    const allHealthy = checks.every(c => c.healthy);
    const safeToSwitch = checks.filter(c => String(c.nodeId) !== String(topo.PRIMARY_ID)).some(c => c.healthy);
    res.json({ code:200, data:{ topo: topo.TOPO_NAME, checks, allHealthy, safeToSwitch } });
  } catch (e) { res.json({ code:500, msg:e.message }); }
});

/**
 * 执行 HA 切换（计划切换 / 故障切换 / 演练）
 * 切换前：健康预检
 * 切换后：更新 CMDB 实例角色 + 记录 HA_SWITCH_RECORD
 */
router.post('/ha/topologies/:id/switch', adminDba, async (req, res) => {
  const { switchType, toNode, reason } = req.body;
  if (!switchType || !toNode) return res.json({ code:400, msg:'switchType/toNode 必填' });
  if (!['PLANNED','FAILOVER','DRILL'].includes(switchType))
    return res.json({ code:400, msg:'switchType 须为 PLANNED / FAILOVER / DRILL' });
  try {
    const sw = await performHaTopologySwitch({
      topoId: Number(req.params.id),
      switchType,
      toNode: Number(toNode),
      operatorId: req.user.userId,
      reason: reason || '',
      triggeredBy: 'MANUAL',
    });
    if (!sw.ok) {
      return res.json({ code: 400, msg: sw.detail, data: sw.result || null });
    }
    const typeLabel = { PLANNED:'计划切换', FAILOVER:'故障切换', DRILL:'容灾演练' }[switchType];
    await automationLog(req, 'HA', Number(req.params.id), `SWITCH_${switchType}`, sw.status,
      `${sw.result?.fromNode}→${toNode}${switchType === 'DRILL' ? ' (演练)' : ''}`);
    res.json({ code:200, msg:`${typeLabel}成功`, data: sw.result });
  } catch (e) { res.json({ code:500, msg:e.message }); }
});

/** 切换记录查询 */
router.get('/ha/switches', async (req, res) => {
  const { topoId, switchType } = req.query;
  const binds = [];
  let sql = `SELECT s.*, t.TOPO_NAME, t.HA_TYPE, u.REAL_NAME OPERATOR
             FROM HA_SWITCH_RECORD s
             LEFT JOIN HA_TOPOLOGY t ON s.TOPO_ID   = t.TOPO_ID
             LEFT JOIN SYS_USER u    ON s.OPERATED_BY = u.USER_ID
             WHERE 1=1`;
  if (topoId)     { sql += ` AND s.TOPO_ID=:${binds.length+1}`;     binds.push(topoId); }
  if (switchType) { sql += ` AND s.SWITCH_TYPE=:${binds.length+1}`; binds.push(switchType); }
  sql += ` ORDER BY s.CREATED_AT DESC FETCH NEXT 50 ROWS ONLY`;
  try { const r = await db.execute(sql, binds); res.json({ code:200, data:r.rows }); }
  catch (e) { res.json({ code:500, msg:e.message }); }
});

/** 容灾链路列表（含实时同步延迟） */
router.get('/ha/dr-links', async (req, res) => {
  try {
    const r = await db.execute(
      `SELECT l.*, s.INSTANCE_NAME SRC_NAME, t.INSTANCE_NAME TGT_NAME
       FROM DR_LINK l
       LEFT JOIN CMDB_INSTANCE s ON l.SOURCE_ID = s.INSTANCE_ID
       LEFT JOIN CMDB_INSTANCE t ON l.TARGET_ID = t.INSTANCE_ID
       ORDER BY l.LINK_ID`, []
    );
    const links = r.rows;
    for (const link of links) {
      if (link.TARGET_ID) {
        try {
          const delaySec = await getReplicationDelaySec(link.TARGET_ID);
          if (delaySec != null) {
            const ms = Math.round(delaySec * 1000);
            const rpoMs = (link.RPO_SEC || 30) * 1000;
            link.SYNC_DELAY_MS      = ms;
            link.LINK_STATUS        = ms > rpoMs * 0.8 ? 'LAG' : 'NORMAL';
            link.DELAY_FROM_MONITOR = true;
          }
        } catch { /* 无监控数据时保留原始值 */ }
      }
    }
    res.json({ code:200, data:links });
  } catch (e) { res.json({ code:500, msg:e.message }); }
});

/** 新建容灾链路 */
router.post('/ha/dr-links', adminDba, async (req, res) => {
  const { linkName, sourceRegion, targetRegion, sourceId, targetId, syncMode, rpoSec, rtoSec } = req.body;
  if (!linkName || !sourceRegion || !targetRegion) return res.json({ code:400, msg:'链路名/源/目标地域必填' });
  try {
    await db.execute(
      `INSERT INTO DR_LINK (LINK_NAME,SOURCE_REGION,TARGET_REGION,SOURCE_ID,TARGET_ID,SYNC_MODE,RPO_SEC,RTO_SEC,SYNC_DELAY_MS,LINK_STATUS,LAST_CHECK_AT)
       VALUES (:1,:2,:3,:4,:5,:6,:7,:8,0,'UNKNOWN',SYSTIMESTAMP)`,
      [linkName, sourceRegion, targetRegion, sourceId || null, targetId || null,
       syncMode || 'ASYNC', rpoSec || 30, rtoSec || 120]
    );
    res.json({ code:200, msg:'容灾链路已创建' });
  } catch (e) { res.json({ code:500, msg:e.message }); }
});

/** 刷新容灾链路状态（从监控获取实时延迟） */
router.post('/ha/dr-links/:id/refresh', async (req, res) => {
  try {
    const lr = await db.execute(`SELECT * FROM DR_LINK WHERE LINK_ID=:1`, [req.params.id]);
    if (!lr.rows.length) return res.json({ code:404, msg:'链路不存在' });
    const link = lr.rows[0];
    let delay = link.SYNC_DELAY_MS || 0;
    if (link.TARGET_ID) {
      try {
        const delaySec = await getReplicationDelaySec(link.TARGET_ID);
        if (delaySec != null) delay = Math.round(delaySec * 1000);
      } catch { /* 保留库内已有延迟 */ }
    }
    const rpoMs   = (link.RPO_SEC || 30) * 1000;
    const newStatus = delay > rpoMs * 0.8 ? 'LAG' : 'NORMAL';
    await db.execute(
      `UPDATE DR_LINK SET SYNC_DELAY_MS=:1,LINK_STATUS=:2,LAST_CHECK_AT=SYSTIMESTAMP WHERE LINK_ID=:3`,
      [delay, newStatus, req.params.id]
    );
    res.json({ code:200, data:{ delayMs: delay, status: newStatus, rpoThresholdMs: Math.round(rpoMs * 0.8) } });
  } catch (e) { res.json({ code:500, msg:e.message }); }
});

/** 执行 DR 演练（使用 DRILL 切换类型，不改变生产主备角色） */
router.post('/ha/dr-links/:id/drill', adminDba, async (req, res) => {
  const { note } = req.body;
  try {
    const lr = await db.execute(`SELECT * FROM DR_LINK WHERE LINK_ID=:1`, [req.params.id]);
    if (!lr.rows.length) return res.json({ code:404, msg:'链路不存在' });
    const link = lr.rows[0];
    if (!link.SOURCE_ID || !link.TARGET_ID)
      return res.json({ code:400, msg:'演练需要绑定具体实例（SOURCE_ID / TARGET_ID）' });

    const drillStartMs = Date.now();
    const topoRes = await db.execute(
      `SELECT TOPO_ID, PRIMARY_ID, MEMBER_IDS FROM HA_TOPOLOGY WHERE ENABLED=1`,
      []
    );
    const topo = (topoRes.rows || []).find(
      (row) => Number(row.PRIMARY_ID) === Number(link.SOURCE_ID)
        || (parseInstanceIdList(row.MEMBER_IDS) || []).some((id) => Number(id) === Number(link.SOURCE_ID))
        || (parseInstanceIdList(row.MEMBER_IDS) || []).some((id) => Number(id) === Number(link.TARGET_ID))
    );
    let drillResult = {
      drillAt: new Date().toISOString(), linkId: link.LINK_ID, linkName: link.LINK_NAME,
      sourceRegion: link.SOURCE_REGION, targetRegion: link.TARGET_REGION,
      rtoSec: link.RTO_SEC, actualDuration: '0s',
      status: 'PASSED', note: note || '例行容灾演练',
    };
    if (topo) {
      const sw = await performHaTopologySwitch({
        topoId: topo.TOPO_ID,
        switchType: 'DRILL',
        toNode: link.TARGET_ID,
        operatorId: req.user.userId,
        reason: note || '容灾链路演练',
        triggeredBy: 'DR_DRILL',
      });
      drillResult.actualDuration = sw.result?.duration || `${((Date.now() - drillStartMs) / 1000).toFixed(1)}s`;
      drillResult.status = sw.ok ? 'PASSED' : 'FAILED';
      drillResult.switchDetail = sw.detail;
      if (!sw.ok) {
        return res.json({ code: 500, msg: `容灾演练失败: ${sw.detail}`, data: drillResult });
      }
    } else {
      drillResult.actualDuration = `${((Date.now() - drillStartMs) / 1000).toFixed(1)}s`;
      drillResult.status = 'SKIPPED';
      drillResult.note = (note || '例行容灾演练') + '（未绑定 HA 拓扑，仅记录演练事件）';
    }
    await db.execute(
      `UPDATE DR_LINK SET LAST_DRILL_AT=SYSTIMESTAMP WHERE LINK_ID=:1`, [req.params.id]
    ).catch(() => {});
    await automationLog(req, 'HA', link.LINK_ID, 'DR_DRILL', drillResult.status === 'FAILED' ? 'FAILED' : 'SUCCESS',
      `${link.SOURCE_REGION}↔${link.TARGET_REGION}`);
    res.json({ code:200, msg:'容灾演练完成（DRILL 模式，不影响生产主备关系）', data:drillResult });
  } catch (e) { res.json({ code:500, msg:e.message }); }
});

/** HA 总览仪表盘 */
router.get('/ha/dashboard', async (req, res) => {
  try {
    const topoCount = await db.execute(`SELECT COUNT(*) CNT FROM HA_TOPOLOGY WHERE ENABLED=1`, []);
    const switchStat = await db.execute(
      `SELECT SWITCH_TYPE, STATUS, COUNT(*) CNT FROM HA_SWITCH_RECORD
       WHERE CREATED_AT>=SYSDATE-30 GROUP BY SWITCH_TYPE, STATUS`, []
    );
    const drHealth = await db.execute(
      `SELECT LINK_STATUS, COUNT(*) CNT FROM DR_LINK GROUP BY LINK_STATUS`, []
    );
    const lastFailover = await db.execute(
      `SELECT TOPO_ID, FROM_NODE, TO_NODE, CREATED_AT FROM HA_SWITCH_RECORD
       WHERE SWITCH_TYPE='FAILOVER' ORDER BY CREATED_AT DESC FETCH NEXT 1 ROWS ONLY`, []
    );
    res.json({ code:200, data:{
      topoCount:    Number(topoCount.rows[0]?.CNT || 0),
      switchStats:  switchStat.rows,
      drHealth:     drHealth.rows,
      lastFailover: lastFailover.rows[0] || null,
    }});
  } catch (e) { res.json({ code:500, msg:e.message }); }
});
// §7 容量预测
router.get('/capacity/snapshots', async (req,res) => {
  const{instanceId,days=30}=req.query; const binds=[Number(days)]; let sql=`SELECT s.*,i.INSTANCE_NAME FROM CAPACITY_SNAPSHOT s LEFT JOIN CMDB_INSTANCE i ON s.INSTANCE_ID=i.INSTANCE_ID WHERE s.SNAP_DATE>=SYSDATE-:1`;
  if(instanceId){sql+=` AND s.INSTANCE_ID=:2`;binds.push(instanceId);}
  sql+=` ORDER BY s.INSTANCE_ID,s.SNAP_DATE`;
  try{const r=await db.execute(sql,binds);res.json({code:200,data:r.rows});}
  catch(e){res.json({code:500,msg:e.message});}
});
router.post('/capacity/snapshots/collect', adminDbaOps, async (req,res) => {
  const{instanceId}=req.body;
  if(!instanceId)return res.json({code:400,msg:'instanceId必填'});
  let snap;
  try{
    snap=await collectCapacitySnapshot(instanceId);
  }catch(e){return res.json({code:500,msg:e.message});}
  try{
    await db.execute(
      `MERGE INTO CAPACITY_SNAPSHOT t
       USING (
         SELECT :1 AS INSTANCE_ID, :2 AS DISK_USED_GB, :3 AS DISK_TOTAL_GB, :4 AS TPS_AVG, :5 AS TPS_PEAK,
                :6 AS QPS_AVG, :7 AS CONN_AVG, :8 AS CPU_AVG_PCT, :9 AS MEM_AVG_PCT
         FROM DUAL
       ) s
       ON (t.INSTANCE_ID = s.INSTANCE_ID AND t.SNAP_DATE = TRUNC(SYSDATE))
       WHEN MATCHED THEN UPDATE SET
         DISK_USED_GB = s.DISK_USED_GB,
         DISK_TOTAL_GB = s.DISK_TOTAL_GB,
         TPS_AVG = s.TPS_AVG,
         TPS_PEAK = s.TPS_PEAK,
         QPS_AVG = s.QPS_AVG,
         CONN_AVG = s.CONN_AVG,
         CPU_AVG_PCT = s.CPU_AVG_PCT,
         MEM_AVG_PCT = s.MEM_AVG_PCT
       WHEN NOT MATCHED THEN INSERT (
         INSTANCE_ID, SNAP_DATE, DISK_USED_GB, DISK_TOTAL_GB, TPS_AVG, TPS_PEAK, QPS_AVG, CONN_AVG, CPU_AVG_PCT, MEM_AVG_PCT
       ) VALUES (
         s.INSTANCE_ID, TRUNC(SYSDATE), s.DISK_USED_GB, s.DISK_TOTAL_GB, s.TPS_AVG, s.TPS_PEAK, s.QPS_AVG, s.CONN_AVG, s.CPU_AVG_PCT, s.MEM_AVG_PCT
       )`,
      [instanceId, snap.diskUsed, snap.diskTotal, snap.tpsAvg, snap.tpsPeak, snap.qpsAvg, snap.connAvg, snap.cpuAvg, snap.memAvg]
    );
    res.json({code:200,msg:'容量快照采集成功',data:snap});
  }catch(e){res.json({code:500,msg:e.message});}
});
router.get('/capacity/forecasts', async (req,res) => {
  const{instanceId}=req.query; const binds=[]; let sql=`SELECT f.*,i.INSTANCE_NAME FROM CAPACITY_FORECAST f LEFT JOIN CMDB_INSTANCE i ON f.INSTANCE_ID=i.INSTANCE_ID WHERE 1=1`;
  if(instanceId){sql+=` AND f.INSTANCE_ID=:1`;binds.push(instanceId);}
  sql+=` ORDER BY f.METRIC_TYPE,f.FORECAST_DATE`;
  try{const r=await db.execute(sql,binds);res.json({code:200,data:r.rows});}
  catch(e){res.json({code:500,msg:e.message});}
});
/**
 * 容量预测：对最近 60 天的真实容量快照做最小二乘线性回归，外推 7~90 天。
 * 快照少于 5 天时不做预测（原先在没有数据时用 50GB / 200TPS 和固定增长率生成数字，属于假数据）。
 * 置信度 = 拟合优度 R² × 100；磁盘的“距写满天数”以快照中的总容量为上限，TPS 没有上限不计算。
 */
function linearFit(points) {
  const n = points.length;
  const mx = points.reduce((a, p) => a + p.x, 0) / n;
  const my = points.reduce((a, p) => a + p.y, 0) / n;
  let sxy = 0; let sxx = 0; let syy = 0;
  for (const p of points) { sxy += (p.x - mx) * (p.y - my); sxx += (p.x - mx) ** 2; syy += (p.y - my) ** 2; }
  const slope = sxx ? sxy / sxx : 0;
  const r2 = sxx && syy ? (sxy * sxy) / (sxx * syy) : 0;
  return { slope, intercept: my - slope * mx, r2 };
}
router.post('/capacity/forecasts/run', adminDbaOps, async (req,res) => {
  const{instanceId}=req.body;
  if(!instanceId)return res.json({code:400,msg:'instanceId必填'});
  try{
    const snaps=await db.execute(
      `SELECT SNAP_DATE, DISK_USED_GB, DISK_TOTAL_GB, TPS_AVG FROM CAPACITY_SNAPSHOT
        WHERE INSTANCE_ID=:1 AND SNAP_DATE >= TRUNC(SYSDATE) - 60 ORDER BY SNAP_DATE`, [instanceId]);
    const rows = snaps.rows || [];
    if (rows.length < 5) return res.json({ code: 400, msg: `容量快照只有 ${rows.length} 天，至少需要 5 天的数据才能预测，请先采集容量快照` });
    const t0 = new Date(rows[0].SNAP_DATE).getTime();
    const day = d => (new Date(d).getTime() - t0) / 86400000;
    const lastX = day(rows[rows.length - 1].SNAP_DATE);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const result = {};
    for (const metric of ['DISK', 'TPS']) {
      const col = metric === 'DISK' ? 'DISK_USED_GB' : 'TPS_AVG';
      const pts = rows.filter(r => r[col] != null).map(r => ({ x: day(r.SNAP_DATE), y: Number(r[col]) }));
      if (pts.length < 5) continue;
      const fit = linearFit(pts);
      const conf = Math.round(Math.max(0, Math.min(1, fit.r2)) * 100);
      const totals = rows.map(r => Number(r.DISK_TOTAL_GB)).filter(v => v > 0);
      const limit = metric === 'DISK' && totals.length ? totals[totals.length - 1] : null;
      const nowVal = fit.intercept + fit.slope * lastX;
      const dtf = limit && fit.slope > 0 ? Math.max(0, Math.round((limit - nowVal) / fit.slope)) : null;
      result[metric] = { slopePerDay: Number(fit.slope.toFixed(4)), confidence: conf, daysToFull: dtf, samples: pts.length };
      await db.execute(`DELETE FROM CAPACITY_FORECAST WHERE INSTANCE_ID=:1 AND METRIC_TYPE=:2`, [instanceId, metric]);
      for (let d = 7; d <= 90; d += 7) {
        const fDate = new Date(today); fDate.setDate(fDate.getDate() + d);
        const x = lastX + d + (today.getTime() - (t0 + lastX * 86400000)) / 86400000;
        const val = Math.max(0, fit.intercept + fit.slope * x);
        await db.execute(
          `INSERT INTO CAPACITY_FORECAST (INSTANCE_ID, METRIC_TYPE, FORECAST_DATE, FORECAST_VAL, CONFIDENCE, DAYS_TO_FULL)
           VALUES (:1, :2, TRUNC(:3), :4, :5, :6)`,
          [instanceId, metric, fDate, Number(val.toFixed(4)), conf, dtf]
        );
      }
    }
    if (!Object.keys(result).length) return res.json({ code: 400, msg: '快照中没有可用于预测的磁盘或 TPS 数据' });
    res.json({ code: 200, msg: `已基于 ${rows.length} 天快照完成预测`, data: result });
  }catch(e){res.json({code:500,msg:e.message});}
});
// 成本分析（CPU/IO/内存成本为随机演示数据）已删除；Top SQL 资源消耗见 SQL 洞察 / SQL 监控大屏

// §8 备份恢复中心（查询结果经 toPlainJson 序列化，避免 Oracle 驱动 TIMESTAMP/LOB 等循环引用）
router.get('/backup/policies', async (req,res) => {
  try{const r=await db.execute(`SELECT p.*,i.INSTANCE_NAME FROM BACKUP_POLICY_PRO p LEFT JOIN CMDB_INSTANCE i ON p.INSTANCE_ID=i.INSTANCE_ID ORDER BY p.POLICY_ID DESC`,[]);res.json({code:200,data:toPlainJson(r.rows)});}
  catch(e){res.json({code:500,msg:e.message});}
});
router.post('/backup/policies', adminDba, async (req,res) => {
  const{policyName,instanceId,backupType,storageType,storagePath,retentionDays,compress,encrypt,schedule}=req.body;
  if(!policyName||!backupType)return res.json({code:400,msg:'策略名/备份类型必填'});
  try{
    const st=storageType||'LOCAL';
    const sp=normalizePolicyStoragePath(st,storagePath);
    if(['LOCAL','NFS'].includes(String(st).toUpperCase())){
      resolveStorageRoot({STORAGE_TYPE:st,STORAGE_PATH:sp},{validateWrite:true});
    }
    await db.execute(`INSERT INTO BACKUP_POLICY_PRO (POLICY_NAME,INSTANCE_ID,BACKUP_TYPE,STORAGE_TYPE,STORAGE_PATH,RETENTION_DAYS,"COMPRESS",ENCRYPT,SCHEDULE,CREATED_BY) VALUES (:1,:2,:3,:4,:5,:6,:7,:8,:9,:10)`,
      [policyName,instanceId||null,backupType,st,sp,retentionDays||7,compress?1:0,encrypt?1:0,schedule||'0 2 * * *',req.user.userId]);
    await automationLog(req,'BACKUP',null,'CREATE_POLICY','SUCCESS',policyName);
    res.json({code:200,msg:'备份策略已创建'});
  }catch(e){res.json({code:500,msg:e.message});}
});
router.put('/backup/policies/:id', adminDba, async (req,res) => {
  const{policyName,retentionDays,schedule,enabled}=req.body;
  try{
    await db.execute(`UPDATE BACKUP_POLICY_PRO SET POLICY_NAME=COALESCE(:1,POLICY_NAME),RETENTION_DAYS=COALESCE(:2,RETENTION_DAYS),SCHEDULE=COALESCE(:3,SCHEDULE),ENABLED=COALESCE(:4,ENABLED),UPDATED_AT=SYSTIMESTAMP WHERE POLICY_ID=:5`,
      [policyName||null,retentionDays||null,schedule||null,enabled===undefined?null:(enabled?1:0),req.params.id]);
    res.json({code:200,msg:'已更新'});
  }catch(e){res.json({code:500,msg:e.message});}
});
router.delete('/backup/policies/:id', adminDba, async (req,res) => {
  try{await db.execute(`DELETE FROM BACKUP_POLICY_PRO WHERE POLICY_ID=:1`,[req.params.id]);res.json({code:200,msg:'已删除'});}
  catch(e){res.json({code:500,msg:e.message});}
});
router.post('/backup/policies/:id/run', adminDbaOps, async (req,res) => {
  try{
    const out=await executeBackupPolicy(req.params.id,{triggerType:'MANUAL',userId:req.user?.userId??null});
    await automationLog(req,'BACKUP',Number(req.params.id),'RUN_BACKUP','SUCCESS',out.detail||out.msg);
    res.json({code:200,msg:out.msg||'备份成功',data:toPlainJson({filePath:out.filePath,sizeMB:out.sizeMB,sizeKB:out.sizeKB,backupResult:out.backupResult,durationSec:out.durationSec,execMode:out.execMode,detail:out.detail})});
  }catch(e){
    const code=e.code==='NOT_FOUND'?404:e.code==='BAD_REQUEST'?400:e.code==='BACKUP_FAILED'?500:500;
    await automationLog(req,'BACKUP',Number(req.params.id),'RUN_BACKUP','FAILED',(e.message||'').slice(0,450)).catch(()=>{});
    res.json({code,msg:e.message});
  }
});
router.get('/backup/records', async (req,res) => {
  const{instanceId,status,backupType}=req.query; const binds=[]; let sql=`SELECT r.*,p.POLICY_NAME,i.INSTANCE_NAME FROM BACKUP_RECORD_PRO r LEFT JOIN BACKUP_POLICY_PRO p ON r.POLICY_ID=p.POLICY_ID LEFT JOIN CMDB_INSTANCE i ON r.INSTANCE_ID=i.INSTANCE_ID WHERE 1=1`;
  if(instanceId){sql+=` AND r.INSTANCE_ID=:${binds.length+1}`;binds.push(instanceId);}
  if(status){sql+=` AND r.STATUS=:${binds.length+1}`;binds.push(status);}
  if(backupType){sql+=` AND r.BACKUP_TYPE=:${binds.length+1}`;binds.push(backupType);}
  sql+=` ORDER BY r.CREATED_AT DESC FETCH NEXT 100 ROWS ONLY`;
  try{const r=await db.execute(sql,binds);res.json({code:200,data:toPlainJson(r.rows)});}
  catch(e){res.json({code:500,msg:e.message});}
});
router.get('/backup/stats', async (req,res) => {
  try{
    const stats=await db.execute(`SELECT STATUS,COUNT(*) CNT,ROUND(AVG(DURATION_SEC),1) AVG_DUR,ROUND(SUM(FILE_SIZE_MB)/1024,2) TOTAL_GB FROM BACKUP_RECORD_PRO WHERE CREATED_AT>=SYSDATE-30 GROUP BY STATUS`,[]);
    const top=await db.execute(`SELECT r.INSTANCE_ID,i.INSTANCE_NAME,COUNT(*) FAIL_CNT FROM BACKUP_RECORD_PRO r LEFT JOIN CMDB_INSTANCE i ON r.INSTANCE_ID=i.INSTANCE_ID WHERE r.STATUS='FAILED' AND r.CREATED_AT>=SYSDATE-7 GROUP BY r.INSTANCE_ID,i.INSTANCE_NAME ORDER BY FAIL_CNT DESC FETCH NEXT 5 ROWS ONLY`,[]);
    res.json({code:200,data:{statusSummary:toPlainJson(stats.rows),topFailures:toPlainJson(top.rows)}});
  }catch(e){res.json({code:500,msg:e.message});}
});
router.get('/backup/restores', async (req,res) => {
  try{const r=await db.execute(`SELECT t.*,br.FILE_PATH,i.INSTANCE_NAME,u.REAL_NAME OPERATOR FROM RESTORE_TASK t LEFT JOIN BACKUP_RECORD_PRO br ON t.RECORD_ID=br.RECORD_ID LEFT JOIN CMDB_INSTANCE i ON t.INSTANCE_ID=i.INSTANCE_ID LEFT JOIN SYS_USER u ON t.CREATED_BY=u.USER_ID ORDER BY t.CREATED_AT DESC FETCH NEXT 50 ROWS ONLY`,[]);res.json({code:200,data:toPlainJson(r.rows)});}
  catch(e){res.json({code:500,msg:e.message});}
});
router.post('/backup/restores', adminDba, async (req,res) => {
  const{recordId,instanceId,restoreType,targetTime,targetTable,flashbackScn}=req.body;
  if(!instanceId||!restoreType)return res.json({code:400,msg:'instanceId/restoreType必填'});
  if(restoreType==='PITR'&&!targetTime)return res.json({code:400,msg:'PITR恢复必须指定目标时间'});
  if(restoreType==='SINGLE_TABLE'&&!targetTable)return res.json({code:400,msg:'单表恢复必须指定目标表名'});
  if(restoreType==='FLASHBACK'&&!flashbackScn)return res.json({code:400,msg:'闪回恢复必须指定SCN'});
  if(['FULL','SINGLE_TABLE'].includes(restoreType)&&!recordId)return res.json({code:400,msg:'全量/单表恢复必须选择关联备份记录'});
  try{
    const outId = { dir: oracledb.BIND_OUT, type: oracledb.NUMBER };
    const binds = {
      recordId: recordId || null,
      instanceId,
      restoreType,
      targetTime: targetTime || null,
      targetTable: targetTable || null,
      flashbackScn: flashbackScn != null && flashbackScn !== '' ? Number(flashbackScn) : null,
      createdBy: req.user?.userId ?? null,
      outId,
    };
    const ins = await db.execute(
      `INSERT INTO RESTORE_TASK (RECORD_ID,INSTANCE_ID,RESTORE_TYPE,TARGET_TIME,TARGET_TABLE,FLASHBACK_SCN,STATUS,CREATED_BY)
       VALUES (:recordId,:instanceId,:restoreType,
         CASE WHEN :targetTime IS NOT NULL THEN TO_TIMESTAMP(:targetTime,'YYYY-MM-DD HH24:MI:SS') END,
         :targetTable,:flashbackScn,'PENDING',:createdBy)
       RETURNING RESTORE_ID INTO :outId`,
      binds
    );
    const restoreId = extractOracleOutBindNumber(ins, 'outId');
    if (restoreId == null) return res.json({ code: 500, msg: '恢复任务创建失败：未获取 RESTORE_ID' });
    await automationLog(req,'BACKUP',restoreId,'CREATE_RESTORE','SUCCESS',`${restoreType}`);
    res.json({code:200,msg:'恢复任务已创建',data:toPlainJson({restoreId})});
  }catch(e){res.json({code:500,msg:e.message});}
});
router.post('/backup/restores/:id/execute', adminDba, async (req,res) => {
  try{
    const out=await executeRestoreTask(req.params.id,{userId:req.user?.userId??null});
    await automationLog(req,'BACKUP',Number(req.params.id),'EXECUTE_RESTORE','SUCCESS',(out.detail||'').slice(0,450));
    res.json({code:200,msg:out.msg||'恢复成功',data:toPlainJson({detail:out.detail,execMode:out.execMode,durationSec:out.durationSec})});
  }catch(e){
    const code=e.code==='NOT_FOUND'?404:e.code==='BAD_REQUEST'?400:500;
    await automationLog(req,'BACKUP',Number(req.params.id),'EXECUTE_RESTORE','FAILED',(e.message||'').slice(0,450)).catch(()=>{});
    res.json({code,msg:e.message});
  }
});

// ── Python 环境诊断接口（帮助排查 exit=9009 等问题）────────────
router.get('/inspect/python-check', async (req, res) => {
  const reportsRoot = getInspectReportsRoot();
  const HEADLESS_PY = path.join(__dirname, '..', '..', 'scripts', 'db_inspection_headless.py');
  const TEMPLATES_DIR = path.join(__dirname, '..', 'templates', 'inspect');

  const pythonInfo = detectPython();
  const templateFiles = {};
  const templateList  = ['mysql','postgresql','oracle','goldendb','dameng'];
  for (const t of templateList) {
    const fp = path.join(TEMPLATES_DIR, `${t}_master_inspection.sql`);
    templateFiles[t] = fs.existsSync(fp) ? `✅ ${fp}` : `❌ 未找到: ${fp}`;
  }

  let reportsRootOk = false;
  try {
    fs.mkdirSync(reportsRoot, { recursive: true });
    reportsRootOk = true;
  } catch (_) {}

  const result = {
    python: pythonInfo
      ? { ok: true,  cmd: pythonInfo.cmd, args: pythonInfo.args, version: pythonInfo.version }
      : { ok: false, msg: '未找到 Python3。请安装 Python3.8+ 并设置 INSPECT_PYTHON 环境变量' },
    headlessScript:  fs.existsSync(HEADLESS_PY) ? `✅ ${HEADLESS_PY}` : `❌ 未找到: ${HEADLESS_PY}`,
    reportsRoot:     reportsRootOk ? `✅ ${reportsRoot}` : `❌ 无法创建: ${reportsRoot}`,
    templatesDir:    TEMPLATES_DIR,
    templateFiles,
    envVars: {
      INSPECT_PYTHON:           process.env.INSPECT_PYTHON     || '（未设置）',
      INSPECT_PYTHON_WORD:      process.env.INSPECT_PYTHON_WORD|| '（未设置，默认开启）',
      INSPECT_PYTHON_REPORTS_DIR: process.env.INSPECT_PYTHON_REPORTS_DIR || '（未设置，默认 backend/reports）',
    },
    helpOnExit9009: [
      '1. 确认已安装 Python3.8+：https://www.python.org/downloads/',
      '2. 安装依赖：pip install python-docx pymysql psycopg2-binary tqdm oracledb',
      '3. Windows 用户：设置环境变量 INSPECT_PYTHON=C:\\Python312\\python.exe',
      '4. Linux 用户：设置 INSPECT_PYTHON=/usr/bin/python3 或 export INSPECT_PYTHON=$(which python3)',
      '5. 重启 Node.js 服务使环境变量生效',
    ],
  };
  res.json({ code: 200, data: result });
});

module.exports = router;
