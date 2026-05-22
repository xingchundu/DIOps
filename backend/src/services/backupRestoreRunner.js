/**
 * 备份恢复中心：按 DB 类型解析脚本模板，优先执行 Shell（RMAN/mysqldump/pg_dump），
 * 不可用时回退为驱动连通校验 + 备份清单（manifest）落盘。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const db = require('../config/db');
const { automationLog } = require('./automationExecLog');
const {
  fetchCmdbInstance,
  connectOracle,
  connectMysql,
  connectPostgres,
  connectDameng,
  normalizeDbType,
  decodeDbPassword,
} = require('../utils/monitorTargetConn');

const SCRIPTS_ROOT = path.join(__dirname, '../../scripts/backup_restore');

/** 平台默认可写本地备份根目录（backend/data/backup） */
const DEFAULT_LOCAL_BACKUP_ROOT = path.resolve(
  process.env.BACKUP_LOCAL_ROOT || path.join(__dirname, '../../data/backup')
);

const LEGACY_PLACEHOLDER_PATHS = new Set(['/backup', '\\backup', '/backup/', 'backup', '']);

function resolveStorageRoot(policy, opts = {}) {
  const storageType = String(policy?.STORAGE_TYPE || 'LOCAL').toUpperCase();
  let raw = String(policy?.STORAGE_PATH ?? '').trim();

  if (storageType === 'LOCAL' || storageType === 'NFS') {
    const normalized = raw.replace(/\\/g, '/').replace(/\/+$/, '') || '';
    if (LEGACY_PLACEHOLDER_PATHS.has(normalized) || LEGACY_PLACEHOLDER_PATHS.has(raw)) {
      raw = DEFAULT_LOCAL_BACKUP_ROOT;
    }
    const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(process.cwd(), raw);
    if (opts.validateWrite) assertStorageWritable(abs, storageType);
    return abs;
  }

  if (!raw) raw = DEFAULT_LOCAL_BACKUP_ROOT;
  const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(process.cwd(), raw);
  if (opts.validateWrite && storageType === 'LOCAL') assertStorageWritable(abs, storageType);
  return abs;
}

function assertStorageWritable(root, storageType = 'LOCAL') {
  try {
    ensureDir(root);
    const probe = path.join(root, `.dio_write_probe_${process.pid}_${Date.now()}`);
    fs.writeFileSync(probe, 'ok', { flag: 'w' });
    fs.unlinkSync(probe);
  } catch (e) {
    const err = new Error(
      `${storageType === 'NFS' ? 'NFS' : '本地'}存储路径不可写或无法创建: ${root}（${e.message}）。` +
        `请填写有效目录，或留空使用平台默认: ${DEFAULT_LOCAL_BACKUP_ROOT}`
    );
    err.code = 'BAD_REQUEST';
    throw err;
  }
}

/** 新建/更新策略时规范化存储路径（写入库前） */
function normalizePolicyStoragePath(storageType, storagePath) {
  return resolveStorageRoot({ STORAGE_TYPE: storageType, STORAGE_PATH: storagePath }, { validateWrite: false });
}

const BACKUP_SCRIPT_MAP = {
  ORACLE: {
    FULL: 'oracle_rman_full.sh',
    INCREMENTAL: 'oracle_rman_incr.sh',
    LOGICAL: 'oracle_datapump.sh',
    PHYSICAL: 'oracle_rman_full.sh',
  },
  MYSQL: {
    FULL: 'mysql_mysqldump.sh',
    INCREMENTAL: 'mysql_mysqldump.sh',
    LOGICAL: 'mysql_mysqldump.sh',
    PHYSICAL: 'mysql_mysqldump.sh',
  },
  GOLDENDB: {
    FULL: 'mysql_mysqldump.sh',
    INCREMENTAL: 'mysql_mysqldump.sh',
    LOGICAL: 'mysql_mysqldump.sh',
    PHYSICAL: 'mysql_mysqldump.sh',
  },
  POSTGRESQL: {
    FULL: 'postgres_pg_dump.sh',
    INCREMENTAL: 'postgres_pg_dump.sh',
    LOGICAL: 'postgres_pg_dump.sh',
    PHYSICAL: 'postgres_pg_dump.sh',
  },
  DAMENG: {
    FULL: 'dameng_export.sh',
    INCREMENTAL: 'dameng_export.sh',
    LOGICAL: 'dameng_export.sh',
    PHYSICAL: 'dameng_export.sh',
  },
};

