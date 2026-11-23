/**
 * 在实例所在主机上执行 shell 命令（HA 切换脚本等）。凭据取自资产管理的主机 SSH 配置。
 * 主机指纹校验（默认开启，避免中间人截获凭据）：known_hosts 取 DBOPS_SSH_KNOWN_HOSTS / MONITOR_SSH_KNOWN_HOSTS /
 * ~/.ssh/known_hosts，支持 ssh-keyscan -H 的哈希主机名；开发环境可设置 DBOPS_SSH_STRICT=false 关闭校验。
 */
const fs = require('fs');
const crypto = require('crypto');
const { Client } = require('ssh2');
const db = require('../config/db');
const { decrypt } = require('./secrets');

/** known_hosts 文件：DBOPS_SSH_KNOWN_HOSTS > MONITOR_SSH_KNOWN_HOSTS（与 Java 共用）> 运行账号的 ~/.ssh/known_hosts */
function knownHostsFile() {
  const f = process.env.DBOPS_SSH_KNOWN_HOSTS || process.env.MONITOR_SSH_KNOWN_HOSTS
    || require('path').join(require('os').homedir(), '.ssh', 'known_hosts');
  return f && fs.existsSync(f) ? f : null;
}

/** 名称是否匹配：支持明文与 ssh-keyscan -H 生成的哈希形式 |1|salt|hash */
function nameMatches(field, names) {
  for (const n of field.split(',')) {
    if (n.startsWith('|1|')) {
      const [, , salt, hash] = n.split('|');
      for (const want of names) {
        const h = crypto.createHmac('sha1', Buffer.from(salt, 'base64')).update(want).digest('base64');
        if (h === hash) return true;
      }
    } else if (names.has(n)) return true;
  }
  return false;
}

function knownHostKeys(host, port) {
  const file = knownHostsFile();
  if (!file) return null;
  const names = new Set([host, `[${host}]:${port}`]);
  const keys = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3 || parts[0].startsWith('#') || parts[0].startsWith('@')) continue;
    if (nameMatches(parts[0], names)) keys.push(Buffer.from(parts[2], 'base64'));
  }
  return keys;
}

async function hostOfInstance(instanceId) {
  const r = await db.execute(
    `SELECT h.IP_ADDR, h.SSH_ENABLED, h.SSH_PORT, h.SSH_USER, h.SSH_AUTH_TYPE, h.SSH_PASSWORD, h.SSH_PRIVATE_KEY
       FROM CMDB_INSTANCE i JOIN CMDB_HOST h ON h.HOST_ID = i.HOST_ID WHERE i.INSTANCE_ID = :1`,
    [instanceId], { fetchInfo: { SSH_PRIVATE_KEY: { type: require('oracledb').STRING } } }
  );
  if (!r.rows.length) throw new Error('实例未关联主机，无法通过 SSH 执行命令');
  const h = r.rows[0];
  if (Number(h.SSH_ENABLED) === 0) throw new Error(`主机 ${h.IP_ADDR} 未启用 SSH`);
  if (!h.SSH_USER) throw new Error(`主机 ${h.IP_ADDR} 未配置 SSH 用户`);
  return h;
}

/** @returns {Promise<{code:number, stdout:string, stderr:string}>} */
async function runOnInstanceHost(instanceId, command, { timeoutMs = 300000, env = {} } = {}) {
  const h = await hostOfInstance(instanceId);
  const port = Number(h.SSH_PORT) || 22;
  const strict = String(process.env.DBOPS_SSH_STRICT || 'true').toLowerCase() !== 'false';
  const allowed = knownHostKeys(h.IP_ADDR, port);
  if (strict && !allowed) {
    throw new Error('未找到 known_hosts 文件，拒绝执行 SSH 命令（防止中间人攻击）。请用 ssh-keyscan 写入 ~/.ssh/known_hosts 或设置 DBOPS_SSH_KNOWN_HOSTS');
  }
  if (strict && !allowed.length) {
    throw new Error(`known_hosts 中没有主机 ${h.IP_ADDR} 的指纹，拒绝执行 SSH 命令。请先执行 ssh-keyscan -p ${port} ${h.IP_ADDR} >> ~/.ssh/known_hosts`);
  }
  const cfg = {
    host: h.IP_ADDR, port, username: h.SSH_USER, readyTimeout: 15000,
    hostVerifier: key => !strict || allowed.some(k => k.length === key.length && crypto.timingSafeEqual(k, key)),
  };
  if (String(h.SSH_AUTH_TYPE || '').toUpperCase() === 'KEY') cfg.privateKey = decrypt(h.SSH_PRIVATE_KEY);
  else cfg.password = decrypt(h.SSH_PASSWORD);

  return new Promise((resolve, reject) => {
    const conn = new Client();
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      conn.end();
      reject(new Error(`SSH 命令执行超时（${Math.round(timeoutMs / 1000)} 秒）`));
    }, timeoutMs);
    conn.on('ready', () => {
      // 参数通过环境变量传入，不拼接进命令文本
      const exports = Object.entries(env).map(([k, v]) => `export ${k}='${String(v).replace(/'/g, `'\\''`)}'`).join('; ');
      conn.exec(exports ? `${exports}; ${command}` : command, (err, stream) => {
        if (err) { clearTimeout(timer); done = true; conn.end(); return reject(err); }
        let stdout = '';
        let stderr = '';
        stream.on('data', d => { stdout += d; if (stdout.length > 200000) stdout = stdout.slice(-200000); });
        stream.stderr.on('data', d => { stderr += d; if (stderr.length > 50000) stderr = stderr.slice(-50000); });
        stream.on('close', code => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          conn.end();
          resolve({ code: code ?? -1, stdout, stderr });
        });
      });
    });
    conn.on('error', e => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(e);
    });
    conn.connect(cfg);
  });
}

module.exports = { runOnInstanceHost };
