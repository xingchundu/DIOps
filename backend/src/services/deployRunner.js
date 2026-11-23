'use strict';

const { spawn } = require('child_process');
const db = require('../config/db');
const { splitSqlStatements } = require('./inspectScriptExecutor');
const {
  fetchCmdbInstance,
  connectOracle,
  connectMysql,
  connectPostgres,
  connectDameng,
  connectSqlServer,
  normalizeDbType,
} = require('../utils/monitorTargetConn');

/**
 * 展开模板变量 {{key}} → params[key]
 */
function expandVars(text, params) {
  if (!text || typeof text !== 'string') return text || '';
  return text.replace(/\{\{(\w+)\}\}/g, (_, k) => {
    if (params[k] == null) return `{{${k}}}`;
    const v = String(params[k]);
    // SQL / 检查步骤：参数值只允许常见的安全字符，防止借参数拼出额外语句
    if (!/^[\w.\-:/@ ,]*$/.test(v)) throw new Error(`参数 ${k} 含不允许的字符（只允许字母、数字、空格和 . - : / @ ,）`);
    return v;
  });
}

/**
 * SHELL 步骤：参数不做文本替换（会被注入任意命令），而是作为环境变量传给子进程，
 * 命令中的 {{key}} 改写为对环境变量的引用（bash: "$DIOPS_P_key"，cmd: %DIOPS_P_key%）。
 */
function shellWithEnv(text, params) {
  const env = {};
  const win = process.platform === 'win32';
  const cmd = String(text || '').replace(/\{\{(\w+)\}\}/g, (m, k) => {
    if (params[k] == null) return m;
    env[`DIOPS_P_${k}`] = String(params[k]);
    return win ? `%DIOPS_P_${k}%` : `"\${DIOPS_P_${k}}"`;
  });
  return { cmd, env };
}

/**
 * 执行 SHELL 类型步骤（Windows 用 cmd，Unix 用 bash）
 */
// [fix] 原 spawnSync 阻塞事件循环（单步最长 300s），部署期间整个后端无响应；改为异步
function runShellStep(command, timeoutSec = 300, extraEnv = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    let child;
    try {
      const opts = { env: { ...process.env, ...extraEnv }, detached: process.platform !== 'win32' };
      child = process.platform === 'win32'
        ? spawn('cmd.exe', ['/d', '/s', '/c', command], opts)
        : spawn('bash', ['-c', command], opts);
    } catch (e) {
      done({ status: 'FAILED', output: '', error: e.message });
      return;
    }
    const timer = setTimeout(() => {
      // 杀整个进程组，避免 bash 被杀后子进程成为孤儿继续运行
      try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* ignore */ } }
      done({ status: 'FAILED', output: stdout.trim(), error: `timeout after ${timeoutSec}s` });
    }, timeoutSec * 1000);
    child.stdout.on('data', (d) => { if (stdout.length < 1024 * 1024) stdout += d.toString('utf8'); });
    child.stderr.on('data', (d) => { if (stderr.length < 1024 * 1024) stderr += d.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(timer); done({ status: 'FAILED', output: '', error: e.message }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const out = stdout.trim();
      if (code === 0) done({ status: 'SUCCESS', output: out || '命令执行成功', error: null });
      else done({ status: 'FAILED', output: out, error: stderr.trim() || `exit code ${code}` });
    });
  });
}

const DEPLOY_FORBIDDEN_SQL_RE = /\b(drop\s+database|drop\s+user|truncate\s+table\s+(sys|system|dba_)|;\s*drop\s+(database|schema)\b)/i;

function assertDeploySql(command, dbType) {
  const stmts = splitSqlStatements(String(command || ''), dbType === 'DAMENG' ? 'ORACLE' : dbType);
  if (!stmts.length) throw new Error('SQL 内容为空');
  for (const st of stmts) {
    const stripped = st.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n\r]*/g, ' ').trim();
    if (!stripped) continue;
    if (DEPLOY_FORBIDDEN_SQL_RE.test(stripped)) {
      throw new Error('SQL 含不允许的危险操作');
    }
  }
  return stmts;
}

