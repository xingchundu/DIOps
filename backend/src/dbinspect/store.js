'use strict';
/**
 * 数据层：内置目录入库（幂等）、检查项 / 模板 / 计划 / 阈值覆盖 CRUD、问题项生命周期。
 * 平台库是 Oracle：VARCHAR2(n CHAR) 仍受 4000 字节上限，写入前统一用 fit() 截断，避免 ORA-12899。
 */
const oracledb = require('oracledb');
const db = require('../config/db');
const { ITEMS: CAT_ITEMS, TEMPLATES: CAT_TEMPLATES } = require('./catalog');
const { FAMILIES, familyOf } = require('./dialect');

const jparse = (s, d) => { try { return s == null || s === '' ? d : (typeof s === 'string' ? JSON.parse(s) : s); } catch { return d; } };
const jstr = (o) => (o == null ? null : JSON.stringify(o));

/** 先按字符数、再按 3900 字节截断 */
function fit(s, maxChars = 4000) {
  if (s == null) return null;
  let out = Array.from(String(s)).slice(0, maxChars).join('');
  if (Buffer.byteLength(out, 'utf8') <= 3900) return out;
  let r = '';
  for (const ch of out) { if (Buffer.byteLength(r + ch, 'utf8') > 3897) break; r += ch; }
  return `${r}…`;
}

// ---------------------------------------------------------------- 内置目录入库
let seedPromise = null;
function ensureSeeded() {
  if (!seedPromise) {
    seedPromise = seedBuiltin().catch((e) => { seedPromise = null; throw e; });
  }
  return seedPromise;
}

async function seedBuiltin() {
  const stat = { items: 0, newItems: 0, impls: 0, templates: 0, newTemplates: 0 };
  const idByCode = new Map();
  for (const it of CAT_ITEMS) {
    const ex = await db.execute('SELECT ITEM_ID FROM DBI_CHECK_ITEM WHERE ITEM_CODE=:1', [it.code]);
    let itemId;
    const ruleJson = jstr(it.rule);
    if (ex.rows.length) {
      itemId = Number(ex.rows[0].ITEM_ID);
      await db.execute(
        `UPDATE DBI_CHECK_ITEM SET CATEGORY=:1, RULE_TYPE=:2, RULE_JSON=:3, SQL_BEARING=:4, SORT_NO=:5, UPDATED_AT=SYSTIMESTAMP WHERE ITEM_ID=:6 AND BUILTIN=1`,
        [it.category, it.rule.type, ruleJson, it.sqlBearing ? 1 : 0, it.sort || 100, itemId]);
    } else {
      const r = await db.execute(
        `INSERT INTO DBI_CHECK_ITEM (ITEM_CODE,ITEM_NAME,CATEGORY,DESCRIPTION,RULE_TYPE,RULE_JSON,WARN_VALUE,CRIT_VALUE,ADVICE,SQL_BEARING,BUILTIN,ENABLED,SORT_NO)
         VALUES (:1,:2,:3,:4,:5,:6,:7,:8,:9,:10,1,1,:11) RETURNING ITEM_ID INTO :12`,
        [it.code, fit(it.name, 128), it.category, fit(it.desc, 500), it.rule.type, ruleJson, it.warn ?? null, it.crit ?? null,
          fit(it.advice, 1000), it.sqlBearing ? 1 : 0, it.sort || 100, { type: oracledb.NUMBER, dir: oracledb.BIND_OUT }]);
      itemId = db.pluckOutBind(r);
      if (itemId == null) throw new Error('写入检查项失败：未取回 ITEM_ID');
      stat.newItems++;
    }
    idByCode.set(it.code, itemId);
    stat.items++;

    const have = await db.execute('SELECT IMPL_ID, DB_FAMILY, IS_CUSTOM FROM DBI_CHECK_IMPL WHERE ITEM_ID=:1', [itemId]);
    const haveMap = new Map(have.rows.map((r) => [r.DB_FAMILY, r]));
    for (const fam of FAMILIES) {
      const im = it.impls[fam];
      const row = haveMap.get(fam);
      if (!im) {
        if (row && Number(row.IS_CUSTOM) === 0) await db.execute('DELETE FROM DBI_CHECK_IMPL WHERE IMPL_ID=:1', [row.IMPL_ID]);
        continue;
      }
      const vals = [im.sql, im.fallback && im.fallback.length ? jstr(im.fallback) : null, im.map ? jstr(im.map) : null,
        im.adaptive ? `${im.adaptive}:${im.adaptiveMetric || ''}` : null, im.unit || null, im.warn ?? null, im.crit ?? null,
        im.dbTypes ? jstr(im.dbTypes) : null];
      if (!row) {
        await db.execute(
          `INSERT INTO DBI_CHECK_IMPL (ITEM_ID,DB_FAMILY,SQL_TEXT,FALLBACK_SQL,COL_MAP,ADAPTIVE,UNIT,WARN_VALUE,CRIT_VALUE,DB_TYPES,IS_CUSTOM,ENABLED)
           VALUES (:1,:2,:3,:4,:5,:6,:7,:8,:9,:10,0,1)`, [itemId, fam, ...vals]);
        stat.impls++;
      } else if (Number(row.IS_CUSTOM) === 0) {
        await db.execute(
          `UPDATE DBI_CHECK_IMPL SET SQL_TEXT=:1,FALLBACK_SQL=:2,COL_MAP=:3,ADAPTIVE=:4,UNIT=:5,WARN_VALUE=:6,CRIT_VALUE=:7,DB_TYPES=:8,UPDATED_AT=SYSTIMESTAMP WHERE IMPL_ID=:9`,
          [...vals, row.IMPL_ID]);
        stat.impls++;
      }
    }
  }
  for (const t of CAT_TEMPLATES) {
    const ex = await db.execute('SELECT TEMPLATE_ID FROM DBI_TEMPLATE WHERE TEMPLATE_CODE=:1', [t.code]);
    if (ex.rows.length) { stat.templates++; continue; }
    const r = await db.execute(
      `INSERT INTO DBI_TEMPLATE (TEMPLATE_CODE,TEMPLATE_NAME,KIND,DB_FAMILIES,DESCRIPTION,ALERT_RULES,BUILTIN,ENABLED)
       VALUES (:1,:2,:3,:4,:5,:6,1,1) RETURNING TEMPLATE_ID INTO :7`,
      [t.code, fit(t.name, 128), t.kind, t.families ? jstr(t.families) : null, fit(t.desc, 500), t.alertRules ? jstr(t.alertRules) : null,
        { type: oracledb.NUMBER, dir: oracledb.BIND_OUT }]);
    const tid = db.pluckOutBind(r);
    let no = 0;
    for (const code of t.items) {
      no += 10;
      await db.execute('INSERT INTO DBI_TEMPLATE_ITEM (TEMPLATE_ID,ITEM_ID,SORT_NO) VALUES (:1,:2,:3)', [tid, idByCode.get(code), no]);
    }
    stat.templates++; stat.newTemplates++;
  }
  return stat;
}

