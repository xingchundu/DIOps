/**
 * [dxc][2026-10-17][新增] 按实例 COLLECT_INTERVAL_SEC 自动采集（与全量 collectAllInstances 并存）
 */
const db = require('../config/db');
const { collectInstance } = require('./monitorCollectPersist');

const TICK_MS = 15000;
let tickTimer = null;
let running = false;

async function loadDueInstances() {
  try {
    const r = await db.execute(
      `SELECT INSTANCE_ID, COLLECT_INTERVAL_SEC, LAST_CHECK
       FROM CMDB_INSTANCE
       WHERE NVL(COLLECT_INTERVAL_SEC, 0) > 0
         AND NVL(STATUS, 'UNKNOWN') <> 'STOPPED'`,
      []
    );
    return r.rows || [];
  } catch (e) {
    if (/ORA-00904|904/.test(e.message || '')) return [];
    throw e;
  }
}

function isDue(row) {
  const sec = Number(row.COLLECT_INTERVAL_SEC);
  if (!Number.isFinite(sec) || sec <= 0) return false;
  const last = row.LAST_CHECK ? new Date(row.LAST_CHECK).getTime() : 0;
  if (!last) return true;
  return Date.now() - last >= sec * 1000;
}

async function tick() {
  if (running) return;
  running = true;
  try {
    const rows = await loadDueInstances();
    for (const row of rows) {
      if (!isDue(row)) continue;
      try {
        await collectInstance(row.INSTANCE_ID);
      } catch (e) {
        console.warn('[monitor-instance-scheduler]', row.INSTANCE_ID, e.message || e);
      }
    }
  } catch (e) {
    console.warn('[monitor-instance-scheduler] tick:', e.message || e);
  } finally {
    running = false;
  }
}

function startMonitorInstanceCollectScheduler() {
  if (tickTimer) return;
  tickTimer = setInterval(() => {
    tick().catch(() => {});
  }, TICK_MS);
  setTimeout(() => tick().catch(() => {}), 5000);
  console.log(`[monitor-instance-scheduler] tick every ${TICK_MS}ms (COLLECT_INTERVAL_SEC per instance)`);
}

function stopMonitorInstanceCollectScheduler() {
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = null;
}

module.exports = { startMonitorInstanceCollectScheduler, stopMonitorInstanceCollectScheduler, tick };
