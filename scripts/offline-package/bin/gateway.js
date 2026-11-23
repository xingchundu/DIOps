#!/usr/bin/env node
'use strict';

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const frontRoot = path.join(root, 'frontend');
const port = parseInt(process.env.HTTPS_PORT || '18443', 10);
const apiUrl = new URL(process.env.BACKEND_URL || 'http://127.0.0.1:3000');

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

function proxy(req, res) {
  const headers = Object.assign({}, req.headers, { host: apiUrl.host });
  const preq = http.request({
    hostname: apiUrl.hostname,
    port: apiUrl.port,
    path: req.url,
    method: req.method,
    headers,
  }, (pres) => {
    res.writeHead(pres.statusCode || 502, pres.headers);
    pres.pipe(res);
  });
  preq.on('error', () => {
    if (res.headersSent) return;
    res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ code: 502, msg: '后端未就绪' }));
  });
  req.pipe(preq);
}

function resolveFile(urlPath) {
  const pathname = decodeURIComponent((urlPath || '/').split('?')[0]);
  const rel = path.normalize(pathname).replace(/^([/\\])+/, '');
  const full = path.resolve(frontRoot, rel);
  if (full !== frontRoot && !full.startsWith(frontRoot + path.sep)) return null;
  return full;
}

const server = https.createServer({
  key: fs.readFileSync(path.join(root, 'certs', 'server.key')),
  cert: fs.readFileSync(path.join(root, 'certs', 'server.crt')),
}, (req, res) => {
  const urlPath = req.url || '/';
  if (urlPath.startsWith('/api') || urlPath === '/health' || urlPath.startsWith('/health?')) {
    return proxy(req, res);
  }

  let file = resolveFile(urlPath === '/' ? '/index.html' : urlPath);
  let stat = null;
  try {
    if (file) stat = fs.statSync(file);
  } catch (_) {
    stat = null;
  }

  if (!stat || stat.isDirectory()) {
    const ext = path.extname(urlPath.split('?')[0]);
    if (ext && ext !== '.html') {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    file = path.join(frontRoot, 'index.html');
  }

  res.writeHead(200, { 'content-type': mime[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

server.listen(port, '0.0.0.0', () => {
  console.log(`[gateway] https://0.0.0.0:${port} -> ${frontRoot}`);
  console.log(`[gateway] /api -> ${apiUrl.href}`);
});