async function execOneSqlStatement(conn, dbType, sql) {
  if (dbType === 'ORACLE' || dbType === 'DAMENG') {
    const result = await conn.execute(sql, [], { autoCommit: true });
    return result.rowsAffected ?? (result.rows?.length || 0);
  }
  if (dbType === 'MYSQL' || dbType === 'GOLDENDB') {
    const [result] = await conn.execute(sql);
    return result.affectedRows || 0;
  }
  if (dbType === 'POSTGRESQL' || dbType === 'PANWEI') {
    const result = await conn.query(sql);
    return result.rowCount || 0;
  }
  if (dbType === 'SQLSERVER') {
    const result = await conn.request().query(sql);
    return (result.rowsAffected && result.rowsAffected[0]) || 0;
  }
  throw new Error(`不支持的数据库类型: ${dbType}`);
}

/**
 * 执行 SQL 类型步骤（连接目标实例执行）
 */
async function runSqlStep(command, instanceId) {
  let conn;
  let dbType = '';
  try {
    const inst = await fetchCmdbInstance(instanceId);
    dbType = normalizeDbType(inst);
    const stmts = assertDeploySql(command, dbType);
    let totalAffected = 0;

    if (dbType === 'ORACLE') conn = await connectOracle(inst);
    else if (dbType === 'MYSQL' || dbType === 'GOLDENDB') conn = await connectMysql(inst);
    else if (dbType === 'POSTGRESQL' || dbType === 'PANWEI') conn = await connectPostgres(inst);
    else if (dbType === 'DAMENG') conn = await connectDameng(inst);
    else if (dbType === 'SQLSERVER') conn = await connectSqlServer(inst);
    else return { status: 'FAILED', output: '', error: `不支持的数据库类型: ${dbType}` };

    for (const st of stmts) {
      totalAffected += Number(await execOneSqlStatement(conn, dbType, st)) || 0;
    }
    return { status: 'SUCCESS', output: `执行成功，共 ${stmts.length} 条语句，影响 ${totalAffected} 行`, error: null };
  } catch (e) {
    return { status: 'FAILED', output: '', error: e.message };
  } finally {
    if (conn) {
      try {
        if (dbType === 'ORACLE' || dbType === 'DAMENG') await conn.close();
        else if (dbType === 'MYSQL' || dbType === 'GOLDENDB' || dbType === 'POSTGRESQL' || dbType === 'PANWEI') await conn.end();
        else if (dbType === 'SQLSERVER') await conn.close();
        else await conn.close();
      } catch {}
    }
  }
}

/**
 * 执行 CHECK 类型步骤（连通性检查）
 */
async function runCheckStep(command, instanceId) {
  const cmd = String(command || '').trim();
  if (!cmd) {
    return runCheckConnectivity(instanceId);
  }
  if (/^(SELECT|SHOW|WITH|EXPLAIN)\b/i.test(cmd)) {
    return runSqlStep(cmd, instanceId);
  }
  return runShellStep(cmd);
}

async function runCheckConnectivity(instanceId) {
  let conn;
  let dbType = '';
  try {
    const inst = await fetchCmdbInstance(instanceId);
    dbType = normalizeDbType(inst);

    if (dbType === 'ORACLE') {
      conn = await connectOracle(inst);
      await conn.close(); conn = null;
    } else if (dbType === 'MYSQL' || dbType === 'GOLDENDB') {
      conn = await connectMysql(inst);
      await conn.end(); conn = null;
    } else if (dbType === 'POSTGRESQL' || dbType === 'PANWEI') {
      conn = await connectPostgres(inst);
      await conn.end(); conn = null;
    } else if (dbType === 'DAMENG') {
      conn = await connectDameng(inst);
      await conn.close(); conn = null;
    } else if (dbType === 'SQLSERVER') {
      conn = await connectSqlServer(inst);
      await conn.close(); conn = null;
    } else {
      return { status: 'FAILED', output: '', error: `不支持的数据库类型: ${dbType}` };
    }

    return { status: 'SUCCESS', output: `${dbType} 实例连接正常`, error: null };
  } catch (e) {
    return { status: 'FAILED', output: '', error: `连接检查失败: ${e.message}` };
  } finally {
    if (conn) {
      try {
        if (dbType === 'ORACLE' || dbType === 'DAMENG') await conn.close();
        else if (dbType === 'MYSQL' || dbType === 'GOLDENDB' || dbType === 'POSTGRESQL' || dbType === 'PANWEI') await conn.end();
        else if (dbType === 'SQLSERVER') await conn.close();
        else await conn.close();
      } catch {}
    }
  }
}

