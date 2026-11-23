/**
 * inspectTaskRun.js  v3
 *
 * 巡检任务执行（手动 / 定时共用）。
 *
 * v3 相对 v2 的修复与改造：
 *  1. 【脚本真正决定报告】手工配置的脚本（INSPECT_SCRIPT）→ 解析为检查项 → 执行 → 发现项/评分 → Word。
 *     原实现里 Word 永远用 master 模板直连生成，脚本只影响一份没人看的 JSON；没配脚本时 5 份报告还写死 100 分 NORMAL。
 *  2. 没配脚本时，自动使用该库类型的 master 模板走同一条链路（Node 执行，不再依赖 Python）。
 *  3. 【实例隔离】一个实例连不上/出错不再中断整个任务；每个实例的成败都记录，任务只在“全部失败”时标 FAILED。
 *  4. 【总结 + 详细】每个实例一份 Word（总结页 + 分类详情 + 附录）；多实例任务另生成一份 Excel 批量汇总。
 *  5. 【模块联动】发现项写入 INSPECT_ISSUE（Java「巡检对比」读取这张表，之前从来没人写，对比永远为空）；
 *     结果同步到知识图谱（kgService）。
 *  6. 脚本 DB_TYPE 与实例不匹配：跳过该脚本并记入日志（原来直接抛错中断任务）。
 *  7. Python 五份 Word 变为可选（INSPECT_PYTHON_WORD=1），默认关闭。
 *
 * 报告记录：
 *   REPORT_TYPE='SUMMARY'  —— 每实例 1 行，payload 含全部检查项/发现项，Word 文件路径在 payload.inspectDocxFile
 *   REPORT_TYPE=HEALTH/RISK/PARAMETER/SPACE/HA —— 每个有检查项的分类 1 行（轻量，payload.parentReportId 指向 SUMMARY），
 *                                                 下载时按分类即时生成“分类版”Word
 */
'use strict';

const fs = require('fs');
const path = require('path');
const oracledb = require('oracledb');
const db = require('../config/db');
const {
  fetchCmdbInstance, connectOracle, connectMysql, connectPostgres, connectSqlServer, connectDameng, normalizeDbType,
} = require('../utils/monitorTargetConn');
const { executeInspectScript } = require('./inspectScriptExecutor');
const { runCheckV8Inspection } = require('./checkV8OracleInspect');
const { automationLog } = require('./automationExecLog');
const { runDbInspectionPythonWord, getInspectReportsRoot } = require('./inspectPythonDocxRunner');
const findingsEngine = require('./inspectFindings');
const { buildInspectWordBuffer } = require('./inspectWordReport');
const { buildBatchExcelBuffer } = require('./inspectBatchExcel');
const { CATEGORY_ORDER, CATEGORY_LABEL } = require('../utils/inspectScriptParser');

const runningInspectTasks = new Set();
const STORE_ROWS_PER_TABLE = Math.max(20, Number(process.env.INSPECT_STORE_ROWS_PER_TABLE) || 300);
const CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.INSPECT_CONCURRENCY) || 2));
const TEMPLATES_DIR = path.join(__dirname, '..', 'templates', 'inspect');
const TEMPLATE_FILE = {
  ORACLE: 'oracle_master_inspection.sql', MYSQL: 'mysql_master_inspection.sql', GOLDENDB: 'goldendb_master_inspection.sql',
  POSTGRESQL: 'postgresql_master_inspection.sql', PANWEI: 'postgresql_master_inspection.sql',
  DAMENG: 'dameng_master_inspection.sql', SQLSERVER: 'sqlserver_master_inspection.sql',
};

