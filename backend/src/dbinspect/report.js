'use strict';
/**
 * 巡检报告：Word（管理层阅读）+ Excel（明细/筛选）。
 * 「SQL 洞察」按数据库类型分节（Oracle / PostgreSQL / MySQL / 达梦），每条 SQL 都带 sql_id 及其类型：
 *   Oracle SQL_ID · PG queryid · MySQL digest · 达梦 SQL_ID；取不到原生 ID 时用 SQL 指纹（FP:xxxx）。
 */
const ExcelJS = require('exceljs');
const { Document, Packer, Paragraph, HeadingLevel, AlignmentType } = require('docx');
const db = require('../config/db');
const { FONT, LANDSCAPE_W, p, fixedTable, pageBreak, headerFooter, sectionProperties } = require('../services/inspectDocxLayout');
const { FAMILIES, FAMILY_LABEL } = require('./dialect');
const KIND_LABEL = { SQL_ID: 'SQL_ID', QUERYID: 'queryid', DIGEST: 'digest', FINGERPRINT: '指纹' };
const { CATEGORY_LABEL, CATEGORY_ORDER } = require('./catalog');

const SEV = { CRITICAL: '严重', WARNING: '预警', OK: '正常', INFO: '提示', NA: '不适用', ERROR: '采集失败' };
const TRIG = { SCHEDULE: '定时', MANUAL: '手动', ALERT: '告警联动', RECHECK: '复检' };
const DIM = {
  ELAPSED: 'Top 总耗时', CPU: 'Top CPU', IO: 'Top IO', EXECS: 'Top 执行次数', SLOW: '平均耗时过高', READS: '读/扫描过大',
  FULLSCAN: '全表扫描', PLAN_CHANGE: '执行计划变化', NO_BIND: '未绑定变量', LONG_RUN: '长时间运行', LOCK: '锁等待', TX: '长事务',
};
const fmt = (n, d = 1) => (n == null || n === '' || Number.isNaN(Number(n)) ? '' : (Number(n) >= 1000 ? Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 }) : String(Math.round(Number(n) * 10 ** d) / 10 ** d)));
const ts = (t) => (t instanceof Date ? `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')} ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}` : (t || ''));
const oneLine = (s, n = 220) => { const x = String(s ?? '').replace(/\s+/g, ' ').trim(); return x.length > n ? `${x.slice(0, n)}…` : x; };

async function loadRun(runId) {
  const run = (await db.execute('SELECT * FROM DBI_RUN WHERE RUN_ID=:1', [runId])).rows[0];
  if (!run) return null;
  const q = async (sql) => (await db.execute(sql, [runId])).rows;
  const instances = await q('SELECT * FROM DBI_RUN_INSTANCE WHERE RUN_ID=:1 ORDER BY INSTANCE_NAME');
  const results = await q('SELECT RESULT_ID,INSTANCE_ID,ITEM_CODE,ITEM_NAME,CATEGORY,STATUS,WORST_VALUE,THRESHOLD_TEXT,ROW_COUNT,MESSAGE,DURATION_MS FROM DBI_RUN_RESULT WHERE RUN_ID=:1 ORDER BY INSTANCE_ID, RESULT_ID');
  const issues = await q(`SELECT * FROM DBI_ISSUE WHERE LAST_RUN_ID=:1 AND STATUS<>'IGNORED' ORDER BY CASE SEVERITY WHEN 'CRITICAL' THEN 0 ELSE 1 END, INSTANCE_NAME, ITEM_CODE`);
  const snaps = await q('SELECT * FROM DBI_SQL_SNAPSHOT WHERE RUN_ID=:1 ORDER BY INSTANCE_ID, ITEM_CODE, RANK_NO');
  const fixed = await q(`SELECT * FROM DBI_ISSUE WHERE STATUS='FIXED' AND FIXED_AT >= (SELECT STARTED_AT FROM DBI_RUN WHERE RUN_ID=:1) ORDER BY INSTANCE_NAME`);
  const instById = new Map(instances.map((i) => [i.INSTANCE_ID, i]));
  // 信息类检查项的证据（Word 报告里展开为明细表）
  const evidenceByResult = new Map(); const evidenceBy = new Map();
  const evRows = await q(`SELECT RESULT_ID, INSTANCE_ID, ITEM_CODE, EVIDENCE FROM DBI_RUN_RESULT WHERE RUN_ID=:1 AND EVIDENCE IS NOT NULL AND STATUS IN ('INFO','OK','WARNING','CRITICAL')`);
  const infoIds = new Set(results.filter((x) => x.STATUS === 'INFO').map((x) => x.RESULT_ID));
  for (const e of evRows) {
    let ev = null; try { ev = JSON.parse(e.EVIDENCE); } catch { continue; }
    if (infoIds.has(e.RESULT_ID)) evidenceByResult.set(e.RESULT_ID, ev);
    evidenceBy.set(`${e.INSTANCE_ID}|${e.ITEM_CODE}`, ev);
  }
  const items = {};
  const implSql = new Map();
  try {
    const codes = [...new Set([...results.map((x) => x.ITEM_CODE), ...issues.map((x) => x.ITEM_CODE)])];
    if (codes.length) {
      const rs = (await db.execute(`SELECT i.ITEM_CODE, i.ADVICE, p.DB_FAMILY, p.SQL_TEXT FROM DBI_CHECK_ITEM i LEFT JOIN DBI_CHECK_IMPL p ON p.ITEM_ID = i.ITEM_ID`, [])).rows;
      for (const r of rs) { items[r.ITEM_CODE] = { advice: r.ADVICE }; if (r.DB_FAMILY) implSql.set(`${r.ITEM_CODE}|${r.DB_FAMILY}`, r.SQL_TEXT); }
    }
  } catch { /* 报告不因此失败 */ }
  return { run, instances, results, issues, snaps, fixed, instById, evidenceByResult, evidenceBy, items, implSql, categoryLabel: CATEGORY_LABEL, categoryOrder: CATEGORY_ORDER };
}

