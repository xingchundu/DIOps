/**
 * 采集后告警评估：ALERT_RULE × 指标 → ALERT_RECORD（与 Java AlertEvaluator 语义对齐）
 */
const db = require('../config/db');

/** ruleId|instanceId → 首次满足条件的时间戳(ms) */
const pendingSince = new Map();

function putIfAbsentFrom(m, alias, sources) {
  if (m.has(alias)) return;
  for (const s of sources) {
    const v = m.get(s);
    if (v != null && Number.isFinite(v)) {
      m.set(alias, v);
      return;
    }
  }
}

function metricMap(engineMetrics, exporterMetrics, reachable = true, healthScore = null, dbType = '') {
  const m = new Map();
  for (const row of exporterMetrics || []) {
    const name = row.METRIC_NAME;
    const v = Number(row.VALUE);
    if (!name || !Number.isFinite(v)) continue;
    m.set(name, v);
    if (name === 'Buffer Cache Hit Ratio') m.set('oracle_buffer_cache_hit_pct', v);
    if (name === 'pg_buffer_cache_hit_ratio') m.set('panwei_buffer_hit_pct', v);
    if (name === 'tablespace_usage_pct') m.set('oracle_tablespace_max_used_pct', v);
  }
  for (const row of engineMetrics || []) {
    const key = row.key;
    const v = Number(row.value);
    if (!key || String(key).startsWith('_') || !Number.isFinite(v)) continue;
    m.set(key, v);
  }
  putIfAbsentFrom(m, 'tablespace_usage_pct', ['oracle_tablespace_max_used_pct', 'db_tablespace_max_used_pct']);
  putIfAbsentFrom(m, 'oracle_buffer_cache_hit', ['oracle_buffer_cache_hit_pct', 'Buffer Cache Hit Ratio']);
  putIfAbsentFrom(m, 'db_active_sessions', ['Active Sessions', 'pg_stat_activity_active', 'mssql_active_sessions', 'mysql_global_status_threads_running']);
  putIfAbsentFrom(m, 'db_buffer_hit_pct', ['Buffer Cache Hit Ratio', 'mysql_innodb_buffer_pool_hit_ratio', 'pg_buffer_cache_hit_ratio', 'mssql_buffer_cache_hit_ratio']);
  m.set('db_reachable', reachable ? 1 : 0);
  m.set('instance_up', reachable ? 1 : 0);
  const dt = String(dbType || '').toUpperCase();
  if (!reachable) {
    if (dt === 'ORACLE') m.set('oracle_instance_up', 0);
    if (dt === 'PANWEI') m.set('panwei_instance_up', 0);
  }
  if (healthScore != null && Number.isFinite(Number(healthScore))) {
    m.set('health_score', Number(healthScore));
  }
  return m;
}

function compare(op, val, threshold) {
  if (val == null || !Number.isFinite(val) || threshold == null || !op) return false;
  const th = Number(threshold);
  if (!Number.isFinite(th)) return false;
  switch (String(op).trim().toLowerCase()) {
    case 'gt': return val > th;
    case 'gte': return val >= th;
    case 'lt': return val < th;
    case 'lte': return val <= th;
    case 'eq': return Math.abs(val - th) < 1e-9;
    case 'ne':
    case 'neq': return Math.abs(val - th) >= 1e-9;
    default: return false;
  }
}

async function hasActiveAlert(ruleId, instanceId) {
  const r = await db.execute(
    `SELECT 1 FROM ALERT_RECORD
     WHERE RULE_ID = :1 AND NVL(INSTANCE_ID, -1) = NVL(:2, -1)
       AND STATUS IN ('OPEN','ACKNOWLEDGED','SILENCED','SUPPRESSED')`,
    [ruleId, instanceId ?? null]
  );
  return (r.rows || []).length > 0;
}

function forgetPending(instanceId) {
  const marker = `|${instanceId}|`;
  for (const k of [...pendingSince.keys()]) {
    if (k.includes(marker) || k.endsWith(`|${instanceId}`)) pendingSince.delete(k);
  }
}

