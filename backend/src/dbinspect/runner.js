'use strict';
/**
 * 巡检运行编排：一次触发（定时 / 手动 / 告警联动 / 复检）= 一条 DBI_RUN，按实例拆子任务并发执行。
 *
 *   连接失败 / 整体异常 → 该实例记“巡检失败”（FAIL_INST），不计入异常、不改动已有问题项；
 *   单个检查项采集失败（权限 / 视图不存在）→ 该项记“采集失败”（ITEMS_ERR），同样不算数据库问题，也不会把它名下的问题项误判为已整改；
 *   采集成功的检查项 → 规则引擎判定 → 写 / 更新问题项；本次不再出现的旧问题自动置“已整改”。
 */
const oracledb = require('oracledb');
const db = require('../config/db');
const store = require('./store');
const { collect, prepare } = require('./collector');
const { judge, resolveThreshold, scoreOf, num, objectOf } = require('./judge');
const { familyOf } = require('./dialect');
const {
  connectOracle, connectMysql, connectPostgres, connectDameng,
} = require('../utils/monitorTargetConn');
const { ymd } = require('../utils/platformClock');

const CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.DBINSPECT_CONCURRENCY) || 3));
const TOPN = Math.max(3, Math.min(50, Number(process.env.DBINSPECT_TOPN) || 10));
const SQL_DAYS = Math.max(1, Math.min(30, Number(process.env.DBINSPECT_SQL_DAYS) || 1));
const SNAP_ROWS_PER_ITEM = 30;
const EVIDENCE_ROWS = 30;
const { fit } = store;

const runningPlans = new Set();

async function loadInstance(id) {
  const r = await db.execute(
    `SELECT INSTANCE_ID, INSTANCE_NAME, DB_TYPE, HOST_IP, PORT, SID, SERVICE_NAME, DB_USER, DB_PASSWORD, ENVIRONMENT, BIZ_LINE, STATUS
       FROM CMDB_INSTANCE WHERE INSTANCE_ID=:1`, [id]);
  return r.rows[0] || null;
}

async function connectFor(inst) {
  const fam = familyOf(inst.DB_TYPE);
  if (fam === 'ORACLE') return { conn: await connectOracle(inst), close: (c) => c.close() };
  if (fam === 'MYSQL') return { conn: await connectMysql(inst), close: (c) => c.end() };
  if (fam === 'POSTGRESQL') return { conn: await connectPostgres(inst), close: (c) => c.end() };
  if (fam === 'DAMENG') return { conn: await connectDameng(inst), close: (c) => c.close() };
  throw new Error(`数据库巡检暂不支持类型 ${inst.DB_TYPE}`);
}

function pickImpl(item, family, dbType) {
  const im = item.implByFamily[family];
  if (!im) return null;
  if (im.dbTypes && im.dbTypes.length && !im.dbTypes.map((x) => String(x).toUpperCase()).includes(String(dbType).toUpperCase())) return null;
  return im;
}

const slimVal = (k, v) => {
  if (v == null) return v;
  const lim = k === 'SQL_TEXT' ? 400 : 160;
  const s = typeof v === 'string' ? v : (typeof v === 'object' ? JSON.stringify(v) : v);
  return typeof s === 'string' && s.length > lim ? `${s.slice(0, lim)}…` : s;
};
function evidenceOf(columns, rows) {
  return JSON.stringify({
    columns: columns.slice(0, 20),
    rows: rows.slice(0, EVIDENCE_ROWS).map((r) => Object.fromEntries(columns.slice(0, 20).map((c) => [c, slimVal(c, r[c])]))),
    total: rows.length,
  });
}