// ---------------------------------------------------------------- 检查项
function shapeImpl(r) {
  return {
    implId: Number(r.IMPL_ID), itemId: Number(r.ITEM_ID), family: r.DB_FAMILY, sql: r.SQL_TEXT,
    fallback: jparse(r.FALLBACK_SQL, []), map: jparse(r.COL_MAP, null),
    adaptive: r.ADAPTIVE ? String(r.ADAPTIVE).split(':')[0] : null,
    adaptiveMetric: r.ADAPTIVE ? String(r.ADAPTIVE).split(':')[1] || null : null,
    unit: r.UNIT, warn: r.WARN_VALUE, crit: r.CRIT_VALUE, dbTypes: jparse(r.DB_TYPES, null),
    isCustom: Number(r.IS_CUSTOM) === 1, enabled: Number(r.ENABLED) !== 0,
  };
}

async function listItems({ category, family, keyword } = {}) {
  await ensureSeeded();
  const items = (await db.execute('SELECT * FROM DBI_CHECK_ITEM ORDER BY SORT_NO, ITEM_ID')).rows;
  const impls = (await db.execute('SELECT IMPL_ID,ITEM_ID,DB_FAMILY,UNIT,WARN_VALUE,CRIT_VALUE,DB_TYPES,IS_CUSTOM,ENABLED FROM DBI_CHECK_IMPL')).rows;
  const thr = (await db.execute('SELECT ITEM_ID, COUNT(*) AS N FROM DBI_THRESHOLD GROUP BY ITEM_ID')).rows;
  const tpl = (await db.execute(
    `SELECT ti.ITEM_ID, t.TEMPLATE_ID, t.TEMPLATE_NAME FROM DBI_TEMPLATE_ITEM ti JOIN DBI_TEMPLATE t ON t.TEMPLATE_ID = ti.TEMPLATE_ID ORDER BY t.TEMPLATE_ID`)).rows;
  const implBy = new Map(); const thrBy = new Map(); const tplBy = new Map();
  for (const r of impls) { if (!implBy.has(r.ITEM_ID)) implBy.set(r.ITEM_ID, []); implBy.get(r.ITEM_ID).push(r); }
  for (const r of thr) thrBy.set(r.ITEM_ID, Number(r.N));
  for (const r of tpl) { if (!tplBy.has(r.ITEM_ID)) tplBy.set(r.ITEM_ID, []); tplBy.get(r.ITEM_ID).push({ templateId: r.TEMPLATE_ID, name: r.TEMPLATE_NAME }); }
  let out = items.map((r) => ({
    itemId: r.ITEM_ID, code: r.ITEM_CODE, name: r.ITEM_NAME, category: r.CATEGORY, description: r.DESCRIPTION,
    ruleType: r.RULE_TYPE, rule: jparse(r.RULE_JSON, {}), warn: r.WARN_VALUE, crit: r.CRIT_VALUE, advice: r.ADVICE,
    sqlBearing: Number(r.SQL_BEARING) === 1, builtin: Number(r.BUILTIN) === 1, enabled: Number(r.ENABLED) !== 0,
    families: (implBy.get(r.ITEM_ID) || []).filter((i) => Number(i.ENABLED) !== 0).map((i) => i.DB_FAMILY),
    impls: (implBy.get(r.ITEM_ID) || []).map((i) => ({ family: i.DB_FAMILY, unit: i.UNIT, warn: i.WARN_VALUE, crit: i.CRIT_VALUE, dbTypes: jparse(i.DB_TYPES, null), isCustom: Number(i.IS_CUSTOM) === 1 })),
    overrideCount: thrBy.get(r.ITEM_ID) || 0, templates: tplBy.get(r.ITEM_ID) || [],
  }));
  if (category) out = out.filter((i) => i.category === category);
  if (family) out = out.filter((i) => i.families.includes(family));
  if (keyword) { const k = String(keyword).toLowerCase(); out = out.filter((i) => `${i.code} ${i.name} ${i.description || ''}`.toLowerCase().includes(k)); }
  return out;
}

