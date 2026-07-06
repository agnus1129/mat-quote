const C = 'mat-cache-v3';
self.addEventListener('install', e => { self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil((async () => {
  const keys = await caches.keys();
  await Promise.all(keys.map(k => caches.delete(k)));   // 옛 캐시 전부 삭제
  await self.clients.claim();
})()); });
// 항상 네트워크 최신본. 오프라인일 때만 캐시 폴백.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const u = new URL(e.request.url);
  if (u.pathname.startsWith('/api/') || u.pathname.startsWith('/auth/')) return;
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