const RESTORE_SCRIPT_MAP = {
  ORACLE: {
    PITR: 'oracle_restore_pitr.sh',
    SINGLE_TABLE: 'oracle_restore_table.sh',
    FLASHBACK: 'oracle_restore_flashback.sh',
    FULL: 'oracle_restore_full.sh',
  },
  MYSQL: {
    PITR: 'mysql_restore_pitr.sh',
    SINGLE_TABLE: 'mysql_restore_table.sh',
    FLASHBACK: 'mysql_restore_full.sh',
    FULL: 'mysql_restore_full.sh',
  },
  GOLDENDB: {
    PITR: 'mysql_restore_pitr.sh',
    SINGLE_TABLE: 'mysql_restore_table.sh',
    FLASHBACK: 'mysql_restore_full.sh',
    FULL: 'mysql_restore_full.sh',
  },
  POSTGRESQL: {
    PITR: 'postgres_restore_pitr.sh',
    SINGLE_TABLE: 'postgres_restore_table.sh',
    FLASHBACK: 'postgres_restore_full.sh',
    FULL: 'postgres_restore_full.sh',
  },
  DAMENG: {
    PITR: 'dameng_restore_full.sh',
    SINGLE_TABLE: 'dameng_restore_full.sh',
    FLASHBACK: 'dameng_restore_full.sh',
    FULL: 'dameng_restore_full.sh',
  },
};

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/** 转为可 JSON 序列化的标量（避免 Oracle/达梦驱动对象循环引用） */
function toJsonSafe(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  try {
    return String(value);
  } catch {
    return null;
  }
}

function sanitizeRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => {
    const plain = {};
    for (const [k, v] of Object.entries(row || {})) {
      plain[k] = toJsonSafe(v);
    }
    return plain;
  });
}

function safeJsonStringify(obj) {
  const seen = new WeakSet();
  return JSON.stringify(obj, (key, val) => {
    if (val != null && typeof val === 'object') {
      if (typeof val === 'function') return undefined;
      if (seen.has(val)) return undefined;
      seen.add(val);
      if (val instanceof Date) return val.toISOString();
      const ctor = val.constructor?.name || '';
      if (/ConnectDescription|ConnOption|Connection|Pool/i.test(ctor)) return undefined;
    }
    return val;
  });
}