async function getItem(itemId) {
  const r = await db.execute('SELECT * FROM DBI_CHECK_ITEM WHERE ITEM_ID=:1', [itemId]);
  if (!r.rows.length) return null;
  const x = r.rows[0];
  const impls = (await db.execute('SELECT * FROM DBI_CHECK_IMPL WHERE ITEM_ID=:1 ORDER BY DB_FAMILY', [itemId])).rows.map(shapeImpl);
  const overrides = (await db.execute('SELECT * FROM DBI_THRESHOLD WHERE ITEM_ID=:1 ORDER BY SCOPE_TYPE, SCOPE_VALUE', [itemId])).rows.map(shapeOverride);
  return {
    itemId: x.ITEM_ID, code: x.ITEM_CODE, name: x.ITEM_NAME, category: x.CATEGORY, description: x.DESCRIPTION, ruleType: x.RULE_TYPE,
    rule: jparse(x.RULE_JSON, {}), warn: x.WARN_VALUE, crit: x.CRIT_VALUE, advice: x.ADVICE, sqlBearing: Number(x.SQL_BEARING) === 1,
    builtin: Number(x.BUILTIN) === 1, enabled: Number(x.ENABLED) !== 0, impls, overrides,
  };
}

const shapeOverride = (r) => ({
  thrId: Number(r.THR_ID), itemId: Number(r.ITEM_ID), scopeType: r.SCOPE_TYPE, scopeValue: r.SCOPE_VALUE,
  warn: r.WARN_VALUE, crit: r.CRIT_VALUE, enabled: Number(r.ENABLED) !== 0,
});

async function updateItem(itemId, d) {
  const sets = []; const binds = [];
  const push = (col, v) => { binds.push(v); sets.push(`${col}=:${binds.length}`); };
  if (d.name != null) push('ITEM_NAME', fit(d.name, 128));
  if (d.description != null) push('DESCRIPTION', fit(d.description, 500));
  if (d.advice != null) push('ADVICE', fit(d.advice, 1000));
  if (d.enabled != null) push('ENABLED', d.enabled ? 1 : 0);
  if ('warn' in d) push('WARN_VALUE', d.warn === '' ? null : d.warn);
  if ('crit' in d) push('CRIT_VALUE', d.crit === '' ? null : d.crit);
  if (!sets.length) return;
  binds.push(itemId);
  await db.execute(`UPDATE DBI_CHECK_ITEM SET ${sets.join(',')}, UPDATED_AT=SYSTIMESTAMP WHERE ITEM_ID=:${binds.length}`, binds);
}

async function createItem(d, userId) {
  const code = String(d.code || '').trim();
  if (!/^[a-z][a-z0-9_.]{2,63}$/.test(code)) throw Object.assign(new Error('检查项编码需小写字母开头，仅含小写字母 / 数字 / 下划线 / 点，3-64 位'), { code: 400 });
  const rule = d.rule || { type: 'THRESHOLD', direction: 'HIGH' };
  if (!['THRESHOLD', 'ROWS', 'STATUS', 'TOPN', 'INFO'].includes(String(rule.type).toUpperCase())) throw Object.assign(new Error('规则类型必须是 THRESHOLD / ROWS / STATUS / TOPN / INFO'), { code: 400 });
  rule.type = String(rule.type).toUpperCase();
  const r = await db.execute(
    `INSERT INTO DBI_CHECK_ITEM (ITEM_CODE,ITEM_NAME,CATEGORY,DESCRIPTION,RULE_TYPE,RULE_JSON,WARN_VALUE,CRIT_VALUE,ADVICE,SQL_BEARING,BUILTIN,ENABLED,SORT_NO,CREATED_BY)
     VALUES (:1,:2,:3,:4,:5,:6,:7,:8,:9,:10,0,1,500,:11) RETURNING ITEM_ID INTO :12`,
    [code, fit(d.name, 128), d.category || 'CONFIG', fit(d.description, 500), rule.type, jstr(rule), d.warn ?? null, d.crit ?? null, fit(d.advice, 1000),
      d.sqlBearing ? 1 : 0, userId ?? null, { type: oracledb.NUMBER, dir: oracledb.BIND_OUT }]);
  return db.pluckOutBind(r);
}

async function deleteItem(itemId) {
  const r = await db.execute('SELECT BUILTIN FROM DBI_CHECK_ITEM WHERE ITEM_ID=:1', [itemId]);
  if (!r.rows.length) throw Object.assign(new Error('检查项不存在'), { code: 404 });
  if (Number(r.rows[0].BUILTIN) === 1) throw Object.assign(new Error('内置检查项不能删除，可停用'), { code: 400 });
  await db.execute('DELETE FROM DBI_CHECK_ITEM WHERE ITEM_ID=:1', [itemId]);
}

