'use strict';
// 数据库巡检：不连库的单元测试（判定引擎 / 方言 / 目录完整性 / 采集 SQL 只读 / 自适应 DM / 报告生成）
process.env.DB_CONNECT_STRING = process.env.DB_CONNECT_STRING || 'x:1/y';
const test = require('node:test');
const assert = require('node:assert/strict');
const { judge, resolveThreshold, scoreOf } = require('../src/dbinspect/judge');
const dialect = require('../src/dbinspect/dialect');
const { ITEMS, TEMPLATES, CATEGORY_LABEL } = require('../src/dbinspect/catalog');
const { buildDmSqlStat } = require('../src/dbinspect/adaptive');
const { readOnlyViolation } = require('../src/utils/inspectScriptParser');
const { inWindow } = require('../src/dbinspect/scheduler');

const item = (rule, extra = {}) => ({ ITEM_CODE: 't.x', ITEM_NAME: 't', rule, ...extra });

test('阈值判定：HIGH / LOW、nullLevel', () => {
  const hi = judge(item({ type: 'THRESHOLD', direction: 'HIGH' }), [{ OBJ: 'USERS', VAL: 92 }, { OBJ: 'SYSTEM', VAL: 50 }], { warn: 80, crit: 90 }, '%');
  assert.equal(hi.status, 'CRITICAL');
  assert.equal(hi.findings.length, 1);
  assert.equal(hi.findings[0].objectKey, 'USERS');
  const lo = judge(item({ type: 'THRESHOLD', direction: 'LOW' }), [{ OBJ: 'db', VAL: 85 }], { warn: 90, crit: 80 }, '%');
  assert.equal(lo.status, 'WARNING');
  const ok = judge(item({ type: 'THRESHOLD', direction: 'HIGH' }), [{ OBJ: 'a', VAL: 10 }], { warn: 80, crit: 90 }, '%');
  assert.equal(ok.status, 'OK');
  assert.equal(ok.findings.length, 0);
});

test('ROWS 规则：有返回即异常；SQL 类问题以 sql_id 为对象键', () => {
  const r = judge(item({ type: 'ROWS', level: 'WARNING' }, { SQL_BEARING: 1 }), [{ SQL_ID: 'abc123', SQL_ID_KIND: 'SQL_ID', SQL_TEXT: 'select 1', OBJ: 'u1', VAL: 30 }], {}, '');
  assert.equal(r.status, 'WARNING');
  assert.match(r.findings[0].objectKey, /^abc123/);
  assert.equal(r.findings[0].sqlId, 'abc123');
  assert.equal(judge(item({ type: 'ROWS' }), [], {}, '').status, 'OK');
});

test('范围阈值优先级：实例 > 业务线 > 环境 > 数据库类型 > 默认', () => {
  const ovs = [
    { SCOPE_TYPE: 'DB_TYPE', SCOPE_VALUE: 'ORACLE', WARN_VALUE: 70, CRIT_VALUE: 80, ENABLED: 1 },
    { SCOPE_TYPE: 'ENV', SCOPE_VALUE: '测试', WARN_VALUE: 90, CRIT_VALUE: 95, ENABLED: 1 },
    { SCOPE_TYPE: 'INSTANCE', SCOPE_VALUE: '7', WARN_VALUE: 50, CRIT_VALUE: 60, ENABLED: 1 },
  ];
  const base = { WARN_VALUE: 80, CRIT_VALUE: 90 };
  const ctx = (o) => ({ dbType: 'ORACLE', family: 'ORACLE', env: '测试', bizLine: null, instanceId: 1, ...o });
  assert.equal(resolveThreshold(base, {}, ovs, ctx()).warn, 90);
  assert.equal(resolveThreshold(base, {}, ovs, ctx({ env: '生产' })).warn, 70);
  assert.equal(resolveThreshold(base, {}, ovs, ctx({ instanceId: 7 })).warn, 50);
  assert.equal(resolveThreshold(base, {}, [], ctx()).warn, 80);
});

test('得分：严重/预警扣分且不低于 0', () => {
  assert.equal(scoreOf(0, 0), 100);
  assert.ok(scoreOf(2, 3) < scoreOf(1, 0));
  assert.ok(scoreOf(99, 99) >= 0);
});

