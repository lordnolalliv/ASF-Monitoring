const CACHE_NAME = 'bohol-asf-watch-v8';
const APP_ASSETS = [
  './',
  './index.html',
  './admin.html',
  './styles.css',
  './app.js',
  './admin.js',
  './barangays.js',
  './bohol-map.js',
  './demo-data.js',
  './bohol-province-seal.png',
  './pig-background.jpg',
  './demo-data.json',
  './manifest.json',
  './app-icon.svg',
  './app-icon-192.png',
  './app-icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => key.startsWith('bohol-asf-watch-') && key !== CACHE_NAME)
        .map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (/\/(?:index|login|logout|api|admin)\.php$/.test(url.pathname)) return;

  if (request.mode === 'navigate' && /\/admin\.html$/.test(url.pathname)) {
    event.respondWith(fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(async () => (await caches.match(request)) || caches.match('./admin.html')));
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put('./index.html', copy));
        }
        return response;
      })
      .catch(() => caches.match('./index.html')));
    return;
  }

  event.respondWith(caches.match(request).then((cached) =>
    cached || fetch(request).then((response) => {
      if (response.ok) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
      }
      return response;
    })
  ));
});