/** “高级”：保存某方言的采集实现（保存后标记 IS_CUSTOM=1，重新写入内置目录时不覆盖） */
async function saveImpl(itemId, family, d) {
  if (!FAMILIES.includes(family)) throw Object.assign(new Error(`方言族必须是 ${FAMILIES.join('/')}`), { code: 400 });
  const sql = String(d.sql || '').trim();
  if (!sql && !d.adaptive) throw Object.assign(new Error('采集 SQL 不能为空'), { code: 400 });
  const { readOnlyViolation } = require('../utils/inspectScriptParser');
  for (const s of [sql, ...(d.fallback || [])]) {
    const v = s && !String(s).startsWith('-- adaptive') ? readOnlyViolation(s.replace(/\{\{\w+\}\}/g, '1')) : null;
    if (v) throw Object.assign(new Error(v), { code: 400 });
  }
  const ex = await db.execute('SELECT IMPL_ID FROM DBI_CHECK_IMPL WHERE ITEM_ID=:1 AND DB_FAMILY=:2', [itemId, family]);
  const vals = [sql, d.fallback && d.fallback.length ? jstr(d.fallback) : null, d.map ? jstr(d.map) : null, d.unit || null,
    d.warn === '' || d.warn == null ? null : d.warn, d.crit === '' || d.crit == null ? null : d.crit, d.enabled === false ? 0 : 1];
  if (ex.rows.length) {
    await db.execute('UPDATE DBI_CHECK_IMPL SET SQL_TEXT=:1,FALLBACK_SQL=:2,COL_MAP=:3,UNIT=:4,WARN_VALUE=:5,CRIT_VALUE=:6,ENABLED=:7,IS_CUSTOM=1,UPDATED_AT=SYSTIMESTAMP WHERE IMPL_ID=:8',
      [...vals, ex.rows[0].IMPL_ID]);
  } else {
    await db.execute('INSERT INTO DBI_CHECK_IMPL (SQL_TEXT,FALLBACK_SQL,COL_MAP,UNIT,WARN_VALUE,CRIT_VALUE,ENABLED,IS_CUSTOM,ITEM_ID,DB_FAMILY) VALUES (:1,:2,:3,:4,:5,:6,:7,1,:8,:9)',
      [...vals, itemId, family]);
  }
}

async function resetImpl(itemId, family) {
  const it = await db.execute('SELECT ITEM_CODE FROM DBI_CHECK_ITEM WHERE ITEM_ID=:1 AND BUILTIN=1', [itemId]);
  if (!it.rows.length) throw Object.assign(new Error('只有内置检查项可以恢复默认采集实现'), { code: 400 });
  await db.execute('UPDATE DBI_CHECK_IMPL SET IS_CUSTOM=0 WHERE ITEM_ID=:1 AND DB_FAMILY=:2', [itemId, family]);
  seedPromise = null;
  await ensureSeeded();
}

async function deleteImpl(itemId, family) {
  await db.execute('DELETE FROM DBI_CHECK_IMPL WHERE ITEM_ID=:1 AND DB_FAMILY=:2 AND IS_CUSTOM=1', [itemId, family]);
}

// ---------------------------------------------------------------- 阈值与范围
async function listOverrides(itemId) {
  return (await db.execute('SELECT * FROM DBI_THRESHOLD WHERE ITEM_ID=:1 ORDER BY SCOPE_TYPE, SCOPE_VALUE', [itemId])).rows.map(shapeOverride);
}
async function saveOverride(itemId, d, userId) {
  const type = String(d.scopeType || '').toUpperCase();
  if (!['DB_TYPE', 'ENV', 'BIZ_LINE', 'INSTANCE'].includes(type)) throw Object.assign(new Error('范围类型必须是 DB_TYPE / ENV / BIZ_LINE / INSTANCE'), { code: 400 });
  const val = String(d.scopeValue ?? '').trim();
  if (!val) throw Object.assign(new Error('范围值不能为空'), { code: 400 });
  const nz = (v) => (v === '' || v == null ? null : Number(v));
  const w = nz(d.warn); const c = nz(d.crit);
  if ((w != null && !Number.isFinite(w)) || (c != null && !Number.isFinite(c))) throw Object.assign(new Error('阈值必须是数字'), { code: 400 });
  const en = d.enabled === false ? 0 : 1;
  const ex = await db.execute('SELECT THR_ID FROM DBI_THRESHOLD WHERE ITEM_ID=:1 AND SCOPE_TYPE=:2 AND SCOPE_VALUE=:3', [itemId, type, val]);
  if (ex.rows.length) {
    await db.execute('UPDATE DBI_THRESHOLD SET WARN_VALUE=:1,CRIT_VALUE=:2,ENABLED=:3,UPDATED_BY=:4,UPDATED_AT=SYSTIMESTAMP WHERE THR_ID=:5', [w, c, en, userId ?? null, ex.rows[0].THR_ID]);
  } else {
    await db.execute('INSERT INTO DBI_THRESHOLD (ITEM_ID,SCOPE_TYPE,SCOPE_VALUE,WARN_VALUE,CRIT_VALUE,ENABLED,UPDATED_BY) VALUES (:1,:2,:3,:4,:5,:6,:7)', [itemId, type, val, w, c, en, userId ?? null]);
  }
}
async function deleteOverride(thrId) { await db.execute('DELETE FROM DBI_THRESHOLD WHERE THR_ID=:1', [thrId]); }

