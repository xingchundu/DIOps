/**
 * 巡检“发现项”引擎：把脚本执行得到的结果集变成可读的问题清单 + 综合评分。
 *
 * 为什么需要：旧实现的评分只数 “ORA-xxxxx / CRITICAL 字样出现了几次（每次 -3）”，
 * 没有脚本时 5 份报告全部写死 100 分 NORMAL；Word 里只有原始表格，看不出哪里有问题。
 *
 * 发现项来源（按优先级）：
 *   1. 脚本里的 `-- @rule` 指令（用户手工配置的阈值，最精确）
 *   2. 通用启发式：使用率列、状态列、风险等级列、错误文本、“列出异常对象”类检查项有返回行
 *   3. 脚本执行失败（权限不足 / 视图不存在 / 语法错误）—— 单独计为“采集异常”，不算数据库问题但会扣分提示
 *
 * 级别：CRITICAL（严重） / WARNING（警告） / INFO（提示）
 */
'use strict';

const LEVEL_RANK = { CRITICAL: 3, WARNING: 2, INFO: 1 };
const LEVEL_LABEL = { CRITICAL: '严重', WARNING: '警告', INFO: '提示' };

const USAGE_COL = /(^|_)(USED_?PCT|PCT_?USED|USED_?PERCENT|PERCENT_?USED|USAGE_?PCT|USAGE|UTIL|UTILIZATION|FULL_?PCT)(_|$)|使用率|占用率|利用率/i;
// [fix] 命中率 / 成功率 / 空闲率 / 可用率「越高越好」，原来被 USAGE_COL 当成使用率，99% 会被误判为 CRITICAL
const GOOD_HIGH_COL = /命中率|成功率|空闲率|可用率|健康率|HIT|HIT_?RATIO|SUCCESS_?RATE|FREE_?PCT|AVAILAB/i;
const STATUS_COL = /^(STATUS|STATE|HEALTH|HEALTH_STATUS|DB_STATUS|OPEN_MODE|RESULT|检查结果|状态|SYNC_STATE|APPLY_STATE)$/i;
const RISK_COL = /^(RISK|RISK_LEVEL|RISKLEVEL|SEVERITY|LEVEL|风险等级|风险级别|严重程度|等级)$/i;
const TEXT_ERR_RE = /ORA-\d{4,5}|ERROR\s*\d+|SQLSTATE|FATAL|PANIC|deadlock detected|ERRORS?:|失败|错误|异常/i;

const BAD_CRITICAL = /^(INVALID|UNUSABLE|CORRUPT(ED)?|FAILED|FAIL|DOWN|OFFLINE|CRASHED|LOST|STOPPED|SUSPENDED|DISCONNECTED|UNAVAILABLE|FATAL|严重|故障|失败|宕机|离线|损坏)$/i;
const BAD_WARNING = /^(DISABLED|ERROR|ERRORS|BLOCKED|UNSYNC(ED)?|NOT[_ ]?SYNC(ED)?|DEGRADED|ABNORMAL|WARNING|WARN|STANDBY_LAG|NEEDS[_ ]?RECOVER|异常|警告|无效|未同步|未启用)$/i;
const RISK_HIGH = /^(HIGH|CRITICAL|SEVERE|FATAL|P0|P1|高|严重|紧急|高风险)$/i;
const RISK_MID = /^(MEDIUM|MODERATE|WARN(ING)?|P2|中|中风险|警告)$/i;

/** 标题里带这些词的检查项，本身就是“列出异常对象”，有返回行即需关注 */
const PROBLEM_SECTION = /(无效|失败|错误|异常|告警|报警|阻塞|锁等待|死锁|长事务|悬挂|挂起|不同步|延迟|落后|缺失|过期|陈旧|invalid|fail|error|blocked|deadlock|long[- ]?running|lag|stale|missing|unusable|disabled|orphan)/i;

