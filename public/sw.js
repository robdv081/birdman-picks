// App-shell cache so the app opens offline; live data always goes to the network.
// Also receives Pro alerts (Web Push): pushes carry no data, so on each one this asks the Birdman server for
// the message, proving which phone it is with the subscription's own auth secret.
const CACHE = 'birdman-v1';
const CONFIG = 'birdman-config';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['./', './index.html', './icon.svg', './manifest.webmanifest'])));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== CONFIG).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('./index.html')))
  );
});

async function serverUrl() {
  const res = await (await caches.open(CONFIG)).match('/birdman-config');
  return res ? (await res.json()).server : '';
}

function authOf(sub) {
  const raw = sub.getKey('auth');
  return btoa(String.fromCharCode(...new Uint8Array(raw))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function showAlerts() {
  let messages = [];
  try {
    const server = await serverUrl();
    const sub = await self.registration.pushManager.getSubscription();
    if (server && sub) {
      const res = await fetch(server + '/api/push/pull', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: sub.endpoint, auth: authOf(sub) }),
      });
      if (res.ok) messages = (await res.json()).messages || [];
    }
  } catch {
    /* fall through to the generic note */
  }
  // Every push must show something; if the message couldn't be fetched, point to the record.
  if (!messages.length) messages = [{ title: 'Birdman Picks', body: 'There’s an update on the Birdman record.', url: self.registration.scope + '#record', tag: 'birdman' }];
  await Promise.all(
    messages.map((m) => self.registration.showNotification(m.title, { body: m.body, tag: m.tag, icon: 'icon.svg', badge: 'icon.svg', data: { url: m.url } }))
  );
}

self.addEventListener('push', (e) => e.waitUntil(showAlerts()));

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || self.registration.scope;
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      const open = wins.find((w) => w.url.startsWith(self.registration.scope));
      if (open) return open.navigate(url).then((w) => (w || open).focus());
      return self.clients.openWindow(url);
    })
  );
});
