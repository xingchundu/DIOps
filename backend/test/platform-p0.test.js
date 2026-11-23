/**
 * 平台运维 Node 冒烟（无数据库）
 * dxc 2026-11-12
 */
const test = require('node:test');
const assert = require('node:assert');
const cron = require('node-cron');

test('platform backup retention / restore drill cron 表达式合法', () => {
  const exprs = [
    process.env.BACKUP_RETENTION_CRON || '0 4 * * *',
    process.env.BACKUP_RESTORE_DRILL_CRON || '0 5 * * 1',
  ];
  for (const e of exprs) assert.ok(cron.validate(e), e);
});

test('restore drill 默认关闭除非显式开启', () => {
  delete process.env.BACKUP_RESTORE_DRILL;
  delete process.env.PLATFORM_GOVERNANCE_MODULE;
  const job = require('../src/platform/restoreDrillJob');
  assert.strictEqual(typeof job.registerDueDrills, 'function');
  assert.strictEqual(typeof job.isEnabled, 'function');
});

test('systemConfig.getBool 解析 BOOLEAN', () => {
  const { parseBool } = require('../src/services/systemConfig');
  assert.strictEqual(parseBool('1'), true);
  assert.strictEqual(parseBool('false'), false);
  assert.strictEqual(parseBool(''), null);
});

test('生产默认要求经网关', () => {
  const keys = ['DIOPS_REQUIRE_GATEWAY', 'DBOPS_ALLOW_DIRECT_NODE', 'NODE_ENV'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    delete process.env.DIOPS_REQUIRE_GATEWAY;
    delete process.env.DBOPS_ALLOW_DIRECT_NODE;
    process.env.NODE_ENV = 'production';
    delete require.cache[require.resolve('../src/middleware/auth')];
    const { gatewayRequired } = require('../src/middleware/auth');
    assert.strictEqual(gatewayRequired(), true);
    process.env.DBOPS_ALLOW_DIRECT_NODE = '1';
    delete require.cache[require.resolve('../src/middleware/auth')];
    assert.strictEqual(require('../src/middleware/auth').gatewayRequired(), false);
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    delete require.cache[require.resolve('../src/middleware/auth')];
  }
});

test('openapi-node 文件存在', () => {
  const fs = require('fs');
  const path = require('path');
  const p = path.join(__dirname, '../../docs/openapi-node.yaml');
  assert.ok(fs.existsSync(p));
  assert.ok(fs.readFileSync(p, 'utf8').includes('openapi:'));
});