const ADVICE_RULES = [
  [/表空间|tablespace|空间|磁盘|disk|datafile|数据文件/i, '检查空间增长趋势，必要时扩容数据文件 / 磁盘，并清理历史、归档与临时数据。'],
  [/无效对象|invalid/i, '重新编译无效对象（Oracle：ALTER … COMPILE / UTL_RECOMP），并排查导致失效的变更。'],
  [/锁|阻塞|lock|block|deadlock/i, '定位阻塞源会话与持锁 SQL，评估终止会话或优化事务粒度，缩短事务时长。'],
  [/长事务|long/i, '核查长事务业务来源，避免长时间持有锁与 undo / WAL，必要时拆分事务。'],
  [/复制|同步|延迟|lag|replica|slave|standby|dataguard|adg|ha/i, '检查主备链路与复制进程状态，确认网络与归档 / binlog 是否积压，必要时重建复制。'],
  [/参数|parameter|配置/i, '对照官方 / 内部基线核对参数，评估后在维护窗口调整，并记录变更。'],
  [/索引|index|统计信息|statistic|stat/i, '重建失效索引，对统计信息陈旧的对象重新收集统计，并评估是否缺少必要索引。'],
  [/备份|backup|rman/i, '核对备份策略与最近一次成功备份时间，确保备份可恢复（定期演练）。'],
  [/连接|会话|session|connection/i, '核对连接数 / 会话数上限与连接池配置，排查连接泄漏与异常来源 IP。'],
  [/内存|memory|sga|pga|buffer|缓存|命中/i, '评估内存参数与缓存命中率，结合负载确定是否需要调整内存配置。'],
  [/日志|log|alert|告警日志/i, '逐条核对告警日志中的错误，处理根因并确认没有持续新增。'],
];

function adviceFor(text) {
  for (const [re, a] of ADVICE_RULES) if (re.test(text)) return a;
  return '请结合业务影响评估，必要时联系 DBA 处理，并在处理后重新巡检确认。';
}

