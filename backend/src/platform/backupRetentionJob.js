/**
 * 按 BACKUP_POLICY_PRO.RETENTION_DAYS 清理超期 SUCCESS 备份记录与本地文件。
 * 修改者: dxc | 时间: 2026-11-12
 */
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const db = require('../config/db');
const { resolveStorageRoot } = require('../services/backupRestoreRunner');
const sysConfig = require('../services/systemConfig');

let started = false;
let lastRun = null;
let lastSummary = null;

async function isEnabled() {
  if (!(await sysConfig.getBool('platform.enabled', true))) return false;
  const env = String(process.env.BACKUP_RETENTION_ENABLED || '').trim().toLowerCase();
  if (env === '0' || env === 'false' || env === 'no') return false;
  if (env === '1' || env === 'true' || env === 'yes') return true;
  return sysConfig.getBool('backup.retention.job_enabled', true);
}

async function logAction(policyId, recordId, action, detail) {
  try {
    await db.execute(
      `INSERT INTO BACKUP_RETENTION_LOG (POLICY_ID, RECORD_ID, ACTION, DETAIL) VALUES (:1, :2, :3, :4)`,
      [policyId || null, recordId || null, action, String(detail || '').slice(0, 1900)]
    );
  } catch (e) {
    console.warn('[platform-backup-retention] log insert failed:', e.message);
  }
}

function safeUnderRoot(filePath, root) {
  if (!filePath || !root) return false;
  const f = path.resolve(filePath);
  const r = path.resolve(root);
  return f === r || f.startsWith(r + path.sep);
}

async function runRetentionOnce(dryRun = false) {
  if (!(await isEnabled())) {
    return { skipped: true, reason: 'disabled', dryRun };
  }
  const summary = { scanned: 0, deletedRows: 0, deletedFiles: 0, skipped: 0, errors: 0, dryRun };
  const policies = await db.execute(
    `SELECT POLICY_ID, INSTANCE_ID, STORAGE_TYPE, STORAGE_PATH, NVL(RETENTION_DAYS, 7) AS RETENTION_DAYS
     FROM BACKUP_POLICY_PRO WHERE NVL(ENABLED, 1) = 1`,
    []
  );
  const policyMap = new Map();
  for (const p of policies.rows || []) {
    policyMap.set(Number(p.POLICY_ID), p);
  }

  const olds = await db.execute(
    `SELECT r.RECORD_ID, r.POLICY_ID, r.BACKUP_PATH, r.END_TIME
     FROM BACKUP_RECORD_PRO r
     WHERE r.STATUS = 'SUCCESS' AND r.END_TIME IS NOT NULL`,
    []
  );

  for (const row of olds.rows || []) {
    summary.scanned++;
    const pol = policyMap.get(Number(row.POLICY_ID));
    if (!pol) {
      summary.skipped++;
      continue;
    }
    const days = Math.max(1, Number(pol.RETENTION_DAYS) || 7);
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const end = row.END_TIME instanceof Date ? row.END_TIME : new Date(row.END_TIME);
    if (end >= cutoff) continue;

    const root = resolveStorageRoot(pol);
    const filePath = row.BACKUP_PATH;
    if (!dryRun) {
      if (filePath && root && safeUnderRoot(filePath, root)) {
        try {
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            summary.deletedFiles++;
          }
        } catch (e) {
          summary.errors++;
          await logAction(row.POLICY_ID, row.RECORD_ID, 'FILE_DELETE_FAIL', e.message);
        }
      }
      try {
        await db.execute(`DELETE FROM BACKUP_RECORD_PRO WHERE RECORD_ID = :1`, [row.RECORD_ID]);
        summary.deletedRows++;
        await logAction(row.POLICY_ID, row.RECORD_ID, 'DELETE', `retention>${days}d`);
      } catch (e) {
        summary.errors++;
        await logAction(row.POLICY_ID, row.RECORD_ID, 'ROW_DELETE_FAIL', e.message);
      }
    }
  }

  lastRun = new Date();
  lastSummary = summary;
  console.log('[platform-backup-retention]', JSON.stringify(summary));
  return summary;
}

function startBackupRetentionScheduler() {
  if (started) return;
  const expr = process.env.BACKUP_RETENTION_CRON || '0 4 * * *';
  if (!cron.validate(expr)) {
    console.warn('[platform-backup-retention] 无效 Cron，跳过:', expr);
    return;
  }
  const { platformTz } = require('../utils/platformClock');
  cron.schedule(expr, () => {
    isEnabled()
      .then((on) => {
        if (!on) return;
        return runRetentionOnce(false);
      })
      .catch((e) => console.error('[platform-backup-retention]', e.message || e));
  }, { timezone: platformTz() });
  started = true;
  isEnabled().then((on) => {
    console.log('[platform-backup-retention] 已启动 Cron:', expr, 'enabled=', on);
  }).catch(() => {
    console.log('[platform-backup-retention] 已启动 Cron:', expr);
  });
}

module.exports = {
  startBackupRetentionScheduler,
  runRetentionOnce,
  isEnabled,
  getStatus: () => ({ started, lastRun, lastSummary, enabled: null }),
};
