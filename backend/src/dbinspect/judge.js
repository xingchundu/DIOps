'use strict';
/**
 * 判定规则引擎（纯函数，无 IO，可单测）。
 * 采集只取数，判定统一在这里完成：同一个规则对 4 个方言族的结果一视同仁，
 * 方言差异只体现在“采集 SQL / 单位 / 默认阈值”上。
 *
 * 规则类型
 *   THRESHOLD  逐行取 VAL 与阈值比较。direction=HIGH(越大越差，默认) / LOW(越小越差)。
 *   ROWS       有返回行即异常（每行一条问题）；行数 ≥ 严重阈值 → 全部升级为严重。
 *   STATUS     TXT 不在 ok 列表 / 在 bad 列表 → 异常，级别取 rule.level。
 *   TOPN       只展示不判定（SQL 洞察里的 Top SQL 排行）。
 *   INFO       只展示不判定（基础信息）。
 *
 * 结果行约定（列名不区分大小写，统一转大写）：
 *   OBJ 对象 / VAL 数值 / TXT 文本状态 / SQL_ID / SQL_ID_KIND / SQL_TEXT / PLAN_HASH / SCHEMA_NAME …其余列作为证据。
 */

const LEVEL_RANK = { OK: 0, INFO: 0, NA: 0, ERROR: 0, WARNING: 1, CRITICAL: 2 };
const SEVERITY_LABEL = { CRITICAL: '严重', WARNING: '警告', OK: '正常', INFO: '信息', NA: '不适用', ERROR: '采集失败' };

