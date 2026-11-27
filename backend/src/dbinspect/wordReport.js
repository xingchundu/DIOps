'use strict';
/**
 * Word 巡检报告 —— 版式对齐附件《Oracle RAC 19c 数据库巡检报告》：
 *   封面（标题 / 副标题 / 项目-内容信息表）→ 1 巡检结论（1.1 各领域评估）→ 2 问题清单与建议（H/M/L 编号）→ 3 环境概况
 *   → 4…N 各领域检查表（检查项 / 结果 / 结论 / 说明）→ 高消耗 SQL（按数据库类型分节，带 SQL_ID）→ 实施计划（立即/短期/中期）
 *   → 附录 A 数据来源 → 附录 B 常用核查命令。
 * 字体 Arial + 微软雅黑；标题色 1F3B5C；表头底色 DCE6F1；边框 BFBFBF；结论列按 高/中/低 着色。
 */
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, TableLayoutType, AlignmentType,
  Header, Footer, PageNumber, ShadingType, BorderStyle, HeadingLevel, VerticalAlign,
} = require('docx');

const W = 9638;                       // A4 纵向内容宽（1134 页边距）
const FONT = { ascii: 'Arial', hAnsi: 'Arial', cs: 'Arial', eastAsia: '微软雅黑' };
const NAVY = '1F3B5C';
const FILL = { head: 'DCE6F1', high: 'F8D7DA', mid: 'FFF1CC', ok: 'DFF0D8', na: 'F2F2F2', code: 'E7E9EC' };
const BORDER = { style: BorderStyle.SINGLE, size: 4, color: 'BFBFBF' };
const BORDERS = { top: BORDER, bottom: BORDER, left: BORDER, right: BORDER };

const FAM_LABEL = { ORACLE: 'Oracle', MYSQL: 'MySQL', POSTGRESQL: 'PostgreSQL', DAMENG: '达梦' };
const TYPE_FAM = { ORACLE: 'ORACLE', MYSQL: 'MYSQL', GOLDENDB: 'MYSQL', POSTGRESQL: 'POSTGRESQL', PANWEI: 'POSTGRESQL', DAMENG: 'DAMENG' };
const DIM = {
  ELAPSED: 'Top 总耗时', CPU: 'Top CPU', IO: 'Top IO', EXECS: 'Top 执行次数', SLOW: '平均耗时过高', READS: '读/扫描过大', FULLSCAN: '全表扫描',
  PLAN_CHANGE: '执行计划变化', NO_BIND: '未绑定变量', LONG_RUN: '长时间运行', LOCK: '锁等待', TX: '长事务', CLUSTER: 'Cluster 等待', AWR: 'AWR 7 天 Top',
  ACTIVE: '当前活动会话', MONITOR: '执行中(SQL Monitor)',
};
const KIND = { SQL_ID: 'SQL_ID', QUERYID: 'queryid', DIGEST: 'digest', FINGERPRINT: '指纹' };
const LOW_CATS = new Set(['CONFIG', 'SECURITY', 'LOG']);