// ---------------------------------------------------------------- 模板
async function listTemplates() {
  await ensureSeeded();
  const ts = (await db.execute(
    `SELECT t.*, (SELECT COUNT(*) FROM DBI_TEMPLATE_ITEM ti WHERE ti.TEMPLATE_ID=t.TEMPLATE_ID) AS ITEM_CNT FROM DBI_TEMPLATE t ORDER BY t.TEMPLATE_ID`)).rows;
  const plans = (await db.execute('SELECT TEMPLATE_ID, PLAN_NAME FROM DBI_PLAN')).rows;
  return ts.map((t) => ({
    templateId: t.TEMPLATE_ID, code: t.TEMPLATE_CODE, name: t.TEMPLATE_NAME, kind: t.KIND, families: jparse(t.DB_FAMILIES, null),
    description: t.DESCRIPTION, alertRules: jparse(t.ALERT_RULES, []), builtin: Number(t.BUILTIN) === 1, enabled: Number(t.ENABLED) !== 0,
    itemCount: Number(t.ITEM_CNT), plans: plans.filter((p) => p.TEMPLATE_ID === t.TEMPLATE_ID).map((p) => p.PLAN_NAME),
  }));
}
async function getTemplate(id) {
  const r = await db.execute('SELECT * FROM DBI_TEMPLATE WHERE TEMPLATE_ID=:1', [id]);
  if (!r.rows.length) return null;
  const t = r.rows[0];
  const items = (await db.execute(
    `SELECT i.ITEM_ID, i.ITEM_CODE, i.ITEM_NAME, i.CATEGORY, ti.SORT_NO FROM DBI_TEMPLATE_ITEM ti JOIN DBI_CHECK_ITEM i ON i.ITEM_ID=ti.ITEM_ID
      WHERE ti.TEMPLATE_ID=:1 ORDER BY ti.SORT_NO, i.ITEM_ID`, [id])).rows;
  return {
    templateId: t.TEMPLATE_ID, code: t.TEMPLATE_CODE, name: t.TEMPLATE_NAME, kind: t.KIND, families: jparse(t.DB_FAMILIES, null),
    description: t.DESCRIPTION, alertRules: jparse(t.ALERT_RULES, []), builtin: Number(t.BUILTIN) === 1, enabled: Number(t.ENABLED) !== 0,
    items: items.map((i) => ({ itemId: i.ITEM_ID, code: i.ITEM_CODE, name: i.ITEM_NAME, category: i.CATEGORY })),
  };
}
async function saveTemplate(id, d, userId) {
  const name = fit(String(d.name || '').trim(), 128);
  if (!name) throw Object.assign(new Error('模板名称不能为空'), { code: 400 });
  const kind = ['DAILY', 'SPECIAL', 'BASELINE'].includes(d.kind) ? d.kind : 'DAILY';
  const itemIds = [...new Set((d.itemIds || []).map(Number).filter(Number.isFinite))];
  const fams = Array.isArray(d.families) && d.families.length ? d.families.filter((f) => FAMILIES.includes(f)) : null;
  return db.withTransaction(async (tx) => {
    let tid = id;
    if (tid) {
      await tx.execute('UPDATE DBI_TEMPLATE SET TEMPLATE_NAME=:1,KIND=:2,DESCRIPTION=:3,ALERT_RULES=:4,DB_FAMILIES=:5,ENABLED=:6,UPDATED_AT=SYSTIMESTAMP WHERE TEMPLATE_ID=:7',
        [name, kind, fit(d.description, 500), jstr(d.alertRules && d.alertRules.length ? d.alertRules : null), jstr(fams), d.enabled === false ? 0 : 1, tid]);
      await tx.execute('DELETE FROM DBI_TEMPLATE_ITEM WHERE TEMPLATE_ID=:1', [tid]);
    } else {
      const code = String(d.code || `tpl_${Date.now().toString(36)}`).replace(/[^\w-]/g, '_').slice(0, 64);
      const r = await tx.execute(
        `INSERT INTO DBI_TEMPLATE (TEMPLATE_CODE,TEMPLATE_NAME,KIND,DB_FAMILIES,DESCRIPTION,ALERT_RULES,BUILTIN,ENABLED,CREATED_BY) VALUES (:1,:2,:3,:4,:5,:6,0,1,:7) RETURNING TEMPLATE_ID INTO :8`,
        [code, name, kind, jstr(fams), fit(d.description, 500), jstr(d.alertRules && d.alertRules.length ? d.alertRules : null), userId ?? null, { type: oracledb.NUMBER, dir: oracledb.BIND_OUT }]);
      tid = db.pluckOutBind(r);
    }
    let no = 0;
    for (const iid of itemIds) { no += 10; await tx.execute('INSERT INTO DBI_TEMPLATE_ITEM (TEMPLATE_ID,ITEM_ID,SORT_NO) VALUES (:1,:2,:3)', [tid, iid, no]); }
    return tid;
  });
}
async function deleteTemplate(id) {
  const used = await db.execute('SELECT COUNT(*) AS N FROM DBI_PLAN WHERE TEMPLATE_ID=:1', [id]);
  if (Number(used.rows[0].N) > 0) throw Object.assign(new Error('该模板正被巡检计划引用，请先修改或删除计划'), { code: 400 });
  const r = await db.execute('SELECT BUILTIN FROM DBI_TEMPLATE WHERE TEMPLATE_ID=:1', [id]);
  if (r.rows.length && Number(r.rows[0].BUILTIN) === 1) throw Object.assign(new Error('内置模板不能删除'), { code: 400 });
  await db.execute('DELETE FROM DBI_TEMPLATE WHERE TEMPLATE_ID=:1', [id]);
}

