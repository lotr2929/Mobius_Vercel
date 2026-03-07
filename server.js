// ── Mobius Local Server ───────────────────────────────────────────────────────
// Serves the Mobius static shell on http://localhost:3000.
// Proxies /api/* requests to Vercel (cloud API gateway).
// Start: node server.js  (or via npm run dev)

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const PORT        = process.env.PORT || 3000;
const VERCEL_HOST = 'mobius-vercel.vercel.app';

const MIME = {
  '.html': 'text/html',
  '.js':   'text/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0];

  // ── Proxy /api/* to Vercel ──────────────────────────────────────────────────
  if (urlPath.startsWith('/api/') || urlPath.startsWith('/auth/') || urlPath === '/ask' || urlPath === '/parse' || urlPath === '/upload') {
    const options = {
      hostname: VERCEL_HOST,
      path:     req.url,
      method:   req.method,
      headers:  { ...req.headers, host: VERCEL_HOST }
    };
    const proxy = https.request(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });
    proxy.on('error', (err) => {
      console.error('[Proxy error]', err.message);
      res.writeHead(502);
      res.end('Proxy error: ' + err.message);
    });
    req.pipe(proxy);
    return;
  }

  // ── Serve static files ──────────────────────────────────────────────────────
  let filePath = urlPath;
  if (filePath === '/' || filePath === '') filePath = '/index.html';
  if (filePath === '/login')              filePath = '/login.html';
  if (filePath === '/signup')             filePath = '/signup.html';

  const fullPath = path.join(__dirname, filePath);
  const ext      = path.extname(fullPath);
  const mimeType = MIME[ext] || 'text/plain';

  fs.readFile(fullPath, (err, data) => {
    if (err) {
      // SPA fallback — any unresolved path serves index.html
      fs.readFile(path.join(__dirname, 'index.html'), (e2, d2) => {
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
  console.log('Mobius running at http://localhost:' + PORT);
  console.log('API proxying to https://' + VERCEL_HOST);
});