const clip = (v, n = 300) => { const s = String(v ?? '').replace(/\r?\n/g, ' ').trim(); return s.length > n ? `${s.slice(0, n)}…` : s; };
const num = (n, d = 0) => (n == null || n === '' || Number.isNaN(Number(n)) ? '' : Number(n).toLocaleString('en-US', { maximumFractionDigits: d }));
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const ymdhm = (t) => { const d = t instanceof Date ? t : new Date(t); return Number.isNaN(d.getTime()) ? '' : `${ymd(d)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

// ------------------------------------------------------------------ 基础积木
const run = (text, o = {}) => new TextRun({ text: String(text ?? ''), font: FONT, size: o.size, bold: o.bold, color: o.color, italics: o.italics });
function P(parts, o = {}) {
  const children = (Array.isArray(parts) ? parts : [parts]).map((x) => (typeof x === 'string' ? run(x, o) : x));
  return new Paragraph({ children, alignment: o.align, spacing: { before: o.before, after: o.after ?? 120, line: o.line ?? 320 }, bullet: o.bullet ? { level: 0 } : undefined, keepNext: o.keepNext, pageBreakBefore: o.pageBreakBefore });
}
const H1 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: t, font: FONT })], keepNext: true });
const H2 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun({ text: t, font: FONT })], keepNext: true });
const Code = (t) => new Paragraph({ spacing: { after: 20, line: 260 }, shading: { type: ShadingType.CLEAR, fill: FILL.code, color: 'auto' }, children: [new TextRun({ text: String(t), font: { ascii: 'Consolas', hAnsi: 'Consolas', eastAsia: 'Consolas', cs: 'Consolas' }, size: 17 })] });

function cell(content, width, o = {}) {
  const lines = Array.isArray(content) ? content : [content];
  return new TableCell({
    width: { size: width, type: WidthType.DXA }, borders: BORDERS, verticalAlign: VerticalAlign.CENTER,
    shading: o.fill ? { type: ShadingType.CLEAR, fill: o.fill, color: 'auto' } : undefined,
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
    children: lines.map((ln) => new Paragraph({
      spacing: { after: 40, line: 280 },
      children: (Array.isArray(ln) ? ln : [ln]).map((x) => (typeof x === 'string' ? run(x, { size: 19, bold: o.bold }) : x)),
    })),
  });
}
/** cols: 列宽比例；rows: 每格 string | {t, fill, bold} | [lines]；返回 Table（无数据时返回 null） */
function table(head, rows, ratio, o = {}) {
  if (!rows.length) return null;
  const TW = o.width || W;
  const sum = ratio.reduce((a, b) => a + b, 0);
  const widths = ratio.map((r) => Math.floor((TW * r) / sum));
  widths[widths.length - 1] += TW - widths.reduce((a, b) => a + b, 0);
  const mk = (c, i) => (c && typeof c === 'object' && !Array.isArray(c) && 't' in c ? cell(c.t, widths[i], { fill: c.fill, bold: c.bold }) : cell(c ?? '', widths[i]));
  return new Table({
    width: { size: TW, type: WidthType.DXA }, columnWidths: widths, layout: TableLayoutType.FIXED,
    rows: [
      new TableRow({ tableHeader: true, cantSplit: true, children: head.map((h, i) => cell(h, widths[i], { fill: FILL.head, bold: true })) }),
      ...rows.map((r) => new TableRow({ cantSplit: o.cantSplit !== false, children: r.map(mk) })),
    ],
  });
}
const spacer = () => new Paragraph({ spacing: { after: 100 }, children: [] });
const push = (arr, ...els) => els.forEach((e) => e && arr.push(e));

// ------------------------------------------------------------------ 数据整理
const sevOf = (issue) => (issue.SEVERITY === 'CRITICAL' ? 'H' : LOW_CATS.has(issue.CATEGORY) ? 'L' : 'M');
const SEV_TXT = { H: ['高', FILL.high], M: ['中', FILL.mid], L: ['低', FILL.ok] };

function buildModel(d) {
  const { run: r, instances, results, issues, snaps, items = {}, categoryLabel, categoryOrder } = d;
  const instName = (id) => d.instById.get(id)?.INSTANCE_NAME || String(id);
  const active = issues.filter((x) => x.STATUS !== 'FIXED');
  const counters = { H: 0, M: 0, L: 0 };
  const numbered = active.map((x) => { const s = sevOf(x); counters[s]++; return { ...x, sev: s, no: `${s}${counters[s]}` }; })
    .sort((a, b) => 'HML'.indexOf(a.sev) - 'HML'.indexOf(b.sev) || a.no.localeCompare(b.no, undefined, { numeric: true }));
  const noByKey = new Map();
  for (const x of numbered) {
    const k = `${x.INSTANCE_ID}|${x.ITEM_CODE}`;
    if (!noByKey.has(k)) noByKey.set(k, []);
    noByKey.get(k).push(x.no);
  }
  const cats = categoryOrder.filter((c) => results.some((x) => x.CATEGORY === c));
  const extra = [...new Set(results.map((x) => x.CATEGORY))].filter((c) => !categoryOrder.includes(c));
  return { r, instances, results, numbered, noByKey, counters, cats: [...cats, ...extra], items, instName, categoryLabel, snaps, d };
}

function domainAssess(m, cat) {
  const rs = m.results.filter((x) => x.CATEGORY === cat);
  const iss = m.numbered.filter((x) => x.CATEGORY === cat);
  const evaluated = rs.filter((x) => !['ERROR', 'NA'].includes(x.STATUS));
  if (!evaluated.length) return { label: '未评估', fill: FILL.na, note: rs.every((x) => x.STATUS === 'NA') ? '本类检查项对当前数据库类型不适用' : '采集失败（权限不足或视图不存在），缺少采集数据' };
  const high = iss.filter((x) => x.sev === 'H');
  if (high.length) return { label: '高风险', fill: FILL.high, note: clip(high.slice(0, 2).map((x) => x.TITLE).join('；'), 160) };
  if (iss.length) return { label: '需关注', fill: FILL.mid, note: clip(iss.slice(0, 2).map((x) => x.TITLE).join('；'), 160) };
  const err = rs.filter((x) => x.STATUS === 'ERROR').length;
  return { label: '良好', fill: FILL.ok, note: `${evaluated.length} 项检查均正常${err ? `；另有 ${err} 项采集失败` : ''}` };
}

// ------------------------------------------------------------------ 各章节
function cover(m) {
  const { r, instances } = m;
  const fams = [...new Set(instances.map((i) => FAM_LABEL[TYPE_FAM[String(i.DB_TYPE).toUpperCase()]] || i.DB_TYPE))];
  const title = `${fams.length === 1 ? `${fams[0]} ` : ''}数据库巡检报告`;
  const names = instances.slice(0, 6).map((i) => i.INSTANCE_NAME).join(' / ') + (instances.length > 6 ? ` 等 ${instances.length} 个` : '');
  const failed = instances.filter((i) => i.EXEC_STATUS === 'FAILED');
  const errItems = m.results.filter((x) => x.STATUS === 'ERROR').length;
  const gaps = [];
  if (failed.length) gaps.push(`${failed.length} 个实例连接失败（${failed.slice(0, 4).map((i) => i.INSTANCE_NAME).join('、')}${failed.length > 4 ? ' 等' : ''}），无采集数据`);
  if (errItems) gaps.push(`${errItems} 个检查项采集失败（权限不足或视图不存在）`);
  const done = r.FINISHED_AT ? new Date(r.FINISHED_AT) : new Date();
  const info = [
    ['巡检对象', `${instances.length} 个实例：${names}${fams.length ? `（${fams.join(' / ')}）` : ''}`],
    ['数据采集时间', `${ymdhm(r.STARTED_AT)} ~ ${r.FINISHED_AT ? ymdhm(r.FINISHED_AT) : '进行中'}`],
    ['分析数据范围', `巡检模板「${r.TEMPLATE_NAME || ''}」；共 ${m.results.length} 条检查结果，${m.snaps.length} 条 SQL 快照`],
    ['数据缺口', gaps.length ? gaps.join('；') : '没有'],
    ['报告日期', ymd(done)],
  ];
  return [
    new Paragraph({ spacing: { before: 2400 }, children: [] }),
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 300 }, children: [new TextRun({ text: title, font: FONT, bold: true, color: NAVY, size: 48 })] }),
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 400 }, children: [new TextRun({ text: `${names} · 触发方式：${{ SCHEDULE: '定时', MANUAL: '手动', ALERT: '告警联动', RECHECK: '复检' }[r.TRIGGER_TYPE] || r.TRIGGER_TYPE}`, font: FONT, size: 24, color: '595959' })] }),
    table(['项目', '内容'], info.map(([a, b]) => [a, b]), [26, 74], { width: 7600 }),
  ];
}

function conclusion(m) {
  const out = [H1('1. 巡检结论')];
  const { H, M, L } = m.counters;
  const failed = m.instances.filter((i) => i.EXEC_STATUS === 'FAILED').length;
  if (!H && !M && !L) {
    out.push(P([run('本次巡检未发现异常项', { bold: true }), run('，已评估的检查项均在阈值范围内。')]));
  } else {
    out.push(P([run('共发现 '), run(`${H} 项高风险`, { bold: true }), run(`、${M} 项中风险、${L} 项低风险问题${H ? '：' : '。'}`)]));
    for (const x of m.numbered.filter((y) => y.sev === 'H').slice(0, 6)) {
      out.push(P([run(`${x.INSTANCE_NAME}：`, { bold: true }), run(clip(x.TITLE, 200))], { bullet: true, after: 80, line: 300 }));
    }
    const more = m.numbered.filter((y) => y.sev === 'H').length - 6;
    if (more > 0) out.push(P(`……另有 ${more} 项高风险问题，见第 2 节。`, { bullet: true, after: 80, line: 300 }));
  }
  if (failed) out.push(P(`另有 ${failed} 个实例连接失败，未能巡检（单独统计，不计入异常），请先恢复连通性后重新巡检。`));
  out.push(H2('1.1 各领域评估'));
  const rows = m.cats.map((c) => { const a = domainAssess(m, c); return [m.categoryLabel[c] || c, { t: a.label, fill: a.fill }, a.note]; });
  push(out, table(['领域', '评估', '要点'], rows, [22, 14, 64]));
  return out;
}

function issuesSection(m) {
  const out = [H1('2. 问题清单与建议')];
  if (!m.numbered.length) { out.push(P('本次巡检未发现需要处理的问题。')); return out; }
  const LIMIT = 80;
  const rows = m.numbered.slice(0, LIMIT).map((x) => {
    const ev = [[run(`${clip(x.TITLE, 260)}`, { size: 19, bold: true })]];
    const meta = [`实例 ${x.INSTANCE_NAME}`];
    if (x.SQL_ID) meta.push(`SQL_ID ${x.SQL_ID}${x.SQL_ID_KIND ? `（${KIND[x.SQL_ID_KIND] || x.SQL_ID_KIND}）` : ''}`);
    else if (x.OBJECT_KEY && x.OBJECT_KEY !== '-') meta.push(`对象 ${clip(x.OBJECT_KEY, 80)}`);
    if (x.CURRENT_VALUE != null && x.CURRENT_VALUE !== '') meta.push(`当前值 ${x.CURRENT_VALUE}${x.THRESHOLD_TEXT ? `，阈值 ${x.THRESHOLD_TEXT}` : ''}`);
    ev.push(clip(meta.join('；'), 260));
    if (x.SQL_TEXT) ev.push([new TextRun({ text: clip(x.SQL_TEXT, 160), font: { ascii: 'Consolas', hAnsi: 'Consolas', eastAsia: 'Consolas' }, size: 16 })]);
    return [{ t: x.no, fill: SEV_TXT[x.sev][1], bold: true }, ev, clip(x.ADVICE || '请结合检查项说明核查并整改。', 300)];
  });
  push(out, table(['编号', '问题与证据', '建议'], rows, [8, 50, 42], { cantSplit: false }));
  if (m.numbered.length > LIMIT) out.push(P(`（仅列出前 ${LIMIT} 项，其余 ${m.numbered.length - LIMIT} 项请在系统「问题项」页查看。）`, { size: 18, color: '595959', before: 80 }));
  return out;
}

function envSection(m, no) {
  const out = [H1(`${no}. 环境概况`)];
  const evOf = (id, code) => m.d.evidenceBy.get(`${id}|${code}`);
  const rows = [];
  rows.push(['巡检实例', `${m.instances.length} 个；成功 ${m.instances.filter((i) => i.EXEC_STATUS === 'OK').length}，连接失败 ${m.instances.filter((i) => i.EXEC_STATUS === 'FAILED').length}`]);
  for (const i of m.instances) {
    const parts = [`${i.DB_TYPE} ${i.HOST_IP || ''}`];
    if (i.EXEC_STATUS === 'FAILED') parts.push(`巡检失败：${clip(i.ERROR_MSG, 120)}`);
    else {
      parts.push(`得分 ${i.SCORE ?? '-'}；严重 ${i.CRIT_CNT} / 预警 ${i.WARN_CNT}${i.ITEMS_ERR ? `；采集失败项 ${i.ITEMS_ERR}` : ''}`);
      const nodes = evOf(i.INSTANCE_ID, 'ora.env.instances');
      if (nodes && nodes.rows.length) parts.push(`RAC 节点：${nodes.rows.map((x) => `${x.INSTANCE_NAME || x.OBJ}（${x.HOST_NAME || ''} ${x.STATUS || ''}）`).join('；')}`);
      const dbi = evOf(i.INSTANCE_ID, 'ora.env.database');
      if (dbi && dbi.rows[0]) { const b = dbi.rows[0]; parts.push(`${b.DATABASE_ROLE || ''} ${b.OPEN_MODE || ''}，${b.LOG_MODE || ''}，CDB=${b.CDB || '-'}`); }
    }
    rows.push([i.INSTANCE_NAME, parts.map((x) => clip(x, 300))]);
  }
  push(out, table(['项目', '配置'], rows, [26, 74]));
  return out;
}

function evidenceTable(ev, maxRows = 10, maxCols = 7) {
  if (!ev || !ev.rows || !ev.rows.length) return null;
  const cols = ev.columns.filter((c) => !['SQL_TEXT'].includes(c)).slice(0, maxCols);
  const head = cols.map((c) => (c === 'OBJ' ? '对象' : c));
  const rows = ev.rows.slice(0, maxRows).map((r) => cols.map((c) => clip(r[c], 70)));
  return table(head, rows, cols.map((c) => (c === 'OBJ' ? 2 : 1)), { cantSplit: true });
}

function categorySections(m, startNo) {
  const out = []; let no = startNo;
  for (const cat of m.cats) {
    const rs = m.results.filter((x) => x.CATEGORY === cat);
    if (cat === 'SQL' && !rs.length) continue;
    out.push(H1(`${no}. ${m.categoryLabel[cat] || cat}`)); no++;
    const multi = m.instances.length > 1;
    const rows = rs.map((x) => {
      const k = `${x.INSTANCE_ID}|${x.ITEM_CODE}`;
      const refs = m.noByKey.get(k);
      let verdict; let fill;
      if (x.STATUS === 'CRITICAL') { verdict = '高'; fill = FILL.high; } else if (x.STATUS === 'WARNING') { verdict = LOW_CATS.has(cat) ? '低' : '中'; fill = LOW_CATS.has(cat) ? FILL.ok : FILL.mid; }
      else if (x.STATUS === 'ERROR') { verdict = '采集失败'; fill = FILL.na; } else if (x.STATUS === 'NA') { verdict = '不适用'; fill = FILL.na; }
      else if (x.STATUS === 'INFO') { verdict = '信息'; fill = undefined; } else { verdict = '正常'; fill = FILL.ok; }
      const note = refs && refs.length ? `见 ${refs.slice(0, 4).join('、')}${refs.length > 4 ? ' 等' : ''}` : clip(x.MESSAGE, 120);
      const name = multi ? [[run(x.ITEM_NAME, { size: 19, bold: true })], [run(m.instName(x.INSTANCE_ID), { size: 17, color: '595959' })]] : x.ITEM_NAME;
      return [name, clip(x.WORST_VALUE || (x.STATUS === 'INFO' ? x.MESSAGE : '') || '', 80), { t: verdict, fill }, note];
    });
    push(out, table(['检查项', '结果', '结论', '说明'], rows, [34, 20, 10, 36], { cantSplit: false }));
    // 信息类检查项明细
    const infos = rs.filter((x) => x.STATUS === 'INFO' && m.d.evidenceByResult.get(x.RESULT_ID));
    const LIMIT_INFO = 14;
    for (const x of infos.slice(0, LIMIT_INFO)) {
      const t = evidenceTable(m.d.evidenceByResult.get(x.RESULT_ID));
      if (!t) continue;
      out.push(P([run(`${x.ITEM_NAME}`, { bold: true, size: 19, color: NAVY }), run(m.instances.length > 1 ? `（${m.instName(x.INSTANCE_ID)}）` : '', { size: 17, color: '595959' })], { before: 160, after: 60, keepNext: true }));
      out.push(t);
    }
    if (infos.length > LIMIT_INFO) out.push(P(`（另有 ${infos.length - LIMIT_INFO} 项信息类明细未在本节展开，可在系统「巡检记录 → 证据」或 Excel 明细中查看。）`, { size: 17, color: '595959', before: 80 }));
  }
  return { out, next: no };
}

function sqlSection(m, no) {
  const snaps = m.snaps;
  const out = [H1(`${no}. 高消耗 SQL`)];
  if (!snaps.length) {
    out.push(P('本次巡检没有 SQL 统计数据（模板未含 SQL 检查项，或目标库未启用/无权读取统计视图：Oracle V$SQL、PG pg_stat_statements、MySQL performance_schema、达梦 V$SQL_STAT）。', { color: '595959' }));
    return { out, next: no + 1 };
  }
  out.push(P('每条 SQL 均带 SQL_ID：Oracle=SQL_ID，PostgreSQL=queryid，MySQL=digest，达梦=SQL_ID；取不到原生 ID 时用 SQL 指纹（FP:）标识。AWR / 统计视图只列出靠前的语句，数值是下限。'));
  const fams = [...new Set(snaps.map((s) => s.DB_FAMILY))].sort((a, b) => ['ORACLE', 'POSTGRESQL', 'MYSQL', 'DAMENG'].indexOf(a) - ['ORACLE', 'POSTGRESQL', 'MYSQL', 'DAMENG'].indexOf(b));
  let k = 0;
  for (const fam of fams) {
    k++;
    out.push(H2(`${no}.${k} ${FAM_LABEL[fam] || fam}`));
    const list = snaps.filter((s) => s.DB_FAMILY === fam);
    // 同实例同 sql_id 合并，保留各维度
    const merged = new Map();
    for (const s of list) {
      const key = `${s.INSTANCE_ID}|${s.SQL_ID}`;
      if (!merged.has(key)) merged.set(key, { ...s, dims: new Set(), sev: null });
      const g = merged.get(key);
      g.dims.add(DIM[s.DIMENSION] || s.DIMENSION || s.ITEM_CODE);
      if (s.SEVERITY === 'CRITICAL' || (s.SEVERITY === 'WARNING' && g.sev !== 'CRITICAL')) g.sev = s.SEVERITY;
      for (const f of ['EXECS', 'TOTAL_MS', 'AVG_MS', 'LOGICAL_READS', 'PHYSICAL_READS', 'ROWS_EXAMINED', 'PLAN_HASH']) if (g[f] == null && s[f] != null) g[f] = s[f];
    }
    const arr = [...merged.values()].sort((a, b) => (b.TOTAL_MS ?? -1) - (a.TOTAL_MS ?? -1) || (b.METRIC_VALUE ?? 0) - (a.METRIC_VALUE ?? 0)).slice(0, 25);
    const totalMs = arr.reduce((a, g) => a + (Number(g.TOTAL_MS) || 0), 0);
    const multi = m.instances.length > 1;
    const rows = arr.map((g) => {
      const perExec = fam === 'MYSQL' ? (g.ROWS_EXAMINED != null && g.EXECS ? g.ROWS_EXAMINED / g.EXECS : null) : ((g.LOGICAL_READS ?? g.PHYSICAL_READS) != null && g.EXECS ? (g.LOGICAL_READS ?? g.PHYSICAL_READS) / g.EXECS : null);
      const mono = (t, size = 17) => new TextRun({ text: t, font: { ascii: 'Consolas', hAnsi: 'Consolas', eastAsia: 'Consolas' }, size });
      const problems = [[run([...g.dims].join('、'), { size: 18, bold: true })], [run(clip(g.SQL_TEXT, 110), { size: 16, color: '595959' })]];
      return [
        [[mono(g.SQL_ID)], [run(`${KIND[g.SQL_ID_KIND] || g.SQL_ID_KIND || ''}${multi ? ` · ${m.instName(g.INSTANCE_ID)}` : ''}`, { size: 15, color: '595959' })]],
        g.TOTAL_MS != null ? num(Number(g.TOTAL_MS) / 1000, 1) : '',
        g.TOTAL_MS != null && totalMs ? `${num((Number(g.TOTAL_MS) / totalMs) * 100, 1)}%` : '',
        num(g.EXECS), perExec != null ? num(perExec) : '',
        { t: problems, fill: g.sev === 'CRITICAL' ? FILL.high : g.sev === 'WARNING' ? FILL.mid : undefined },
      ];
    });
    push(out, table(['SQL_ID', '耗时 (秒)', '占比', '执行次数', fam === 'MYSQL' ? '单次扫描行' : '单次逻辑读', '对象 / 问题'], rows, [24, 10, 8, 10, 12, 36]));
    out.push(P(`占比为占本表所列语句总耗时的比例；共 ${merged.size} 条去重 SQL，仅列前 ${arr.length} 条。`, { size: 17, color: '595959', before: 60 }));
  }
  return { out, next: no + 1 };
}

function planSection(m, no) {
  const out = [H1(`${no}. 实施计划`)];
  const bucket = { H: [], M: [], L: [] };
  for (const x of m.numbered) bucket[x.sev].push(x);
  const line = (x) => P([run(`${x.no}　`, { bold: true }), run(`${x.INSTANCE_NAME}：${clip(x.ITEM_NAME, 40)} —— ${clip(x.ADVICE || x.TITLE, 120)}`)], { bullet: true, after: 80, line: 300 });
  const sect = (title, list, empty) => {
    out.push(H2(title));
    if (!list.length) { out.push(P(empty, { color: '595959' })); return; }
    const seen = new Set(); let n = 0;
    for (const x of list) { const k = `${x.ITEM_CODE}|${x.INSTANCE_ID}`; if (seen.has(k)) continue; seen.add(k); out.push(line(x)); if (++n >= 30) break; }
    if (list.length > 30) out.push(P(`……其余 ${list.length - 30} 项见第 2 节。`, { size: 18, color: '595959' }));
  };
  sect(`${no}.1 立即（1 周内）`, bucket.H, '无高风险问题。');
  sect(`${no}.2 短期（1 个月内）`, bucket.M, '无。');
  sect(`${no}.3 中期`, bucket.L, '无。');
  const failed = m.instances.filter((i) => i.EXEC_STATUS === 'FAILED');
  if (failed.length) out.push(P(`另：恢复 ${failed.map((i) => i.INSTANCE_NAME).join('、')} 的连通性后补充巡检。`, { before: 100 }));
  return { out, next: no + 1 };
}

function appendices(m) {
  const out = [H1('附录 A. 数据来源')];
  const rows = m.instances.map((i) => [`${i.INSTANCE_NAME}（${i.DB_TYPE} ${i.HOST_IP || ''}）`,
    i.EXEC_STATUS === 'FAILED' ? `连接失败：${clip(i.ERROR_MSG, 100)}` : `共 ${i.ITEMS_TOTAL ?? '-'} 个检查项，其中采集失败 ${i.ITEMS_ERR ?? 0}、不适用 ${i.ITEMS_NA ?? 0}；耗时 ${num((i.DURATION_MS || 0) / 1000, 1)} 秒`]);
  rows.push([`DIOps 数据库巡检 #${m.r.RUN_ID}`, `模板「${m.r.TEMPLATE_NAME || ''}」，采集语句为只读查询；判定由规则引擎完成`]);
  push(out, table(['来源', '内容'], rows, [38, 62]));

  out.push(H1('附录 B. 常用核查命令'));
  const seen = new Set(); let n = 0;
  for (const x of m.numbered) {
    if (seen.has(x.ITEM_CODE)) continue; seen.add(x.ITEM_CODE);
    const inst = m.instances.find((i) => i.INSTANCE_ID === x.INSTANCE_ID);
    const fam = TYPE_FAM[String(inst?.DB_TYPE || '').toUpperCase()];
    const sql = m.d.implSql.get(`${x.ITEM_CODE}|${fam}`);
    if (!sql || String(sql).startsWith('-- adaptive')) continue;
    out.push(P(`${x.ITEM_NAME}（${FAM_LABEL[fam] || fam}）：`, { bold: true, after: 40, before: 100, keepNext: true }));
    String(sql).replace(/\{\{TOPN\}\}/g, '10').replace(/\{\{DAYS\}\}/g, '1').replace(/\{\{MINEXECS\}\}/g, '3')
      .split(/(?<=;)|\n/).map((s) => s.trim()).filter(Boolean).forEach((ln) => out.push(Code(clip(ln, 1500))));
    if (++n >= 12) break;
  }
  if (!n) out.push(P('本次无异常项，无需附核查命令。'));
  return out;
}

