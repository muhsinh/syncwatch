// Minimal service worker: makes the app installable; always network-first so updates land immediately.
self.addEventListener('fetch', (e) => { if (e.request.method === 'GET') e.respondWith(fetch(e.request).catch(() => caches.match(e.request))); });
