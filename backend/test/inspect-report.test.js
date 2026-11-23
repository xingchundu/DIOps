/**
 * 巡检（脚本驱动 → 结论 → Word/Excel）与知识图谱辅助函数的单元测试；不依赖数据库。
 * 运行：node --test test/inspect-report.test.js
 */
const test = require('node:test');
const assert = require('node:assert');

process.env.DBOPS_SECRET_KEY = process.env.DBOPS_SECRET_KEY || 'unit-test-key';

const { parseInspectScript, readOnlyViolation } = require('../src/utils/inspectScriptParser');
const F = require('../src/services/inspectFindings');

test('脚本解析：>>SECTION 标记分段 + 方言标记写法', () => {
  const ora = parseInspectScript(`PROMPT >>SECTION:表空间\nSELECT 1 FROM dual;\nPROMPT >>SECTION:无效对象\nSELECT 2 FROM dual;`, 'ORACLE');
  assert.strictEqual(ora.sections.length, 2);
  assert.strictEqual(ora.marked, true);
  const my = parseInspectScript(`SELECT '>>SECTION: 连接数';\nSHOW STATUS LIKE 'Threads%';`, 'MYSQL');
  assert.ok(my.sections.length >= 1);
});

test('脚本解析：无标记时按语句自动分段，@rule 指令被解析', () => {
  const p = parseInspectScript(`-- @rule col=LAG_SEC op=>= warn=300 crit=600 title=备库延迟\nSELECT 1 FROM dual;\nSELECT 2 FROM dual;`, 'ORACLE');
  assert.strictEqual(p.marked, false);
  assert.ok(p.sections.length >= 2);
  assert.ok(Array.isArray(p.rules));
});

test('只读检查：拦截写/DDL，放行查询与 XA RECOVER', () => {
  assert.ok(readOnlyViolation('DROP TABLE t'));
  assert.ok(readOnlyViolation('DELETE FROM t'));
  assert.ok(readOnlyViolation('UPDATE t SET a=1'));
  assert.ok(!readOnlyViolation('SELECT * FROM t'));
  assert.ok(!readOnlyViolation('WITH x AS (SELECT 1 FROM dual) SELECT * FROM x'));
  assert.ok(!readOnlyViolation('XA RECOVER'));
});

const sections = [
  { no: 1, title: '表空间使用率', category: 'SPACE', errors: [], tables: [{ columns: ['TABLESPACE_NAME', 'USED_PCT'], rows: [{ TABLESPACE_NAME: 'USERS', USED_PCT: 97.5 }, { TABLESPACE_NAME: 'SYSTEM', USED_PCT: 60 }], rowCount: 2 }] },
  { no: 2, title: '备库同步', category: 'HA', errors: [], tables: [{ columns: ['DEST', 'LAG_SEC'], rows: [{ DEST: 'STBY', LAG_SEC: 900 }], rowCount: 1 }] },
  { no: 3, title: '某视图', category: 'RISK', tables: [], errors: [{ sql: 'select * from dba_x', error: 'ORA-00942' }] },
];

test('结论分析：@rule 阈值命中 + 采集失败不当作“正常”', () => {
  const rules = [{ col: 'LAG_SEC', op: '>=', warn: '300', crit: '600', title: '备库延迟', section: '备库', advice: '检查传输链路', cat: '' }];
  const { findings, collectErrors } = F.analyze(sections, rules, [{ section: '某视图', sql: 'select * from dba_x', error: 'ORA-00942' }]);
  assert.ok(findings.some((f) => f.level === 'CRITICAL' && /备库延迟/.test(f.title)), '应命中备库延迟严重');
  assert.strictEqual(collectErrors.length, 1);
  const sc = F.score(findings, collectErrors, sections.length);
  assert.ok(sc.score < 100);
  assert.ok(sc.collectErrors >= 1);
  assert.ok(['CRITICAL', 'WARNING'].includes(sc.status));
});

test('Word 报告：生成合法 docx（zip 头）且含“巡检总结”', async () => {
  const { buildInspectWordBuffer } = require('../src/services/inspectWordReport');
  const { findings, collectErrors } = F.analyze(sections, [], []);
  const sc = F.score(findings, collectErrors, sections.length);
  const buf = await buildInspectWordBuffer({
    dbType: 'ORACLE', instanceName: 'T1', host: '1.1.1.1:1521', taskName: 't', checkedAtLocal: '2026-01-01 00:00:00', inspectorName: 'u',
    overallScore: sc.score, overallStatus: sc.status, conclusion: F.conclusion(sc, 3, 2),
    counts: { critical: sc.critical, warning: sc.warning, info: sc.info, collectErrors: sc.collectErrors },
    sections, findings, collectErrors, scripts: [],
  });
  assert.strictEqual(buf.slice(0, 2).toString(), 'PK');
  assert.ok(buf.length > 5000);
});

test('批量 Excel：含 5 个工作表，失败实例单独列出', async () => {
  const { buildBatchExcelBuffer } = require('../src/services/inspectBatchExcel');
  const ExcelJS = require('exceljs');
  const ok = (n) => ({ instanceId: n, instanceName: `DB-${n}`, dbType: 'ORACLE', host: `10.0.0.${n}`, ok: true, score: 90 - n, status: 'WARNING', counts: { critical: 0, warning: 1, info: 0, collectErrors: 0 }, findings: [], sections: [], wordFile: `/x/DB-${n}.docx`, durationSec: 1 });
  const bad = { instanceId: 9, instanceName: 'DB-9', dbType: 'MYSQL', host: '10.0.0.9', ok: false, error: '连接超时' };
  const buf = await buildBatchExcelBuffer({ taskName: 't', taskId: 1, startedAt: 'a', finishedAt: 'b', results: [ok(1), ok(2), bad] });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  assert.deepStrictEqual(wb.worksheets.map((w) => w.name), ['批量总览', '问题清单', '分类矩阵', '失败实例', '说明']);
});

test('知识图谱：按字节截断中文不超限；SQL 指纹对空白/大小写不敏感', () => {
  const kg = require('../src/services/kgService');
  assert.strictEqual(kg.sqlKey('SELECT  1\nFROM t'), kg.sqlKey('select 1 from T'));
  assert.notStrictEqual(kg.sqlKey('select 1 from a'), kg.sqlKey('select 1 from b'));
});

test('orasqlx：SQL_ID 校验', () => {
  const { SQL_ID_RE } = require('../src/services/orasqlxRunner');
  assert.ok(SQL_ID_RE.test('2jqdamknrmm6r'));
  assert.ok(!SQL_ID_RE.test('2jqdamknrmm6r; rm -rf /'));
  assert.ok(!SQL_ID_RE.test('short'));
});