async function insertResult(runId, inst, item, r) {
  await db.execute(
    `INSERT INTO DBI_RUN_RESULT (RUN_ID,INSTANCE_ID,ITEM_ID,ITEM_CODE,ITEM_NAME,CATEGORY,STATUS,WORST_VALUE,THRESHOLD_TEXT,ROW_COUNT,MESSAGE,EVIDENCE,DURATION_MS)
     VALUES (:1,:2,:3,:4,:5,:6,:7,:8,:9,:10,:11,:12,:13)`,
    [runId, inst.INSTANCE_ID, item.ITEM_ID, item.ITEM_CODE, fit(item.ITEM_NAME, 128), item.CATEGORY, r.status, fit(r.worst, 120), fit(r.thr, 120),
      r.rowCount ?? null, fit(r.message, 900), r.evidence || null, r.ms ?? null]);
}

async function insertSnapshots(runId, inst, family, item, columns, rows, findings) {
  const sevBy = new Map(findings.map((f) => [f.objectKey, f.level]));
  let rank = 0;
  for (const row of rows.slice(0, SNAP_ROWS_PER_ITEM)) {
    if (!row.SQL_ID) continue;
    rank++;
    const sev = sevBy.get(objectOf(row, item)) || (item.rule.type === 'TOPN' ? null : 'OK');
    await db.execute(
      `INSERT INTO DBI_SQL_SNAPSHOT (RUN_ID,INSTANCE_ID,DB_TYPE,DB_FAMILY,ITEM_CODE,DIMENSION,RANK_NO,SQL_ID,SQL_ID_KIND,PLAN_HASH,SCHEMA_NAME,EXECS,TOTAL_MS,AVG_MS,CPU_MS,
         LOGICAL_READS,PHYSICAL_READS,ROWS_PROC,ROWS_EXAMINED,METRIC_VALUE,SEVERITY,LAST_ACTIVE,SQL_TEXT,EXTRA)
       VALUES (:1,:2,:3,:4,:5,:6,:7,:8,:9,:10,:11,:12,:13,:14,:15,:16,:17,:18,:19,:20,:21,:22,:23,:24)`,
      [runId, inst.INSTANCE_ID, inst.DB_TYPE, family, item.ITEM_CODE, item.dimension || null, rank, fit(row.SQL_ID, 120), row.SQL_ID_KIND || null,
        fit(row.PLAN_HASH, 60), fit(row.SCHEMA_NAME, 120), num(row.EXECS), num(row.TOTAL_MS), num(row.AVG_MS), num(row.CPU_MS), num(row.LOGICAL_READS),
        num(row.PHYSICAL_READS), num(row.ROWS_PROC), num(row.ROWS_EXAMINED), num(row.VAL), sev, fit(row.LAST_ACTIVE, 30), fit(row.SQL_TEXT, 1900),
        JSON.stringify(Object.fromEntries(['OBJ', 'USERNAME', 'EVENT', 'MACHINE', 'PROGRAM', 'BLOCKER_SID', 'BLOCKER_SQL_ID', 'TABLE_NAME', 'PLAN_COUNT', 'MIN_AVG_MS', 'MAX_AVG_MS', 'FMS', 'NO_INDEX_EXECS']
          .filter((k) => row[k] != null).map((k) => [k, row[k]]))).slice(0, 3000)]);
  }
}

