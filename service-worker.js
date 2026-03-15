const CACHE_NAME = 'mobius-20260315-1';

// App shell — everything needed to run the UI offline
const SHELL_URLS = [
  '/',
  '/index.html',
  '/login.html',
  '/signup.html',
  '/manifest.json',
  '/mobius-logo.png',
  '/favicon.ico',
  '/commands.js',
  '/google_api.js',
  '/actions.js',
  '/service-worker.js'
];

// ── Install — cache the app shell ────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(SHELL_URLS))
      .then(() => self.skipWaiting())
  );
});

// ── Activate — clean up old caches ───────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(names => Promise.all(
        names.map(name => name !== CACHE_NAME ? caches.delete(name) : null)
      ))
      .then(() => self.clients.claim())
  );
});

// ── Fetch — network first for API, cache first for shell ─────────────────────
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // API calls and external requests — network only, no caching
  // If network fails, let the error surface naturally so Mobius can handle it
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname === '/ask' ||
    url.pathname === '/parse' ||
    url.pathname === '/upload' ||
    url.pathname.startsWith('/auth/') ||
    url.origin !== self.location.origin
  ) {
    return; // browser handles normally — fails gracefully if offline
  }

  // App shell — cache first, network fallback
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;

      return fetch(event.request).then(response => {
        // Cache successful shell responses
        if (response && response.status === 200 && response.type === 'basic') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => {
        // Offline fallback — return cached index.html for navigation
        if (event.request.mode === 'navigate') {
          return caches.match('/index.html');
        }
      });
    })
  );
});
