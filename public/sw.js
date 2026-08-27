/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║  BoltCall — Service Worker (PWA)                            ║
 * ║  Cache-first for static assets, network-first for API       ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

const CACHE_NAME = 'boltcall-v1';

// প্রথম install-এ এই assets cache করা হবে
const PRECACHE_ASSETS = [
  '/',
  '/index.html',
  '/style.css',
  '/script.js',
  '/pwa.html',
  '/icon-192.png',
  '/icon-512.png',
  '/manifest.json'
];

// ── Install — Precache static assets ──
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('📦 SW: Precaching assets');
      return cache.addAll(PRECACHE_ASSETS);
    })
  );
  self.skipWaiting();
});

// ── Activate — পুরনো cache মুছে ফেলুন ──
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      );
    })
  );
  self.clients.claim();
});

// ── Fetch — Cache-first for static, Network-first for API ──
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // API calls ও Socket.IO — সবসময় network
  if (url.pathname.startsWith('/api/') ||
      url.pathname.startsWith('/socket.io/') ||
      url.pathname.startsWith('/upload')) {
    return;
  }

  // Static assets — cache-first
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;

      return fetch(event.request).then((response) => {
        // শুধু successful responses cache করুন
        if (!response || response.status !== 200 || response.type !== 'basic') {
          return response;
        }

        const responseClone = response.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, responseClone);
        });

        return response;
      });
    }).catch(() => {
      // Offline fallback
      if (event.request.destination === 'document') {
        return caches.match('/index.html');
      }
    })
  );
});