// ---------------------------------------------------------------- 计划
const shapePlan = (p) => ({
  planId: p.PLAN_ID, name: p.PLAN_NAME, templateId: p.TEMPLATE_ID, templateName: p.TEMPLATE_NAME, scope: jparse(p.SCOPE_JSON, {}),
  cron: p.CRON_EXPR, windowStart: p.WINDOW_START, windowEnd: p.WINDOW_END, enabled: Number(p.ENABLED) !== 0,
  lastRunId: p.LAST_RUN_ID, lastRunAt: p.LAST_RUN_AT, lastStatus: p.LAST_STATUS, lastSummary: p.LAST_SUMMARY,
});
async function listPlans() {
  const rows = (await db.execute(
    `SELECT p.*, t.TEMPLATE_NAME, r.STATUS AS LAST_STATUS,
            CASE WHEN r.RUN_ID IS NULL THEN NULL ELSE '成功 ' || r.OK_INST || '/' || r.TOTAL_INST END AS LAST_SUMMARY
       FROM DBI_PLAN p LEFT JOIN DBI_TEMPLATE t ON t.TEMPLATE_ID=p.TEMPLATE_ID LEFT JOIN DBI_RUN r ON r.RUN_ID=p.LAST_RUN_ID ORDER BY p.PLAN_ID`)).rows;
  return rows.map(shapePlan);
}
async function getPlan(id) {
  const r = await db.execute(`SELECT p.*, t.TEMPLATE_NAME FROM DBI_PLAN p LEFT JOIN DBI_TEMPLATE t ON t.TEMPLATE_ID=p.TEMPLATE_ID WHERE p.PLAN_ID=:1`, [id]);
  return r.rows.length ? shapePlan(r.rows[0]) : null;
}
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
async function savePlan(id, d, userId) {
  const name = fit(String(d.name || '').trim(), 128);
  if (!name) throw Object.assign(new Error('计划名称不能为空'), { code: 400 });
  if (!d.templateId) throw Object.assign(new Error('请选择巡检模板'), { code: 400 });
  const cron = String(d.cron || '').trim() || null;
  if (cron) {
    const nodeCron = require('node-cron');
    const norm = cron.split(/\s+/).length === 6 ? cron : cron;
    if (!nodeCron.validate(norm)) throw Object.assign(new Error(`cron 表达式不合法：${cron}`), { code: 400 });
  }
  const ws = d.windowStart || null; const we = d.windowEnd || null;
  if ((ws && !HHMM.test(ws)) || (we && !HHMM.test(we)) || (!!ws !== !!we)) throw Object.assign(new Error('执行窗口需成对填写 HH:mm，如 01:00 至 06:00'), { code: 400 });
  const scope = {
    dbTypes: (d.scope?.dbTypes || []).map(String), envs: (d.scope?.envs || []).map(String),
    bizLines: (d.scope?.bizLines || []).map(String), instanceIds: (d.scope?.instanceIds || []).map(Number).filter(Number.isFinite),
  };
  if (id) {
    await db.execute('UPDATE DBI_PLAN SET PLAN_NAME=:1,TEMPLATE_ID=:2,SCOPE_JSON=:3,CRON_EXPR=:4,WINDOW_START=:5,WINDOW_END=:6,ENABLED=:7,UPDATED_AT=SYSTIMESTAMP WHERE PLAN_ID=:8',
      [name, d.templateId, fit(jstr(scope), 3900), cron, ws, we, d.enabled === false ? 0 : 1, id]);
    return id;
  }
  const r = await db.execute(
    `INSERT INTO DBI_PLAN (PLAN_NAME,TEMPLATE_ID,SCOPE_JSON,CRON_EXPR,WINDOW_START,WINDOW_END,ENABLED,CREATED_BY) VALUES (:1,:2,:3,:4,:5,:6,:7,:8) RETURNING PLAN_ID INTO :9`,
    [name, d.templateId, fit(jstr(scope), 3900), cron, ws, we, d.enabled === false ? 0 : 1, userId ?? null, { type: oracledb.NUMBER, dir: oracledb.BIND_OUT }]);
  return db.pluckOutBind(r);
}
async function deletePlan(id) { await db.execute('DELETE FROM DBI_PLAN WHERE PLAN_ID=:1', [id]); }

