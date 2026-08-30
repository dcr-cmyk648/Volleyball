const CACHE_VERSION = 'vball-static-v31-central-history-league-variance';
const APP_SHELL = [
  './',
  './index.html',
  './tournament.html',
  './stats.html',
  './trend.html',
  './ranking.html',
  './players.html',
  './help.html',
  './ratings.js',
  './bayesian-ratings.js',
  './overall-dynamic-ratings.js',
  './bayesian-ratings-worker.js',
  './default_database',
  './manifest.webmanifest',
  './icons/icon-192.png?v=20260808',
  './icons/icon-512.png?v=20260808',
  './icons/apple-touch-icon.png?v=20260808',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(key => key !== CACHE_VERSION)
          .map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== location.origin) return;

  event.respondWith(
    fetch(event.request)
      .then(response => {
        const copy = response.clone();
        caches.open(CACHE_VERSION).then(cache => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request).then(cached => cached || caches.match('./stats.html')))
  );
});
