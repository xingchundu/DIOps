/**
 * Oracle 深度巡检 Word 报告 — 对齐 OracleDBDI 样例结构（由 enrichment + 脚本结果 JSON 生成）。
 */
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
} = require('docx');
const {
  FONT, LANDSCAPE_W, statusLabel, fixedTable, pageBreak, headerFooter, sectionProperties,
} = require('./inspectDocxLayout');

/** 无数据不能伪装成「正常」：统一输出「未采集」 */
function statusOrUnknown(actual, ok, bad = '需关注') {
  if (actual == null || actual === '' || actual === 'N/A' || actual === '—') return '未采集';
  return ok ? '正常' : bad;
}

function p(text, opts = {}) {
  const { color, bold, italics, align } = opts;
  const runOpts = { text: String(text), font: FONT, size: opts.size || 20 };
  if (color) runOpts.color = String(color).replace('#', '');
  if (bold) runOpts.bold = true;
  if (italics) runOpts.italics = true;
  return new Paragraph({ children: [new TextRun(runOpts)], alignment: align });
}

/** 两列基础信息表 */
function table2col(pairs) {
  const rows = pairs.map(([a, b]) => [String(a), b == null || b === '' ? 'N/A' : String(b)]);
  return fixedTable(['项目', '值'], rows, LANDSCAPE_W) || p('（无基础信息）');
}

function tableFromRows(header, rows, cellOptsPerCell = null) {
  const t = fixedTable(header.map(String), rows, LANDSCAPE_W, cellOptsPerCell);
  // 空结果不生成「只有表头」的空表，避免报告里出现大量空表格
  return t || p('（无返回记录）', { color: '888888' });
}

function paramStatusText(val, name) {
  const n = String(name || '').toLowerCase();
  const v = String(val || '');
  if (n.includes('processes') && Number(v) < 500) return '需优化';
  if (n.includes('sessions') && Number(v) < 1000) return '需优化';
  return '正常';
}

/**
 * @param {object} payload — INSPECT_REPORT JSON：含 oracleEnrichment、scriptSections、errors 等
 * @returns {Promise<Buffer>}
 */