// ---------------------------------------------------------------- 实例范围
const SUPPORTED_TYPES = ['ORACLE', 'MYSQL', 'GOLDENDB', 'POSTGRESQL', 'PANWEI', 'DAMENG'];
async function listInstances() {
  const r = await db.execute(`SELECT INSTANCE_ID, INSTANCE_NAME, DB_TYPE, HOST_IP, PORT, ENVIRONMENT, BIZ_LINE, STATUS FROM CMDB_INSTANCE ORDER BY INSTANCE_NAME`);
  return r.rows.filter((x) => SUPPORTED_TYPES.includes(String(x.DB_TYPE).toUpperCase()));
}
async function listScopeOptions() {
  const inst = await listInstances();
  const uniq = (k) => [...new Set(inst.map((i) => i[k]).filter(Boolean))].sort();
  return {
    dbTypes: uniq('DB_TYPE'), envs: uniq('ENVIRONMENT'), bizLines: uniq('BIZ_LINE'),
    instances: inst.map((i) => ({ instanceId: i.INSTANCE_ID, name: i.INSTANCE_NAME, dbType: i.DB_TYPE, host: `${i.HOST_IP}:${i.PORT ?? ''}`, env: i.ENVIRONMENT, bizLine: i.BIZ_LINE, status: i.STATUS })),
  };
}
/** 计划范围 + 模板方言限制 → 实例清单 */
async function resolveInstances(scope, template) {
  const all = (await listInstances()).filter((i) => String(i.STATUS || 'RUNNING').toUpperCase() !== 'STOPPED');
  const s = scope || {};
  let out = all;
  if (s.instanceIds && s.instanceIds.length) {
    const set = new Set(s.instanceIds.map(Number));
    out = all.filter((i) => set.has(Number(i.INSTANCE_ID)));
  } else {
    if (s.dbTypes && s.dbTypes.length) { const set = new Set(s.dbTypes.map((x) => String(x).toUpperCase())); out = out.filter((i) => set.has(String(i.DB_TYPE).toUpperCase()) || set.has(familyOf(i.DB_TYPE))); }
    if (s.envs && s.envs.length) { const set = new Set(s.envs.map((x) => String(x).toUpperCase())); out = out.filter((i) => set.has(String(i.ENVIRONMENT || '').toUpperCase())); }
    if (s.bizLines && s.bizLines.length) { const set = new Set(s.bizLines.map(String)); out = out.filter((i) => set.has(String(i.BIZ_LINE || ''))); }
  }
  if (template && template.families && template.families.length) out = out.filter((i) => template.families.includes(familyOf(i.DB_TYPE)));
  return out;
}

// ---------------------------------------------------------------- 运行时：加载模板的检查项（含实现 + 阈值覆盖）
async function loadRunItems(templateId, onlyCode, itemCodes) {
  await ensureSeeded();
  let sql; const binds = [];
  if (itemCodes && itemCodes.length) {            // 复检：直接按检查项编码取，不依赖模板
    sql = `SELECT i.* FROM DBI_CHECK_ITEM i WHERE i.ENABLED=1 AND i.ITEM_CODE IN (${itemCodes.map((_, k) => `:${k + 1}`).join(',')}) ORDER BY i.SORT_NO`;
    binds.push(...itemCodes);
  } else {
    sql = `SELECT i.* FROM DBI_TEMPLATE_ITEM ti JOIN DBI_CHECK_ITEM i ON i.ITEM_ID=ti.ITEM_ID WHERE ti.TEMPLATE_ID=:1 AND i.ENABLED=1`;
    binds.push(templateId);
    if (onlyCode) { sql += ' AND i.ITEM_CODE=:2'; binds.push(onlyCode); }
    sql += ' ORDER BY ti.SORT_NO, i.ITEM_ID';
  }
  const items = (await db.execute(sql, binds)).rows;
  if (!items.length) return [];
  const ids = items.map((i) => i.ITEM_ID);
  const ph = ids.map((_, k) => `:${k + 1}`).join(',');
  const impls = (await db.execute(`SELECT * FROM DBI_CHECK_IMPL WHERE ENABLED=1 AND ITEM_ID IN (${ph})`, ids)).rows;
  const thr = (await db.execute(`SELECT * FROM DBI_THRESHOLD WHERE ITEM_ID IN (${ph})`, ids)).rows;
  return items.map((i) => ({
    ...i, rule: { ...jparse(i.RULE_JSON, {}), type: i.RULE_TYPE },
    implByFamily: Object.fromEntries(impls.filter((m) => m.ITEM_ID === i.ITEM_ID).map((m) => [m.DB_FAMILY, shapeImpl(m)])),
    overrides: thr.filter((t) => t.ITEM_ID === i.ITEM_ID),
  }));
}