/**
 * 执行部署任务
 * @param {number} jobId - DEPLOY_JOB.JOB_ID
 * @param {object} opts - { cancelCheck: () => boolean }
 */
async function executeDeployJob(jobId, opts = {}) {
  const cancelCheck = opts.cancelCheck || (() => false);
  const preClaimed = opts.preClaimed === true;

  // 加载任务 + 模板
  const jobR = await db.execute(
    `SELECT j.JOB_ID, j.TEMPLATE_ID, j.INSTANCE_ID, j.HOST_ID, j.TARGET_IP, j.PARAMS, j.STATUS,
            t.TEMPLATE_NAME, t.STEPS_JSON, t.DB_TYPE
     FROM DEPLOY_JOB j
     JOIN DEPLOY_TEMPLATE t ON j.TEMPLATE_ID = t.TEMPLATE_ID
     WHERE j.JOB_ID = :1`, [jobId]
  );
  if (!jobR.rows.length) throw new Error('部署任务不存在');

  const job = jobR.rows[0];
  if (preClaimed) {
    if (job.STATUS !== 'RUNNING') throw new Error(`任务状态 ${job.STATUS} 无法执行`);
  } else {
    if (job.STATUS === 'RUNNING') throw new Error('任务正在执行中');
    if (job.STATUS === 'CANCELLED') throw new Error('任务已取消');
    // 更新状态为 RUNNING
    await db.execute(
      `UPDATE DEPLOY_JOB SET STATUS='RUNNING', START_TIME=SYSTIMESTAMP, UPDATED_AT=SYSTIMESTAMP, STEPS_LOG=NULL WHERE JOB_ID=:1`,
      [jobId], { autoCommit: true }
    );
  }

  let steps = [];
  try { steps = JSON.parse(job.STEPS_JSON || '[]'); } catch { steps = []; }
  const params = (() => { try { return JSON.parse(job.PARAMS || '{}'); } catch { return {}; } })();

  const stepLogs = [];
  let finalStatus = 'SUCCESS';
  let summary = '';

  for (let i = 0; i < steps.length; i++) {
    // 取消检查
    if (cancelCheck()) {
      finalStatus = 'CANCELLED';
      summary = `任务已取消（步骤 ${i + 1}/${steps.length} 执行前）`;
      stepLogs.push({ name: steps[i].name, type: steps[i].type, status: 'SKIPPED', output: '任务已取消', error: null, startTime: null, duration: 0 });
      // 剩余步骤标记 SKIPPED
      for (let j = i + 1; j < steps.length; j++) {
        stepLogs.push({ name: steps[j].name, type: steps[j].type, status: 'SKIPPED', output: '', error: null, startTime: null, duration: 0 });
      }
      break;
    }

    const step = steps[i];
    const startTime = Date.now();
    const logEntry = { name: step.name, type: step.type, status: 'RUNNING', output: '', error: null, startTime: new Date().toISOString(), duration: 0 };

    // 实时写入步骤日志
    stepLogs.push(logEntry);
    await updateStepsLog(jobId, stepLogs);

    try {
      let result;
      if (step.type === 'SHELL') {
        const { cmd, env } = shellWithEnv(step.command, params);
        result = await runShellStep(cmd, 300, env);
      } else if (step.type === 'SQL') {
        const command = expandVars(step.command, params);
        result = await runSqlStep(command, job.INSTANCE_ID);
      } else if (step.type === 'CHECK') {
        result = await runCheckStep(expandVars(step.command, params), job.INSTANCE_ID);
      } else {
        result = { status: 'FAILED', output: '', error: `未知步骤类型: ${step.type}` };
      }

      logEntry.status = result.status;
      logEntry.output = result.output;
      logEntry.error = result.error;
      logEntry.duration = Date.now() - startTime;

      if (cancelCheck()) {
        finalStatus = 'CANCELLED';
        summary = `任务已取消（步骤 ${i + 1}/${steps.length} 执行后）`;
        break;
      }

      if (result.status === 'FAILED') {
        finalStatus = 'FAILED';
        summary = `步骤「${step.name}」失败: ${result.error || '未知错误'}`;
        // 剩余步骤标记 SKIPPED
        for (let j = i + 1; j < steps.length; j++) {
          stepLogs.push({ name: steps[j].name, type: steps[j].type, status: 'SKIPPED', output: '', error: null, startTime: null, duration: 0 });
        }
        break;
      }
    } catch (e) {
      logEntry.status = 'FAILED';
      logEntry.error = e.message;
      logEntry.duration = Date.now() - startTime;
      finalStatus = 'FAILED';
      summary = `步骤「${step.name}」异常: ${e.message}`;
      for (let j = i + 1; j < steps.length; j++) {
        stepLogs.push({ name: steps[j].name, type: steps[j].type, status: 'SKIPPED', output: '', error: null, startTime: null, duration: 0 });
      }
      break;
    }

    // 每步骤完成后更新日志
    await updateStepsLog(jobId, stepLogs);
  }

  if (finalStatus === 'SUCCESS') {
    summary = `全部 ${steps.length} 个步骤执行成功`;
  }

  const curR = await db.execute(`SELECT STATUS FROM DEPLOY_JOB WHERE JOB_ID=:1`, [jobId]);
  const curStatus = curR.rows[0]?.STATUS;
  if (curStatus === 'CANCELLED' || cancelCheck()) {
    await db.execute(
      `UPDATE DEPLOY_JOB SET STEPS_LOG=:1, LOG_SUMMARY=:2, UPDATED_AT=SYSTIMESTAMP WHERE JOB_ID=:3`,
      [JSON.stringify(stepLogs), summary || '任务已取消', jobId],
      { autoCommit: true }
    );
    return { status: 'CANCELLED', summary: summary || '任务已取消', stepLogs };
  }

  await db.execute(
    `UPDATE DEPLOY_JOB SET STATUS=:1, END_TIME=SYSTIMESTAMP, UPDATED_AT=SYSTIMESTAMP,
     LOG_SUMMARY=:2, STEPS_LOG=:3 WHERE JOB_ID=:4 AND STATUS <> 'CANCELLED'`,
    [finalStatus, summary, JSON.stringify(stepLogs), jobId],
    { autoCommit: true }
  );

  return { status: finalStatus, summary, stepLogs };
}

