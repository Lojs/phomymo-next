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

const VERSION = 'phomymo-v3';
const SHELL = `${VERSION}-shell`;
const ASSETS = `${VERSION}-assets`;

const SHELL_URLS = ['/', '/index.html', '/manifest.webmanifest', '/icon.svg', '/asset-manifest.json'];

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
 * Drop cache entries this build does not reference.
 *
 * Hashed filenames change every release, so the ASSETS cache accumulated one dead entry per built
 * chunk per deploy and nothing ever removed them: the pdf.js worker alone is ~1.2 MB, so a year of
 * updates leaves a browser holding megabytes of orphaned JavaScript. Cache NAMES are versioned, so
 * `activate` already discards the previous *release's* caches wholesale.
 *
 * An earlier version of this tried to trim by keeping "whatever is under /assets/" — which is a
 * tautology: every entry under /assets/ is kept precisely because it is under /assets/, so the
 * only things it could ever delete were the icons. The dead hashed chunks survived, which is the
 * exact problem it claimed to solve.
 *
 * The list of filenames THIS build ships comes from the build itself: a small Vite plugin writes
 * dist/asset-manifest.json listing every emitted file, and the worker fetches it here. A file the
 * build no longer produces is therefore not in the list and does get deleted.
 *
 * If the manifest cannot be read, everything is kept. An over-large cache is a minor cost;
 * deleting a file the running app still needs is a broken app, so the failure mode is chosen.
 */
const trimAssets = async () => {
  const cache = await caches.open(ASSETS);
  let names;
  try {
    const res = await fetch('/asset-manifest.json', { cache: 'no-store' });
    if (!res.ok) return;
    const parsed = await res.json();
    if (!Array.isArray(parsed) || !parsed.length) return;
    names = parsed;
  } catch {
    return;   // no manifest, offline, or malformed: keep everything
  }
  const keep = new Set([...SHELL_URLS, ...names.map((n) => new URL(n, self.location.origin).pathname)]);
  const keys = await cache.keys();
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