function num(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[%,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function cmp(op, value, threshold) {
  if (op === 'contains') return String(value).toLowerCase().includes(String(threshold).toLowerCase());
  if (op === 'regex') { try { return new RegExp(threshold, 'i').test(String(value)); } catch { return false; } }
  const a = num(value);
  const b = num(threshold);
  if (a == null || b == null) {
    // 非数值：只支持 = / !=
    if (op === '=') return String(value) === String(threshold);
    if (op === '!=') return String(value) !== String(threshold);
    return false;
  }
  switch (op) {
    case '>=': return a >= b;
    case '>': return a > b;
    case '<=': return a <= b;
    case '<': return a < b;
    case '=': return a === b;
    case '!=': return a !== b;
    default: return false;
  }
}

function colIndex(columns, name) {
  const up = String(name).toUpperCase();
  return columns.findIndex((c) => String(c).toUpperCase() === up);
}

/** 取一行里最能说明问题的几个单元格，作为证据 */
function evidenceOf(columns, row, focusCol) {
  const parts = [];
  if (focusCol != null) parts.push(`${focusCol}=${row[focusCol]}`);
  for (const c of columns) {
    if (parts.length >= 4) break;
    if (c === focusCol) continue;
    const v = row[c];
    if (v == null || v === '') continue;
    parts.push(`${c}=${String(v).slice(0, 60)}`);
  }
  return parts.join('；');
}

class Collector {
  constructor() { this.map = new Map(); }
  /** 同一检查项、同一规则只保留一条，累计命中数并保留前几个样例 */
  add({ key, level, category, section, sectionNo, title, detail, advice, source, hit }) {
    let f = this.map.get(key);
    if (!f) {
      f = { key, level, category, section, sectionNo, title, detail, advice, source, count: 0, samples: [], hits: [] };
      this.map.set(key, f);
    }
    if (LEVEL_RANK[level] > LEVEL_RANK[f.level]) f.level = level;
    f.count += 1;
    if (hit) {
      if (f.samples.length < 5 && hit.evidence) f.samples.push(hit.evidence);
      if (f.hits.length < 200) f.hits.push({ t: hit.tableIdx, r: hit.rowIdx, level });
    }
  }
  list() { return [...this.map.values()]; }
}

/**
 * @param {Array} sections 执行器返回的 sections
 * @param {Array} rules    脚本 @rule 指令
 * @param {Array} errors   执行器返回的 errors
 */
function analyze(sections, rules = [], errors = []) {
  const col = new Collector();

  sections.forEach((sec, secIdx) => {
    const category = sec.category || 'OTHER';
    const secKey = `${secIdx}`;
    const titleText = sec.title || '';
    let secHasFinding = false;

    (sec.tables || []).forEach((tb, tableIdx) => {
      const columns = tb.columns || [];
      (tb.rows || []).forEach((row, rowIdx) => {
        // 1) 用户 @rule
        for (const r of rules) {
          if (r.section && !titleText.toLowerCase().includes(String(r.section).toLowerCase())) continue;
          const real = columns.find((c) => String(c).toUpperCase() === String(r.col).toUpperCase());
          if (!real) continue;
          const v = row[real];
          if (v == null || v === '') continue;
          let level = null;
          if (r.crit != null && cmp(r.op, v, r.crit)) level = 'CRITICAL';
          else if (r.warn != null && cmp(r.op, v, r.warn)) level = 'WARNING';
          if (!level) continue;
          secHasFinding = true;
          const threshold = level === 'CRITICAL' ? r.crit : r.warn;
          col.add({
            key: `${secKey}|rule|${r.col}|${r.title}`, level, category: r.cat || category, section: titleText, sectionNo: sec.no,
            title: r.title, detail: `${r.col} ${r.op} ${threshold}`, advice: r.advice || adviceFor(`${r.title} ${titleText}`), source: 'RULE',
            hit: { tableIdx, rowIdx, evidence: evidenceOf(columns, row, real) },
          });
        }

        // 2) 通用启发式
        for (const c of columns) {
          const v = row[c];
          if (v == null || v === '') continue;
          const s = String(v).trim();

          if (USAGE_COL.test(c) && !GOOD_HIGH_COL.test(c)) {
            const raw = num(v);
            // [fix] 0–1 归一化小数（0.95）原来不报警；统一按百分比换算
            let n = raw;
            if (n != null && n > 0 && n <= 1) n = n * 100;
            if (n != null && n >= 0 && n <= 100) {
              const level = n >= 95 ? 'CRITICAL' : n >= 85 ? 'WARNING' : null;
              if (level) {
                secHasFinding = true;
                col.add({
                  key: `${secKey}|usage|${c}`, level, category, section: titleText, sectionNo: sec.no,
                  title: `${c} 偏高`, detail: `使用率 ≥ ${level === 'CRITICAL' ? 95 : 85}%${raw !== n ? `（原值 ${raw} 按小数换算）` : ''}`,
                  advice: adviceFor(`${c} ${titleText}`), source: 'HEURISTIC',
                  hit: { tableIdx, rowIdx, evidence: evidenceOf(columns, row, c) },
                });
              }
            }
            continue;
          }
          if (STATUS_COL.test(c) && typeof v !== 'number') {
            const level = BAD_CRITICAL.test(s) ? 'CRITICAL' : BAD_WARNING.test(s) ? 'WARNING' : null;
            if (level) {
              secHasFinding = true;
              col.add({
                key: `${secKey}|status|${c}|${s.toUpperCase()}`, level, category, section: titleText, sectionNo: sec.no,
                title: `${c} 异常：${s}`, detail: `状态值为 ${s}`, advice: adviceFor(titleText), source: 'HEURISTIC',
                hit: { tableIdx, rowIdx, evidence: evidenceOf(columns, row, c) },
              });
            }
            continue;
          }
          if (RISK_COL.test(c) && typeof v !== 'number') {
            const level = RISK_HIGH.test(s) ? 'CRITICAL' : RISK_MID.test(s) ? 'WARNING' : null;
            if (level) {
              secHasFinding = true;
              col.add({
                key: `${secKey}|risk|${c}|${level}`, level, category, section: titleText, sectionNo: sec.no,
                title: `${level === 'CRITICAL' ? '高' : '中'}风险项`, detail: `${c}=${s}`, advice: adviceFor(titleText), source: 'HEURISTIC',
                hit: { tableIdx, rowIdx, evidence: evidenceOf(columns, row, c) },
              });
            }
            continue;
          }
          // [fix] 原 key 只有 secKey|text，整个 section 的所有错误文本被合并成 1 条 WARNING（评分虚高）；
          //       且「正常/无异常」这类文本会被宽松正则误报。按列去重、跳过明确的正常值。
          if (typeof v === 'string' && v.length >= 6 && TEXT_ERR_RE.test(v)
              && !/^(正常|无|NONE|OK|NO ERRORS?|无异常|未发现异常|无错误|NO ERROR)$/i.test(s)) {
            secHasFinding = true;
            col.add({
              key: `${secKey}|text|${c}`, level: 'WARNING', category, section: titleText, sectionNo: sec.no,
              title: '输出中包含错误信息', detail: '结果文本含 ORA- / ERROR / 失败 等字样', advice: adviceFor(titleText), source: 'HEURISTIC',
              hit: { tableIdx, rowIdx, evidence: `${c}=${s.slice(0, 120)}` },
            });
          }
        }
      });
    });

    // 3) “列出异常对象”类检查项：有返回行就提示
    if (!secHasFinding && PROBLEM_SECTION.test(titleText)) {
      const total = (sec.tables || []).reduce((a, t) => a + (t.rows ? t.rows.length : 0), 0);
      if (total > 0) {
        col.add({
          key: `${secKey}|problem-section`, level: 'INFO', category, section: titleText, sectionNo: sec.no,
          title: `${titleText} 返回 ${total} 条记录`, detail: '该检查项用于列出异常对象，存在返回记录', advice: adviceFor(titleText), source: 'HEURISTIC',
          hit: null,
        });
      }
    }
  });

  const findings = col.list().sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level] || (a.sectionNo ?? 0) - (b.sectionNo ?? 0));
  findings.forEach((f, i) => { f.id = i + 1; });

  const collectErrors = (errors || []).map((e) => ({ section: e.section || '', sql: e.sql || '', error: e.error || String(e) }));
  return { findings, collectErrors };
}