async function buildOracleDbdiDocxBuffer(payload) {
  const oracle = payload.oracleEnrichment || {};
  const basic = oracle.basic_info || {};
  const dbst = oracle.db_status || {};
  const params = oracle.parameters || [];
  const perf = oracle.performance || {};
  const tss = oracle.tablespaces || [];
  const large = oracle.large_objects || [];
  const backup = oracle.backup || {};
  const sec = oracle.security || {};
  const alerts = oracle.alerts || [];
  const issues = oracle.issues || [];
  const waitEvents = oracle.wait_events || [];
  const scriptSections = payload.scriptSections || [];
  const scriptErrors = payload.scriptErrors || [];

  const inspector = payload.inspectorName || '平台自动巡检';
  const timeStr =
    payload.checkedAtLocal ||
    (payload.checkedAt ? String(payload.checkedAt).replace('T', ' ').slice(0, 19) : '');

  const maxSess = Number(dbst.max_sessions) || 0;
  const actSess = Number(dbst.active_sessions) || 0;
  const sessRatio = maxSess > 0 ? Number(((actSess / maxSess) * 100).toFixed(1)) : null;

  const basicPairs = [
    ['数据库名称', basic.db_name],
    ['数据库版本', basic.db_version],
    ['实例名称', basic.instance_name],
    ['主机名', basic.host_name],
    ['操作系统', basic.os_version],
    ['数据库角色', basic.database_role],
    ['启动时间', basic.startup_time],
    ['唯一名称', basic.db_unique_name],
    ['巡检人员', inspector],
  ];

  const runRowsPlain = [
    ['实例状态', dbst.instance_status || 'N/A', statusOrUnknown(dbst.instance_status, String(dbst.instance_status || '').toUpperCase() === 'OPEN')],
    ['归档模式', dbst.log_mode || 'N/A', statusOrUnknown(dbst.log_mode, /ARCHIVE/i.test(String(dbst.log_mode || '')), '未启用归档')],
    ['活动会话', `${actSess}/${maxSess || 'N/A'}`, statusOrUnknown(sessRatio, sessRatio != null && sessRatio < 85)],
    ['离线数据文件', String(dbst.offline_datafiles ?? 0), statusOrUnknown(dbst.offline_datafiles, Number(dbst.offline_datafiles ?? 0) === 0)],
    ['离线临时文件', String(dbst.offline_tempfiles ?? 0), statusOrUnknown(dbst.offline_tempfiles, Number(dbst.offline_tempfiles ?? 0) === 0)],
    ['会话使用率', sessRatio != null ? `${sessRatio}%` : 'N/A', statusOrUnknown(sessRatio, sessRatio != null && sessRatio < 85)],
  ];

  const paramRows = params.slice(0, 12).map((x) => {
    const st = paramStatusText(x.value, x.name);
    return [
      x.name,
      String(x.value ?? 'N/A'),
      '见基线建议',
      x._error ? String(x._error).slice(0, 80) : '—',
      st,
    ];
  });

  const perfRows = [
    ['Buffer Cache命中率', perf.buffer_cache_hit != null ? `${perf.buffer_cache_hit}%` : 'N/A', '≥95%',
      statusOrUnknown(perf.buffer_cache_hit, perf.buffer_cache_status === 'good')],
    ['Library Cache命中率', perf.library_cache_hit != null ? `${perf.library_cache_hit}%` : 'N/A', '≥95%',
      statusOrUnknown(perf.library_cache_hit, perf.library_cache_status === 'good')],
    ['无效对象数量', String(perf.invalid_objects ?? 0), '0', statusOrUnknown(perf.invalid_objects, Number(perf.invalid_objects ?? 0) === 0)],
    ['数据库状态', dbst.instance_status || 'N/A', 'OPEN', statusOrUnknown(dbst.instance_status, String(dbst.instance_status || '').toUpperCase() === 'OPEN')],
  ];

  const tsHeader = ['表空间名', '总大小(GB)', '已用(GB)', '空闲(GB)', '使用率', '自动扩展', '状态'];
  const tsRows = tss.slice(0, 40).map((x) => {
    const pct = Number(x.used_pct) || 0;
    const maxG = Number(x.max_gb) || 0;
    const usedG = maxG > 0 ? +((pct / 100) * maxG).toFixed(2) : null;
    const freeG = maxG > 0 && usedG != null ? +(maxG - usedG).toFixed(2) : null;
    let stLabel = '正常';
    if (pct >= 95) stLabel = '紧急扩容';
    else if (pct >= 85) stLabel = '需关注';
    return [
      x.name || '',
      maxG ? maxG.toFixed(2) : '—',
      usedG != null ? String(usedG) : '—',
      freeG != null ? String(freeG) : '—',
      `${pct.toFixed(2)}%`,
      '—',
      stLabel,
    ];
  });

  const backupRows = [
    ['最近备份时间', backup.last_backup || 'N/A', statusOrUnknown(backup.last_backup, backup.backup_health === 'good')],
    ['备份状态', backup.backup_status || 'N/A', statusOrUnknown(backup.backup_status, backup.backup_status === 'COMPLETED', '无备份')],
    ['备份类型', backup.backup_type || 'N/A', statusOrUnknown(backup.backup_type, true)],
    ['归档模式', backup.archive_mode || 'N/A', statusOrUnknown(backup.archive_mode, backup.archive_status === 'good', '未启用')],
  ];

  const secUsers = (sec.unlocked_default_users || []).map((u) => [
    u.USERNAME || u.username,
    u.ACCOUNT_STATUS || u.account_status,
    '高风险',
  ]);

  const flatAlerts = alerts.length
    ? [
        p(`最近24小时内发现 ${alerts.length} 条告警信息:`, { bold: true }),
        ...alerts.slice(0, 15).map(
          (a) =>
            new Paragraph({
              children: [
                new TextRun({
                  text: `[${a.time || a.ALERT_TIME || ''}] `,
                  font: 'SimSun',
                  bold: true,
                  color: 'FF8C00',
                }),
                new TextRun({
                  text: String(a.message || a.MESSAGE_TEXT || '').slice(0, 900),
                  font: 'SimSun',
                }),
              ],
            })
        ),
      ]
    : [p('（近期无 v$diag_alert_ext 告警或权限不足）')];

  const { cover, body } = buildChildrenList({
    basicPairs,
    runRowsPlain,
    paramRows,
    perfRows,
    tsHeader,
    tsRows,
    backupRows,
    secUsers,
    sec,
    alerts,
    issues,
    scriptErrors,
    scriptSections,
    waitEvents,
    large,
    timeStr,
    payload,
    oracle,
    flatAlerts,
  });

  const title = 'Oracle 数据库深度巡检报告';
  const hf = headerFooter(title, payload.instanceName || '');
  const doc = new Document({
    creator: 'DIOps', title,
    styles: { default: { document: { run: { font: FONT, size: 20 } } } },
    sections: [
      { properties: sectionProperties(false), ...hf, children: cover },
      { properties: sectionProperties(true), ...hf, children: body },
    ],
  });

  return Packer.toBuffer(doc);
}

