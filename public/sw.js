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

const VERSION = 'phomymo-v2';
const SHELL = `${VERSION}-shell`;
const ASSETS = `${VERSION}-assets`;

const SHELL_URLS = ['/', '/index.html', '/manifest.webmanifest', '/icon.svg'];

/**
 * Hashed by Vite, so a given name always means the same bytes.
 *
 * Only /assets/ qualifies. Icons live at /icons/ and are NOT content-hashed — a new release can
 * replace icon-512.png under the same name — so they must not be treated as immutable.
 */
const isImmutableAsset = (url) =>
  url.pathname.startsWith('/assets/');

/** Icons are NOT content-hashed, so they need revalidation. */
const isIcon = (url) =>
  url.pathname.startsWith('/icons/');

/**
 * Drop cache entries no longer referenced by the shell.
 *
 * Hashed filenames change every release, so the ASSETS cache accumulated one dead entry per built
 * chunk per deploy and nothing ever removed them: a year of updates leaves a browser holding
 * megabytes of orphaned JavaScript. The cache names are versioned, so `activate` already discards
 * the previous *release's* caches wholesale — but every orphaned entry inside the *current* release's
 * cache survives, because the version never changes within a release. Trimming the ASSETS cache to
 * its own keys on activate costs one list() and keeps the cache exactly as large as the build.
 */
const trimAssets = async () => {
  const cache = await caches.open(ASSETS);
  const keys = await cache.keys();
  const keep = new Set(SHELL_URLS);
  // Anything still cached under /assets/ may be in use by this very release; entries anywhere else
  // were written by the icon path (which shares the cache) and are re-fetchable on demand.
  for (const req of keys) {
    const url = new URL(req.url);
    if (isImmutableAsset(url)) keep.add(url.pathname);
  }
  const stale = keys.filter((req) => !keep.has(new URL(req.url).pathname));
  await Promise.all(stale.map((req) => cache.delete(req)));
};

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
      .then(trimAssets)
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
    // Icons are not content-hashed, so use network-first with cache fallback. The cache write is
    // inside the respondWith chain rather than a floating `caches.open(...).then(...)`: a promise
    // the worker does not know about can be killed when the response resolves, which loses the
    // entry silently.
    event.respondWith(
      caches.open(ASSETS).then(async (cache) => {
        try {
          const fresh = await fetch(request);
          if (fresh.ok) await cache.put(request, fresh.clone());
          return fresh;
        } catch {
          return (await cache.match(request)) ?? Response.error();
        }
      }),
    );
    return;
  }

  // Navigations and the manifest: prefer the network, fall back to the cached shell offline.
  if (request.mode === 'navigate' || url.pathname === '/manifest.webmanifest') {
    event.respondWith(
      caches.open(SHELL).then(async (cache) => {
        try {
          const fresh = await fetch(request);
          if (fresh.ok) await cache.put(request, fresh.clone());
          return fresh;
        } catch {
          return (await cache.match(request)) ?? (await cache.match('/index.html')) ?? Response.error();
        }
      }),
    );
  }
});
