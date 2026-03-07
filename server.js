// ── Mobius Local Server ───────────────────────────────────────────────────────
// Serves the Mobius static shell on http://localhost:3000.
// Vercel /api/* endpoints are called directly from the client as external APIs.
// Start: node server.js  (or via npm run dev)

const http   = require('http');
const fs     = require('fs');
const path   = require('path');

const PORT = process.env.PORT || 3000;

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
  // Normalise URL — strip query string, default to index.html
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/' || urlPath === '')    urlPath = '/index.html';
  if (urlPath === '/login')                 urlPath = '/login.html';
  if (urlPath === '/signup')                urlPath = '/signup.html';

  const filePath = path.join(__dirname, urlPath);
  const ext      = path.extname(filePath);
  const mimeType = MIME[ext] || 'text/plain';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // Any unresolved path falls back to index.html (SPA behaviour)
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
});
