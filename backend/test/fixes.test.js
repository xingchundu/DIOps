/**
 * 代码审查修复的单元测试（不依赖数据库）：node --test test/
 */
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');

process.env.DBOPS_SECRET_KEY = process.env.DBOPS_SECRET_KEY || 'unit-test-key';

test('splitSql：引号/注释/PLSQL 块/$$ 函数体', () => {
  const { splitSql, isPlsqlBlock } = require('../src/utils/sqlScript');
  const ora = splitSql(`SELECT 'a;b' FROM dual; -- x;y
BEGIN
  NULL; dbms_output.put_line('1;2');
END;
/
UPDATE t SET c = 1;`, 'ORACLE');
  assert.strictEqual(ora.length, 3);
  assert.ok(isPlsqlBlock(ora[1]));
  const pg = splitSql(`CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql; SELECT 1;`, 'POSTGRESQL');
  assert.strictEqual(pg.length, 2);
  assert.strictEqual(splitSql('STOP SLAVE; START SLAVE;', 'MYSQL').length, 2);
});

test('secrets：AES-GCM 往返，与 Java 同格式；兼容历史 Base64', () => {
  const s = require('../src/utils/secrets');
  const enc = s.encrypt('P@ss中文;1');
  assert.ok(enc.startsWith(s.PREFIX));
  assert.notStrictEqual(enc, s.encrypt('P@ss中文;1'));
  assert.strictEqual(s.decrypt(enc), 'P@ss中文;1');
  assert.strictEqual(s.decrypt('b2xkcHdk'), 'oldpwd');
});

test('partialSet：只更新请求里出现的字段', () => {
  const { partialSet } = require('../src/utils/partialUpdate');
  const { sets, binds } = partialSet({ name: 'x', remark: null }, { name: 'APP_NAME', remark: 'REMARK', owner: 'OWNER' });
  assert.strictEqual(sets.length, 2);
  assert.ok(!sets.join(',').includes('OWNER'));
  assert.deepStrictEqual(binds, ['x', null]);
});

test('部署参数：SHELL 走环境变量，SQL 参数白名单', () => {
  const src = require('fs').readFileSync(require.resolve('../src/services/deployRunner'), 'utf8');
  // 不加载整个模块（依赖数据库驱动），只取两个纯函数
  const m = {};
  new Function('m', src.slice(src.indexOf('function expandVars'), src.indexOf('/**\n * 执行 SHELL')) + '\nm.expandVars = expandVars; m.shellWithEnv = shellWithEnv;')(m);
  const evil = 'x"; rm -rf / #';
  const { cmd, env } = m.shellWithEnv('echo {{name}}', { name: evil });
  assert.ok(!cmd.includes('rm -rf'));
  if (process.platform !== 'win32') {
    const out = execFileSync('bash', ['-c', cmd], { env: { ...process.env, ...env } }).toString().trim();
    assert.strictEqual(out, evil);
  }
  assert.throws(() => m.expandVars('SELECT {{v}}', { v: "1; DROP TABLE t" }));
  assert.strictEqual(m.expandVars('SELECT {{v}}', { v: 'abc_1' }), 'SELECT abc_1');
});
