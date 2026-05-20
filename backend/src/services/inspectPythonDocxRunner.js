/**
 * inspectPythonDocxRunner.js  v2.2
 *
 * 调用 backend/scripts/db_inspection_headless.py，
 * 按 db_inspection.py 逻辑生成 5 份完整格式 Word 报告，写入 backend/reports 目录。
 *
 * 修复：
 *   - 智能 Python 检测（兼容 Windows py/python/python3，自动跳过 Windows Store 存根）
 *   - 模板 SQL 文件优先（保证 Word 格式与独立运行 db_inspection.py 完全一致）
 *   - 错误信息包含 stdout/stderr，方便排查
 *   - reports 目录自动创建
 */
'use strict';

const fs            = require('fs');
const os            = require('os');
const path          = require('path');
const { spawnSync } = require('child_process');
const { decodeDbPassword } = require('../utils/monitorTargetConn');

// ── 路径常量 ─────────────────────────────────────────────────────
const SCRIPTS_DIR   = path.join(__dirname, '..', '..', 'scripts');
const HEADLESS_PY   = path.join(SCRIPTS_DIR, 'db_inspection_headless.py');
const TEMPLATES_DIR = path.join(__dirname, '..', 'templates', 'inspect');

function getInspectReportsRoot() {
  return path.resolve(
    process.env.INSPECT_PYTHON_REPORTS_DIR ||
    path.join(__dirname, '..', '..', 'reports')
  );
}

// ── Python 检测（缓存，避免重复探测）────────────────────────────
let _cachedPython = undefined;   // undefined = not yet detected

/**
 * 探测系统中可用的 Python3 解释器。
 * 在 Windows 上依次尝试: py -3 → python → python3
 * 在 Linux/Mac 上依次尝试: python3 → python
 *
 * 通过实际运行 `<cmd> --version` 并验证输出含 "Python 3.x" 来确认可用性，
 * 避免把 Windows Store 存根或 Python 2 当成有效解释器。
 *
 * @returns {{ cmd: string, args: string[], version: string } | null}
 */
function detectPython() {
  if (_cachedPython !== undefined) return _cachedPython;

  // 用户可通过环境变量强制指定路径
  const envPy = process.env.INSPECT_PYTHON || process.env.PYTHON3 || process.env.PYTHON;
  if (envPy) {
    const t = spawnSync(envPy, ['--version'], { encoding: 'utf-8', timeout: 8000 });
    const out = ((t.stdout || '') + (t.stderr || '')).trim();
    const m   = out.match(/Python\s+(3\.\d+[.\d]*)/);
    if (!t.error && t.status === 0 && m) {
      _cachedPython = { cmd: envPy, args: [], version: m[1] };
      return _cachedPython;
    }
    // 用户指定的不可用 → 继续自动检测
    console.warn(`[inspect-py] 指定的 Python(${envPy}) 不可用(exit=${t.status})，将自动检测`);
  }

  // 候选命令列表（Windows 优先 py 启动器；Linux/Mac 优先 python3）
  const candidates = process.platform === 'win32'
    ? [
        { cmd: 'py',      args: ['-3'] },    // Python Launcher for Windows
        { cmd: 'python',  args: []     },
        { cmd: 'python3', args: []     },
      ]
    : [
        { cmd: 'python3', args: []     },
        { cmd: 'python',  args: []     },
      ];

  for (const { cmd, args } of candidates) {
    const t = spawnSync(cmd, [...args, '--version'], {
      encoding: 'utf-8',
      timeout:  8000,
      env:      process.env,
    });
    const out = ((t.stdout || '') + (t.stderr || '')).trim();
    const m   = out.match(/Python\s+(3\.\d+[.\d]*)/);
    if (!t.error && t.status === 0 && m) {
      _cachedPython = { cmd, args, version: m[1] };
      console.log(`[inspect-py] 使用 Python${m[1]}: ${cmd} ${args.join(' ')}`.trim());
      return _cachedPython;
    }
  }

  _cachedPython = null;  // 未找到
  return null;
}

// ── DB 类型工具 ──────────────────────────────────────────────────
function normalizeDbTypePy(dbType) {
  const t = String(dbType || '').toUpperCase().trim();
  if (t === 'DAMENG' || t === '达梦' || t === '达梦(DM)' || t === 'DM') return 'DAMENG';
  return t;
}

