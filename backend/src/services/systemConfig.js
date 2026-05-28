/**
 * 系统配置服务：从 SYS_CONFIG 表读取配置，内存缓存，支持热更新。
 */
const db = require('../config/db');

let cache = {};
let loaded = false;

async function loadAll() {
  try {
    const r = await db.execute(`SELECT CONFIG_KEY, CONFIG_VALUE FROM SYS_CONFIG`, []);
    cache = {};
    for (const row of (r.rows || [])) {
      cache[row.CONFIG_KEY] = row.CONFIG_VALUE;
    }
    loaded = true;
  } catch (e) {
    if (/ORA-00942|942/.test(e.message || '')) {
      console.warn('[system-config] SYS_CONFIG 表不存在，请执行 migration_system_config.sql');
    } else {
      console.warn('[system-config] loadAll error:', e.message);
    }
  }
}

async function get(key, fallback) {
  if (!loaded) await loadAll();
  const v = cache[key];
  if (v === undefined || v === null || v === '') return fallback;
  return v;
}

async function getNumber(key, fallback) {
  const v = await get(key);
  if (v === undefined || v === null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

async function set(key, value, userId) {
  await db.execute(
    `UPDATE SYS_CONFIG SET CONFIG_VALUE=:1, UPDATED_BY=:2, UPDATED_AT=SYSTIMESTAMP WHERE CONFIG_KEY=:3`,
    [String(value), userId || null, key]
  );
  cache[key] = String(value);
}

async function getAll() {
  if (!loaded) await loadAll();
  try {
    const r = await db.execute(
      `SELECT CONFIG_KEY, CONFIG_VALUE, DEFAULT_VALUE, CATEGORY, LABEL, DESCRIPTION, VALUE_TYPE, MIN_VAL, MAX_VAL, OPTIONS, UPDATED_AT
       FROM SYS_CONFIG ORDER BY CATEGORY, CONFIG_ID`,
      []
    );
    return r.rows || [];
  } catch { return []; }
}

async function reset(key, userId) {
  const r = await db.execute(`SELECT DEFAULT_VALUE FROM SYS_CONFIG WHERE CONFIG_KEY=:1`, [key]);
  if (r.rows.length && r.rows[0].DEFAULT_VALUE != null) {
    await set(key, r.rows[0].DEFAULT_VALUE, userId);
  }
}

module.exports = { loadAll, get, getNumber, set, getAll, reset };
