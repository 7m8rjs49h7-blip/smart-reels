/* Lumen service worker: app shell, catalog, thumbnails, and range-capable offline video. */
const VERSION = 'v1.2.0';
const SHELL = 'lumen-shell-' + VERSION;
const DATA = 'lumen-data';
const IMG = 'lumen-img';
const MEDIA = 'lumen-media';
const SHELL_FILES = ['./', 'index.html', 'styles.css', 'app.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-180.png'];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    await c.addAll(SHELL_FILES);
    const d = await caches.open(DATA);
    try { await d.add('data/catalog.json'); } catch (_) {}
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) {
      if (k.startsWith('lumen-shell-') && k !== SHELL) await caches.delete(k);
    }
    await self.clients.claim();
  })());
});

function parseRange(h, size) {
  const m = /bytes=(\d*)-(\d*)/.exec(h || '');
  if (!m) return null;
  let start = m[1] === '' ? null : parseInt(m[1], 10);
  let end = m[2] === '' ? null : parseInt(m[2], 10);
  if (start === null) { start = Math.max(0, size - end); end = size - 1; }
  if (end === null || end >= size) end = size - 1;
  if (start > end || start >= size) return 'bad';
  return [start, end];
}

async function serveMedia(req, cached) {
  const blob = await cached.blob();
  const size = blob.size;
  const type = cached.headers.get('Content-Type') || blob.type || 'video/webm';
  const range = req.headers.get('range');
  if (!range) {
    return new Response(blob, { status: 200, headers: { 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' } });
  }
  const r = parseRange(range, size);
  if (r === 'bad' || !r) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  }
  const [s, e] = r;
  return new Response(blob.slice(s, e + 1, type), {
    status: 206,
    headers: { 'Content-Type': type, 'Content-Length': String(e - s + 1), 'Content-Range': `bytes ${s}-${e}/${size}`, 'Accept-Ranges': 'bytes' },
  });
}

async function trim(cacheName, max) {
  const c = await caches.open(cacheName);
  const keys = await c.keys();
  for (let i = 0; i < keys.length - max; i++) await c.delete(keys[i]);
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Video files: serve from offline cache (with Range support) if downloaded, else network.
  if (req.destination === 'video' || req.destination === 'audio' || /\.(webm|mov|mp4|ogv)(\?|$)/i.test(url.pathname)) {
    e.respondWith((async () => {
      const c = await caches.open(MEDIA);
      const hit = await c.match(url.href, { ignoreVary: true, ignoreSearch: false });
      if (hit) return serveMedia(req, hit);
      return fetch(req);
    })());
    return;
  }

  // Thumbnails / posters: cache-first.
  if (req.destination === 'image' && url.origin !== location.origin) {
    e.respondWith((async () => {
      const c = await caches.open(IMG);
      const hit = await c.match(req, { ignoreVary: true });
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res.ok || res.type === 'opaque') { c.put(req, res.clone()); trim(IMG, 400); }
        return res;
      } catch (err) {
        return new Response('', { status: 504 });
      }
    })());
    return;
  }

  if (url.origin !== location.origin) return;

  // Catalog: network-first, fall back to cache.
  if (url.pathname.endsWith('/data/catalog.json')) {
    e.respondWith((async () => {
      const c = await caches.open(DATA);
      try {
        const res = await fetch(req, { cache: 'no-cache' });
        if (res.ok) c.put('data/catalog.json', res.clone());
        return res;
      } catch (err) {
        return (await c.match('data/catalog.json')) || new Response('{"topics":[],"items":[]}', { headers: { 'Content-Type': 'application/json' } });
      }
    })());
    return;
  }

  // App shell: stale-while-revalidate; navigations fall back to cached index.
  e.respondWith((async () => {
    const c = await caches.open(SHELL);
    const key = req.mode === 'navigate' ? 'index.html' : req;
    const hit = await c.match(key, { ignoreSearch: req.mode === 'navigate' });
    const net = fetch(req).then((res) => { if (res.ok) c.put(key, res.clone()); return res; }).catch(() => null);
    return hit || (await net) || new Response('Offline', { status: 503 });
  })());
});
