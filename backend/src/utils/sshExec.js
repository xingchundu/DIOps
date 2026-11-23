/**
 * [dxc][2026-10-08][新增] 非交互 SSH 执行（白名单命令由 monitorHostCollect 传入固定串）
 */
const { Client } = require('ssh2');

function connectSsh(hostConfig) {
  const {
    host,
    port = 22,
    username,
    password,
    privateKey,
    readyTimeout = 15000,
  } = hostConfig;
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn
      .on('ready', () => resolve(conn))
      .on('error', reject)
      .connect({
        host,
        port: Number(port) || 22,
        username,
        password: password || undefined,
        privateKey: privateKey || undefined,
        readyTimeout,
        tryKeyboard: false,
      });
  });
}

function execOnConn(conn, command, timeoutMs = 25000, maxBytes = 512 * 1024) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      reject(new Error(`SSH command timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    conn.exec(command, (err, stream) => {
      if (err) {
        clearTimeout(timer);
        reject(err);
        return;
      }
      stream
        .on('close', (code) => {
          clearTimeout(timer);
          if (killed) return;
          resolve({
            code: code ?? 0,
            stdout: stdout.slice(0, maxBytes),
            stderr: stderr.slice(0, maxBytes),
          });
        })
        .on('data', (d) => {
          stdout += d.toString('utf8');
          if (stdout.length > maxBytes) stdout = stdout.slice(0, maxBytes);
        });
      stream.stderr.on('data', (d) => {
        stderr += d.toString('utf8');
        if (stderr.length > maxBytes) stderr = stderr.slice(0, maxBytes);
      });
    });
  });
}

async function runSshCommand(hostConfig, command, opts = {}) {
  const conn = await connectSsh(hostConfig);
  try {
    return await execOnConn(conn, command, opts.timeoutMs, opts.maxBytes);
  } finally {
    conn.end();
  }
}

module.exports = { runSshCommand, connectSsh, execOnConn };