function defaultPort(dbType) {
  const t = normalizeDbTypePy(dbType);
  if (t === 'ORACLE')     return 1521;
  if (t === 'POSTGRESQL') return 5432;
  if (t === 'DAMENG')     return 5236;
  if (t === 'GOLDENDB')   return 3308;
  return 3306;
}

/**
 * 按 dbType 查找 master inspection SQL 模板文件路径。
 * 优先顺序：
 *   backend/src/templates/inspect/ → backend/scripts/sql/ → backend/scripts/
 */
function findTemplateSqlPath(dbType) {
  const fileMap = {
    MYSQL:      'mysql_master_inspection.sql',
    POSTGRESQL: 'postgresql_master_inspection.sql',
    ORACLE:     'oracle_master_inspection.sql',
    GOLDENDB:   'goldendb_master_inspection.sql',
    DAMENG:     'dameng_master_inspection.sql',
  };
  const fname = fileMap[normalizeDbTypePy(dbType)];
  if (!fname) return null;
  const candidates = [
    path.join(TEMPLATES_DIR, fname),
    path.join(SCRIPTS_DIR, 'sql', fname),
    path.join(SCRIPTS_DIR, fname),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * 执行 db_inspection_headless.py，生成 5 份 Word（与 db_inspection.py 输出完全一致）。
 *
 * @param {{
 *   dbType: string,
 *   instRow: object,
 *   mergedSqlText?: string,
 *   taskId?: number,
 *   inspectTimeStr: string,
 *   fileTimestamp: string,
 * }} opts
 * @returns {{ ok: boolean, files?: Record<string,string>, error?: string }}
 */
function runDbInspectionPythonWord(opts) {
  const { dbType, instRow, mergedSqlText, inspectTimeStr, fileTimestamp } = opts;
  const reportsRoot = getInspectReportsRoot();
  const tempFiles   = [];

  try {
    // ── 0. 确保输出目录存在 ───────────────────────────────────
    fs.mkdirSync(reportsRoot, { recursive: true });

    // ── 1. 检查脚本文件 ───────────────────────────────────────
    if (!fs.existsSync(HEADLESS_PY)) {
      return {
        ok: false,
        error: `未找到巡检脚本: ${HEADLESS_PY}。请确认 backend/scripts/db_inspection_headless.py 存在。`,
      };
    }

    // ── 2. 检测 Python3 解释器 ────────────────────────────────
    const pythonInfo = detectPython();
    if (!pythonInfo) {
      return {
        ok: false,
        error:
          '未找到可用的 Python3 解释器。\n' +
          '解决方法：\n' +
          '  1) 安装 Python 3.8+（https://www.python.org/downloads/）\n' +
          '  2) 安装依赖：pip install python-docx pymysql psycopg2-binary tqdm oracledb\n' +
          '  3) 或在 backend/.env 中设置 INSPECT_PYTHON=/your/python3 路径',
      };
    }
    const { cmd: pythonCmd, args: pythonBaseArgs } = pythonInfo;

    // ── 3. 确定 SQL 来源（模板文件 > mergedSqlText）──────────
    const templatePath = findTemplateSqlPath(dbType);
    let sqlPath;

    if (templatePath) {
      // 直接使用模板文件（无需临时文件，有完整 >>SECTION: 标记）
      sqlPath = templatePath;
    } else if (mergedSqlText && String(mergedSqlText).trim()) {
      const tmp = path.join(
        os.tmpdir(),
        `inspect_sql_${opts.taskId || 'x'}_${Date.now()}.sql`
      );
      fs.writeFileSync(tmp, String(mergedSqlText), 'utf8');
      tempFiles.push(tmp);
      sqlPath = tmp;
    } else {
      return {
        ok:    false,
        error: `未找到 ${dbType} 巡检模板文件（${TEMPLATES_DIR}）且未提供 mergedSqlText。` +
               `请确认 backend/src/templates/inspect/ 目录中有对应 SQL 文件。`,
      };
    }

    // ── 4. 构建配置文件（密码写文件，不暴露在命令行参数中）────
    const pwd  = decodeDbPassword(instRow.DB_PASSWORD);
    const port = Number(instRow.PORT) || defaultPort(dbType);

    const cfg = {
      dbType:         normalizeDbTypePy(dbType),
      host:           String(instRow.HOST_IP      || '').trim(),
      port,
      user:           String(instRow.DB_USER      || '').trim(),
      password:       pwd,
      database:       String(instRow.SERVICE_NAME || instRow.SID || '').trim(),
      serviceName:    String(instRow.SERVICE_NAME || '').trim(),
      sid:            String(instRow.SID          || '').trim(),
      sqlPath,
      outputDir:      reportsRoot,
      inspectTimeStr: String(inspectTimeStr || ''),
      fileTimestamp:  String(fileTimestamp  || ''),
    };

    const ts         = Date.now();
    const cfgPath    = path.join(os.tmpdir(), `inspect_cfg_${ts}.json`);
    const resultPath = path.join(os.tmpdir(), `inspect_out_${ts}.json`);
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 0), 'utf8');
    tempFiles.push(cfgPath, resultPath);

    // ── 5. 调用 Python 脚本 ───────────────────────────────────
    const pyArgs = [
      ...pythonBaseArgs,           // e.g. ['-3'] for Windows py launcher
      '-u',                        // unbuffered stdout/stderr
      HEADLESS_PY,
      '--config', cfgPath,
      '--result', resultPath,
    ];

    console.log(`[inspect-py] 启动: ${pythonCmd} ${pyArgs.join(' ')}`);

    const run = spawnSync(pythonCmd, pyArgs, {
      encoding:   'utf-8',
      maxBuffer:  64 * 1024 * 1024,
      timeout:    600_000,          // 10 分钟
      env: {
        ...process.env,
        PYTHONUTF8:       '1',
        PYTHONIOENCODING: 'utf-8',
        // 确保 db_inspection.py 能被 headless 脚本 import
        PYTHONPATH: SCRIPTS_DIR + (process.env.PYTHONPATH ? path.delimiter + process.env.PYTHONPATH : ''),
      },
    });

    // ── 6. 分析执行结果 ───────────────────────────────────────
    if (run.error) {
      // spawnSync 本身失败（命令不存在等）
      return {
        ok: false,
        error: `Python 进程启动失败（${pythonCmd}）: ${run.error.message}\n` +
               `请检查 Python 安装并设置环境变量 INSPECT_PYTHON`,
      };
    }

    const stdoutTail = (run.stdout || '').slice(-3000);
    const stderrTail = (run.stderr || '').slice(-3000);

    // 结果文件不存在 → Python 崩溃或未完成
    if (!fs.existsSync(resultPath)) {
      return {
        ok: false,
        error: [
          `Python 巡检脚本未生成结果文件（exit=${run.status}）`,
          stderrTail ? `stderr: ${stderrTail}` : '',
          stdoutTail ? `stdout: ${stdoutTail}` : '',
        ].filter(Boolean).join('\n'),
      };
    }

    // 解析结果 JSON
    let parsed = null;
    try {
      parsed = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    } catch (parseErr) {
      return {
        ok: false,
        error: [
          `Python 结果文件 JSON 解析失败（exit=${run.status}）: ${parseErr.message}`,
          stderrTail ? `stderr: ${stderrTail}` : '',
          stdoutTail ? `stdout: ${stdoutTail}` : '',
        ].filter(Boolean).join('\n'),
      };
    }

    if (!parsed || parsed.ok !== true) {
      const errMsg = parsed?.error
        ? String(parsed.error).slice(0, 1000)
        : `巡检脚本返回失败（exit=${run.status}）`;
      return {
        ok: false,
        error: [
          errMsg,
          stderrTail ? `stderr: ${stderrTail}` : '',
          stdoutTail ? `stdout: ${stdoutTail}` : '',
        ].filter(Boolean).join('\n'),
        detail: parsed,
      };
    }

    // ── 7. 验证 5 份文件均落盘 ───────────────────────────────
    const files   = parsed.files || {};
    const need    = ['HEALTH', 'RISK', 'PARAMETER', 'SPACE', 'HA'];
    const missing = need.filter((k) => {
      const fp = files[k];
      return !fp || !fs.existsSync(path.resolve(String(fp)));
    });

    if (missing.length) {
      return {
        ok:    false,
        error: `db_inspection 应生成 5 份 Word，以下未落盘: ${missing.join(', ')}\n` +
               `reportsRoot=${reportsRoot}\nfiles=${JSON.stringify(files)}`,
      };
    }

    console.log(`[inspect-py] 成功生成 5 份 Word: ${Object.values(files).map(f => path.basename(f)).join(', ')}`);
    return { ok: true, files };

  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  } finally {
    for (const p of tempFiles) {
      try { fs.unlinkSync(p); } catch (_) { /* ignore */ }
    }
  }
}

module.exports = { runDbInspectionPythonWord, getInspectReportsRoot, detectPython };