function mapOverallLabel(st) {
  const s = String(st || '').toUpperCase();
  if (s === 'PASS' || s === 'NORMAL') return '正常';
  if (s === 'WARN' || s === 'WARNING') return '预警';
  if (s === 'FAIL' || s === 'CRITICAL') return '严重';
  return statusLabel(st);
}

function flattenScriptSections(scriptSections) {
  const out = [];
  if (!scriptSections || !scriptSections.length) {
    out.push(p('（本节暂无脚本结果集）'));
    return out;
  }
  for (const sec of scriptSections) {
    out.push(new Paragraph({ text: String(sec.title || '分段'), heading: HeadingLevel.HEADING_2 }));
    const tables = sec.tables || [];
    if (!tables.length) {
      out.push(p('（无表格输出）'));
      continue;
    }
    for (const tb of tables) {
      const cols = tb.columns || [];
      const rows = tb.rows || [];
      if (!cols.length) continue;
      const data = rows.map((r) => cols.map((c) => (r[c] != null ? String(r[c]) : '')));
      out.push(tableFromRows(cols, data));
    }
  }
  return out;
}

function buildChildrenList(ctx) {
  const {
    basicPairs,
    runRowsPlain,
    paramRows,
    perfRows,
    tsHeader,
    tsRows,
    backupRows,
    secUsers,
    sec,
    issues,
    scriptErrors,
    scriptSections,
    waitEvents,
    large,
    timeStr,
    payload,
    oracle,
    flatAlerts,
  } = ctx;

  const cover = [
    p('', { after: 600 }),
    p('Oracle 数据库深度巡检报告', { size: 48, bold: true, align: AlignmentType.CENTER, color: '1F3A5F', after: 160 }),
    p(`巡检时间：${timeStr}`, { size: 22, align: AlignmentType.CENTER, color: '666666', after: 400 }),
    p(`实例：${payload.instanceName || ''}`, { size: 28, align: AlignmentType.CENTER, after: 80 }),
    p(`报告类型：${payload.reportType || '综合巡检'}`, { size: 22, align: AlignmentType.CENTER, after: 200 }),
    p(`综合得分：${payload.overallScore ?? oracle.overallScore ?? '—'}`, { size: 40, bold: true, align: AlignmentType.CENTER, after: 120 }),
    p(`综合结论：${mapOverallLabel(payload.overallStatus ?? oracle.overallStatus)}`, { size: 28, bold: true, align: AlignmentType.CENTER, after: 400 }),
    p(`巡检人：${payload.inspectorName || '平台自动巡检'}`, { size: 20, align: AlignmentType.CENTER }),
    pageBreak(),
  ];

  const body = [
    new Paragraph({ text: '一、基础信息', heading: HeadingLevel.HEADING_1 }),
    table2col(basicPairs),
    new Paragraph({ text: '二、数据库运行状态', heading: HeadingLevel.HEADING_1 }),
    tableFromRows(['检查项', '结果', '状态'], runRowsPlain, (ri, ci) => {
      if (ci === 2) {
        const ok = runRowsPlain[ri][2] === '正常';
        return ok ? { color: '008000' } : { color: 'DC1414', bold: true };
      }
      if (ci === 1) return { color: '008000' };
      return {};
    }),
    new Paragraph({ text: '三、主机资源使用情况', heading: HeadingLevel.HEADING_1 }),
    p('（主机 CPU/内存由主机监控或巡检脚本附录提供）', { italics: true }),
    tableFromRows(
      ['资源类型', '当前使用率', '详细信息', '状态'],
      [
        ['CPU使用率', '—', '由脚本/主机采集', '未采集'],
        ['内存使用率', '—', '由脚本/主机采集', '未采集'],
      ]
    ),
    new Paragraph({ text: '磁盘空间使用情况 (df -h)', heading: HeadingLevel.HEADING_2 }),
    p('（若脚本中输出主机磁盘信息，见第十二节「巡检脚本摘录」）', { italics: true }),
    new Paragraph({ text: '四、重要参数配置', heading: HeadingLevel.HEADING_1 }),
    paramRows.length
      ? tableFromRows(['参数名', '当前值', '建议值', '说明', '状态'], paramRows, (ri, ci) => {
          if (ci === 4 && paramRows[ri][4] === '需优化') return { color: 'FF8C00', bold: true };
          if (ci === 4) return { color: '008000' };
          return {};
        })
      : p('（无参数数据）'),
    new Paragraph({ text: '五、性能指标分析', heading: HeadingLevel.HEADING_1 }),
    tableFromRows(['性能指标', '当前值', '标准值', '状态'], perfRows, (ri, ci) =>
      ci === 3 && perfRows[ri][3] !== '正常' ? { color: 'FF8C00', bold: true } : ci === 3 ? { color: '008000' } : {}
    ),
    new Paragraph({ text: '主要等待事件 (TOP 5)', heading: HeadingLevel.HEADING_2 }),
    waitEvents.length
      ? tableFromRows(
          ['等待事件', '等待次数', '等待时间(秒)'],
          waitEvents.map((w) => [w.event, String(w.waits), String(w.time_sec)])
        )
      : p('（无等待事件数据或权限不足）'),
    new Paragraph({ text: '六、表空间使用情况', heading: HeadingLevel.HEADING_1 }),
    tsRows.length
      ? tableFromRows(tsHeader, tsRows, (ri, ci) => {
          const st = tsRows[ri][6];
          if (ci === 6 && st === '紧急扩容') return { color: 'DC1414', bold: true };
          if (ci === 6 && st === '需关注') return { color: 'FF8C00', bold: true };
          if (ci === 4) return { color: '008000' };
          return {};
        })
      : p('（无表空间数据）'),
    new Paragraph({ text: '七、大对象分析 (>1GB)', heading: HeadingLevel.HEADING_1 }),
    large.length
      ? tableFromRows(
          ['Owner', '对象名', '类型', '大小(GB)', '表空间'],
          large.map((o) => [
            o.owner || o.OWNER,
            o.name || o.SEGMENT_NAME,
            o.type || o.SEGMENT_TYPE,
            String(o.size_gb ?? o.SIZE_GB ?? ''),
            o.tablespace || o.TABLESPACE_NAME,
          ])
        )
      : p('未发现大于1GB的对象'),
    new Paragraph({ text: '八、备份与恢复状态', heading: HeadingLevel.HEADING_1 }),
    tableFromRows(['检查项', '结果', '状态'], backupRows, (ri, ci) => {
      if (ci === 2) {
        const v = backupRows[ri][2];
        if (v === '正常') return { color: '008000' };
        if (v === '无备份') return { color: 'DC1414', bold: true };
        return { color: 'FF8C00', bold: true };
      }
      return {};
    }),
    new Paragraph({ text: '九、安全检查', heading: HeadingLevel.HEADING_1 }),
    new Paragraph({ text: '9.1 默认用户状态', heading: HeadingLevel.HEADING_2 }),
    secUsers.length
      ? tableFromRows(['用户名', '账户状态', '风险等级'], secUsers, (ri, ci) =>
          ci === 2 ? { color: 'DC1414', bold: true } : {}
        )
      : p('（无未锁定默认账户样本数据）'),
    p(`审计状态: ${sec.audit_trail || 'N/A'}`),
    new Paragraph({ text: '十、告警日志分析', heading: HeadingLevel.HEADING_1 }),
    ...flatAlerts,
    new Paragraph({ text: '十一、巡检总结与建议', heading: HeadingLevel.HEADING_1 }),
    new Paragraph({ text: '11.1 问题摘要', heading: HeadingLevel.HEADING_2 }),
    ...(issues.length
      ? issues.map((x) => p(`• ${x}`, { color: 'FF8C00' }))
      : [p('（无明显扣分项）', { color: '008000' })]),
    ...(scriptErrors.length
      ? [
          new Paragraph({ text: '11.2 脚本执行异常', heading: HeadingLevel.HEADING_2 }),
          ...scriptErrors.slice(0, 8).map((e) => p(`• ${e.error || e}`, { color: 'DC1414' })),
        ]
      : []),
    new Paragraph({ text: '11.3 运维建议', heading: HeadingLevel.HEADING_2 }),
    p('1. 定期关注表空间与归档空间，提前规划扩容。'),
    p('2. 保持备份与恢复策略可用，定期做恢复演练。'),
    p('3. 定期巡检告警日志与安全基线。'),
    p('4. 结合本报告中「第十二节」脚本输出核对细节。'),
    new Paragraph({ text: '十二、巡检脚本摘录（脚本库执行结果）', heading: HeadingLevel.HEADING_1 }),
    ...flattenScriptSections(scriptSections),
    new Paragraph({
      children: [new TextRun({ text: '--- 报告结束 ---', font: FONT })],
      alignment: AlignmentType.CENTER,
    }),
  ];
  return { cover, body };
}

module.exports = { buildOracleDbdiDocxBuffer };
