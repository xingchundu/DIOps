/**
 * orasqlx 调用封装：Oracle SQL_ID 深度诊断（23 条规则 + AWR/ASH 历史 + DOCX 报告）。
 *
 * 为什么放在 SQL 优化模块：它的输入是 SQL_ID、输出是针对单条 SQL 的诊断与优化建议，
 * 和“SQL 优化 / SQL 洞察”是同一类问题，只是需要连库采集 V$/AWR 数据。
 *
 * 安全约束
 *  - 数据库口令只通过环境变量 ORASQLX_PWD 传给子进程，不进命令行（ps 看不到）。
 *  - 参数全部校验后用 spawn(args[]) 传递，不经过 shell。
 *  - orasqlx 本身只执行只读采集。连接信息完全取自所选 CMDB 实例，不需要另外填写连接串。
 *  - 子进程设总超时，超时强制 kill。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const TOOL_DIR = path.resolve(__dirname, '..', '..', 'tools', 'orasqlx');
const SQL_ID_RE = /^[0-9a-z]{13}$/i;
const IDENT_RE = /^[A-Za-z0-9_$#]{1,128}$/;
const HOST_RE = /^[A-Za-z0-9._:\-\[\]]{1,255}$/;
const SVC_RE = /^[A-Za-z0-9._$#\-]{1,128}$/;
const USER_RE = /^[A-Za-z0-9_$#.\-"]{1,128}$/;

function candidates() {
  const arch = os.arch() === 'arm64' ? 'arm64' : 'amd64';
  return [
    process.env.ORASQLX_BIN,
    path.join(TOOL_DIR, 'dist', `orasqlx-linux-${arch}`),
    path.join(TOOL_DIR, 'orasqlx'),
  ].filter(Boolean);
}

function findBinary() {
  for (const p of candidates()) {
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch (_) { /* next */ }
  }
  return null;
}

/** 工程内自动编译：缺二进制时尝试 deps/go 或 PATH 中的 go（仅此模块，无需手工 build.sh） */
function ensureBinary() {
  const hit = findBinary();
  if (hit) return hit;
  const arch = os.arch() === 'arm64' ? 'arm64' : 'amd64';
  const out = path.join(TOOL_DIR, 'dist', `orasqlx-linux-${arch}`);
  const goCandidates = [
    process.env.GO_BIN,
    path.resolve(__dirname, '..', '..', '..', 'deps', 'go', 'bin', 'go'),
    'go',
  ].filter(Boolean);
  let goBin = null;
  for (const g of goCandidates) {
    const r = spawnSync(g, ['version'], { stdio: 'ignore' });
    if (r.status === 0) { goBin = g; break; }
  }
  if (!goBin) return null;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const env = {
    ...process.env,
    GOPROXY: process.env.GOPROXY || 'https://goproxy.cn,direct',
    CGO_ENABLED: '0',
    GOOS: 'linux',
    GOARCH: arch,
  };
  const build = spawnSync(
    goBin,
  ['build', '-trimpath', '-ldflags', '-s -w', '-o', out, '.'],
    { cwd: TOOL_DIR, env, stdio: 'pipe', timeout: 300000 },
  );
  if (build.status === 0) {
    try { fs.chmodSync(out, 0o755); } catch (_) { /* ignore */ }
    return findBinary();
  }
  return null;
}

function runCapture(bin, args, { env = {}, timeoutMs = 20000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    const t = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => { if (out.length < 200000) out += d; });
    child.stderr.on('data', (d) => { if (err.length < 200000) err += d; });
    child.on('error', (e) => { clearTimeout(t); resolve({ code: -1, out, err: err + e.message }); });
    child.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
  });
}

/** 可用性：二进制是否存在。供前端决定是否可用并给出明确原因（无授权校验）。 */
async function status() {
  const bin = ensureBinary() || findBinary();
  if (!bin) {
    return { available: false, reason: 'NO_BINARY', message: 'orasqlx 编译失败（需 Go 1.21+ 与网络拉取依赖），请联系管理员检查 backend/tools/orasqlx' };
  }
  const v = await runCapture(bin, ['--version']);
  return { available: true, bin, version: (v.out || '').split('\n')[0].trim(), reason: 'OK', message: '可用' };
}

