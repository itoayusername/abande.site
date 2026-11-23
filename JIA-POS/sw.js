// JIA POS service worker: keeps the app opening when the internet is down.
// Firestore/Auth traffic is never intercepted; the Firebase SDK handles offline data itself.
const V = 'jia-pos-v26';
const SHELL = ['./', 'JIA-POS.html', 'manifest.webmanifest', 'icon.png', 'icon-192.png'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(V).then(c => Promise.all(SHELL.map(u => c.add(new Request(u, { cache: 'reload' })).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== V).map(x => caches.delete(x)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET') return;
  const u = new URL(r.url);
  if (u.origin !== location.origin && u.hostname !== 'www.gstatic.com' && u.hostname !== 'cdn.jsdelivr.net') return;
  if (r.mode === 'navigate') {
    e.respondWith(fetch(r).then(x => { const c = x.clone(); caches.open(V).then(h => h.put(r, c)); return x; })
      .catch(() => caches.match(r).then(m => m || caches.match('JIA-POS.html') || caches.match('./'))));
    return;
  }
  e.respondWith(caches.match(r).then(m => m || fetch(r).then(x => {
    if (x.ok || x.type === 'opaque') { const c = x.clone(); caches.open(V).then(h => h.put(r, c)); }
    return x;
  })));
});