const p2 = (n) => String(n).padStart(2, '0');
const localStamp = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
const fileStamp = (d) => `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
const safeName = (s) => String(s || 'db').replace(/[^\w一-鿿.-]+/g, '_').slice(0, 60);

/** Oracle VARCHAR2 默认按字节计长，中文 3 字节：按字节截断，避免 ORA-12899 */
function byteTrunc(s, max) {
  const str = String(s ?? '');
  if (Buffer.byteLength(str, 'utf8') <= max) return str;
  let out = '';
  for (const ch of str) {
    if (Buffer.byteLength(out + ch, 'utf8') > max - 3) break;
    out += ch;
  }
  return `${out}…`;
}

function inspectLog(verboseConsole, session, ...args) {
  const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a, (k, v) => (typeof v === 'bigint' ? String(v) : v)))).join(' ');
  const ts = new Date().toISOString();
  if (verboseConsole) console.log(`[inspect-task] ${ts} ${line}`);
  if (session?.logs) session.logs.push(`${ts} ${line}`);
}

function attachInspectSession(err, session) {
  if (!session || !err) return;
  if (err.inspectLogs == null) err.inspectLogs = session.logs;
  if (err.inspectSqlErrors == null) err.inspectSqlErrors = session.sqlErrors;
  if (err.inspectReportIds == null) err.inspectReportIds = session.reportIds;
}

function safeJson(str) {
  try { return typeof str === 'string' ? JSON.parse(str) : str; } catch { return []; }
}

async function loadInspectScriptsByIds(ids) {
  if (!ids || !ids.length) return [];
  const nums = [...new Set(ids.map(Number).filter(Number.isFinite))];
  if (!nums.length) return [];
  const ph = nums.map((_, i) => `:${i + 1}`).join(',');
  const r = await db.execute(
    `SELECT SCRIPT_ID, SCRIPT_NAME, DB_TYPE, CATEGORY, SCRIPT_CONTENT, VERSION, NVL(ENABLED,1) AS EN
     FROM INSPECT_SCRIPT WHERE SCRIPT_ID IN (${ph})`,
    nums,
    { fetchInfo: { SCRIPT_CONTENT: { type: oracledb.STRING, maxSize: 52 * 1024 * 1024 } } }
  );
  return (r.rows || []).filter((row) => Number(row.EN) !== 0);
}

function loadMasterTemplate(dbType) {
  const f = TEMPLATE_FILE[dbType];
  if (!f) return null;
  const p = path.join(TEMPLATES_DIR, f);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

async function connectByType(dbType, inst) {
  if (dbType === 'ORACLE') return { conn: await connectOracle(inst), close: (c) => c.close() };
  if (dbType === 'MYSQL' || dbType === 'GOLDENDB') return { conn: await connectMysql(inst), close: (c) => c.end() };
  if (dbType === 'POSTGRESQL' || dbType === 'PANWEI') return { conn: await connectPostgres(inst), close: (c) => c.end() };
  if (dbType === 'SQLSERVER') return { conn: await connectSqlServer(inst), close: (c) => c.close() };
  if (dbType === 'DAMENG') return { conn: await connectDameng(inst), close: (c) => c.close() };
  throw new Error(`脚本巡检不支持数据库类型: ${dbType}`);
}

async function fetchTopWaitsOracle(conn) {
  try {
    const r = await conn.execute(
      `SELECT * FROM (SELECT event, total_waits AS waits, ROUND(time_waited/100,2) AS time_sec
         FROM v$system_event WHERE NVL(wait_class,'x') != 'Idle' ORDER BY time_waited DESC) WHERE ROWNUM <= 5`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT });
    return (r.rows || []).map((row) => ({ event: row.EVENT, waits: row.WAITS, time_sec: row.TIME_SEC }));
  } catch { return []; }
}

/** 存库用：每张表最多保留 STORE_ROWS_PER_TABLE 行，Word 在执行时已用完整数据生成 */
function slimSections(sections) {
  return sections.map((s) => ({
    ...s,
    tables: (s.tables || []).map((t) => (t.rows.length > STORE_ROWS_PER_TABLE
      ? { ...t, rows: t.rows.slice(0, STORE_ROWS_PER_TABLE), truncated: true, rowCount: t.rowCount ?? t.rows.length }
      : t)),
  }));
}

/** 按分类拆分：返回该分类的 sections + findings */
function scopeByCategory(payload, cat) {
  return {
    ...payload,
    categoryFilter: cat,
    sections: (payload.sections || []).filter((s) => (s.category || 'OTHER') === cat),
    findings: (payload.findings || []).filter((f) => (f.category || 'OTHER') === cat),
    collectErrors: (payload.collectErrors || []).filter((e) => (payload.sections || []).some((s) => (s.category || 'OTHER') === cat && s.title === e.section)),
  };
}

async function insertReport(row) {
  const r = await db.execute(
    `INSERT INTO INSPECT_REPORT (TASK_ID,INSTANCE_ID,DB_TYPE,REPORT_TYPE,OVERALL_SCORE,OVERALL_STATUS,SUMMARY,PAYLOAD,CREATED_BY)
     VALUES (:taskId,:instanceId,:dbType,:reportType,:score,:status,:summary,:payload,:userId)
     RETURNING REPORT_ID INTO :rid`,
    {
      taskId: row.taskId, instanceId: row.instanceId, dbType: row.dbType, reportType: row.reportType, score: row.score, status: row.status,
      summary: byteTrunc(row.summary, 3900), payload: JSON.stringify(row.payload), userId: row.userId,
      rid: { type: oracledb.NUMBER, dir: oracledb.BIND_OUT },
    });
  const id = r?.outBinds?.rid?.[0];
  return id != null ? Number(id) : null;
}

/** 发现项 → INSPECT_ISSUE（Java「巡检对比」依赖；写入失败不影响巡检结果） */
async function insertIssues(reportId, instanceId, findings) {
  if (reportId == null || !findings.length) return;
  for (const f of findings) {
    try {
      await db.execute(
        `INSERT INTO INSPECT_ISSUE (REPORT_ID,INSTANCE_ID,CATEGORY,SEVERITY,TITLE,DESCRIPTION,ADVICE,METRIC_KEY,METRIC_VALUE,THRESHOLD)
         VALUES (:1,:2,:3,:4,:5,:6,:7,:8,:9,:10)`,
        [reportId, instanceId, byteTrunc(f.category || 'OTHER', 60), f.level,
          byteTrunc(`${f.section ? f.section + '：' : ''}${f.title}`, 250),
          byteTrunc(`${f.detail || ''}${f.samples?.length ? '；' + f.samples.join(' | ') : ''}`, 3900), byteTrunc(f.advice || '', 3900),
          byteTrunc(f.key, 120), byteTrunc(String(f.count), 250), byteTrunc(f.detail || '', 250)]);
    } catch (e) {
      console.warn('[inspect-task] INSPECT_ISSUE 写入失败（请确认已执行建库脚本）:', e.message);
      return;
    }
  }
}

/**
 * 单实例巡检：连接 → 执行脚本 → 分析 → Word → 入库。失败抛出，由调用方记入结果。
 */
async function inspectOneInstance(ctx, instId) {
  const { task, scripts, uid, runDir, taskId, verboseLog, session, inspectMoment } = ctx;
  const t0 = Date.now();
  const inst = await fetchCmdbInstance(instId);
  const dbType = normalizeDbType(inst);
  const instLabel = `${inst.INSTANCE_NAME}(${inst.INSTANCE_ID})`;
  const host = `${inst.HOST_IP}:${inst.PORT || ''}`;
  inspectLog(verboseLog, session, `实例 ${instLabel} type=${dbType}`);

  if (task.DB_TYPE && String(task.DB_TYPE).toUpperCase() !== dbType) {
    throw new Error(`任务限定 DB 类型 ${task.DB_TYPE}，实例类型为 ${dbType}`);
  }

  // 1) 选脚本：与实例类型匹配的启用脚本；没有则使用 master 模板
  const matched = scripts.filter((s) => String(s.DB_TYPE || '').toUpperCase() === dbType
    || (dbType === 'PANWEI' && String(s.DB_TYPE || '').toUpperCase() === 'POSTGRESQL'));
  const skipped = scripts.filter((s) => !matched.includes(s));
  for (const s of skipped) inspectLog(verboseLog, session, `  跳过脚本「${s.SCRIPT_NAME}」：DB_TYPE=${s.DB_TYPE} 与实例 ${dbType} 不匹配`);
  let toRun = matched.map((s) => ({ name: s.SCRIPT_NAME, dbType: s.DB_TYPE, category: String(s.CATEGORY || 'HEALTH').toUpperCase(), version: s.VERSION, text: String(s.SCRIPT_CONTENT || '') }));
  let scriptNote = '';
  if (!toRun.length) {
    const tpl = loadMasterTemplate(dbType);
    if (!tpl) throw new Error(`没有可用的 ${dbType} 巡检脚本，且未找到 master 模板`);
    toRun = [{ name: `${dbType} master 巡检模板`, dbType, category: 'HEALTH', version: 'builtin', text: tpl }];
    scriptNote = scripts.length ? '任务配置的脚本与该实例类型不匹配，已改用平台内置 master 巡检模板。' : '任务未配置脚本，使用平台内置 master 巡检模板。';
  }

  // 2) 连接并执行
  const { conn, close } = await connectByType(dbType, inst);
  let sections = [];
  const errors = [];
  const rules = [];
  let enrichment = null;
  try {
    for (const sc of toRun) {
      inspectLog(verboseLog, session, `  执行脚本「${sc.name}」`);
      const out = await executeInspectScript(dbType, conn, sc.text, { defaultCategory: sc.category });
      sections.push(...out.sections);
      errors.push(...out.errors);
      rules.push(...out.rules);
    }
    if (dbType === 'ORACLE') {
      try {
        const base = await runCheckV8Inspection(conn);
        enrichment = { ...base, wait_events: await fetchTopWaitsOracle(conn) };
      } catch (e) { inspectLog(verboseLog, session, `  Oracle enrichment 失败（忽略）: ${e.message}`); }
    }
  } finally {
    await Promise.resolve(close(conn)).catch(() => {});
  }
  sections = sections.map((s, i) => ({ ...s, no: i + 1 }));   // 多脚本合并后统一编号

  // 3) 分析 + 评分
  const { findings, collectErrors } = findingsEngine.analyze(sections, rules, errors);
  let sc = findingsEngine.score(findings, collectErrors, sections.length);
  if (enrichment?.overallScore != null && Number(enrichment.overallScore) < sc.score) {
    sc = { ...sc, score: Math.round(Number(enrichment.overallScore)) };      // CheckV8 评分更低时取更低者
    if (sc.score < 70) sc.status = 'CRITICAL'; else if (sc.score < 85 && sc.status === 'NORMAL') sc.status = 'WARNING';
  }
  const okSections = sections.filter((s) => !(s.errors || []).length).length;
  const conclusion = findingsEngine.conclusion(sc, sections.length, okSections);
  for (const e of collectErrors) {
    session?.sqlErrors?.push({ instanceId: inst.INSTANCE_ID, instanceName: inst.INSTANCE_NAME, section: e.section, error: e.error, sqlPreview: (e.sql || '').slice(0, 300) });
  }

  const payload = {
    engine: 'inspect-task-v3', dbType, taskId, taskName: task.TASK_NAME,
    instanceId: inst.INSTANCE_ID, instanceName: inst.INSTANCE_NAME, host,
    checkedAt: inspectMoment.toISOString(), checkedAtLocal: localStamp(inspectMoment),
    inspectorName: uid != null ? `用户#${uid}` : 'AUTOMATION',
    scripts: toRun.map((s) => ({ name: s.name, dbType: s.dbType, category: s.category, version: s.version })), scriptNote,
    overallScore: sc.score, overallStatus: sc.status, conclusion, unreliable: sc.unreliable,
    counts: { critical: sc.critical, warning: sc.warning, info: sc.info, collectErrors: sc.collectErrors },
    findings, collectErrors, sections,        // 完整数据（仅用于生成 Word，入库前瘦身）
    oracleEnrichment: enrichment || undefined,
  };

  // 4) Word（总结 + 详细）
  let wordFile = null;
  let wordError = null;
  try {
    const buf = await buildInspectWordBuffer(payload);
    fs.mkdirSync(runDir, { recursive: true });
    wordFile = path.join(runDir, `${safeName(inst.INSTANCE_NAME)}_${inst.INSTANCE_ID}_${fileStamp(inspectMoment)}.docx`);
    fs.writeFileSync(wordFile, buf);
    inspectLog(verboseLog, session, `  Word 已生成 ${path.basename(wordFile)}`);
  } catch (e) {
    wordError = e.message || String(e);
    inspectLog(verboseLog, session, `  Word 生成失败: ${wordError}`);
  }

  // 5) 入库：SUMMARY + 分类行
  const stored = { ...payload, sections: slimSections(sections), inspectDocxFile: wordFile || undefined, inspectDocxEngine: wordFile ? 'node-docx' : undefined, wordError: wordError || undefined };
  const summaryId = await insertReport({
    taskId, instanceId: inst.INSTANCE_ID, dbType, reportType: 'SUMMARY', score: sc.score, status: sc.status, summary: conclusion, payload: stored, userId: uid,
  });
  const reportIds = [];
  if (summaryId != null) { reportIds.push(summaryId); session?.reportIds?.push(summaryId); }
  await insertIssues(summaryId, inst.INSTANCE_ID, findings);

  const legacy = process.env.INSPECT_PYTHON_WORD === '1'
    ? await runDbInspectionPythonWord({
      dbType, instRow: inst, mergedSqlText: toRun.map((s) => s.text).join('\n'), taskId,
      inspectTimeStr: localStamp(inspectMoment), fileTimestamp: fileStamp(inspectMoment),
    }).catch((e) => ({ ok: false, error: e.message }))
    : null;

  for (const cat of CATEGORY_ORDER) {
    const secs = sections.filter((s) => (s.category || 'OTHER') === cat);
    if (!secs.length) continue;
    const fs_ = findings.filter((f) => (f.category || 'OTHER') === cat);
    const cr = fs_.filter((f) => f.level === 'CRITICAL').length;
    const wa = fs_.filter((f) => f.level === 'WARNING').length;
    const failed = secs.filter((s) => (s.errors || []).length).length;
    const catScore = Math.max(0, 100 - Math.min(60, cr * 10) - Math.min(30, wa * 3) - Math.min(5, fs_.length - cr - wa) - Math.min(10, failed * 2));
    const catStatus = cr || catScore < 70 ? 'CRITICAL' : wa || failed || catScore < 85 ? 'WARNING' : 'NORMAL';
    const catPayload = {
      engine: 'inspect-task-v3', dbType, taskId, instanceId: inst.INSTANCE_ID, instanceName: inst.INSTANCE_NAME, reportType: cat,
      parentReportId: summaryId, checkedAt: payload.checkedAt, checkedAtLocal: payload.checkedAtLocal,
      overallScore: catScore, overallStatus: catStatus, findings: fs_, counts: { critical: cr, warning: wa, info: fs_.length - cr - wa, collectErrors: failed },
      sectionTitles: secs.map((s) => s.title),
      inspectDocxFile: legacy?.ok ? legacy.files?.[cat] : undefined, inspectDocxEngine: legacy?.ok ? 'db_inspection_py' : undefined,
    };
    const id = await insertReport({
      taskId, instanceId: inst.INSTANCE_ID, dbType, reportType: cat, score: catScore, status: catStatus,
      summary: `${CATEGORY_LABEL[cat]}：${secs.length} 个检查项，严重 ${cr}、警告 ${wa}${failed ? `、${failed} 项执行失败` : ''}，评分 ${catScore}`, payload: catPayload, userId: uid,
    });
    if (id != null) { reportIds.push(id); session?.reportIds?.push(id); }
    await insertIssues(id, inst.INSTANCE_ID, fs_);
  }

  // 6) 知识图谱（失败不影响巡检）
  try {
    await require('./kgService').recordInspection({
      taskId, reportId: summaryId, instance: { id: inst.INSTANCE_ID, name: inst.INSTANCE_NAME, dbType, host },
      score: sc.score, status: sc.status, findings,
    });
  } catch (e) { inspectLog(verboseLog, session, `  知识图谱写入失败（忽略）: ${e.message}`); }

  return {
    instanceId: inst.INSTANCE_ID, instanceName: inst.INSTANCE_NAME, dbType, host, ok: true,
    score: sc.score, status: sc.status, counts: payload.counts, findings, sections: sections.map((s) => ({ no: s.no, title: s.title, category: s.category, errors: s.errors })),
    wordFile, wordError, reportIds, conclusion, durationSec: Math.round((Date.now() - t0) / 100) / 10,
  };
}

