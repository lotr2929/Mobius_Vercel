// ── Mobius Local Server ──────────────────────────────────────────────────
const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const PORT        = process.env.PORT || 3000;
const VERCEL_HOST = 'mobius-pwa.vercel.app';
const ROOT_DIR    = path.resolve(__dirname, '..');  // server.js lives in js/ -- root is one level up

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0];

  // ── CORS headers for all responses ───────────────────────────────────────────
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── Ollama proxy — forwards to localhost:11434, adds CORS ────────────────────
  if (urlPath.startsWith('/ollama/')) {
    const ollamaPath = urlPath.replace('/ollama', '');
    const body = [];
    req.on('data', chunk => body.push(chunk));
    req.on('end', () => {
      const options = {
        hostname: '127.0.0.1',
        port: 11434,
        path: ollamaPath + (req.url.includes('?') ? '?' + req.url.split('?')[1] : ''),
        method: req.method,
        headers: { 'Content-Type': 'application/json' }
      };
      const proxy = http.request(options, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, {
          'Content-Type': proxyRes.headers['content-type'] || 'application/json',
          'Access-Control-Allow-Origin': '*'
        });
        proxyRes.pipe(res);
      });
      proxy.on('error', () => { res.writeHead(503); res.end(JSON.stringify({ error: 'Ollama not running' })); });
      if (body.length) proxy.write(Buffer.concat(body));
      proxy.end();
    });
    return;
  }

  // ── Proxy /api/* and /ask to Vercel ─────────────────────────────────────────
  if (urlPath.startsWith('/api/') || urlPath.startsWith('/auth/') || urlPath === '/ask' || urlPath === '/parse' || urlPath === '/upload' || urlPath === '/agent') {
    const options = {
      hostname: VERCEL_HOST,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: VERCEL_HOST }
    };
    const proxy = https.request(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });
    proxy.on('error', (err) => {
      res.writeHead(502);
      res.end('Proxy error: ' + err.message);
    });
    req.pipe(proxy);
    return;
  }

  // ── Serve static files ──────────────────────────────────────────────────────
  let filePath = urlPath;
  if (filePath === '/' || filePath === '') filePath = '/index.html';
  const fullPath = path.join(ROOT_DIR, filePath);
  const ext = path.extname(fullPath);
  const mimeType = MIME[ext] || 'text/plain';

  fs.readFile(fullPath, (err, data) => {
    if (err) {
      fs.readFile(path.join(ROOT_DIR, 'index.html'), (e2, d2) => {
        if (e2) { res.writeHead(500); res.end('Server error'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(d2);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': mimeType });
    res.end(data);
  });
}).listen(PORT, () => {
  console.log(`🚀 Mobius running at http://localhost:${PORT}`);
});