/** 单实例巡检 */
async function inspectInstance(ctx, instRow) {
  const { runId, items, onlyOneItem } = ctx;
  const t0 = Date.now();
  const family = familyOf(instRow.DB_TYPE);
  const inst = instRow;
  const stat = { crit: 0, warn: 0, ok: 0, err: 0, na: 0, total: 0, fixed: 0 };
  let conn; let closer;
  try {
    const c = await connectFor(inst);
    conn = c.conn; closer = c.close;
  } catch (e) {
    const msg = String(e.message || e).replace(/\s+/g, ' ').slice(0, 900);
    await db.execute(`UPDATE DBI_RUN_INSTANCE SET EXEC_STATUS='FAILED', ERROR_MSG=:1, DURATION_MS=:2 WHERE RUN_ID=:3 AND INSTANCE_ID=:4`,
      [fit(`连接失败：${msg}`, 900), Date.now() - t0, runId, inst.INSTANCE_ID]);
    return { ok: false, crit: 0, warn: 0 };
  }

  const checked = new Map();           // 本次成功采集且结果完整的检查项 → 现存问题对象集合（用于自动整改）
  let lost = null;
  try {
    await prepare(family, conn);
    for (const item of items) {
      stat.total++;
      const t1 = Date.now();
      const impl = pickImpl(item, family, inst.DB_TYPE);
      if (!impl) {
        stat.na++;
        await insertResult(runId, inst, item, { status: 'NA', message: `${inst.DB_TYPE} 暂无该检查项的采集实现` });
        continue;
      }
      const thr = resolveThreshold(
        { WARN_VALUE: item.WARN_VALUE, CRIT_VALUE: item.CRIT_VALUE }, { WARN_VALUE: impl.warn, CRIT_VALUE: impl.crit }, item.overrides,
        { dbType: String(inst.DB_TYPE).toUpperCase(), family, env: inst.ENVIRONMENT, bizLine: inst.BIZ_LINE, instanceId: inst.INSTANCE_ID });
      if (!thr.enabled) {
        stat.na++;
        await insertResult(runId, inst, item, { status: 'NA', message: '已在「阈值与范围」中对该范围关闭此检查项' });
        continue;
      }
      if (lost) {
        stat.err++;
        await insertResult(runId, inst, item, { status: 'ERROR', message: `连接已中断，未执行：${lost}` });
        continue;
      }
      let got;
      try {
        got = await collect({ conn, family, dbType: inst.DB_TYPE, item, impl, params: { topn: TOPN, days: SQL_DAYS, minExecs: item.rule.minExecs || 3 } });
      } catch (e) {
        stat.err++;
        if (e.lost) lost = e.message;
        await insertResult(runId, inst, item, { status: 'ERROR', message: `采集失败：${e.message}`, ms: Date.now() - t1 });
        continue;
      }
      const unit = impl.unit || item.rule.unit || '';
      const j = judge(item, got.rows, thr, unit);
      stat.ok += j.status === 'OK' || j.status === 'INFO' ? 1 : 0;

      // 问题项
      const seen = new Set();
      let counted = { crit: 0, warn: 0 };
      for (const f of j.findings) {
        let up;
        try { up = await store.upsertIssue(runId, inst, item, f); } catch (e) { console.warn('[db-inspect] 问题项写入失败:', e.message); continue; }
        seen.add(f.objectKey);
        if (up.status === 'IGNORED') continue;               // 已忽略的问题不再计入本次异常
        if (f.level === 'CRITICAL') counted.crit++; else counted.warn++;
      }
      if (!j.truncated) checked.set(item.ITEM_CODE, seen);   // 结果被截断时无法确认“不再出现”，不自动整改
      stat.crit += counted.crit; stat.warn += counted.warn;
      const status = counted.crit ? 'CRITICAL' : counted.warn ? 'WARNING' : (j.status === 'CRITICAL' || j.status === 'WARNING' ? 'OK' : j.status);
      await insertResult(runId, inst, item, {
        status, worst: j.worstValue, thr: j.thresholdText, rowCount: got.rows.length, ms: Date.now() - t1,
        message: counted.crit || counted.warn ? j.message : (j.findings.length ? '异常项均已被忽略' : j.message),
        evidence: evidenceOf(got.columns, got.rows),
      });
      if (item.SQL_BEARING) {
        try { await insertSnapshots(runId, inst, family, item, got.columns, got.rows, j.findings); } catch (e) { console.warn('[db-inspect] SQL 快照写入失败:', e.message); }
      }
    }
  } finally {
    try { await Promise.resolve(closer(conn)); } catch { /* ignore */ }
  }
  try { stat.fixed = await store.autoFixIssues(runId, inst.INSTANCE_ID, checked); } catch (e) { console.warn('[db-inspect] 自动整改判定失败:', e.message); }
  await db.execute(
    `UPDATE DBI_RUN_INSTANCE SET EXEC_STATUS='OK', ITEMS_TOTAL=:1, ITEMS_OK=:2, ITEMS_ERR=:3, ITEMS_NA=:4, CRIT_CNT=:5, WARN_CNT=:6, SCORE=:7, DURATION_MS=:8,
            ERROR_MSG=:9 WHERE RUN_ID=:10 AND INSTANCE_ID=:11`,
    [stat.total, stat.ok, stat.err, stat.na, stat.crit, stat.warn, scoreOf(stat.crit, stat.warn), Date.now() - t0,
      lost ? fit(`连接中途中断：${lost}`, 900) : null, runId, inst.INSTANCE_ID]);
  return { ok: true, crit: stat.crit, warn: stat.warn };
}