/** 简易并发池 */
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * 执行巡检任务。
 * @returns {{reports:number, instances:number, okInstances:number, failedInstances:number, results:Array, excelFile?:string, runDir:string, logs, sqlErrors, reportIds}}
 */
async function runInspectTaskById(req, taskId, options = {}) {
  const verboseLog = !!options.verboseLog;
  const session = options.collectLogs ? { logs: [], sqlErrors: [], reportIds: [] } : null;

  taskId = Number(taskId);
  if (runningInspectTasks.has(taskId)) {
    const busy = Object.assign(new Error('任务正在执行中，请稍后再试'), { code: 'BUSY' });
    attachInspectSession(busy, session);
    throw busy;
  }
  // 检查与占用之间不能有 await
  runningInspectTasks.add(taskId);
  let claimed = false;
  let task; let instanceIds; let scripts;
  try {
    const tr = await db.execute(`SELECT * FROM INSPECT_TASK WHERE TASK_ID=:1`, [taskId]);
    if (!tr.rows.length) throw Object.assign(new Error('任务不存在'), { code: 'NOT_FOUND' });
    task = tr.rows[0];
    instanceIds = [...new Set((safeJson(task.INSTANCE_IDS) || []).map(Number).filter(Number.isFinite))];
    const scriptIds = safeJson(task.SCRIPT_IDS) || [];
    if (!instanceIds.length) throw Object.assign(new Error('任务未配置目标实例'), { code: 'BAD_TASK' });
    scripts = scriptIds.length ? await loadInspectScriptsByIds(scriptIds) : [];
    if (scriptIds.length && !scripts.length) {
      throw Object.assign(new Error('任务配置的巡检脚本均已删除或停用，请重新选择脚本（或清空脚本以使用内置模板）'), { code: 'BAD_SCRIPTS' });
    }
    const claim = await db.execute(
      `UPDATE INSPECT_TASK SET STATUS='RUNNING', LAST_RUN_AT=SYSTIMESTAMP
        WHERE TASK_ID=:1 AND (STATUS IS NULL OR STATUS<>'RUNNING' OR LAST_RUN_AT IS NULL OR LAST_RUN_AT < SYSTIMESTAMP - INTERVAL '2' HOUR)`,
      [taskId]);
    if (!claim.rowsAffected) throw Object.assign(new Error('任务正在执行中（其他节点或定时任务），请稍后再试'), { code: 'BUSY' });
    claimed = true;
  } catch (e) {
    if (!claimed) runningInspectTasks.delete(taskId);
    attachInspectSession(e, session);
    throw e;
  }

  try {
    const startedAt = new Date();
    const runDir = path.join(getInspectReportsRoot(), 'inspect', String(taskId), fileStamp(startedAt));
    const uid = req.user?.userId ?? null;
    inspectLog(verboseLog, session, `开始 taskId=${taskId} name=${task.TASK_NAME} instances=[${instanceIds.join(',')}] scripts=${scripts.map((s) => s.SCRIPT_NAME).join('|') || '内置模板'}`);

    const ctx = { task, scripts, uid, runDir, taskId, verboseLog, session, inspectMoment: startedAt };
    const results = await pool(instanceIds, CONCURRENCY, async (instId) => {
      try {
        return await inspectOneInstance(ctx, instId);
      } catch (e) {
        inspectLog(verboseLog, session, `实例 ${instId} 巡检失败: ${e.message || e}`);
        let name = `#${instId}`; let dbType = ''; let host = '';
        try { const i = await fetchCmdbInstance(instId); name = i.INSTANCE_NAME; dbType = i.DB_TYPE; host = `${i.HOST_IP}:${i.PORT || ''}`; } catch { /* 实例已删除 */ }
        return { instanceId: instId, instanceName: name, dbType, host, ok: false, error: String(e.message || e).slice(0, 800) };
      }
    });

    const ok = results.filter((r) => r.ok);
    const failed = results.filter((r) => !r.ok);
    const finishedAt = new Date();

    // 多实例：批量 Excel 汇总；同时写 latest.json 清单供下载
    let excelFile = null;
    let excelError = null;
    try {
      if (instanceIds.length > 1 || options.forceExcel) {
        const buf = await buildBatchExcelBuffer({
          taskName: task.TASK_NAME, taskId, startedAt: localStamp(startedAt), finishedAt: localStamp(finishedAt), results,
        });
        fs.mkdirSync(runDir, { recursive: true });
        excelFile = path.join(runDir, `批量巡检汇总_${safeName(task.TASK_NAME)}_${fileStamp(startedAt)}.xlsx`);
        fs.writeFileSync(excelFile, buf);
        inspectLog(verboseLog, session, `批量 Excel 已生成 ${path.basename(excelFile)}`);
      }
    } catch (e) { excelError = e.message || String(e); inspectLog(verboseLog, session, `批量 Excel 生成失败: ${excelError}`); }

    try {
      fs.mkdirSync(path.dirname(runDir), { recursive: true });
      fs.writeFileSync(path.join(path.dirname(runDir), 'latest.json'), JSON.stringify({
        taskId, taskName: task.TASK_NAME, startedAt: localStamp(startedAt), finishedAt: localStamp(finishedAt), excelFile, excelError,
        instances: results.map((r) => ({ instanceId: r.instanceId, instanceName: r.instanceName, ok: r.ok, score: r.score, status: r.status, wordFile: r.wordFile, error: r.error })),
      }, null, 1));
    } catch { /* 清单写失败不影响结果 */ }

    const finalStatus = ok.length ? 'DONE' : 'FAILED';
    await db.execute(`UPDATE INSPECT_TASK SET STATUS=:1 WHERE TASK_ID=:2`, [finalStatus, taskId]);
    await automationLog(req, 'INSPECT', taskId, 'RUN_TASK', ok.length ? 'SUCCESS' : 'FAILED',
      `ok=${ok.length} failed=${failed.length}${failed.length ? ' ' + failed.map((f) => `${f.instanceName}:${f.error}`).join('; ').slice(0, 300) : ''}`);
    inspectLog(verboseLog, session, `完成 taskId=${taskId} ok=${ok.length} failed=${failed.length}`);

    if (!ok.length) {
      const e = Object.assign(new Error(`全部 ${failed.length} 个实例巡检失败：${failed.map((f) => `${f.instanceName}（${f.error}）`).join('；').slice(0, 600)}`), { code: 'ALL_FAILED' });
      attachInspectSession(e, session);
      throw e;
    }
    return {
      reports: ok.reduce((a, r) => a + (r.reportIds?.length || 0), 0),
      instances: instanceIds.length, okInstances: ok.length, failedInstances: failed.length,
      results: results.map((r) => ({ instanceId: r.instanceId, instanceName: r.instanceName, ok: r.ok, score: r.score, status: r.status, error: r.error, wordError: r.wordError, durationSec: r.durationSec })),
      excelFile, excelError, runDir,
      logs: session?.logs ?? [], sqlErrors: session?.sqlErrors ?? [], reportIds: session?.reportIds ?? [],
    };
  } catch (e) {
    if (e.code !== 'ALL_FAILED') {
      await db.execute(`UPDATE INSPECT_TASK SET STATUS='FAILED' WHERE TASK_ID=:1`, [taskId]).catch(() => {});
      await automationLog(req, 'INSPECT', taskId, 'RUN_TASK', 'FAILED', (e.message || String(e)).slice(0, 450)).catch(() => {});
    }
    attachInspectSession(e, session);
    throw e;
  } finally {
    runningInspectTasks.delete(taskId);
  }
}

module.exports = { runInspectTaskById, loadInspectScriptsByIds, scopeByCategory, byteTrunc };