test('方言族归类与 sql_id 兜底（指纹）', () => {
  assert.equal(dialect.familyOf('GOLDENDB'), 'MYSQL');
  assert.equal(dialect.familyOf('PANWEI'), 'POSTGRESQL');
  assert.equal(dialect.familyOf('DAMENG'), 'DAMENG');
  const a = dialect.ensureSqlId({ SQL_TEXT: 'select * from t where id = 1' }, 'MYSQL');
  const b = dialect.ensureSqlId({ SQL_TEXT: 'SELECT *   FROM t WHERE id = 2' }, 'MYSQL');
  assert.match(a.sqlId, /^FP:/);
  assert.equal(a.kind, 'FINGERPRINT');
  assert.equal(a.sqlId, b.sqlId, '字面量不同的同一语句指纹应一致');
  const n = dialect.ensureSqlId({ SQL_ID: 'dd3ahs', SQL_TEXT: 'x' }, 'ORACLE');
  assert.equal(n.sqlId, 'dd3ahs');
  assert.equal(n.kind, 'SQL_ID');
  assert.equal(dialect.ensureSqlId({ SQL_ID: 'a1b2', SQL_TEXT: 'x' }, 'POSTGRESQL').kind, 'QUERYID');
  assert.equal(dialect.ensureSqlId({ SQL_ID: 'a1b2', SQL_TEXT: 'x' }, 'MYSQL').kind, 'DIGEST');
});

test('目录完整：模板引用的检查项都存在；每个检查项至少一种数据库实现；分类有中文名', () => {
  const codes = new Set(ITEMS.map((i) => i.code));
  assert.equal(codes.size, ITEMS.length, '检查项编码不得重复');
  for (const t of TEMPLATES) for (const c of t.items) assert.ok(codes.has(c), `${t.code} 引用了不存在的检查项 ${c}`);
  for (const i of ITEMS) {
    assert.ok(Object.keys(i.impls).length > 0, `${i.code} 没有任何采集实现`);
    assert.ok(CATEGORY_LABEL[i.category], `${i.code} 分类无中文名`);
  }
});

test('SQL 洞察检查项：四类数据库都有实现，且结果列包含 SQL_ID', () => {
  const sqlItems = ITEMS.filter((i) => i.code.startsWith('sql.') && i.code !== 'sql.stats_ready');
  assert.ok(sqlItems.length >= 9);
  for (const i of sqlItems) {
    for (const fam of ['ORACLE', 'MYSQL', 'POSTGRESQL', 'DAMENG']) {
      const im = i.impls[fam];
      if (!im) continue;                      // 个别维度仅部分库支持（如 top_cpu 仅 Oracle/达梦/PanWei）
      if (im.adaptive) continue;              // 达梦：运行时按实际列生成
      assert.match(`${im.sql}`, /SQL_ID/i, `${i.code}/${fam} 采集 SQL 未返回 SQL_ID`);
    }
  }
  const oraTop = ITEMS.find((i) => i.code === 'sql.top_elapsed').impls.ORACLE.sql;
  assert.match(oraTop, /sql_id/i);
  assert.match(ITEMS.find((i) => i.code === 'sql.top_elapsed').impls.MYSQL.sql, /DIGEST/i);
  assert.match(ITEMS.find((i) => i.code === 'sql.top_elapsed').impls.POSTGRESQL.sql, /queryid/i);
});

test('所有内置采集 SQL（含 fallback）通过只读校验', () => {
  let n = 0;
  for (const i of ITEMS) for (const im of Object.values(i.impls)) {
    for (const s of [im.sql, ...(im.fallback || [])]) {
      if (!s || String(s).startsWith('-- adaptive')) continue;
      const v = readOnlyViolation(String(s).replace(/\{\{\w+\}\}/g, '1')); n++;
      assert.equal(v, null, `${i.code}: ${v}`);
    }
  }
  assert.ok(n > 100);
});

test('达梦自适应 V$SQL_STAT：按实际列生成；缺 SQL_ID 列时给出明确报错', () => {
  const cols = ['SQL_ID', 'SQL_TEXT', 'EXEC_COUNT', 'TOTAL_EXEC_TIME', 'LOGIC_READ_CNT', 'PHY_READ_CNT'];
  const q = buildDmSqlStat(new Set(cols), 'elapsed', { divisor: 1000 });
  assert.match(String(q.sql || q), /V\$SQL_STAT/i);
  assert.match(String(q.sql || q), /SQL_ID/);
  assert.throws(() => buildDmSqlStat(new Set(['SQL_TEXT', 'EXEC_COUNT']), 'elapsed', { divisor: 1000 }), /SQL_ID/);
});

test('执行窗口：按北京时间，支持跨午夜', () => {
  const at = (h, m) => new Date(`2026-01-01T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+08:00`);
  assert.equal(inWindow('01:00', '06:00', at(2, 0)), true);
  assert.equal(inWindow('01:00', '06:00', at(7, 0)), false);
  assert.equal(inWindow('22:00', '06:00', at(23, 30)), true);
  assert.equal(inWindow('22:00', '06:00', at(3, 0)), true);
  assert.equal(inWindow('22:00', '06:00', at(12, 0)), false);
  assert.equal(inWindow('', '', at(12, 0)), true);
  // 02:00 UTC 是北京时间 10:00，不能因为宿主机时区落进凌晨窗口
  assert.equal(inWindow('01:00', '06:00', new Date('2026-01-01T02:00:00Z')), false);
});

