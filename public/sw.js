/**
 * Offline shell for Phomymo Next.
 *
 * Scope is deliberately narrow: this caches the application shell and the hashed build assets, so the
 * app opens with no network. It does NOT cache anything the user created — designs, templates and the
 * printer registry live in localStorage and are never touched here. Caching user data in a Cache
 * Storage entry would duplicate it, need its own eviction story, and risk serving a stale label.
 *
 * Hashed assets (/assets/*) are immutable, so they are cache-first with no revalidation. index.html
 * and the manifest are network-first with a cache fallback, so a deployed update is picked up as soon
 * as the device is online and only falls back to the cached shell when it is not.
 */

const VERSION = 'phomymo-v1';
const SHELL = `${VERSION}-shell`;
const ASSETS = `${VERSION}-assets`;

const SHELL_URLS = ['/', '/index.html', '/manifest.webmanifest', '/icon.svg'];

/** Hashed by Vite, so a given name always means the same bytes. */
const isImmutableAsset = (url) =>
  url.pathname.startsWith('/assets/');

/** Icons are NOT content-hashed, so they need revalidation. */
const isIcon = (url) =>
  url.pathname.startsWith('/icons/');

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL).then((cache) => cache.addAll(SHELL_URLS)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;   // nothing third-party to worry about

  if (isImmutableAsset(url)) {
    event.respondWith(
      caches.open(ASSETS).then(async (cache) => {
        const hit = await cache.match(request);
        if (hit) return hit;
        const fresh = await fetch(request);
        if (fresh.ok) {
          event.waitUntil(cache.put(request, fresh.clone()));
        }
        return fresh;
      }),
    );
    return;
  }

  if (isIcon(url)) {
    // Icons are not content-hashed, so use network-first with cache fallback.
    event.respondWith(
      fetch(request)
        .then((fresh) => {
          if (fresh.ok) {
            const copy = fresh.clone();
            caches.open(ASSETS).then((cache) => cache.put(request, copy));
          }
          return fresh;
        })
        .catch(async () => (await caches.match(request)) ?? Response.error()),
    );
    return;
  }

  // Navigations and the manifest: prefer the network, fall back to the cached shell offline.
  if (request.mode === 'navigate' || url.pathname === '/manifest.webmanifest') {
    event.respondWith(
      fetch(request)
        .then((fresh) => {
          if (fresh.ok) {
            const copy = fresh.clone();
            caches.open(SHELL).then((cache) => cache.put(request, copy));
          }
          return fresh;
        })
        .catch(async () => (await caches.match(request)) ?? (await caches.match('/index.html')) ?? Response.error()),
    );
  }
});
