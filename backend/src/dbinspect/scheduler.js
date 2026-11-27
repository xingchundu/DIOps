'use strict';
/**
 * 巡检调度：
 *  1) 计划 Cron → node-cron；每 90s 对账（计划增删改后自动生效，无需重启）；到点若不在执行窗口内则跳过（窗口支持跨午夜）。
 *  2) 告警联动：轮询新产生的 ALERT_RECORD，按“专项模板”里配置的告警关键字匹配，对该实例自动触发专项巡检（同实例同模板有冷却时间）。
 * 多节点部署时，同一计划的重复触发由 runner 里的 RUNNING 记录挡住。
 */
const cron = require('node-cron');
const db = require('../config/db');
const store = require('./store');
const runner = require('./runner');
const { platformTz, minutesNow } = require('../utils/platformClock');

const RELOAD_MS = 90 * 1000;
const ALERT_POLL_MS = Math.max(15, Number(process.env.DBINSPECT_ALERT_POLL_SEC) || 60) * 1000;
const ALERT_COOLDOWN_MS = Math.max(1, Number(process.env.DBINSPECT_ALERT_COOLDOWN_MIN) || 30) * 60 * 1000;

const jobs = new Map();            // planId → { task, expr, sig }
let reloadTimer = null; let alertTimer = null;
let lastAlertId = null;
const cooldown = new Map();        // `${templateId}|${instanceId}` → ts

const toMin = (s) => { const m = /^(\d{2}):(\d{2})$/.exec(s || ''); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };

/** 当前时刻是否在窗口内；未配置窗口=始终允许；start>end 视为跨午夜 */
function inWindow(start, end, now = new Date()) {
  const a = toMin(start); const b = toMin(end);
  if (a == null || b == null || a === b) return true;
  const n = minutesNow(now);
  return a < b ? (n >= a && n < b) : (n >= a || n < b);
}

async function fire(plan) {
  if (!inWindow(plan.windowStart, plan.windowEnd)) {
    console.log(`[db-inspect] 计划「${plan.name}」不在执行窗口 ${plan.windowStart}-${plan.windowEnd}，本次跳过`);
    return;
  }
  try {
    const r = await runner.startRun({ templateId: plan.templateId, planId: plan.planId, planName: plan.name, scope: plan.scope, triggerType: 'SCHEDULE' });
    console.log(`[db-inspect] 计划「${plan.name}」已启动 run=${r.runId} 实例=${r.total}`);
  } catch (e) {
    console.warn(`[db-inspect] 计划「${plan.name}」未能启动：${e.message}`);
  }
}

async function reload() {
  let plans;
  try { plans = (await store.listPlans()).filter((p) => p.enabled && p.cron); } catch (e) { console.warn('[db-inspect] 读取计划失败:', e.message); return; }
  const want = new Map(plans.map((p) => [p.planId, p]));
  for (const [id, j] of jobs) {
    const p = want.get(id);
    if (!p || j.sig !== `${p.cron}|${p.templateId}|${p.windowStart}|${p.windowEnd}|${JSON.stringify(p.scope)}`) { try { j.task.stop(); } catch { /* ignore */ } jobs.delete(id); }
  }
  for (const p of plans) {
    if (jobs.has(p.planId)) continue;
    if (!cron.validate(p.cron)) { console.warn(`[db-inspect] 计划「${p.name}」Cron 无效: ${p.cron}`); continue; }
    const sig = `${p.cron}|${p.templateId}|${p.windowStart}|${p.windowEnd}|${JSON.stringify(p.scope)}`;
    const task = cron.schedule(p.cron, () => { fire(p).catch(() => {}); }, { timezone: platformTz() });
    jobs.set(p.planId, { task, expr: p.cron, sig });
  }
}

async function pollAlerts() {
  try {
    if (lastAlertId == null) {
      lastAlertId = Number((await db.execute('SELECT NVL(MAX(ALERT_ID),0) AS M FROM ALERT_RECORD')).rows[0].M);
      return;
    }
    const rows = (await db.execute(
      `SELECT ALERT_ID, RULE_NAME, INSTANCE_ID, CONTENT FROM ALERT_RECORD WHERE ALERT_ID > :1 AND INSTANCE_ID IS NOT NULL ORDER BY ALERT_ID`, [lastAlertId])).rows;
    if (!rows.length) return;
    lastAlertId = Math.max(...rows.map((r) => Number(r.ALERT_ID)));
    const tpls = (await store.listTemplates()).filter((t) => t.enabled && t.alertRules && t.alertRules.length);
    if (!tpls.length) return;
    const supported = new Set((await store.listInstances()).map((i) => i.INSTANCE_ID));
    for (const a of rows) {
      if (!supported.has(a.INSTANCE_ID)) continue;
      const text = `${a.RULE_NAME || ''} ${a.CONTENT || ''}`.toLowerCase();
      for (const t of tpls) {
        if (!t.alertRules.some((k) => k && text.includes(String(k).toLowerCase()))) continue;
        const key = `${t.templateId}|${a.INSTANCE_ID}`;
        if (Date.now() - (cooldown.get(key) || 0) < ALERT_COOLDOWN_MS) continue;
        cooldown.set(key, Date.now());
        try {
          const r = await runner.startRun({ templateId: t.templateId, instanceIds: [a.INSTANCE_ID], triggerType: 'ALERT', triggerRef: `alert:${a.ALERT_ID}`, planName: `告警联动：${a.RULE_NAME || ''}` });
          console.log(`[db-inspect] 告警 ${a.ALERT_ID} 触发专项巡检「${t.name}」run=${r.runId}`);
        } catch (e) { console.warn('[db-inspect] 告警联动失败:', e.message); }
      }
    }
  } catch (e) { console.warn('[db-inspect] 告警轮询失败:', e.message); }
}

function start() {
  if (String(process.env.DBINSPECT_SCHEDULER || '1') === '0') return;
  runner.reapStaleRuns().catch(() => {});
  store.ensureSeeded().catch((e) => console.warn('[db-inspect] 内置检查项初始化失败（是否已执行 migration_db_inspect.sql？）:', e.message));
  reload();
  reloadTimer = setInterval(reload, RELOAD_MS); reloadTimer.unref?.();
  if (String(process.env.DBINSPECT_ALERT_LINK || '1') !== '0') { alertTimer = setInterval(pollAlerts, ALERT_POLL_MS); alertTimer.unref?.(); }
}
function stop() {
  for (const j of jobs.values()) { try { j.task.stop(); } catch { /* ignore */ } }
  jobs.clear(); clearInterval(reloadTimer); clearInterval(alertTimer);
}

module.exports = { start, stop, reload, inWindow, pollAlerts };