/** SQL 洞察：family → instance → dimension → rows */
function groupSql(d) {
  const out = new Map();
  for (const s of d.snaps) {
    const fam = s.DB_FAMILY;
    if (!out.has(fam)) out.set(fam, new Map());
    const m = out.get(fam);
    const inst = d.instById.get(s.INSTANCE_ID);
    const k = s.INSTANCE_ID;
    if (!m.has(k)) m.set(k, { inst, dims: new Map() });
    const dm = m.get(k).dims;
    const dim = s.DIMENSION || s.ITEM_CODE;
    if (!dm.has(dim)) dm.set(dim, []);
    dm.get(dim).push(s);
  }
  return out;
}
const familyOrder = FAMILIES.length ? FAMILIES : ['ORACLE', 'POSTGRESQL', 'MYSQL', 'DAMENG'];
const idCell = (s) => `${s.SQL_ID}${s.SQL_ID_KIND ? `（${KIND_LABEL[s.SQL_ID_KIND] || s.SQL_ID_KIND}）` : ''}`;
const sqlCols = (fam) => (fam === 'MYSQL'
  ? ['#', 'SQL ID（digest）', '库', '执行次数', '总耗时(ms)', '平均(ms)', '扫描行', '判定', 'SQL 文本']
  : ['#', 'SQL ID', '计划哈希', '执行次数', '总耗时(ms)', '平均(ms)', fam === 'POSTGRESQL' ? '读块(shared)' : '逻辑读', '判定', 'SQL 文本']);
const sqlRow = (fam, s) => (fam === 'MYSQL'
  ? [s.RANK_NO, idCell(s), s.SCHEMA_NAME || '', fmt(s.EXECS), fmt(s.TOTAL_MS), fmt(s.AVG_MS, 2), fmt(s.ROWS_EXAMINED), SEV[s.SEVERITY] || '', oneLine(s.SQL_TEXT)]
  : [s.RANK_NO, idCell(s), s.PLAN_HASH || '', fmt(s.EXECS), fmt(s.TOTAL_MS), fmt(s.AVG_MS, 2), fmt(s.LOGICAL_READS ?? s.PHYSICAL_READS), SEV[s.SEVERITY] || '', oneLine(s.SQL_TEXT)]);

async function buildWord(runId) {
  const d = await loadRun(runId);
  if (!d) throw Object.assign(new Error('巡检记录不存在'), { code: 404 });
  return require('./wordReport').buildDoc(d);
}