/**
 * 更新步骤日志到 DEPLOY_JOB.STEPS_LOG
 */
async function updateStepsLog(jobId, stepLogs) {
  try {
    await db.execute(
      `UPDATE DEPLOY_JOB SET STEPS_LOG=:1, UPDATED_AT=SYSTIMESTAMP WHERE JOB_ID=:2`,
      [JSON.stringify(stepLogs), jobId],
      { autoCommit: true }
    );
  } catch {}
}

/**
 * 取消部署任务
 */
async function cancelDeployJob(jobId, userId) {
  const jobR = await db.execute(`SELECT STATUS FROM DEPLOY_JOB WHERE JOB_ID=:1`, [jobId]);
  if (!jobR.rows.length) throw new Error('任务不存在');
  const status = jobR.rows[0].STATUS;
  if (status !== 'PENDING' && status !== 'RUNNING') {
    throw new Error(`状态为 ${status}，无法取消`);
  }

  await db.execute(
    `UPDATE DEPLOY_JOB SET STATUS='CANCELLED', CANCELLED_BY=:1, CANCELLED_AT=SYSTIMESTAMP,
     UPDATED_AT=SYSTIMESTAMP, END_TIME=SYSTIMESTAMP WHERE JOB_ID=:2`,
    [userId, jobId],
    { autoCommit: true }
  );
}

// 运行中的任务取消标记
const cancelFlags = new Map();

function setCancelFlag(jobId) {
  cancelFlags.set(jobId, true);
}

function clearCancelFlag(jobId) {
  cancelFlags.delete(jobId);
}

function isCancelled(jobId) {
  return cancelFlags.get(jobId) === true;
}

module.exports = {
  executeDeployJob,
  cancelDeployJob,
  setCancelFlag,
  clearCancelFlag,
  isCancelled,
  expandVars,
};