/**
 * 评分：100 起扣。严重 -10（最多 -60）、警告 -3（最多 -30）、提示 -1（最多 -5）、采集异常 -2（最多 -10）。
 * 采集异常多半是权限 / 版本差异，不应把“库没问题”判成“库有问题”，所以单独轻扣并在报告里提示“结果可能不完整”。
 */
function score(findings, collectErrors, totalSections) {
  const c = findings.filter((f) => f.level === 'CRITICAL').length;
  const w = findings.filter((f) => f.level === 'WARNING').length;
  const i = findings.filter((f) => f.level === 'INFO').length;
  const e = collectErrors.length;
  let s = 100 - Math.min(60, c * 10) - Math.min(30, w * 3) - Math.min(5, i) - Math.min(10, e * 2);
  s = Math.max(0, Math.round(s));
  // 一半以上检查项都执行失败：结果不可信，不能给出“正常”
  const unreliable = totalSections > 0 && e >= Math.max(3, Math.ceil(totalSections / 2));
  let status = c > 0 || s < 70 ? 'CRITICAL' : w > 0 || e > 0 || s < 85 ? 'WARNING' : 'NORMAL';
  if (unreliable && status === 'NORMAL') status = 'WARNING';
  return { score: s, status, critical: c, warning: w, info: i, collectErrors: e, unreliable };
}

/** 一句话总结（Word 总结页、列表摘要、Excel 都用它） */
function conclusion({ score: s, status, critical, warning, info, collectErrors, unreliable }, sectionCount, okSections) {
  const stLabel = { NORMAL: '正常', WARNING: '预警', CRITICAL: '严重' }[status] || status;
  const parts = [`共执行 ${sectionCount} 个检查项（成功 ${okSections}），综合评分 ${s}，结论：${stLabel}`];
  if (critical || warning || info) parts.push(`发现严重 ${critical}、警告 ${warning}、提示 ${info} 项`);
  else parts.push('未发现需要处理的问题');
  if (collectErrors) parts.push(`${collectErrors} 条语句执行失败（多为权限或版本差异，相关检查项结果可能不完整）`);
  if (unreliable) parts.push('超过半数检查项执行失败，本次结果不可作为“健康”依据，请先修复采集权限后重新巡检');
  return `${parts.join('；')}。`;
}

module.exports = { analyze, score, conclusion, adviceFor, LEVEL_RANK, LEVEL_LABEL };
