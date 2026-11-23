/**
 * 平台运维闭环 Node 作业（备份保留 / 恢复演练登记）。
 * 修改者: dxc | 2026-11-12
 */
const { startBackupRetentionScheduler } = require('./backupRetentionJob');
const { startRestoreDrillScheduler } = require('./restoreDrillJob');

function startPlatformJobs() {
  if (String(process.env.PLATFORM_NOTIFY_MODULE || '1') !== '0') {
    startBackupRetentionScheduler();
  }
  if (String(process.env.PLATFORM_GOVERNANCE_MODULE || '1') !== '0') {
    startRestoreDrillScheduler();
  }
}

module.exports = { startPlatformJobs };
