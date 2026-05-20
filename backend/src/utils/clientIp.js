/**
 * 取客户端 IP（登录审计等）。
 * 在受信反向代理后请设 TRUST_PROXY=1（或 true），并在 app 上 app.set('trust proxy', 1)。
 */
function getClientIp(req) {
  const trust = process.env.TRUST_PROXY === '1'
    || String(process.env.TRUST_PROXY || '').toLowerCase() === 'true';
  if (trust) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim().slice(0, 128);
    const xr = req.headers['x-real-ip'];
    if (xr) return String(xr).trim().slice(0, 128);
  }
  const raw = req.ip || req.socket?.remoteAddress || '';
  return String(raw).replace(/^::ffff:/, '').slice(0, 128);
}

module.exports = { getClientIp };
