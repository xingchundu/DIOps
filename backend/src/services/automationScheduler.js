/**
 * 自动化运维定时任务：根据库中 Cron 表达式注册 node-cron，驱动巡检批次与策略类模拟执行。
 * 关闭：环境变量 AUTOMATION_SCHEDULER_DISABLED=1
 */
const cron = require('node-cron');
const db = require('../config/db');
const { runInspectBatchById } = require('./automationInspectBatchRun');
const { runInspectTaskById } = require('./inspectTaskRun');
const { automationLog } = require('./automationExecLog');

/** @type {Map<string, { task: import('node-cron').ScheduledTask, expr: string, label: string, kind: string }>} */
const entries = new Map();

let reloadTimer = null;
let started = false;

function schedulerReq() {
  return { user: { userId: null, username: 'AUTOMATION_SCHEDULER' } };
}

function isDisabled() {
  const v = String(process.env.AUTOMATION_SCHEDULER_DISABLED || '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function getTimezone() {
  return process.env.AUTOMATION_SCHEDULER_TIMEZONE || undefined;
}

function clearPrefix(prefix) {
  for (const [key, row] of entries) {
    if (key.startsWith(prefix)) {
      try { row.task.stop(); } catch (_) { /* ignore */ }
      entries.delete(key);
    }
  }
}

function normalizeCron(expr) {
  if (expr == null) return '';
  const s = String(expr).trim();
  return s;
}

function registerValidated(key, expr, label, kind, handler) {
  if (!cron.validate(expr)) return false;
  const opts = {};
  const tz = getTimezone();
  if (tz) opts.timezone = tz;
  const task = cron.schedule(expr, handler, opts);
  entries.set(key, { task, expr, label: String(label).slice(0, 240), kind });
  return true;
}

async function triggerInspectBatch(batchId, batchName) {
  const req = schedulerReq();
  try {
    const out = await runInspectBatchById(req, batchId);
    if (out.skipped) {
      console.log('[automation-scheduler]', out.skipped);
    }
  } catch (e) {
    const msg = e.message || String(e);
    console.error('[automation-scheduler] inspect batch', batchId, msg);
    await automationLog(req, 'INSPECT', batchId, 'BATCH_CRON', 'FAILED', msg.slice(0, 450));
  }
}

async function triggerInspectTask(taskId) {
  const req = schedulerReq();
  try {
    const out = await runInspectTaskById(req, taskId);
    console.log('[automation-scheduler] inspect task', taskId, 'ok reports=', out.reports);
  } catch (e) {
    const msg = e.message || String(e);
    console.error('[automation-scheduler] inspect task', taskId, msg);
    await automationLog(req, 'INSPECT', taskId, 'TASK_CRON', 'FAILED', msg.slice(0, 450));
  }
}

async function simulatedBackupTick(row) {
  const req = schedulerReq();
  const pid = row.POLICY_ID;
  const conn = await db.getConnection();
  try {
    const detail = `定时策略模拟归档（接单 RMAN/expdp）；cron=${normalizeCron(row.SCHEDULE)}`.slice(0, 1020);
    await conn.execute(
      `INSERT INTO BACKUP_RECORD (POLICY_ID, INSTANCE_ID, BACKUP_TYPE, STATUS, START_TIME, END_TIME, FILE_PATH, DETAIL)
       VALUES (:p,:i,NVL(:bt,'FULL'),'SUCCESS',SYSTIMESTAMP,SYSTIMESTAMP,:fp,:detail)`,
      {
        p: pid,
        i: row.INSTANCE_ID ?? null,
        bt: row.BACKUP_TYPE || 'FULL',
        fp: '/backup/cron-simulated/',
        detail,
      },
      { autoCommit: true }
    );
    await automationLog(req, 'BACKUP', pid, 'CRON_TICK', 'SUCCESS', `policy=${row.POLICY_NAME || pid}`);
  } catch (e) {
    console.error('[automation-scheduler] backup policy', pid, e.message || e);
    await automationLog(req, 'BACKUP', pid, 'CRON_TICK', 'FAILED', (e.message || String(e)).slice(0, 450));
  } finally {
    await conn.close().catch(() => {});
  }
}

async function simulatedSpaceTick(row) {
  const req = schedulerReq();
  const sid = row.SPACE_POLICY_ID;
  try {
    const msg = `模拟空间巡检 inst=${row.INSTANCE_ID} 阈值=${row.THRESHOLD_PCT}% cleanTmp=${row.CLEAN_TMP ? 1 : 0}`;
    await automationLog(req, 'SPACE', sid, 'CRON_TICK', 'SUCCESS', msg.slice(0, 450));
  } catch (e) {
    console.error('[automation-scheduler] space policy', sid, e.message || e);
  }
}

async function reloadCronJobsFromDb() {
  if (!started || isDisabled()) return;

  clearPrefix('inspect:');
  const qb = await db.execute(
    `SELECT BATCH_ID, BATCH_NAME, CRON_EXPR FROM AUTOMATION_INSPECT_BATCH
     WHERE CRON_EXPR IS NOT NULL AND LENGTH(TRIM(CRON_EXPR)) > 0`,
    []
  );
  for (const row of qb.rows || []) {
    const expr = normalizeCron(row.CRON_EXPR);
    if (!expr) continue;
    const key = `inspect:${row.BATCH_ID}`;
    const label = `${row.BATCH_NAME || 'batch'}(#${row.BATCH_ID})`;
    const bid = Number(row.BATCH_ID);
    const ok = registerValidated(key, expr, label, 'INSPECT_BATCH', () => {
      triggerInspectBatch(bid, label);
    });
    if (!ok) console.warn('[automation-scheduler] 无效 Cron（巡检批次）', bid, expr);
  }

  clearPrefix('inspTask:');
  const qt = await db.execute(
    `SELECT TASK_ID, TASK_NAME, CRON_EXPR FROM INSPECT_TASK
     WHERE CRON_EXPR IS NOT NULL AND LENGTH(TRIM(CRON_EXPR)) > 0`,
    []
  );
  for (const row of qt.rows || []) {
    const expr = normalizeCron(row.CRON_EXPR);
    if (!expr) continue;
    const key = `inspTask:${row.TASK_ID}`;
    const tid = Number(row.TASK_ID);
    const label = `${row.TASK_NAME || 'task'}(#${tid})`;
    const ok = registerValidated(key, expr, label, 'INSPECT_TASK', () => {
      triggerInspectTask(tid);
    });
    if (!ok) console.warn('[automation-scheduler] 无效 Cron（巡检任务）', tid, expr);
  }

  clearPrefix('backup:');
  const qp = await db.execute(
    `SELECT POLICY_ID, POLICY_NAME, INSTANCE_ID, BACKUP_TYPE, SCHEDULE
     FROM BACKUP_POLICY WHERE NVL(ENABLED,1)=1 AND SCHEDULE IS NOT NULL AND LENGTH(TRIM(SCHEDULE)) > 0`,
    []
  );
  for (const row of qp.rows || []) {
    const expr = normalizeCron(row.SCHEDULE);
    if (!expr) continue;
    const key = `backup:${row.POLICY_ID}`;
    const pid = Number(row.POLICY_ID);
    const ok = registerValidated(key, expr, row.POLICY_NAME || `policy${pid}`, 'BACKUP_POLICY', () => {
      simulatedBackupTick(row);
    });
    if (!ok) console.warn('[automation-scheduler] 无效 Cron（备份策略）', pid, expr);
  }

  clearPrefix('space:');
  const qs = await db.execute(
    `SELECT SPACE_POLICY_ID, INSTANCE_ID, THRESHOLD_PCT, CLEAN_TMP, SCHEDULE_CRON
     FROM SPACE_POLICY WHERE NVL(ENABLED,1)=1 AND SCHEDULE_CRON IS NOT NULL AND LENGTH(TRIM(SCHEDULE_CRON)) > 0`,
    []
  );
  for (const row of qs.rows || []) {
    const expr = normalizeCron(row.SCHEDULE_CRON);
    if (!expr) continue;
    const key = `space:${row.SPACE_POLICY_ID}`;
    const sid = Number(row.SPACE_POLICY_ID);
    const ok = registerValidated(key, expr, `space#${sid}`, 'SPACE_POLICY', () => {
      simulatedSpaceTick(row);
    });
    if (!ok) console.warn('[automation-scheduler] 无效 Cron（空间策略）', sid, expr);
  }
}

function scheduleReloadLoop() {
  const rawMs = parseInt(process.env.AUTOMATION_SCHEDULER_REFRESH_MS || '90000', 10);
  const ms = Number.isFinite(rawMs) ? Math.max(15000, rawMs) : 90000;
  reloadTimer = setInterval(() => {
    reloadCronJobsFromDb().catch((e) => console.error('[automation-scheduler] reload', e.message || e));
  }, ms);
}

function getSchedulerStatusPayload() {
  const list = [];
  for (const [key, row] of entries) {
    list.push({ key, kind: row.kind, cron: row.expr, label: row.label });
  }
  const rawMs = parseInt(process.env.AUTOMATION_SCHEDULER_REFRESH_MS || '90000', 10);
  const refreshMs = Number.isFinite(rawMs) ? Math.max(15000, rawMs) : 90000;
  return {
    running: started && !isDisabled(),
    disabled: isDisabled(),
    timezone: getTimezone() || null,
    refreshMs,
    timezoneEnv: process.env.AUTOMATION_SCHEDULER_TIMEZONE || null,
    jobs: list.sort((a, b) => a.key.localeCompare(b.key)),
  };
}

async function startAutomationScheduler() {
  if (started) return;
  started = true;
  if (isDisabled()) {
    console.log('[automation-scheduler] 已跳过启动（AUTOMATION_SCHEDULER_DISABLED）');
    return;
  }
  try {
    await reloadCronJobsFromDb();
    console.log(`[automation-scheduler] 已加载 ${entries.size} 条 Cron 作业（巡检批次 / 备份 / 空间）`);
    scheduleReloadLoop();
  } catch (e) {
    console.error('[automation-scheduler] 启动失败:', e.message || e);
  }
}

function stopAutomationSchedulerForTests() {
  if (reloadTimer) clearInterval(reloadTimer);
  reloadTimer = null;
  entries.clear();
  started = false;
}

module.exports = {
  startAutomationScheduler,
  getSchedulerStatusPayload,
  reloadCronJobsFromDb,
  stopAutomationSchedulerForTests,
};