test('STATUS：期望列表和异常列表同时生效', () => {
  const rule = { type: 'STATUS', ok: ['OPEN'], bad: ['DOWN'], level: 'CRITICAL' };
  const bad = judge(item(rule), [{ OBJ: 'a', TXT: 'UNKNOWN' }], {}, '');
  assert.equal(bad.status, 'CRITICAL');
  const listed = judge(item(rule), [{ OBJ: 'a', TXT: 'DOWN' }], {}, '');
  assert.equal(listed.status, 'CRITICAL');
  const ok = judge(item(rule), [{ OBJ: 'a', TXT: 'OPEN' }], {}, '');
  assert.equal(ok.status, 'OK');
});

test('报告：Word / Excel 可生成，SQL 洞察按库类型分节且带 SQL ID', async () => {
  const db = require('../src/config/db');
  const orig = db.execute;
  const run = { RUN_ID: 1, TEMPLATE_NAME: 'SQL 洞察', TRIGGER_TYPE: 'MANUAL', STATUS: 'SUCCESS', TOTAL_INST: 3, FAIL_INST: 1, OK_INST: 2, CRIT_CNT: 1, WARN_CNT: 2, STARTED_AT: new Date(), FINISHED_AT: new Date() };
  const inst = [
    { RUN_ID: 1, INSTANCE_ID: 1, INSTANCE_NAME: 'ora-prod', DB_TYPE: 'ORACLE', HOST_IP: '10.0.0.1', EXEC_STATUS: 'OK', CRIT_CNT: 1, WARN_CNT: 1, ITEMS_ERR: 0, ITEMS_NA: 0, SCORE: 80 },
    { RUN_ID: 1, INSTANCE_ID: 2, INSTANCE_NAME: 'my-prod', DB_TYPE: 'MYSQL', HOST_IP: '10.0.0.2', EXEC_STATUS: 'OK', CRIT_CNT: 0, WARN_CNT: 1, ITEMS_ERR: 1, ITEMS_NA: 0, SCORE: 95 },
    { RUN_ID: 1, INSTANCE_ID: 3, INSTANCE_NAME: 'pg-prod', DB_TYPE: 'POSTGRESQL', HOST_IP: '10.0.0.3', EXEC_STATUS: 'FAILED', ERROR_MSG: '连接失败：timeout', CRIT_CNT: 0, WARN_CNT: 0 },
  ];
  const snaps = [
    { INSTANCE_ID: 1, DB_FAMILY: 'ORACLE', DIMENSION: 'ELAPSED', ITEM_CODE: 'sql.top_elapsed', RANK_NO: 1, SQL_ID: 'dd3ahs9x2kq7p', SQL_ID_KIND: 'SQL_ID', PLAN_HASH: '123', EXECS: 100, TOTAL_MS: 5000, AVG_MS: 50, LOGICAL_READS: 1e6, SEVERITY: 'WARNING', SQL_TEXT: 'select * from t' },
    { INSTANCE_ID: 2, DB_FAMILY: 'MYSQL', DIMENSION: 'FULLSCAN', ITEM_CODE: 'sql.full_scan', RANK_NO: 1, SQL_ID: '8f3a9c0e11aa', SQL_ID_KIND: 'DIGEST', SCHEMA_NAME: 'app', EXECS: 10, TOTAL_MS: 900, AVG_MS: 90, ROWS_EXAMINED: 1e7, SEVERITY: 'CRITICAL', SQL_TEXT: 'select * from o where x=?' },
  ];
  const results = [
    { RESULT_ID: 1, INSTANCE_ID: 1, ITEM_CODE: 'storage.tablespace', ITEM_NAME: '表空间使用率', CATEGORY: 'STORAGE', STATUS: 'CRITICAL', WORST_VALUE: '96%', THRESHOLD_TEXT: '≥90%', MESSAGE: 'USERS 96%' },
    { RESULT_ID: 2, INSTANCE_ID: 1, ITEM_CODE: 'ora.env.instances', ITEM_NAME: '实例与节点（RAC）', CATEGORY: 'AVAILABILITY', STATUS: 'INFO', MESSAGE: '2 条' },
    { RESULT_ID: 3, INSTANCE_ID: 2, ITEM_CODE: 'sql.full_scan', ITEM_NAME: '全表扫描', CATEGORY: 'SQL', STATUS: 'WARNING', MESSAGE: '1 条' },
    { RESULT_ID: 4, INSTANCE_ID: 2, ITEM_CODE: 'log.errors', ITEM_NAME: '错误日志', CATEGORY: 'LOG', STATUS: 'ERROR', MESSAGE: '权限不足' },
  ];
  const issues = [
    { ISSUE_ID: 1, INSTANCE_ID: 1, INSTANCE_NAME: 'ora-prod', ITEM_CODE: 'storage.tablespace', ITEM_NAME: '表空间使用率', CATEGORY: 'STORAGE', OBJECT_KEY: 'USERS', SEVERITY: 'CRITICAL', TITLE: '表空间 USERS 当前 96%，超过严重阈值 90%', CURRENT_VALUE: '96%', THRESHOLD_TEXT: '≥90%', ADVICE: '扩容表空间', STATUS: 'OPEN', OCCURRENCES: 1, FIRST_SEEN: new Date() },
    { ISSUE_ID: 2, INSTANCE_ID: 2, INSTANCE_NAME: 'my-prod', ITEM_CODE: 'sql.full_scan', ITEM_NAME: '全表扫描', CATEGORY: 'SQL', OBJECT_KEY: '8f3a9c0e11aa', SEVERITY: 'WARNING', TITLE: '全表扫描 SQL 8f3a9c0e11aa', SQL_ID: '8f3a9c0e11aa', SQL_ID_KIND: 'DIGEST', SQL_TEXT: 'select * from o where x=?', ADVICE: '建索引', STATUS: 'OPEN', OCCURRENCES: 2, FIRST_SEEN: new Date() },
  ];
  db.execute = async (sql) => {
    const s = String(sql);
    const rows = /FROM DBI_RUN_INSTANCE/.test(s) ? inst : /EVIDENCE FROM DBI_RUN_RESULT|EVIDENCE IS NOT NULL/.test(s) ? [{ RESULT_ID: 2, INSTANCE_ID: 1, ITEM_CODE: 'ora.env.instances', EVIDENCE: JSON.stringify({ columns: ['OBJ', 'HOST_NAME', 'STATUS'], rows: [{ OBJ: 'inst1', HOST_NAME: 'db1', STATUS: 'OPEN' }, { OBJ: 'inst2', HOST_NAME: 'db2', STATUS: 'OPEN' }], total: 2 }) }] : /FROM DBI_RUN_RESULT/.test(s) ? results : /FROM DBI_ISSUE WHERE LAST_RUN_ID/.test(s) ? issues : /FROM DBI_CHECK_ITEM i LEFT JOIN DBI_CHECK_IMPL/.test(s) ? [{ ITEM_CODE: 'storage.tablespace', ADVICE: 'x', DB_FAMILY: 'ORACLE', SQL_TEXT: 'SELECT 1 FROM dual' }] : /FROM DBI_SQL_SNAPSHOT/.test(s) ? snaps : /FROM DBI_RUN WHERE/.test(s) ? [run] : [];
    return { rows };
  };
  try {
    const report = require('../src/dbinspect/report');
    const doc = await report.buildWord(1);
    assert.ok(doc.length > 5000);
    assert.equal(Buffer.from(doc).subarray(0, 2).toString(), 'PK');
    require('fs').writeFileSync(process.env.DBINSPECT_SAMPLE_DOCX || require('os').tmpdir() + '/dbinspect_sample.docx', doc);
    // 版式对齐附件：章节标题与结构
    const JSZip = require('jszip');
    const zx = await JSZip.loadAsync(doc);
    const xml = await zx.file('word/document.xml').async('string');
    for (const h of ['1. 巡检结论', '1.1 各领域评估', '2. 问题清单与建议', '3. 环境概况', '高消耗 SQL', '实施计划', '附录 A. 数据来源', '附录 B. 常用核查命令']) assert.ok(xml.includes(h), `缺少章节 ${h}`);
    assert.ok(xml.includes('H1') && xml.includes('M1'), '问题编号 H/M');
    assert.ok(xml.includes('8f3a9c0e11aa') && xml.includes('digest'), 'SQL_ID 与类型');
    const xlsx = await report.buildExcel(1);
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(xlsx);
    const names = wb.worksheets.map((w) => w.name);
    assert.ok(names.some((n) => /SQL洞察-.*Oracle/i.test(n)), names.join(','));
    assert.ok(names.some((n) => /SQL洞察-.*MySQL/i.test(n)), names.join(','));
    assert.ok(!names.some((n) => /PostgreSQL/i.test(n) && /SQL洞察/.test(n)), '无数据的库类型不应出现空 sheet');
    const ws = wb.worksheets.find((w) => /SQL洞察-.*Oracle/i.test(w.name));
    assert.equal(ws.getRow(2).getCell(5).value, 'dd3ahs9x2kq7p');
  } finally { db.execute = orig; }
});
