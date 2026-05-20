/**
 * Oracle 深度巡检 Word 报告 — 对齐 OracleDBDI 样例结构（由 enrichment + 脚本结果 JSON 生成）。
 */
const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  Table,
  TableRow,
  TableCell,
  HeadingLevel,
  WidthType,
  AlignmentType,
} = require('docx');

function p(text, opts = {}) {
  const { color, bold, italics, align } = opts;
  const runOpts = { text: String(text), font: 'SimSun' };
  if (color) runOpts.color = String(color).replace('#', '');
  if (bold) runOpts.bold = true;
  if (italics) runOpts.italics = true;
  return new Paragraph({
    children: [new TextRun(runOpts)],
    alignment: align,
  });
}

function cellPara(text, opts = {}) {
  return new TableCell({ children: [p(text == null ? '' : String(text), opts)] });
}

function table2col(pairs) {
  const rows = pairs.map(([a, b]) =>
    new TableRow({
      children: [cellPara(a, { bold: true }), cellPara(b == null ? 'N/A' : String(b))],
    })
  );
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows });
}

function tableFromRows(header, rows, cellOptsPerCell = null) {
  const heads = header.map((h) => cellPara(h, { bold: true }));
  const trh = new TableRow({ children: heads });
  const dataRows = rows.map((r, ri) =>
    new TableRow({
      children: r.map((cell, ci) => {
        const opt = cellOptsPerCell ? cellOptsPerCell(ri, ci, cell) : {};
        return cellPara(cell, opt);
      }),
    })
  );
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [trh, ...dataRows],
  });
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
    ['实例状态', dbst.instance_status || 'N/A', dbst.instance_status === 'OPEN' ? '正常' : '异常'],
    ['归档模式', dbst.log_mode || 'N/A', '正常'],
    ['活动会话', `${actSess}/${maxSess || 'N/A'}`, '正常'],
    ['离线数据文件', String(dbst.offline_datafiles ?? 0), '正常'],
    ['离线临时文件', String(dbst.offline_tempfiles ?? 0), '正常'],
    ['会话使用率', sessRatio != null ? `${sessRatio}%` : 'N/A', '正常'],
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
    [
      'Buffer Cache命中率',
      perf.buffer_cache_hit != null ? `${perf.buffer_cache_hit}%` : 'N/A',
      '≥95%',
      perf.buffer_cache_status === 'good' ? '正常' : '需关注',
    ],
    [
      'Library Cache命中率',
      perf.library_cache_hit != null ? `${perf.library_cache_hit}%` : 'N/A',
      '≥95%',
      perf.library_cache_status === 'good' ? '正常' : '需关注',
    ],
    ['无效对象数量', String(perf.invalid_objects ?? 0), '0', perf.invalid_objects > 0 ? '需关注' : '正常'],
    ['数据库状态', '运行中', '运行中', '正常'],
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
    ['最近备份时间', backup.last_backup || 'N/A', backup.backup_health === 'good' ? '正常' : '异常'],
    ['备份状态', backup.backup_status || 'N/A', backup.backup_status === 'COMPLETED' ? '正常' : '无备份'],
    ['备份类型', backup.backup_type || 'N/A', '正常'],
    ['归档模式', backup.archive_mode || 'N/A', backup.archive_status === 'good' ? '正常' : '未启用'],
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

  const safeChildren = buildChildrenList({
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

  const doc = new Document({
    sections: [{ properties: {}, children: safeChildren }],
  });

  return Packer.toBuffer(doc);
}

function mapOverallLabel(st) {
  const s = String(st || '').toUpperCase();
  if (s === 'PASS' || s === 'NORMAL') return '正常';
  if (s === 'WARN' || s === 'WARNING') return '需关注';
  if (s === 'FAIL' || s === 'CRITICAL') return '异常';
  return st || '—';
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

  const children = [
    new Paragraph({
      text: 'Oracle 数据库深度巡检报告',
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
    }),
    new Paragraph({
      children: [new TextRun({ text: `巡检时间: ${timeStr}`, font: 'SimSun' })],
      alignment: AlignmentType.CENTER,
    }),
    p(`实例: ${payload.instanceName || ''}  报告类型: ${payload.reportType || ''}`, { italics: true }),
    p(
      `综合得分: ${payload.overallScore ?? oracle.overallScore ?? '—'}  结论: ${mapOverallLabel(payload.overallStatus ?? oracle.overallStatus)}`,
      { bold: true }
    ),
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
        ['CPU使用率', '—', '由脚本/主机采集', '正常'],
        ['内存使用率', '—', '由脚本/主机采集', '正常'],
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
      children: [new TextRun({ text: '--- 报告结束 ---', font: 'SimSun' })],
      alignment: AlignmentType.CENTER,
    }),
  ];
  return children;
}

module.exports = { buildOracleDbdiDocxBuffer };