// ------------------------------------------------------------------ 入口
async function buildDoc(d) {
  const m = buildModel(d);
  const fams = [...new Set(m.instances.map((i) => FAM_LABEL[TYPE_FAM[String(i.DB_TYPE).toUpperCase()]] || i.DB_TYPE))];
  const names = m.instances.slice(0, 3).map((i) => i.INSTANCE_NAME).join('/') + (m.instances.length > 3 ? ' 等' : '');
  const hdr = `${fams.length === 1 ? `${fams[0]} ` : ''}数据库巡检报告 · ${names}`;

  const body = [];
  push(body, ...conclusion(m).filter(Boolean));
  push(body, ...issuesSection(m));
  let no = 3;
  push(body, ...envSection(m, no)); no++;
  const cs = categorySections(m, no); push(body, ...cs.out); no = cs.next;
  const sq = sqlSection(m, no); push(body, ...sq.out); no = sq.next;
  const pl = planSection(m, no); push(body, ...pl.out);
  push(body, ...appendices(m));

  // 第一章从新页开始（封面之后）
  if (body[0]) body[0] = new Paragraph({ heading: HeadingLevel.HEADING_1, pageBreakBefore: true, keepNext: true, children: [new TextRun({ text: '1. 巡检结论', font: FONT })] });

  const doc = new Document({
    creator: 'DIOps', title: '数据库巡检报告',
    styles: {
      default: { document: { run: { font: FONT, size: 21 } } },
      paragraphStyles: [
        { id: 'Heading1', name: 'heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { font: FONT, bold: true, color: NAVY, size: 30 }, paragraph: { spacing: { before: 360, after: 160 }, keepNext: true, outlineLevel: 0 } },
        { id: 'Heading2', name: 'heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { font: FONT, bold: true, color: NAVY, size: 25 }, paragraph: { spacing: { before: 240, after: 120 }, keepNext: true, outlineLevel: 1 } },
      ],
    },
    sections: [{
      properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1134, bottom: 1134, left: 1134, right: 1134, header: 708, footer: 708 } } },
      headers: { default: new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: hdr, font: FONT, size: 16, color: '595959' })] })] }) },
      footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ children: ['第 ', PageNumber.CURRENT, ' 页 / 共 ', PageNumber.TOTAL_PAGES, ' 页'], font: FONT, size: 16, color: '595959' })] })] }) },
      children: [...cover(m).filter(Boolean), ...body],
    }],
  });
  return Packer.toBuffer(doc);
}

module.exports = { buildDoc };
