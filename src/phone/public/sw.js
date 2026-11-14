// Keeps the app itself on the phone, so Hark opens (and can record) even when the Mac is out of reach.
const CACHE = 'hark-phone-v1';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (/^\/(ws|audio|upload|health|manifest)/.test(url.pathname)) return;
  // The pairing key is never part of what gets cached.
  const key = url.origin + url.pathname;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(key, copy));
        }
        return res;
      })
      .catch(() => caches.match(key).then((hit) => hit || caches.match(url.origin + '/'))),
  );
});