async function pool(list, limit, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (next < list.length) { const i = next++; await fn(list[i], i); }
  }));
}

async function executeRun(runId, items, instances) {
  const ctx = { runId, items };
  let ok = 0; let fail = 0; let crit = 0; let warn = 0;
  await pool(instances, CONCURRENCY, async (inst) => {
    let r;
    try { r = await inspectInstance(ctx, inst); } catch (e) {
      console.error('[db-inspect] 实例巡检异常', inst.INSTANCE_ID, e);
      await db.execute(`UPDATE DBI_RUN_INSTANCE SET EXEC_STATUS='FAILED', ERROR_MSG=:1 WHERE RUN_ID=:2 AND INSTANCE_ID=:3`,
        [fit(`巡检异常：${e.message}`, 900), runId, inst.INSTANCE_ID]).catch(() => {});
      r = { ok: false, crit: 0, warn: 0 };
    }
    if (r.ok) ok++; else fail++;
    crit += r.crit; warn += r.warn;
    await db.execute('UPDATE DBI_RUN SET DONE_INST=DONE_INST+1, OK_INST=:1, FAIL_INST=:2, CRIT_CNT=:3, WARN_CNT=:4 WHERE RUN_ID=:5', [ok, fail, crit, warn, runId]).catch(() => {});
  });
  const status = ok === 0 ? 'FAILED' : fail > 0 ? 'PARTIAL' : 'SUCCESS';
  await db.execute(`UPDATE DBI_RUN SET STATUS=:1, FINISHED_AT=SYSTIMESTAMP, OK_INST=:2, FAIL_INST=:3, CRIT_CNT=:4, WARN_CNT=:5, DONE_INST=TOTAL_INST WHERE RUN_ID=:6`,
    [status, ok, fail, crit, warn, runId]);
  await createReport(runId).catch((e) => console.warn('[db-inspect] 报告记录写入失败:', e.message));
  return { status, ok, fail, crit, warn };
}