function validate(opts) {
  const errs = [];
  if (!SQL_ID_RE.test(opts.sqlId || '')) errs.push('SQL_ID 应为 13 位字母数字');
  if (opts.pdb && !IDENT_RE.test(opts.pdb)) errs.push('PDB 名称含非法字符');
  if (opts.awrDays != null && !(Number.isInteger(opts.awrDays) && opts.awrDays >= 0 && opts.awrDays <= 365)) errs.push('awrDays 应为 0~365 的整数');
  return errs;
}

/**
 * 执行一次诊断。inst 为 CMDB 实例行（含已解密口令 pwd）。
 * 返回 { jsonFile, docxFile, snapshot, findings, stdout }；失败抛出带说明的 Error。
 */
async function runDiagnosis({ inst, pwd, sqlId, pdb, awrDays, noAwr, jobId, timeoutSec = 300, onLog }) {
  const bin = ensureBinary() || findBinary();
  if (!bin) throw new Error('orasqlx 不可用（自动编译未成功）');
  const errs = validate({ sqlId, pdb, awrDays });
  if (errs.length) throw new Error(errs.join('；'));
  if (!USER_RE.test(inst.DB_USER || '') || !HOST_RE.test(inst.HOST_IP || '')) throw new Error('实例连接信息含不支持的字符');
  const svc = inst.SERVICE_NAME || inst.SID;
  if (!svc || !SVC_RE.test(svc)) throw new Error('实例缺少服务名/SID 或含不支持的字符');

  const { getInspectReportsRoot } = require('./inspectPythonDocxRunner'); // 延迟加载：status() 不需要数据库驱动
  const outDir = path.join(getInspectReportsRoot(), 'sqldiag', String(jobId));
  fs.mkdirSync(outDir, { recursive: true });
  const jsonFile = path.join(outDir, `${sqlId}_snapshot.json`);
  const docxFile = path.join(outDir, `${sqlId}_diag.docx`);
  const connect = `${inst.DB_USER}@${inst.HOST_IP}:${inst.PORT || 1521}/${svc}`; // 不含口令
  const env = { ORASQLX_PWD: pwd };

  // 1) 连库采集 + 规则分析，输出 JSON 快照
  const a1 = [sqlId.toLowerCase(), '--connect', connect, '--format', 'json', '-o', jsonFile, '--timeout', '90'];
  if (pdb) a1.push('--pdb', pdb);
  // 默认不读 AWR/ASH（不依赖 Diagnostics Pack 授权）；需要历史 AWR 时由 options 显式关闭 noAwr
  if (noAwr !== false) a1.push('--no-awr');
  else if (awrDays != null) a1.push('--awr-days', String(awrDays));
  onLog && onLog(`采集 ${inst.INSTANCE_NAME || inst.INSTANCE_ID} / ${sqlId} …`);
  const r1 = await runCapture(bin, a1, { env, timeoutMs: timeoutSec * 1000 });
  if (r1.code !== 0 || !fs.existsSync(jsonFile)) {
    throw new Error(`orasqlx 采集失败（退出码 ${r1.code}）：${(r1.err || r1.out).trim().split('\n').slice(-4).join(' | ').slice(0, 600)}`);
  }
  // 2) 用快照离线生成 DOCX（不再连库；失败不影响 JSON 结果）
  let docxOk = true;
  const r2 = await runCapture(bin, ['--input', jsonFile, '--keep-findings', '--format', 'docx', '-o', docxFile], { timeoutMs: 60000 });
  if (r2.code !== 0 || !fs.existsSync(docxFile)) docxOk = false;

  let snapshot = {};
  try { snapshot = JSON.parse(fs.readFileSync(jsonFile, 'utf8')); } catch (_) { /* keep {} */ }
  const sevName = ['critical', 'warning', 'info'];
  const findings = (snapshot.findings || []).map((f) => ({
    id: f.id, level: sevName[f.severity] || 'info', title: f.problem, advice: f.suggestion,
    evidence: f.evidence, risk: f.risk, verify: f.verify, confidence: f.confidence, effort: f.effort,
  }));
  return { jsonFile, docxFile: docxOk ? docxFile : null, snapshot, findings, stdout: r1.out.slice(-2000) };
}

module.exports = { status, runDiagnosis, findBinary, SQL_ID_RE };
