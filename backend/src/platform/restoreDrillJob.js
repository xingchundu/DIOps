/**
 * 为有 SUCCESS 备份的策略登记恢复演练待办（不自动执行恢复）。
 * 修改者: dxc | 时间: 2026-11-12
 */
const cron = require('node-cron');
const db = require('../config/db');
const sysConfig = require('../services/systemConfig');

let started = false;

async function isEnabled() {
  if (!(await sysConfig.getBool('platform.enabled', true))) return false;
  const env = String(process.env.BACKUP_RESTORE_DRILL || '').trim();
  if (env === '1' || env === 'true') return true;
  if (env === '0' || env === 'false') return false;
  if (process.env.PLATFORM_GOVERNANCE_MODULE === '0') return false;
  return sysConfig.getBool('backup.restore_drill.enabled', false);
}

async function intervalDays() {
  const env = process.env.BACKUP_RESTORE_DRILL_DAYS;
  if (env !== undefined && env !== '') {
    return Math.max(7, parseInt(env, 10));
  }
  return Math.max(7, await sysConfig.getNumber('backup.restore_drill.interval_days', 30));
}

async function registerDueDrills() {
  if (!(await isEnabled())) return 0;
  const intervalDaysVal = await intervalDays();
  const policies = await db.execute(
    `SELECT p.POLICY_ID, p.POLICY_NAME, p.INSTANCE_ID
     FROM BACKUP_POLICY_PRO p WHERE NVL(p.ENABLED,1)=1`,
    []
  );
  let n = 0;
  for (const p of policies.rows || []) {
    const rec = await db.execute(
      `SELECT RECORD_ID, END_TIME, CREATED_AT FROM BACKUP_RECORD_PRO
       WHERE POLICY_ID=:1 AND STATUS='SUCCESS' ORDER BY RECORD_ID DESC FETCH FIRST 1 ROWS ONLY`,
      [p.POLICY_ID]
    );
    const row = rec.rows?.[0];
    if (!row) continue;
    const exists = await db.execute(
      `SELECT 1 FROM BACKUP_RESTORE_DRILL WHERE POLICY_ID=:1 AND STATUS IN ('DUE','SCHEDULED')
       AND CREATED_AT > SYSTIMESTAMP - NUMTODSINTERVAL(:2, 'DAY')`,
      [p.POLICY_ID, intervalDaysVal]
    );
    if ((exists.rows || []).length) continue;
    await db.execute(
      `INSERT INTO BACKUP_RESTORE_DRILL (POLICY_ID, RECORD_ID, INSTANCE_ID, STATUS, SCHEDULED_AT, NOTE)
       VALUES (:1,:2,:3,'DUE',SYSTIMESTAMP,:4)`,
      [p.POLICY_ID, row.RECORD_ID, p.INSTANCE_ID,
        `距上次成功备份已超过演练登记周期(${intervalDaysVal}天)，请安排恢复验证`]
    );
    n++;
  }
  if (n > 0) console.log('[platform-restore-drill] registered', n);
  return n;
}

function startRestoreDrillScheduler() {
  if (started) return;
  const expr = process.env.BACKUP_RESTORE_DRILL_CRON || '0 5 * * 1';
  if (!cron.validate(expr)) {
    console.warn('[platform-restore-drill] invalid cron', expr);
    return;
  }
  cron.schedule(expr, () => {
    registerDueDrills().catch((e) => console.error('[platform-restore-drill]', e.message));
  });
  started = true;
  isEnabled().then((on) => {
    console.log('[platform-restore-drill] 已启动 Cron:', expr, 'enabled=', on);
  }).catch(() => {
    console.log('[platform-restore-drill] 已启动 Cron:', expr);
  });
}

module.exports = { startRestoreDrillScheduler, registerDueDrills, isEnabled };