/** 解析 INSERT RETURNING 的 NUMBER 出参，避免把 BIND_OUT / 连接描述对象返回给前端 */
function extractOracleOutBindNumber(result, bindName) {
  const raw = result?.outBinds?.[bindName];
  if (raw == null) return null;
  const pick = Array.isArray(raw) ? raw[0] : raw;
  if (pick == null) return null;
  if (typeof pick === 'object') {
    const n = Number(pick);
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(pick);
  return Number.isFinite(n) ? n : null;
}

function buildRestoreDetail(inst, task, backupRecord) {
  const rt = toJsonSafe(task.RESTORE_TYPE);
  const tt = toJsonSafe(task.TARGET_TIME);
  const tbl = toJsonSafe(task.TARGET_TABLE);
  const scn = toJsonSafe(task.FLASHBACK_SCN);
  const bf = backupRecord?.FILE_PATH || null;
  const cs = buildConnectString(inst);
  let s = `驱动恢复预检通过 (${normalizeDbType(inst)} / ${rt})；连接 ${cs}`;
  if (bf) s += `；备份文件 ${bf}`;
  if (tt) s += `；目标时间 ${tt}`;
  if (tbl) s += `；表 ${tbl}`;
  if (scn != null && scn !== '') s += `；SCN ${scn}`;
  return `${s}；实例连通正常`;
}

function resolveScript(map, dbType, key) {
  const t = String(dbType || '').toUpperCase();
  const k = String(key || '').toUpperCase();
  const name = map[t]?.[k] || map.ORACLE?.FULL;
  if (!name) return null;
  const full = path.join(SCRIPTS_ROOT, name);
  return fs.existsSync(full) ? full : null;
}

function buildConnectString(inst) {
  const t = normalizeDbType(inst);
  if (t === 'ORACLE' || t === 'DAMENG') {
    return inst.SERVICE_NAME
      ? `${inst.HOST_IP}:${inst.PORT}/${inst.SERVICE_NAME}`
      : `${inst.HOST_IP}:${inst.PORT}/${inst.SID}`;
  }
  if (t === 'MYSQL' || t === 'GOLDENDB') {
    const dbName = inst.SERVICE_NAME || inst.SID || '';
    return dbName ? `${inst.HOST_IP}:${inst.PORT}/${dbName}` : `${inst.HOST_IP}:${inst.PORT}`;
  }
  if (t === 'POSTGRESQL') {
    const database = inst.SERVICE_NAME || inst.SID || 'postgres';
    return `${inst.HOST_IP}:${inst.PORT}/${database}`;
  }
  return `${inst.HOST_IP}:${inst.PORT}`;
}

function buildExecEnv(inst, policy, filePath, extra = {}) {
  const pwd = decodeDbPassword(inst.DB_PASSWORD);
  return {
    ...process.env,
    DB_TYPE: normalizeDbType(inst),
    DB_HOST: String(inst.HOST_IP || ''),
    DB_PORT: String(inst.PORT || ''),
    DB_USER: String(inst.DB_USER || ''),
    DB_PASSWORD: pwd,
    DB_CONNECT: buildConnectString(inst),
    INSTANCE_ID: String(inst.INSTANCE_ID),
    INSTANCE_NAME: String(inst.INSTANCE_NAME || ''),
    BACKUP_TYPE: String(policy?.BACKUP_TYPE || extra.BACKUP_TYPE || 'FULL'),
    STORAGE_PATH: String(
      policy?._resolvedStorageRoot || policy?.STORAGE_PATH || extra.STORAGE_PATH || DEFAULT_LOCAL_BACKUP_ROOT
    ),
    BACKUP_FILE: filePath,
    COMPRESS: policy?.COMPRESS ? '1' : '0',
    ENCRYPT: policy?.ENCRYPT ? '1' : '0',
    RESTORE_TYPE: String(extra.RESTORE_TYPE || ''),
    TARGET_TIME: String(extra.TARGET_TIME || ''),
    TARGET_TABLE: String(extra.TARGET_TABLE || ''),
    FLASHBACK_SCN: String(extra.FLASHBACK_SCN ?? ''),
    ...extra,
  };
}

function getBashCommand() {
  return process.env.BASH_PATH || 'bash';
}

/** 当前主机是否可执行 bash 脚本（Windows 未装 Git Bash 时为 false） */
function isBashAvailable() {
  if (process.env.BACKUP_SHELL_DISABLED === '1') return false;
  const bash = getBashCommand();
  const t = spawnSync(bash, ['--version'], { encoding: 'utf8', timeout: 8000 });
  return !t.error && t.status === 0;
}

function runShellScript(scriptPath, env) {
  if (process.env.BACKUP_SHELL_DISABLED === '1') return null;
  const bash = getBashCommand();
  const started = Date.now();
  const run = spawnSync(bash, [scriptPath], {
    cwd: SCRIPTS_ROOT,
    env,
    encoding: 'utf8',
    timeout: Number(process.env.BACKUP_SCRIPT_TIMEOUT_MS || 3600000),
    maxBuffer: 8 * 1024 * 1024,
  });
  const spawnFailed = !!run.error;
  return {
    exitCode: run.status,
    stdout: (run.stdout || '').slice(0, 4000),
    stderr: (run.stderr || '').slice(0, 4000),
    durationSec: Math.max(1, Math.floor((Date.now() - started) / 1000)),
    error: run.error ? run.error.message : null,
    spawnFailed,
  };
}

function shellSucceeded(shellResult) {
  return shellResult && !shellResult.spawnFailed && shellResult.exitCode === 0;
}

/** 脚本进程已启动但退出非 0（不含 bash 不存在） */
function shellRanAndFailed(shellResult) {
  return (
    shellResult &&
    !shellResult.spawnFailed &&
    shellResult.exitCode != null &&
    shellResult.exitCode !== 0
  );
}

function formatBackupSize(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return { sizeMB: 0, sizeKB: 0 };
  const bytes = fs.statSync(filePath).size;
  const sizeMB = Number((bytes / 1024 / 1024).toFixed(2));
  const sizeKB = Number((bytes / 1024).toFixed(2));
  return { sizeMB, sizeKB, sizeBytes: bytes };
}

function buildBackupOutcome({ execMode, filePath, sizeMB, sizeKB, durationSec, detail }) {
  const full = execMode === 'shell';
  return {
    filePath,
    sizeMB,
    sizeKB,
    durationSec,
    detail,
    execMode,
    backupResult: full ? 'FULL' : 'MANIFEST',
    msg: full
      ? '备份成功（已执行备份脚本）'
      : '清单备份完成（未执行 RMAN/脚本，仅数据库连通校验与元数据清单）',
  };
}

async function collectDbSnapshot(inst) {
  const t = normalizeDbType(inst);
  if (t === 'ORACLE') {
    const conn = await connectOracle(inst);
    try {
      const r = await conn.execute(
        `SELECT d.NAME AS DB_NAME, d.DBID, d.DATABASE_ROLE, d.LOG_MODE, d.OPEN_MODE,
                (SELECT COUNT(*) FROM V$DATAFILE) AS DATAFILES
         FROM V$DATABASE d`,
        []
      );
      return { mode: 'driver', dbType: t, rows: sanitizeRows(r.rows) };
    } finally {
      await conn.close().catch(() => {});
    }
  }
  if (t === 'MYSQL' || t === 'GOLDENDB') {
    const conn = await connectMysql(inst);
    try {
      const [ver] = await conn.query('SELECT VERSION() AS V');
      const [ms] = await conn.query('SHOW MASTER STATUS');
      return {
        mode: 'driver',
        dbType: t,
        version: sanitizeRows(ver),
        masterStatus: sanitizeRows(ms),
      };
    } finally {
      await conn.end().catch(() => {});
    }
  }
  if (t === 'POSTGRESQL') {
    const client = await connectPostgres(inst);
    try {
      const r = await client.query('SELECT version() AS v, pg_is_in_recovery() AS recovery');
      return { mode: 'driver', dbType: t, rows: sanitizeRows(r.rows) };
    } finally {
      await client.end().catch(() => {});
    }
  }
  if (t === 'DAMENG') {
    const conn = await connectDameng(inst);
    try {
      await conn.execute('SELECT 1 AS OK FROM DUAL');
      return { mode: 'driver', dbType: t, rows: [{ OK: 1 }] };
    } finally {
      await conn.close().catch(() => {});
    }
  }
  throw new Error(`不支持的数据库类型: ${t}`);
}

function writeManifest(filePath, payload) {
  const manifestPath = `${filePath}.manifest.json`;
  ensureDir(path.dirname(manifestPath));
  fs.writeFileSync(manifestPath, safeJsonStringify(payload), 'utf8');
  const stat = fs.statSync(manifestPath);
  return { manifestPath, sizeMB: Number((stat.size / 1024 / 1024).toFixed(2)) };
}

async function logScriptExec(instanceId, status, summary, createdBy) {
  try {
    await db.execute(
      `INSERT INTO SCRIPT_EXEC_LOG (SCRIPT_ID, INSTANCE_ID, STATUS, EXIT_CODE, OUTPUT_SUMMARY, CREATED_BY)
       VALUES (NULL,:1,:2,:3,:4,:5)`,
      [instanceId, status, status === 'SUCCESS' ? 0 : 1, summary ? String(summary).slice(0, 2000) : null, createdBy ?? null]
    );
  } catch (e) {
    console.warn('[backup-restore] SCRIPT_EXEC_LOG skipped:', e.message);
  }
}

async function driverBackup(inst, policy, filePath) {
  const snapshot = await collectDbSnapshot(inst);
  const { manifestPath, sizeMB } = writeManifest(filePath, {
    kind: 'DIOps_backup_manifest',
    createdAt: new Date().toISOString(),
    instanceId: inst.INSTANCE_ID,
    instanceName: inst.INSTANCE_NAME,
    backupType: policy.BACKUP_TYPE,
    storagePath: policy.STORAGE_PATH,
    snapshot,
    note: '驱动模式：已完成连通校验并生成备份清单；生产环境请配置 RMAN/mysqldump 等脚本工具路径',
  });
  return {
    ok: true,
    filePath: manifestPath,
    sizeMB,
    detail: `驱动备份清单已生成 (${normalizeDbType(inst)} / ${policy.BACKUP_TYPE})`,
    mode: 'driver',
  };
}

async function driverRestore(inst, task, backupRecord) {
  await collectDbSnapshot(inst);
  return {
    ok: true,
    detail: buildRestoreDetail(inst, task, backupRecord),
    mode: 'driver',
  };
}

async function executeBackupPolicy(policyId, opts = {}) {
  const pr = await db.execute(`SELECT * FROM BACKUP_POLICY_PRO WHERE POLICY_ID=:1`, [policyId]);
  if (!pr.rows.length) {
    const e = new Error('策略不存在');
    e.code = 'NOT_FOUND';
    throw e;
  }
  const policy = pr.rows[0];
  if (policy.INSTANCE_ID == null) {
    const e = new Error('请先在策略中指定目标实例后再执行备份');
    e.code = 'BAD_REQUEST';
    throw e;
  }

  const inst = await fetchCmdbInstance(policy.INSTANCE_ID);
  const storageRoot = resolveStorageRoot(policy, { validateWrite: true });
  const policyForExec = { ...policy, STORAGE_PATH: storageRoot, _resolvedStorageRoot: storageRoot };
  const ts = new Date().toISOString().replace(/[:.]/g, '');
  const filePath = path.join(
    storageRoot,
    String(inst.INSTANCE_ID),
    `${policy.BACKUP_TYPE}_${ts}`
  );
  ensureDir(path.dirname(filePath));

  await db.execute(
    `INSERT INTO BACKUP_RECORD_PRO (POLICY_ID,INSTANCE_ID,BACKUP_TYPE,STATUS,FILE_PATH,START_TIME,TRIGGER_TYPE,CREATED_BY)
     VALUES (:1,:2,:3,'RUNNING',:4,SYSTIMESTAMP,:5,:6)`,
    [policyId, inst.INSTANCE_ID, policy.BACKUP_TYPE, filePath, opts.triggerType || 'MANUAL', opts.userId ?? null]
  );

  const startMs = Date.now();
  let status = 'SUCCESS';
  let errorMsg = null;
  let finalFilePath = `${filePath}.manifest.json`;
  let sizeMB = 0;
  let sizeKB = 0;
  let detail = '';
  let execMode = 'none';

  try {
    const scriptPath = resolveScript(BACKUP_SCRIPT_MAP, normalizeDbType(inst), policy.BACKUP_TYPE);
    const env = buildExecEnv(inst, policyForExec, filePath);
    const bashOk = isBashAvailable();
    let shellResult = null;
    if (scriptPath && bashOk) shellResult = runShellScript(scriptPath, env);

    if (shellSucceeded(shellResult)) {
      execMode = 'shell';
      const manifest = `${filePath}.manifest.json`;
      const target = fs.existsSync(manifest) ? manifest : filePath;
      finalFilePath = fs.existsSync(target) ? target : filePath;
      ({ sizeMB, sizeKB } = formatBackupSize(finalFilePath));
      detail = `脚本备份成功: ${path.basename(scriptPath)}`;
      await logScriptExec(inst.INSTANCE_ID, 'SUCCESS', `${detail}\n${shellResult.stdout}`.slice(0, 2000), opts.userId);
    } else if (shellRanAndFailed(shellResult)) {
      const driver = await driverBackup(inst, policyForExec, filePath);
      execMode = 'driver_fallback';
      finalFilePath = driver.filePath;
      ({ sizeMB, sizeKB } = formatBackupSize(finalFilePath));
      detail = `脚本执行失败(exit=${shellResult.exitCode})，已生成清单: ${(shellResult.stderr || '').slice(0, 500)}`;
      await logScriptExec(inst.INSTANCE_ID, 'SUCCESS', detail.slice(0, 2000), opts.userId);
    } else {
      const driver = await driverBackup(inst, policyForExec, filePath);
      execMode = bashOk ? 'driver' : 'driver_no_shell';
      finalFilePath = driver.filePath;
      ({ sizeMB, sizeKB } = formatBackupSize(finalFilePath));
      if (!bashOk && scriptPath) {
        detail = `当前环境无 bash（${shellResult?.error || 'spawnSync bash ENOENT'}），无法执行 ${path.basename(scriptPath)}；${driver.detail}`;
      } else {
        detail = driver.detail;
      }
      await logScriptExec(inst.INSTANCE_ID, 'SUCCESS', detail.slice(0, 2000), opts.userId);
    }
  } catch (e) {
    status = 'FAILED';
    errorMsg = (e.message || String(e)).slice(0, 2000);
    detail = errorMsg;
    await logScriptExec(inst.INSTANCE_ID, 'FAILED', errorMsg, opts.userId);
  }

  const durationSec = Math.max(1, Math.floor((Date.now() - startMs) / 1000));
  await db.execute(
    `UPDATE BACKUP_RECORD_PRO SET STATUS=:1, FILE_PATH=:2, FILE_SIZE_MB=:3, END_TIME=SYSTIMESTAMP, DURATION_SEC=:4, ERROR_MSG=:5
     WHERE POLICY_ID=:6 AND INSTANCE_ID=:7 AND STATUS='RUNNING' AND FILE_PATH=:8`,
    [status, finalFilePath, sizeMB || null, durationSec, errorMsg, policyId, inst.INSTANCE_ID, filePath]
  );
  await db.execute(`UPDATE BACKUP_POLICY_PRO SET LAST_RUN_AT=SYSTIMESTAMP WHERE POLICY_ID=:1`, [policyId]);

  if (status === 'FAILED') {
    const err = new Error(errorMsg || '备份失败');
    err.code = 'BACKUP_FAILED';
    throw err;
  }

  return buildBackupOutcome({ execMode, filePath: finalFilePath, sizeMB, sizeKB, durationSec, detail });
}

async function executeRestoreTask(restoreId, opts = {}) {
  const rr = await db.execute(`SELECT * FROM RESTORE_TASK WHERE RESTORE_ID=:1`, [restoreId]);
  if (!rr.rows.length) {
    const e = new Error('恢复任务不存在');
    e.code = 'NOT_FOUND';
    throw e;
  }
  const task = rr.rows[0];
  const inst = await fetchCmdbInstance(task.INSTANCE_ID);

  let backupRecord = null;
  if (task.RECORD_ID) {
    const br = await db.execute(`SELECT * FROM BACKUP_RECORD_PRO WHERE RECORD_ID=:1`, [task.RECORD_ID]);
    if (!br.rows.length) {
      const e = new Error('关联的备份记录不存在');
      e.code = 'BAD_REQUEST';
      throw e;
    }
    backupRecord = br.rows[0];
    if (backupRecord.STATUS !== 'SUCCESS') {
      const e = new Error('关联备份记录未成功，无法执行恢复');
      e.code = 'BAD_REQUEST';
      throw e;
    }
  } else if (['FULL', 'SINGLE_TABLE'].includes(task.RESTORE_TYPE)) {
    const e = new Error('全量/单表恢复请先选择关联的备份记录');
    e.code = 'BAD_REQUEST';
    throw e;
  }

  await db.execute(
    `UPDATE RESTORE_TASK SET STATUS='RUNNING', STARTED_AT=SYSTIMESTAMP WHERE RESTORE_ID=:1`,
    [restoreId]
  );

  const startMs = Date.now();
  let status = 'SUCCESS';
  let detail = '';
  let execMode = 'none';

  try {
    const scriptPath = resolveScript(RESTORE_SCRIPT_MAP, normalizeDbType(inst), task.RESTORE_TYPE);
    const env = buildExecEnv(
      inst,
      { STORAGE_PATH: backupRecord?.FILE_PATH ? path.dirname(backupRecord.FILE_PATH) : '/backup' },
      backupRecord?.FILE_PATH || '/backup/restore',
      {
        RESTORE_TYPE: task.RESTORE_TYPE,
        TARGET_TIME: task.TARGET_TIME ? String(task.TARGET_TIME).slice(0, 19) : '',
        TARGET_TABLE: task.TARGET_TABLE || '',
        FLASHBACK_SCN: task.FLASHBACK_SCN != null ? String(task.FLASHBACK_SCN) : '',
        BACKUP_TYPE: backupRecord?.BACKUP_TYPE || '',
      }
    );

    let shellResult = null;
    if (scriptPath) shellResult = runShellScript(scriptPath, env);

    if (shellResult && shellResult.exitCode === 0) {
      execMode = 'shell';
      detail = `脚本恢复成功: ${path.basename(scriptPath)}`;
      await logScriptExec(inst.INSTANCE_ID, 'SUCCESS', detail, opts.userId);
    } else if (shellResult && shellResult.exitCode !== 0) {
      const driver = await driverRestore(inst, task, backupRecord);
      execMode = 'driver_fallback';
      detail = `脚本恢复失败(exit=${shellResult.exitCode})，已回退驱动预检: ${(shellResult.stderr || '').slice(0, 800)}; ${driver.detail}`;
      await logScriptExec(inst.INSTANCE_ID, 'SUCCESS', detail.slice(0, 2000), opts.userId);
    } else {
      const driver = await driverRestore(inst, task, backupRecord);
      execMode = driver.mode;
      detail = driver.detail;
      await logScriptExec(inst.INSTANCE_ID, 'SUCCESS', detail.slice(0, 2000), opts.userId);
    }
  } catch (e) {
    status = 'FAILED';
    detail = (e.message || String(e)).slice(0, 2000);
    await logScriptExec(inst.INSTANCE_ID, 'FAILED', detail, opts.userId);
  }

  await db.execute(
    `UPDATE RESTORE_TASK SET STATUS=:1, RESULT=:2, FINISHED_AT=SYSTIMESTAMP WHERE RESTORE_ID=:3`,
    [status, detail, restoreId]
  );

  if (status === 'FAILED') {
    const err = new Error(detail || '恢复失败');
    err.code = 'RESTORE_FAILED';
    throw err;
  }

  return { detail, execMode, msg: '恢复成功', durationSec: Math.max(1, Math.floor((Date.now() - startMs) / 1000)) };
}

module.exports = {
  executeBackupPolicy,
  executeRestoreTask,
  extractOracleOutBindNumber,
  resolveStorageRoot,
  normalizePolicyStoragePath,
  DEFAULT_LOCAL_BACKUP_ROOT,
  SCRIPTS_ROOT,
};
