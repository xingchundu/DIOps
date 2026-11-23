/**
 * 批量巡检 Excel 汇总：多实例巡检结束后生成一份总览，便于管理层/值班快速定位“哪些库有问题、问题是什么”。
 *
 * Sheet：
 *   1 批量总览   —— 任务信息 + 统计卡片 + 每实例一行（评分 / 状态 / 严重·警告·提示 / Top 问题 / Word 文件 / 结果）
 *   2 问题清单   —— 所有实例的发现项（可筛选、按级别排序）
 *   3 分类矩阵   —— 实例 × 分类 的 严重/警告 计数
 *   4 失败实例   —— 连接失败 / 执行失败的实例与原因
 *   5 说明       —— 评分口径与图例
 */
'use strict';

const ExcelJS = require('exceljs');
const { CATEGORY_LABEL, CATEGORY_ORDER } = require('../utils/inspectScriptParser');
const { LEVEL_LABEL, LEVEL_RANK } = require('./inspectFindings');

const STATUS_LABEL = { NORMAL: '正常', WARNING: '预警', CRITICAL: '严重', FAILED: '失败' };
const FILL = {
  head: 'FF1F3A5F', NORMAL: 'FFE2F0D9', WARNING: 'FFFFF2CC', CRITICAL: 'FFF8CBAD', FAILED: 'FFD9D9D9', card: 'FFEAEFF5',
};

function headRow(ws, rowNo, count) {
  const r = ws.getRow(rowNo);
  for (let c = 1; c <= count; c++) {
    const cell = r.getCell(c);
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: FILL.head } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  }
  r.height = 22;
}

function box(ws, fromRow, toRow, cols) {
  const thin = { style: 'thin', color: { argb: 'FFC9D1DB' } };
  for (let r = fromRow; r <= toRow; r++) {
    for (let c = 1; c <= cols; c++) ws.getRow(r).getCell(c).border = { top: thin, bottom: thin, left: thin, right: thin };
  }
}

/**
 * @param {{taskName:string, taskId?:number, startedAt:string, finishedAt:string, results: Array<{
 *   instanceId, instanceName, dbType, host, ok:boolean, error?:string, score?, status?, counts?, findings?, sections?, wordFile?, durationSec?, conclusion? }>}} data
 * @returns {Promise<Buffer>}
 */
