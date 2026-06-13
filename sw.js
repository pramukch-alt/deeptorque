const CACHE_NAME = 'torque-inspect-v4';
const ASSETS = [
  './',
  './index.html',
  './index.css',
  './app.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

// Install Event
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[Service Worker] Pre-caching static assets');
      return cache.addAll(ASSETS);
    }).catch(err => {
      console.error('[Service Worker] Pre-caching failed:', err);
    })
  );
  self.skipWaiting();
});

// Activate Event (Cleanup Old Caches)
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            console.log('[Service Worker] Removing old cache:', key);
            return caches.delete(key);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Fetch Event (Cache First with Network Fallback, Dynamic Google Fonts Caching)
self.addEventListener('fetch', (e) => {
  // Only handle GET requests
  if (e.request.method !== 'GET') return;

  e.respondWith(
    caches.match(e.request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }
      return fetch(e.request).then((response) => {
        // Don't cache non-success responses or non-http protocols
        if (!response || response.status !== 200 || response.type !== 'basic' && !e.request.url.startsWith('https://fonts.')) {
          return response;
        }

        // Cache external fonts dynamically
        if (e.request.url.startsWith('https://fonts.googleapis.com') || e.request.url.startsWith('https://fonts.gstatic.com')) {
          const responseToCache = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(e.request, responseToCache);
          });
        }
        return response;
      }).catch((err) => {
        console.log('[Service Worker] Fetch failed, probably offline:', err);
        // Fallback or just let it fail
      });
    })
  );
});
