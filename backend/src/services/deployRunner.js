'use strict';

const { spawnSync } = require('child_process');
const db = require('../config/db');
const {
  fetchCmdbInstance,
  connectOracle,
  connectMysql,
  connectPostgres,
  connectDameng,
  normalizeDbType,
} = require('../utils/monitorTargetConn');

/**
 * 展开模板变量 {{key}} → params[key]
 */
function expandVars(text, params) {
  if (!text || typeof text !== 'string') return text || '';
  return text.replace(/\{\{(\w+)\}\}/g, (_, k) => (params[k] != null ? String(params[k]) : `{{${k}}}`));
}

/**
 * 执行 SHELL 类型步骤
 */
function runShellStep(command, timeoutSec = 300) {
  const bash = process.platform === 'win32' ? 'bash' : 'bash';
  try {
    const r = spawnSync(bash, ['-c', command], {
      encoding: 'utf8',
      timeout: timeoutSec * 1000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = (r.stdout || '').trim();
    const stderr = (r.stderr || '').trim();
    if (r.status === 0) {
      return { status: 'SUCCESS', output: stdout || '命令执行成功', error: null };
    }
    return { status: 'FAILED', output: stdout, error: stderr || `exit code ${r.status}` };
  } catch (e) {
    return { status: 'FAILED', output: '', error: e.message };
  }
}

/**
 * 执行 SQL 类型步骤（连接目标实例执行）
 */
async function runSqlStep(command, instanceId) {
  let conn;
  try {
    const inst = await fetchCmdbInstance(instanceId);
    const dbType = normalizeDbType(inst);

    if (dbType === 'ORACLE') {
      conn = await connectOracle(inst);
      const result = await conn.execute(command, [], { autoCommit: true });
      const rows = result.rows || [];
      return { status: 'SUCCESS', output: `执行成功，影响 ${rows.length} 行`, error: null };
    }
    if (dbType === 'MYSQL' || dbType === 'GOLDENDB') {
      conn = await connectMysql(inst);
      const [result] = await conn.execute(command);
      return { status: 'SUCCESS', output: `执行成功，affectedRows: ${result.affectedRows || 0}`, error: null };
    }
    if (dbType === 'POSTGRESQL') {
      conn = await connectPostgres(inst);
      const result = await conn.query(command);
      return { status: 'SUCCESS', output: `执行成功，rowCount: ${result.rowCount || 0}`, error: null };
    }
    if (dbType === 'DAMENG') {
      conn = await connectDameng(inst);
      const result = await conn.execute(command, [], { autoCommit: true });
      return { status: 'SUCCESS', output: `执行成功`, error: null };
    }

    return { status: 'FAILED', output: '', error: `不支持的数据库类型: ${dbType}` };
  } catch (e) {
    return { status: 'FAILED', output: '', error: e.message };
  } finally {
    if (conn) {
      try { await conn.close(); } catch {}
    }
  }
}

/**
 * 执行 CHECK 类型步骤（连通性检查）
 */
async function runCheckStep(command, instanceId) {
  // CHECK 步骤：尝试连接目标实例验证可用性
  let conn;
  try {
    const inst = await fetchCmdbInstance(instanceId);
    const dbType = normalizeDbType(inst);

    if (dbType === 'ORACLE') {
      conn = await connectOracle(inst);
      await conn.close(); conn = null;
    } else if (dbType === 'MYSQL' || dbType === 'GOLDENDB') {
      conn = await connectMysql(inst);
      await conn.end(); conn = null;
    } else if (dbType === 'POSTGRESQL') {
      conn = await connectPostgres(inst);
      await conn.end(); conn = null;
    } else if (dbType === 'DAMENG') {
      conn = await connectDameng(inst);
      await conn.close(); conn = null;
    } else {
      return { status: 'FAILED', output: '', error: `不支持的数据库类型: ${dbType}` };
    }

    return { status: 'SUCCESS', output: `${dbType} 实例连接正常`, error: null };
  } catch (e) {
    return { status: 'FAILED', output: '', error: `连接检查失败: ${e.message}` };
  } finally {
    if (conn) {
      try { await conn.close(); } catch {}
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
  if (job.STATUS === 'RUNNING') throw new Error('任务正在执行中');
  if (job.STATUS === 'CANCELLED') throw new Error('任务已取消');

  let steps = [];
  try { steps = JSON.parse(job.STEPS_JSON || '[]'); } catch { steps = []; }
  const params = (() => { try { return JSON.parse(job.PARAMS || '{}'); } catch { return {}; } })();

  // 更新状态为 RUNNING
  await db.execute(
    `UPDATE DEPLOY_JOB SET STATUS='RUNNING', START_TIME=SYSTIMESTAMP, UPDATED_AT=SYSTIMESTAMP, STEPS_LOG=NULL WHERE JOB_ID=:1`,
    [jobId], { autoCommit: true }
  );

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
      const command = expandVars(step.command, params);

      if (step.type === 'SHELL') {
        result = runShellStep(command);
      } else if (step.type === 'SQL') {
        result = await runSqlStep(command, job.INSTANCE_ID);
      } else if (step.type === 'CHECK') {
        result = await runCheckStep(command, job.INSTANCE_ID);
      } else {
        result = { status: 'FAILED', output: '', error: `未知步骤类型: ${step.type}` };
      }

      logEntry.status = result.status;
      logEntry.output = result.output;
      logEntry.error = result.error;
      logEntry.duration = Date.now() - startTime;

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

  await db.execute(
    `UPDATE DEPLOY_JOB SET STATUS=:1, END_TIME=SYSTIMESTAMP, UPDATED_AT=SYSTIMESTAMP,
     LOG_SUMMARY=:2, STEPS_LOG=:3 WHERE JOB_ID=:4`,
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