async function buildBatchExcelBuffer(data) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'DIOps';
  wb.created = new Date();
  const results = data.results || [];
  const okList = results.filter((r) => r.ok);
  const failList = results.filter((r) => !r.ok);
  const scores = okList.map((r) => r.score).filter((x) => Number.isFinite(x));
  const avg = scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10 : null;
  const cnt = (st) => okList.filter((r) => r.status === st).length;

  // ───────── 1 批量总览 ─────────
  const ws = wb.addWorksheet('批量总览', { views: [{ state: 'frozen', ySplit: 9, xSplit: 2 }] });
  const COLS = [
    { h: '序号', w: 6 }, { h: '实例', w: 24 }, { h: '类型', w: 12 }, { h: '地址', w: 22 }, { h: '综合评分', w: 10 }, { h: '结论', w: 9 },
    { h: '严重', w: 7 }, { h: '警告', w: 7 }, { h: '提示', w: 7 }, { h: '检查项', w: 8 }, { h: '执行失败', w: 9 },
    { h: '主要问题（Top3）', w: 60 }, { h: 'Word 报告', w: 34 }, { h: '耗时(s)', w: 8 }, { h: '执行结果', w: 40 },
  ];
  COLS.forEach((c, i) => { ws.getColumn(i + 1).width = c.w; });

  ws.mergeCells(1, 1, 1, COLS.length);
  ws.getCell('A1').value = `批量巡检汇总 — ${data.taskName || ''}`;
  ws.getCell('A1').font = { size: 16, bold: true, color: { argb: FILL.head } };
  ws.getRow(1).height = 28;
  ws.mergeCells(2, 1, 2, COLS.length);
  ws.getCell('A2').value = `开始：${data.startedAt || ''}　结束：${data.finishedAt || ''}　任务ID：${data.taskId ?? ''}`;
  ws.getCell('A2').font = { color: { argb: 'FF666666' } };

  const cards = [
    ['实例总数', results.length], ['巡检成功', okList.length], ['巡检失败', failList.length], ['平均评分', avg ?? '—'],
    ['严重实例', cnt('CRITICAL')], ['预警实例', cnt('WARNING')], ['正常实例', cnt('NORMAL')],
    ['严重问题总数', okList.reduce((a, r) => a + (r.counts?.critical || 0), 0)],
  ];
  cards.forEach(([k, v], i) => {
    const col = 1 + (i % 4) * 3 + (i % 4 ? 0 : 0);
    const row = 4 + Math.floor(i / 4) * 2;
    const base = [1, 4, 7, 10][i % 4];
    ws.mergeCells(row, base, row, base + 2);
    ws.mergeCells(row + 1, base, row + 1, base + 2);
    const a = ws.getCell(row, base);
    a.value = k; a.font = { size: 10, color: { argb: 'FF666666' } }; a.alignment = { horizontal: 'center' };
    const b = ws.getCell(row + 1, base);
    b.value = v; b.font = { size: 18, bold: true }; b.alignment = { horizontal: 'center' };
    for (const c of [a, b]) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: FILL.card } };
    void col;
  });

  const HEAD = 9;
  COLS.forEach((c, i) => { ws.getRow(HEAD).getCell(i + 1).value = c.h; });
  headRow(ws, HEAD, COLS.length);

  const sorted = [...results].sort((a, b) => {
    const ra = a.ok ? (a.status === 'CRITICAL' ? 0 : a.status === 'WARNING' ? 1 : 3) : 0;
    const rb = b.ok ? (b.status === 'CRITICAL' ? 0 : b.status === 'WARNING' ? 1 : 3) : 0;
    return ra - rb || (a.score ?? -1) - (b.score ?? -1);
  });
  sorted.forEach((r, i) => {
    const top = (r.findings || []).slice(0, 3).map((f) => `[${LEVEL_LABEL[f.level]}] ${f.section ? f.section + '：' : ''}${f.title}`).join('\n');
    const st = r.ok ? r.status : 'FAILED';
    const row = ws.addRow([
      i + 1, r.instanceName || `#${r.instanceId}`, r.dbType || '', r.host || '', r.ok ? r.score : null, STATUS_LABEL[st] || st,
      r.ok ? r.counts?.critical ?? 0 : null, r.ok ? r.counts?.warning ?? 0 : null, r.ok ? r.counts?.info ?? 0 : null,
      r.ok ? (r.sections || []).length : null, r.ok ? r.counts?.collectErrors ?? 0 : null,
      r.ok ? top || '未发现问题' : '', r.wordFile ? String(r.wordFile).split(/[\\/]/).pop() : '', r.durationSec ?? null,
      r.ok ? (r.wordError ? `巡检完成，Word 生成失败：${r.wordError}` : '成功') : `失败：${r.error || ''}`,
    ]);
    row.alignment = { vertical: 'top', wrapText: true };
    row.getCell(6).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: FILL[st] || FILL.FAILED } };
    row.getCell(5).fill = row.getCell(6).fill;
    row.getCell(6).font = { bold: true };
    if (r.ok && r.counts?.critical) row.getCell(7).font = { bold: true, color: { argb: 'FFC00000' } };
  });
  box(ws, HEAD, ws.rowCount, COLS.length);
  // [fix] autoFilter 的 to.row 原来等于表头行本身，筛选范围不含任何数据行
  ws.autoFilter = { from: { row: HEAD, column: 1 }, to: { row: Math.max(HEAD, ws.rowCount), column: COLS.length } };

  // ───────── 2 问题清单 ─────────
  const wi = wb.addWorksheet('问题清单', { views: [{ state: 'frozen', ySplit: 1 }] });
  const ICOLS = [['实例', 22], ['类型', 11], ['级别', 8], ['分类', 11], ['检查项', 34], ['问题', 40], ['证据', 50], ['命中数', 8], ['整改建议', 60]];
  ICOLS.forEach(([h, w], i) => { wi.getColumn(i + 1).width = w; wi.getRow(1).getCell(i + 1).value = h; });
  headRow(wi, 1, ICOLS.length);
  const all = [];
  for (const r of okList) for (const f of r.findings || []) all.push({ r, f });
  all.sort((a, b) => LEVEL_RANK[b.f.level] - LEVEL_RANK[a.f.level] || String(a.r.instanceName).localeCompare(String(b.r.instanceName)));
  for (const { r, f } of all) {
    const row = wi.addRow([r.instanceName, r.dbType, LEVEL_LABEL[f.level], CATEGORY_LABEL[f.category] || f.category || '', f.section || '', f.title,
      (f.samples || [])[0] || f.detail || '', f.count, f.advice || '']);
    row.alignment = { vertical: 'top', wrapText: true };
    row.getCell(3).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: f.level === 'CRITICAL' ? FILL.CRITICAL : f.level === 'WARNING' ? FILL.WARNING : FILL.card } };
  }
  if (!all.length) wi.addRow(['本次批量巡检未发现问题']);
  box(wi, 1, wi.rowCount, ICOLS.length);
  wi.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, wi.rowCount), column: ICOLS.length } };

  // ───────── 3 分类矩阵 ─────────
  const wm = wb.addWorksheet('分类矩阵', { views: [{ state: 'frozen', ySplit: 1, xSplit: 1 }] });
  wm.getColumn(1).width = 26;
  wm.getRow(1).getCell(1).value = '实例 \\ 分类（严重/警告）';
  CATEGORY_ORDER.forEach((c, i) => { wm.getColumn(i + 2).width = 15; wm.getRow(1).getCell(i + 2).value = CATEGORY_LABEL[c]; });
  headRow(wm, 1, CATEGORY_ORDER.length + 1);
  for (const r of okList) {
    const vals = CATEGORY_ORDER.map((c) => {
      const fs = (r.findings || []).filter((f) => (f.category || 'OTHER') === c);
      const cr = fs.filter((f) => f.level === 'CRITICAL').length;
      const wa = fs.filter((f) => f.level === 'WARNING').length;
      return { cr, wa, text: cr || wa ? `${cr}/${wa}` : '-' };
    });
    const row = wm.addRow([r.instanceName, ...vals.map((v) => v.text)]);
    vals.forEach((v, i) => {
      const cell = row.getCell(i + 2);
      cell.alignment = { horizontal: 'center' };
      if (v.cr) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: FILL.CRITICAL } };
      else if (v.wa) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: FILL.WARNING } };
    });
  }
  box(wm, 1, wm.rowCount, CATEGORY_ORDER.length + 1);

  // ───────── 4 失败实例 ─────────
  const wf = wb.addWorksheet('失败实例');
  [['实例', 26], ['类型', 12], ['地址', 24], ['失败原因', 90]].forEach(([h, w], i) => { wf.getColumn(i + 1).width = w; wf.getRow(1).getCell(i + 1).value = h; });
  headRow(wf, 1, 4);
  for (const r of failList) wf.addRow([r.instanceName || `#${r.instanceId}`, r.dbType || '', r.host || '', r.error || '']).alignment = { wrapText: true, vertical: 'top' };
  if (!failList.length) wf.addRow(['全部实例巡检成功']);
  box(wf, 1, wf.rowCount, 4);

  // ───────── 5 说明 ─────────
  const wd = wb.addWorksheet('说明');
  wd.getColumn(1).width = 120;
  [
    '评分口径：100 分起扣。严重 -10（最多 -60）；警告 -3（最多 -30）；提示 -1（最多 -5）；语句执行失败 -2（最多 -10）。',
    '结论：存在严重问题或评分 < 70 = 严重；存在警告 / 执行失败或评分 < 85 = 预警；否则正常。',
    '“执行失败”多为账号权限不足 / 视图不存在 / 版本差异；对应检查项结果不完整，请补充授权后重新巡检。',
    '问题来源：脚本里的 “-- @rule” 阈值指令 + 通用规则（使用率、状态列、风险等级列、错误文本、异常对象类检查项有返回行）。',
    '每个实例的 Word 报告含「巡检总结」与「详细结果」，文件名见“批量总览”；可在平台“自动化运维 → 自动巡检 → 综合报告”下载。',
  ].forEach((t) => { wd.addRow([t]).alignment = { wrapText: true, vertical: 'top' }; });

  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = { buildBatchExcelBuffer };