// ---------------------------------------------------------------- 问题项
async function upsertIssue(runId, inst, item, f) {
  const key = fit(f.objectKey || '-', 250);
  const binds = {
    sev: f.level, title: fit(f.title, 500), cur: fit(f.value, 120), thr: fit(f.thresholdText, 120),
    ev: JSON.stringify({ ...f.evidence, ...(f.planHash ? { PLAN_HASH: f.planHash } : {}) }).slice(0, 30000),
    advice: fit(item.ADVICE, 1000), sqlId: fit(f.sqlId, 120), kind: f.sqlIdKind || null, sqlText: fit(f.sqlText, 1900), run: runId,
  };
  const find = () => db.execute(`SELECT ISSUE_ID, STATUS FROM DBI_ISSUE WHERE INSTANCE_ID=:1 AND ITEM_CODE=:2 AND OBJECT_KEY=:3 AND STATUS<>'FIXED'`, [inst.INSTANCE_ID, item.ITEM_CODE, key]);
  const update = async (id) => db.execute(
    `UPDATE DBI_ISSUE SET SEVERITY=:sev,TITLE=:title,CURRENT_VALUE=:cur,THRESHOLD_TEXT=:thr,EVIDENCE=:ev,ADVICE=:advice,SQL_ID=:sqlId,SQL_ID_KIND=:kind,SQL_TEXT=:sqlText,
            LAST_RUN_ID=:run,LAST_SEEN=SYSTIMESTAMP,OCCURRENCES=OCCURRENCES+1 WHERE ISSUE_ID=:id`, { ...binds, id });
  let ex = await find();
  if (ex.rows.length) { await update(ex.rows[0].ISSUE_ID); return { issueId: ex.rows[0].ISSUE_ID, status: ex.rows[0].STATUS, isNew: false }; }
  try {
    const r = await db.execute(
      `INSERT INTO DBI_ISSUE (INSTANCE_ID,INSTANCE_NAME,DB_TYPE,HOST_IP,ITEM_ID,ITEM_CODE,ITEM_NAME,CATEGORY,OBJECT_KEY,SEVERITY,TITLE,CURRENT_VALUE,THRESHOLD_TEXT,EVIDENCE,ADVICE,SQL_ID,SQL_ID_KIND,SQL_TEXT,STATUS,FIRST_RUN_ID,LAST_RUN_ID)
       VALUES (:iid,:iname,:dbt,:host,:itemId,:code,:iname2,:cat,:key,:sev,:title,:cur,:thr,:ev,:advice,:sqlId,:kind,:sqlText,'OPEN',:run,:run) RETURNING ISSUE_ID INTO :rid`,
      { iid: inst.INSTANCE_ID, iname: fit(inst.INSTANCE_NAME, 128), dbt: inst.DB_TYPE, host: inst.HOST_IP, itemId: item.ITEM_ID, code: item.ITEM_CODE, iname2: fit(item.ITEM_NAME, 128),
        cat: item.CATEGORY, key, ...binds, rid: { type: oracledb.NUMBER, dir: oracledb.BIND_OUT } });
    return { issueId: db.pluckOutBind(r, 'rid'), status: 'OPEN', isNew: true };
  } catch (e) {
    if (/ORA-00001/.test(String(e.message))) {         // 并发写入同一问题：改为更新
      ex = await find();
      if (ex.rows.length) { await update(ex.rows[0].ISSUE_ID); return { issueId: ex.rows[0].ISSUE_ID, status: ex.rows[0].STATUS, isNew: false }; }
    }
    throw e;
  }
}

/** 本次已成功采集的检查项里，不再出现的问题 → 自动置为“已整改” */
async function autoFixIssues(runId, instanceId, checked) {
  let fixed = 0;
  for (const [code, seen] of checked) {
    const r = await db.execute(`SELECT ISSUE_ID, OBJECT_KEY FROM DBI_ISSUE WHERE INSTANCE_ID=:1 AND ITEM_CODE=:2 AND STATUS<>'FIXED'`, [instanceId, code]);
    for (const row of r.rows) {
      if (seen.has(row.OBJECT_KEY)) continue;
      await db.execute(`UPDATE DBI_ISSUE SET STATUS='FIXED', FIXED_AT=SYSTIMESTAMP, LAST_RUN_ID=:1, HANDLED_BY=NVL(HANDLED_BY,'auto') WHERE ISSUE_ID=:2`, [runId, row.ISSUE_ID]);
      fixed++;
    }
  }
  return fixed;
}

async function setIssueStatus(issueId, status, user, note) {
  if (!['OPEN', 'FIXING', 'FIXED', 'IGNORED'].includes(status)) throw Object.assign(new Error('状态必须是 OPEN / FIXING / FIXED / IGNORED'), { code: 400 });
  // :status 在 SET 和 CASE 里各出现一次。数组绑定按出现次数计数，4 个值对不上 5 个占位符（NJS-098），状态改不了。
  const r = await db.execute(
    `UPDATE DBI_ISSUE SET STATUS=:status, HANDLED_BY=:handledBy, NOTE=NVL(:note, NOTE),
            FIXED_AT=CASE WHEN :status='FIXED' THEN SYSTIMESTAMP ELSE FIXED_AT END
      WHERE ISSUE_ID=:issueId`,
    { status, handledBy: fit(user, 64), note: note ? fit(note, 500) : null, issueId });
  return r.rowsAffected;
}

module.exports = {
  fit, jparse, jstr, ensureSeeded, seedBuiltin, reseed: async () => { seedPromise = null; return ensureSeeded(); },
  listItems, getItem, updateItem, createItem, deleteItem, saveImpl, resetImpl, deleteImpl,
  listOverrides, saveOverride, deleteOverride,
  listTemplates, getTemplate, saveTemplate, deleteTemplate,
  listPlans, getPlan, savePlan, deletePlan,
  listInstances, listScopeOptions, resolveInstances, loadRunItems,
  upsertIssue, autoFixIssues, setIssueStatus, SUPPORTED_TYPES,
};