async function createReport(runId) {
  const r = (await db.execute('SELECT * FROM DBI_RUN WHERE RUN_ID=:1', [runId])).rows[0];
  if (!r) return;
  const abn = (await db.execute(`SELECT COUNT(*) AS N FROM DBI_RUN_INSTANCE WHERE RUN_ID=:1 AND EXEC_STATUS='OK' AND (CRIT_CNT>0 OR WARN_CNT>0)`, [runId])).rows[0].N;
  const open = (await db.execute(`SELECT COUNT(*) AS N FROM DBI_ISSUE WHERE LAST_RUN_ID=:1 AND STATUS IN ('OPEN','FIXING')`, [runId])).rows[0].N;
  const name = `${r.ONLY_ITEM_CODE ? '复检' : '数据库巡检'}报告（${ymd()}）${r.TEMPLATE_NAME ? ` · ${r.TEMPLATE_NAME}` : ''}`;
  // 同一名字在 MERGE 的 UPDATE / INSERT 里各出现一次。数组绑定按出现次数计数，
  // 会报 NJS-098（17 个占位符、9 个值），报告行写不进去，巡检报告页就是空的。按名字绑定可复用。
  await db.execute(
    `MERGE INTO DBI_REPORT t USING (SELECT :runId AS RID FROM DUAL) s ON (t.RUN_ID = s.RID)
     WHEN MATCHED THEN UPDATE SET REPORT_NAME=:reportName, INSTANCE_COUNT=:instanceCount, ABNORMAL_INST=:abnormalInst,
       FAIL_INST=:failInst, CRIT_CNT=:critCnt, WARN_CNT=:warnCnt, OPEN_ISSUES=:openIssues
     WHEN NOT MATCHED THEN INSERT (RUN_ID,REPORT_NAME,TRIGGER_TYPE,INSTANCE_COUNT,ABNORMAL_INST,FAIL_INST,CRIT_CNT,WARN_CNT,OPEN_ISSUES)
       VALUES (:runId,:reportName,:triggerType,:instanceCount,:abnormalInst,:failInst,:critCnt,:warnCnt,:openIssues)`,
    {
      runId, reportName: fit(name, 250), triggerType: r.TRIGGER_TYPE,
      instanceCount: r.TOTAL_INST, abnormalInst: abn, failInst: r.FAIL_INST,
      critCnt: r.CRIT_CNT, warnCnt: r.WARN_CNT, openIssues: open,
    });
}

/**
 * 发起一次巡检。立即返回 runId，实际执行在后台进行（前端轮询进度）。
 * @param {{templateId?:number, itemCodes?:string[], planId?:number, planName?:string, scope?:object, instanceIds?:number[],
 *          triggerType?:'SCHEDULE'|'MANUAL'|'ALERT'|'RECHECK', triggerRef?:string, onlyItemCode?:string, user?:{userId?:number,username?:string}}} o
 */