function sheet(wb, name, cols, rows, widths = []) {
  const ws = wb.addWorksheet(name.slice(0, 31), { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.addRow(cols);
  rows.forEach((r) => ws.addRow(r));
  const h = ws.getRow(1);
  h.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  h.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3A5F' } };
  cols.forEach((_, i) => { ws.getColumn(i + 1).width = widths[i] || 16; });
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
  ws.eachRow((row, n) => {
    if (n === 1) return;
    row.eachCell((c) => {
      const v = c.value;
      if (v === '严重') c.font = { color: { argb: 'FFC0392B' }, bold: true };
      else if (v === '预警') c.font = { color: { argb: 'FFB9770E' }, bold: true };
      else if (v === '巡检失败' || v === '采集失败') c.font = { color: { argb: 'FF7F8C8D' }, italic: true };
    });
  });
  return ws;
}

async function buildExcel(runId) {
  const d = await loadRun(runId);
  if (!d) throw Object.assign(new Error('巡检记录不存在'), { code: 404 });
  const wb = new ExcelJS.Workbook();
  wb.creator = 'DIOps';
  sheet(wb, '实例总览', ['实例', '类型', '地址', '结果', '严重', '预警', '采集失败项', '不适用', '得分', '耗时(ms)', '说明'],
    d.instances.map((i) => [i.INSTANCE_NAME, i.DB_TYPE, i.HOST_IP, i.EXEC_STATUS === 'OK' ? (i.CRIT_CNT ? '严重' : i.WARN_CNT ? '预警' : '正常') : i.EXEC_STATUS === 'FAILED' ? '巡检失败' : '执行中',
      i.CRIT_CNT, i.WARN_CNT, i.ITEMS_ERR, i.ITEMS_NA, i.SCORE, i.DURATION_MS, i.ERROR_MSG]), [24, 12, 16, 10, 8, 8, 12, 8, 8, 12, 60]);
  sheet(wb, '异常项', ['级别', '状态', '实例', '类型', '分类', '检查项', '对象', '当前值', '阈值', 'SQL ID', 'ID 类型', 'SQL 文本', '整改建议', '首次发现', '出现次数'],
    d.issues.map((x) => [SEV[x.SEVERITY], x.STATUS, x.INSTANCE_NAME, x.DB_TYPE, CATEGORY_LABEL[x.CATEGORY] || x.CATEGORY, x.ITEM_NAME, x.SQL_ID ? '' : x.OBJECT_KEY, x.CURRENT_VALUE, x.THRESHOLD_TEXT,
      x.SQL_ID, x.SQL_ID_KIND, x.SQL_TEXT, x.ADVICE, ts(x.FIRST_SEEN), x.OCCURRENCES]), [8, 8, 22, 12, 10, 24, 28, 14, 16, 26, 12, 60, 50, 19, 8]);
  const sqlBy = groupSql(d);
  for (const fam of familyOrder) {
    const m = sqlBy.get(fam); if (!m) continue;
    const rows = [];
    for (const { inst, dims } of m.values()) for (const [dim, list] of dims) for (const s of list) {
      rows.push([inst?.INSTANCE_NAME, inst?.DB_TYPE, DIM[dim] || dim, s.RANK_NO, s.SQL_ID, s.SQL_ID_KIND, s.PLAN_HASH, s.SCHEMA_NAME, s.EXECS, s.TOTAL_MS, s.AVG_MS, s.CPU_MS,
        s.LOGICAL_READS, s.PHYSICAL_READS, s.ROWS_PROC, s.ROWS_EXAMINED, s.METRIC_VALUE, SEV[s.SEVERITY] || '', s.LAST_ACTIVE, s.SQL_TEXT]);
    }
    sheet(wb, `SQL洞察-${FAMILY_LABEL[fam] || fam}`, ['实例', '类型', '维度', '排名', 'SQL ID', 'ID 类型', '计划哈希', '库/Schema', '执行次数', '总耗时ms', '平均ms', 'CPU ms', '逻辑读', '物理读', '返回行', '扫描行', '判定值', '判定', '最近活动', 'SQL 文本'],
      rows, [22, 12, 14, 6, 28, 12, 14, 14, 12, 12, 10, 10, 12, 12, 10, 12, 10, 8, 18, 80]);
  }
  sheet(wb, '检查结果', ['实例', '分类', '检查项', '编码', '结果', '最差值', '阈值', '行数', '说明', '耗时ms'],
    d.results.map((r) => [d.instById.get(r.INSTANCE_ID)?.INSTANCE_NAME, CATEGORY_LABEL[r.CATEGORY] || r.CATEGORY, r.ITEM_NAME, r.ITEM_CODE, SEV[r.STATUS] || r.STATUS, r.WORST_VALUE, r.THRESHOLD_TEXT, r.ROW_COUNT, r.MESSAGE, r.DURATION_MS]),
    [22, 10, 28, 24, 10, 16, 18, 8, 70, 10]);
  return wb.xlsx.writeBuffer();
}

module.exports = { buildWord, buildExcel, loadRun, groupSql };