function num(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = Number(String(v).replace(/[%,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function fmtNum(n) {
  if (n == null) return '—';
  if (Math.abs(n) >= 1000 && Number.isInteger(n)) return String(n);
  return String(Math.round(n * 100) / 100);
}

/** 大小写不敏感取列 */
function pick(row, names) {
  if (!row) return undefined;
  const list = Array.isArray(names) ? names : [names];
  for (const n of list) {
    const k = String(n).toUpperCase();
    if (row[k] !== undefined) return row[k];
  }
  return undefined;
}

/**
 * 解析生效阈值：实例 > 业务线 > 环境 > 库类型 > 方言默认(impl) > 全局默认(item)。
 * warn / crit 各自独立向上回落；enabled 取最具体的那条范围。
 * @param {{WARN_VALUE,CRIT_VALUE}} item
 * @param {{WARN_VALUE,CRIT_VALUE}|null} impl
 * @param {Array<{SCOPE_TYPE,SCOPE_VALUE,WARN_VALUE,CRIT_VALUE,ENABLED}>} overrides  该检查项全部范围覆盖
 * @param {{dbType:string,family:string,env?:string,bizLine?:string,instanceId:number}} ctx
 */
function resolveThreshold(item, impl, overrides, ctx) {
  const order = [
    ['INSTANCE', String(ctx.instanceId)],
    ['BIZ_LINE', ctx.bizLine],
    ['ENV', ctx.env],
    ['DB_TYPE', ctx.dbType],
    ['DB_TYPE', ctx.family],
  ];
  const hits = [];
  for (const [t, v] of order) {
    if (v == null || v === '') continue;
    const o = (overrides || []).find((x) => x.SCOPE_TYPE === t && String(x.SCOPE_VALUE).toUpperCase() === String(v).toUpperCase());
    if (o) hits.push({ ...o, _src: `${t}:${o.SCOPE_VALUE}` });
  }
  const firstNum = (key, fallback) => {
    for (const h of hits) if (h[key] != null) return { v: Number(h[key]), src: h._src };
    for (const x of [impl, item]) if (x && x[key] != null) return { v: Number(x[key]), src: x === impl ? 'IMPL' : 'GLOBAL' };
    return { v: fallback, src: 'NONE' };
  };
  const warn = firstNum('WARN_VALUE', null);
  const crit = firstNum('CRIT_VALUE', null);
  const enabled = hits.length ? Number(hits[0].ENABLED) !== 0 : true;
  return { warn: warn.v, crit: crit.v, enabled, warnSource: warn.src, critSource: crit.src };
}

const EVIDENCE_SKIP = new Set(['SQL_TEXT']);
function evidenceRow(row, max = 12) {
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(row)) {
    if (EVIDENCE_SKIP.has(k)) continue;
    if (v == null || v === '') continue;
    out[k] = typeof v === 'string' && v.length > 120 ? `${v.slice(0, 120)}…` : v;
    if (++n >= max) break;
  }
  return out;
}

function thresholdText(rule, thr, unit) {
  const u = unit || '';
  if (rule.type === 'THRESHOLD') {
    const op = String(rule.direction || 'HIGH').toUpperCase() === 'LOW' ? '<=' : '>=';
    const parts = [];
    if (thr.warn != null) parts.push(`警告 ${op}${fmtNum(thr.warn)}${u}`);
    if (thr.crit != null) parts.push(`严重 ${op}${fmtNum(thr.crit)}${u}`);
    return parts.join('，');
  }
  if (rule.type === 'ROWS') {
    return `有记录即异常${thr.crit != null ? `，≥${fmtNum(thr.crit)} 条严重` : ''}`;
  }
  if (rule.type === 'STATUS') {
    if (rule.ok && rule.ok.length) return `期望：${rule.ok.join('/')}`;
    if (rule.bad && rule.bad.length) return `异常：${rule.bad.join('/')}`;
  }
  return '';
}

function objectOf(row, item) {
  const sqlId = row.SQL_ID && item.SQL_BEARING ? String(row.SQL_ID) : null;
  const obj = row.OBJ != null && row.OBJ !== '' ? String(row.OBJ) : null;
  if (item.SQL_BEARING) {
    // SQL 类：以 sql_id 为对象键；同一 sql_id 的不同对象（如不同会话）用 OBJ 区分，避免互相覆盖
    if (sqlId && obj && obj !== sqlId) return `${sqlId}@${obj}`.slice(0, 250);
    return (sqlId || obj || '-').slice(0, 250);
  }
  return (obj || '-').slice(0, 250);
}

function mkFinding(level, row, item, rule, unit, title, thrText, value) {
  return {
    level,
    objectKey: objectOf(row, item),
    obj: row.OBJ != null ? String(row.OBJ) : null,
    value: value == null ? null : (typeof value === 'number' ? fmtNum(value) : String(value)),
    unit: unit || '',
    title,
    thresholdText: thrText,
    sqlId: item.SQL_BEARING ? (row.SQL_ID || null) : null,
    sqlIdKind: item.SQL_BEARING ? (row.SQL_ID_KIND || null) : null,
    sqlText: item.SQL_BEARING ? (row.SQL_TEXT || null) : null,
    planHash: row.PLAN_HASH != null ? String(row.PLAN_HASH) : null,
    evidence: evidenceRow(row),
  };
}

/**
 * @param {{ITEM_CODE,ITEM_NAME,SQL_BEARING,RULE_TYPE,rule:object}} item  rule = 已解析的 RULE_JSON（含 type）
 * @param {Array<object>} rows 采集结果（键已大写）
 * @param {{warn,crit,enabled}} thr
 * @param {string} unit
 * @returns {{status:string, findings:Array, worstValue:string|null, thresholdText:string, message:string}}
 */
function judge(item, rows, thr, unit) {
  const rule = { ...(item.rule || {}), type: String(item.RULE_TYPE || item.rule?.type || 'INFO').toUpperCase() };
  const u = unit != null ? unit : (rule.unit || '');
  const maxFindings = Math.max(1, Number(rule.maxFindings) || 20);
  const thrText = thresholdText(rule, thr, u);
  const findings = [];
  const name = item.ITEM_NAME || item.ITEM_CODE;

  if (rule.type === 'TOPN' || rule.type === 'INFO') {
    return { status: 'INFO', findings, worstValue: null, thresholdText: '', message: rows.length ? `${rows.length} 条` : '无返回数据' };
  }
  if (!rows.length) {
    return { status: 'OK', findings, worstValue: null, thresholdText: thrText, message: '无返回数据（无对象超过阈值，或该特性未启用）' };
  }

  if (rule.type === 'THRESHOLD') {
    const low = String(rule.direction || 'HIGH').toUpperCase() === 'LOW';
    const hit = (v, t) => (t != null && (low ? v <= t : v >= t));
    let worst = null;
    for (const row of rows) {
      const v = num(pick(row, ['VAL']));
      const objTxt = row.OBJ != null && row.OBJ !== '' ? String(row.OBJ) : '';
      const sqlTxt = item.SQL_BEARING && row.SQL_ID ? `SQL ${row.SQL_ID}` : '';
      const who = sqlTxt || objTxt;
      if (v == null) {
        if (rule.nullLevel && LEVEL_RANK[rule.nullLevel]) {
          findings.push(mkFinding(rule.nullLevel, row, item, rule, u,
            `${name}${who ? `：${who}` : ''} 无有效数据（${rule.nullText || '未取到值'}）`, thrText, null));
        }
        continue;
      }
      let level = null;
      let against = null;
      if (hit(v, thr.crit)) { level = 'CRITICAL'; against = thr.crit; } else if (hit(v, thr.warn)) { level = 'WARNING'; against = thr.warn; }
      if (!worst || (low ? v < worst.v : v > worst.v)) worst = { v };
      if (level) {
        const dirTxt = low ? '低于' : '超过';
        findings.push(mkFinding(level, row, item, rule, u,
          `${name}${who ? `：${who}` : ''} 当前 ${fmtNum(v)}${u}，${dirTxt}${level === 'CRITICAL' ? '严重' : '警告'}阈值 ${fmtNum(against)}${u}`,
          thrText, v));
      }
    }
    findings.sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level]);
    const cut = findings.slice(0, maxFindings);
    return finish(cut, findings.length, worst ? `${fmtNum(worst.v)}${u}` : null, thrText, rows.length);
  }

  if (rule.type === 'ROWS') {
    const warnN = thr.warn != null ? thr.warn : 1;
    const count = rows.length;
    if (count < warnN) return { status: 'OK', findings, worstValue: String(count), thresholdText: thrText, message: `${count} 条，未达阈值` };
    const escalate = thr.crit != null && count >= thr.crit;
    const base = rule.level === 'CRITICAL' ? 'CRITICAL' : 'WARNING';
    const level = escalate ? 'CRITICAL' : base;
    for (const row of rows.slice(0, maxFindings)) {
      const who = (item.SQL_BEARING && row.SQL_ID) ? `SQL ${row.SQL_ID}` : (row.OBJ != null ? String(row.OBJ) : '');
      const extra = row.TXT != null && row.TXT !== '' ? `（${row.TXT}）` : '';
      findings.push(mkFinding(level, row, item, rule, u, `${name}${who ? `：${who}` : ''}${extra}，共 ${count} 条`, thrText, row.VAL != null ? num(row.VAL) ?? row.VAL : null));
    }
    return finish(findings, count, String(count), thrText, count);
  }

  if (rule.type === 'STATUS') {
    const ok = (rule.ok || []).map((x) => String(x).toUpperCase());
    const bad = (rule.bad || []).map((x) => String(x).toUpperCase());
    const level = rule.level === 'WARNING' ? 'WARNING' : 'CRITICAL';
    let lastTxt = null;
    for (const row of rows) {
      const t = row.TXT != null ? String(row.TXT).trim() : '';
      lastTxt = t;
      const T = t.toUpperCase();
      // 同时配了期望值和异常值时，两边都要生效：不在期望列表，或落在异常列表，都算异常。
      // 原先只要配了 bad，ok 就被丢掉，期望之外的状态会判成正常。
      const isBad = (bad.length && bad.includes(T)) || (ok.length && !ok.includes(T));
      if (isBad) {
        findings.push(mkFinding(level, row, item, rule, '',
          `${name}${row.OBJ ? `：${row.OBJ}` : ''} 状态为 ${t || '空'}${ok.length ? `（期望 ${rule.ok.join('/')}）` : ''}`, thrText, t));
      }
    }
    return finish(findings.slice(0, maxFindings), findings.length, lastTxt, thrText, rows.length);
  }

  return { status: 'INFO', findings, worstValue: null, thresholdText: '', message: `未知规则类型 ${rule.type}` };
}

function finish(findings, totalFindings, worstValue, thrText, rowCount) {
  let status = 'OK';
  for (const f of findings) if (LEVEL_RANK[f.level] > LEVEL_RANK[status]) status = f.level;
  const message = findings.length
    ? `${totalFindings} 项异常${totalFindings > findings.length ? `（显示前 ${findings.length}）` : ''}`
    : `共 ${rowCount} 行，均在阈值内`;
  return { status, findings, worstValue, thresholdText: thrText, message, truncated: totalFindings > findings.length };
}

/** 实例得分：严重每项 -10（最多 -60），警告每项 -3（最多 -30） */
function scoreOf(critCount, warnCount) {
  return Math.max(0, 100 - Math.min(60, critCount * 10) - Math.min(30, warnCount * 3));
}

module.exports = { judge, resolveThreshold, scoreOf, num, pick, fmtNum, objectOf, SEVERITY_LABEL, LEVEL_RANK };
