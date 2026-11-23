/**
 * 自动化运维定时任务：根据库中 Cron 表达式注册 node-cron，驱动巡检批次、巡检任务与备份策略。
 * 关闭：环境变量 AUTOMATION_SCHEDULER_DISABLED=1
 */
const cron = require('node-cron');
const licenseGate = require('../utils/licenseGate');
const db = require('../config/db');
const { runInspectBatchById } = require('./automationInspectBatchRun');
const { runInspectTaskById } = require('./inspectTaskRun');
const { automationLog } = require('./automationExecLog');
const { executeBackupPolicy } = require('./backupRestoreRunner');

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
  licenseGate.start();
  // 授权到期超过宽限期后不再执行定时巡检 / 策略任务
  const gated = (...a) => {
    if (!licenseGate.backgroundAllowed()) {
      console.warn('[automation-scheduler] 授权到期超过宽限期，跳过定时任务', key);
      return undefined;
    }
    return handler(...a);
  };
  const task = cron.schedule(expr, gated, opts);
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

// 说明：原 simulatedBackupTick / simulatedSpaceTick 会按 Cron 往 BACKUP_RECORD 写入“SUCCESS”的假备份记录、
// 往执行日志写“空间巡检 SUCCESS”，实际什么也没做。已删除：旧 BACKUP_POLICY 表与 SPACE_POLICY 不再注册定时任务，
// 只在启动时提示一次（备份请使用「备份策略」= BACKUP_POLICY_PRO，会真正执行备份脚本）。
let _legacyWarned = false;

function registerOrKeep(desired, key, expr, label, kind, handler) {
  desired.set(key, { expr, label, kind, handler });
}

async function reloadCronJobsFromDb() {
  if (!started || isDisabled()) return;

  // 先把所有表查完再统一对比（原实现先清空再查询：查询失败时该类定时任务全部丢失；
  // 而且每 90 秒停掉重建一次，恰好落在重建窗口内的触发会被漏掉）
  const desired = new Map();

  const qb = await db.execute(
    `SELECT BATCH_ID, BATCH_NAME, CRON_EXPR FROM AUTOMATION_INSPECT_BATCH
     WHERE CRON_EXPR IS NOT NULL AND LENGTH(TRIM(CRON_EXPR)) > 0`,
    []
  );
  for (const row of qb.rows || []) {
    const expr = normalizeCron(row.CRON_EXPR);
    if (!expr) continue;
    const bid = Number(row.BATCH_ID);
    const label = `${row.BATCH_NAME || 'batch'}(#${bid})`;
    registerOrKeep(desired, `inspect:${bid}`, expr, label, 'INSPECT_BATCH', () => { triggerInspectBatch(bid, label); });
  }

  const qt = await db.execute(
    `SELECT TASK_ID, TASK_NAME, CRON_EXPR FROM INSPECT_TASK
     WHERE CRON_EXPR IS NOT NULL AND LENGTH(TRIM(CRON_EXPR)) > 0`,
    []
  );
  for (const row of qt.rows || []) {
    const expr = normalizeCron(row.CRON_EXPR);
    if (!expr) continue;
    const tid = Number(row.TASK_ID);
    registerOrKeep(desired, `inspTask:${tid}`, expr, `${row.TASK_NAME || 'task'}(#${tid})`, 'INSPECT_TASK', () => { triggerInspectTask(tid); });
  }

  const qp = await db.execute(
    `SELECT POLICY_ID, POLICY_NAME, INSTANCE_ID, BACKUP_TYPE, SCHEDULE
     FROM BACKUP_POLICY_PRO WHERE NVL(ENABLED,1)=1 AND SCHEDULE IS NOT NULL AND LENGTH(TRIM(SCHEDULE)) > 0`,
    []
  );
  for (const row of qp.rows || []) {
    const expr = normalizeCron(row.SCHEDULE);
    if (!expr) continue;
    const pid = Number(row.POLICY_ID);
    registerOrKeep(desired, `backup:${pid}`, expr, row.POLICY_NAME || `policy${pid}`, 'BACKUP_POLICY_PRO', () => {
      executeBackupPolicy(pid, { triggerType: 'SCHEDULED', userId: null })
        .then((out) => console.log('[automation-scheduler] backup policy', pid, out.execMode, out.detail || out.msg))
        .catch((e) => {
          console.error('[automation-scheduler] backup policy', pid, e.message || e);
          automationLog(schedulerReq(), 'BACKUP', pid, 'CRON_TICK', 'FAILED', (e.message || String(e)).slice(0, 450));
        });
    });
  }

  if (!_legacyWarned) {
    _legacyWarned = true;
    const legacy = await db.execute(
      `SELECT (SELECT COUNT(*) FROM BACKUP_POLICY WHERE NVL(ENABLED,1)=1 AND SCHEDULE IS NOT NULL) AS B,
              (SELECT COUNT(*) FROM SPACE_POLICY WHERE NVL(ENABLED,1)=1 AND SCHEDULE_CRON IS NOT NULL) AS S FROM DUAL`, []
    ).catch(() => ({ rows: [] }));
    const r = legacy.rows?.[0];
    if (r && (Number(r.B) || Number(r.S))) {
      console.warn(`[automation-scheduler] 旧备份策略 ${Number(r.B) || 0} 条、空间策略 ${Number(r.S) || 0} 条带 Cron，但这两类没有真实执行逻辑，已不再定时运行；备份请改用「备份策略」。`);
    }
  }

  // 对比：表达式未变的保留原任务；变了或已删除的停止；新增的注册
  for (const [key, row] of entries) {
    const want = desired.get(key);
    if (!want || want.expr !== row.expr) {
      try { row.task.stop(); } catch (_) { /* ignore */ }
      entries.delete(key);
    } else {
      row.label = String(want.label).slice(0, 240);
    }
  }
  for (const [key, want] of desired) {
    if (entries.has(key)) continue;
    const ok = registerValidated(key, want.expr, want.label, want.kind, want.handler);
    if (!ok) console.warn('[automation-scheduler] 无效 Cron', key, want.expr);
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
