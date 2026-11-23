/**
 * 被管库密码 / SSH 凭据的加解密（与 Java com.dbops.monitor.Secrets 格式一致）。
 *
 *   新格式：AESGCM:v1:<base64(iv[12] || ciphertext || tag[16])>，AES-256-GCM
 *   旧格式：Base64（可带 ENCRYPTED: 前缀）——只读兼容，Java 启动时会把旧格式逐步改写为新格式
 *
 * 密钥：环境变量 DBOPS_SECRET_KEY（任意长度口令，经 SHA-256 得到 32 字节密钥）。
 * 未配置时无法解密新格式数据，加密时退回旧格式并打印警告（仅用于开发环境）。
 */
const crypto = require('crypto');

const PREFIX = 'AESGCM:v1:';
let warned = false;

function key() {
  const raw = process.env.DBOPS_SECRET_KEY;
  if (!raw || !String(raw).trim()) return null;
  return crypto.createHash('sha256').update(String(raw).trim(), 'utf8').digest();
}

function decrypt(enc) {
  if (enc == null) return '';
  const s = String(enc).trim();
  if (!s) return '';
  if (s.startsWith(PREFIX)) {
    const k = key();
    if (!k) throw new Error('凭据已加密，但未配置 DBOPS_SECRET_KEY，无法解密');
    const buf = Buffer.from(s.slice(PREFIX.length), 'base64');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(buf.length - 16);
    const ct = buf.subarray(12, buf.length - 16);
    const d = crypto.createDecipheriv('aes-256-gcm', k, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  }
  const b64 = s.replace(/^ENCRYPTED:/i, '');
  // 旧数据：Base64；不是合法 Base64 时按明文处理
  if (/^[A-Za-z0-9+/=\s]+$/.test(b64)) return Buffer.from(b64, 'base64').toString('utf8');
  return b64;
}

function encrypt(plain) {
  if (plain == null || String(plain) === '') return null;
  const k = key();
  if (!k) {
    if (!warned) {
      warned = true;
      console.warn('[secrets] 未配置 DBOPS_SECRET_KEY，凭据仅做 Base64 编码保存（不安全，生产环境必须配置）');
    }
    return Buffer.from(String(plain), 'utf8').toString('base64');
  }
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', k, iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return PREFIX + Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64');
}

module.exports = { decrypt, encrypt, PREFIX };