async function evaluateAlertsForInstance(instanceId, instanceName, dbType, engineMetrics, exporterMetrics, opts = {}) {
  const reachable = opts.reachable !== false;
  const healthScore = opts.healthScore;
  let rules;
  try {
    rules = await db.execute(
      `SELECT RULE_ID, RULE_NAME, METRIC, OPERATOR, THRESHOLD, DURATION, SEVERITY, DB_TYPE, INSTANCE_ID,
              TABLESPACE_NAME, TARGET_HOST_IP
       FROM ALERT_RULE WHERE NVL(ENABLED, 1) = 1 AND NVL(RULE_TYPE, 'THRESHOLD') <> 'SQL_INSIGHT'`, []);
  } catch {
    // 未执行 v6 迁移脚本时降级为旧列
    rules = await db.execute(
      `SELECT RULE_ID, RULE_NAME, METRIC, OPERATOR, THRESHOLD, DURATION, SEVERITY, DB_TYPE, INSTANCE_ID
       FROM ALERT_RULE WHERE NVL(ENABLED, 1) = 1 AND NVL(RULE_TYPE, 'THRESHOLD') <> 'SQL_INSIGHT'`, []);
  }
  const values = metricMap(engineMetrics, exporterMetrics, reachable, healthScore, dbType);
  const fired = [];
  const dt = String(dbType || '').toUpperCase();
  const instanceIp = opts.hostIp ? String(opts.hostIp).trim() : '';
  const now = Date.now();

  for (const rule of rules.rows || []) {
    const metric = rule.METRIC;
    if (!metric || metric === 'cluster_reachable_member_count') continue;
    const rDb = rule.DB_TYPE ? String(rule.DB_TYPE).toUpperCase() : null;
    if (rDb && rDb !== dt) continue;
    if (rule.INSTANCE_ID != null && Number(rule.INSTANCE_ID) !== Number(instanceId)) continue;
    if (rule.TARGET_HOST_IP && String(rule.TARGET_HOST_IP).toLowerCase() !== instanceIp.toLowerCase()) continue;

    const ruleId = Number(rule.RULE_ID);
    const tbsFilter = rule.TABLESPACE_NAME ? String(rule.TABLESPACE_NAME) : '';
    const pendKey = `${ruleId}|${instanceId}|${tbsFilter}`;
    let val;
    let tbsHit = '';
    if (tbsFilter) {
      const wanted = tbsFilter.split(/[,，;；\s]+/).filter(Boolean).map(s => s.toUpperCase());
      const hit = [];
      for (const [k, v] of values) {
        if (!k.startsWith('tablespace_pct@')) continue;
        const name = k.slice('tablespace_pct@'.length).toUpperCase();
        if (wanted.some(w => w.endsWith('*') ? name.startsWith(w.slice(0, -1)) : name === w)) hit.push([name, v]);
      }
      if (!hit.length) { pendingSince.delete(pendKey); continue; }
      val = Math.max(...hit.map(h => h[1]));
      tbsHit = hit.map(h => h[0]).join(',');
    } else {
      val = values.get(metric);
    }
    if (val == null) {
      pendingSince.delete(pendKey);
      continue;
    }
    const breached = compare(rule.OPERATOR, val, rule.THRESHOLD);
    if (!breached) {
      pendingSince.delete(pendKey);
      continue;
    }
    const durMin = rule.DURATION != null ? Number(rule.DURATION) : 5;
    const durationMs = Math.max(0, durMin) * 60_000;
    let since = pendingSince.get(pendKey);
    if (since == null) {
      since = now;
      pendingSince.set(pendKey, since);
    }
    if (now - since < durationMs) continue;
    if (await hasActiveAlert(ruleId, instanceId)) continue;

    const scope = (instanceIp || instanceName) + (tbsHit ? `/${tbsHit}` : '');
    const content = `${rule.RULE_NAME}: [${scope}] ${metric}=${val} (${rule.OPERATOR} ${rule.THRESHOLD})`;
    await db.execute(
      `INSERT INTO ALERT_RECORD (RULE_ID, RULE_NAME, INSTANCE_ID, INSTANCE_NAME, SEVERITY, CONTENT, STATUS, TRIGGER_TIME)
       VALUES (:1, :2, :3, :4, :5, :6, 'OPEN', SYSTIMESTAMP)`,
      [ruleId, rule.RULE_NAME, instanceId, instanceName, rule.SEVERITY || 'P3', content.slice(0, 1024)]
    );
    fired.push(rule.RULE_NAME);
  }
  return fired;
}

module.exports = { evaluateAlertsForInstance, metricMap, forgetPending };