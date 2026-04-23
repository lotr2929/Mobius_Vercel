// service-worker.js
// PWA offline shell. Network-first strategy -- always serves fresh files when
// online, falls back to cache only when offline. No manual cache-busting needed.

const CACHE_NAME = 'mobius-v6';

const SHELL_URLS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/favicon.ico',
  '/mobius-logo.png',
  '/js/commands.js',
  '/js/log.js',
  '/js/router.js',
  '/js/connectivity.js',
  '/js/panel.js',
  '/js/scores.js'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(SHELL_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(names => Promise.all(
        names.map(name => name !== CACHE_NAME ? caches.delete(name) : null)
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname === '/ask') return;
  event.respondWith(
    fetch(event.request).then(response => {
      if (response && response.status === 200 && response.type === 'basic')
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, response.clone()));
      return response;
    }).catch(() =>
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        if (event.request.mode === 'navigate') return caches.match('/index.html');
      })
    )
  );
});