async function startRun(o) {
  await store.ensureSeeded();
  const triggerType = o.triggerType || 'MANUAL';
  let template = null;
  let items;
  if (o.itemCodes && o.itemCodes.length) {
    items = await store.loadRunItems(null, null, o.itemCodes);
  } else {
    template = await store.getTemplate(o.templateId);
    if (!template) throw Object.assign(new Error('巡检模板不存在'), { code: 404 });
    if (!template.enabled) throw Object.assign(new Error('巡检模板已停用'), { code: 400 });
    items = await store.loadRunItems(o.templateId, o.onlyItemCode);
  }
  if (!items.length) throw Object.assign(new Error('模板里没有可执行的（已启用的）检查项'), { code: 400 });

  let instances;
  if (o.instanceIds && o.instanceIds.length) {
    instances = [];
    for (const id of o.instanceIds) { const i = await loadInstance(id); if (i && store.SUPPORTED_TYPES.includes(String(i.DB_TYPE).toUpperCase())) instances.push(i); }
  } else {
    const list = await store.resolveInstances(o.scope, template);
    instances = [];
    for (const x of list) { const i = await loadInstance(x.INSTANCE_ID); if (i) instances.push(i); }
  }
  if (!instances.length) throw Object.assign(new Error('范围内没有可巡检的实例（仅支持 Oracle / MySQL / PostgreSQL / 达梦及其兼容库，且未停用）'), { code: 400 });

  if (o.planId != null) {
    if (runningPlans.has(o.planId)) throw Object.assign(new Error('该计划正在执行中，请稍后再试'), { code: 409 });
    const busy = await db.execute(`SELECT COUNT(*) AS N FROM DBI_RUN WHERE PLAN_ID=:1 AND STATUS='RUNNING' AND STARTED_AT > SYSTIMESTAMP - INTERVAL '2' HOUR`, [o.planId]);
    if (Number(busy.rows[0].N) > 0) throw Object.assign(new Error('该计划正在执行中（其他节点），请稍后再试'), { code: 409 });
  }

  const tplName = template ? template.name : `复检：${items.map((i) => i.ITEM_NAME).join('、')}`;
  const r = await db.execute(
    `INSERT INTO DBI_RUN (PLAN_ID,PLAN_NAME,TEMPLATE_ID,TEMPLATE_NAME,TRIGGER_TYPE,TRIGGER_REF,ONLY_ITEM_CODE,STATUS,TOTAL_INST,CREATED_BY,CREATED_NAME)
     VALUES (:1,:2,:3,:4,:5,:6,:7,'RUNNING',:8,:9,:10) RETURNING RUN_ID INTO :11`,
    [o.planId ?? null, fit(o.planName, 128), template ? template.templateId : null, fit(tplName, 128), triggerType, fit(o.triggerRef, 120),
      o.onlyItemCode || (o.itemCodes && o.itemCodes.length === 1 ? o.itemCodes[0] : null), instances.length,
      o.user?.userId ?? null, fit(o.user?.username || (triggerType === 'SCHEDULE' ? 'system' : null), 60), { type: oracledb.NUMBER, dir: oracledb.BIND_OUT }]);
  const runId = db.pluckOutBind(r);
  for (const i of instances) {
    await db.execute(`INSERT INTO DBI_RUN_INSTANCE (RUN_ID,INSTANCE_ID,INSTANCE_NAME,DB_TYPE,HOST_IP,EXEC_STATUS) VALUES (:1,:2,:3,:4,:5,'RUNNING')`,
      [runId, i.INSTANCE_ID, fit(i.INSTANCE_NAME, 128), i.DB_TYPE, i.HOST_IP]);
  }
  if (o.planId != null) {
    runningPlans.add(o.planId);
    await db.execute('UPDATE DBI_PLAN SET LAST_RUN_ID=:1, LAST_RUN_AT=SYSTIMESTAMP WHERE PLAN_ID=:2', [runId, o.planId]).catch(() => {});
  }
  const done = executeRun(runId, items, instances)
    .catch(async (e) => {
      console.error('[db-inspect] 巡检运行失败', runId, e);
      await db.execute(`UPDATE DBI_RUN SET STATUS='FAILED', FINISHED_AT=SYSTIMESTAMP, MESSAGE=:1 WHERE RUN_ID=:2`, [fit(`运行异常：${e.message}`, 900), runId]).catch(() => {});
    })
    .finally(() => { if (o.planId != null) runningPlans.delete(o.planId); });
  return { runId, total: instances.length, done };
}

/** 复检：只重跑某个问题项对应的检查项（该实例） */
async function recheckIssue(issueId, user) {
  const r = await db.execute('SELECT INSTANCE_ID, ITEM_CODE, ITEM_NAME FROM DBI_ISSUE WHERE ISSUE_ID=:1', [issueId]);
  if (!r.rows.length) throw Object.assign(new Error('问题项不存在'), { code: 404 });
  const x = r.rows[0];
  return startRun({ itemCodes: [x.ITEM_CODE], instanceIds: [x.INSTANCE_ID], triggerType: 'RECHECK', triggerRef: `issue:${issueId}`, user });
}

/** 服务重启会让后台线程中断：把长时间停在 RUNNING 的记录收尾，避免界面一直“执行中” */
async function reapStaleRuns() {
  const r = await db.execute(
    `UPDATE DBI_RUN SET STATUS='FAILED', FINISHED_AT=SYSTIMESTAMP, MESSAGE='服务重启或执行超时，已中断' WHERE STATUS='RUNNING' AND STARTED_AT < SYSTIMESTAMP - INTERVAL '2' HOUR`);
  await db.execute(`UPDATE DBI_RUN_INSTANCE SET EXEC_STATUS='FAILED', ERROR_MSG='服务重启或执行超时，已中断' WHERE EXEC_STATUS='RUNNING' AND RUN_ID IN (SELECT RUN_ID FROM DBI_RUN WHERE STATUS='FAILED')`);
  return r.rowsAffected || 0;
}

module.exports = { startRun, recheckIssue, reapStaleRuns, createReport, inspectInstance, pickImpl };
