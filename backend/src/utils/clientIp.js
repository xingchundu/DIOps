/**
 * 取客户端 IP（登录审计等）。
 * 在受信反向代理后请设 TRUST_PROXY=1（或 true），并在 app 上 app.set('trust proxy', 1)。
 * 使用 Express 解析后的 req.ip，避免直接信任可被伪造的 X-Forwarded-For。
 */
function getClientIp(req) {
  const raw = req.ip || req.socket?.remoteAddress || '';
  return String(raw).replace(/^::ffff:/, '').slice(0, 128);
}

module.exports = { getClientIp };
