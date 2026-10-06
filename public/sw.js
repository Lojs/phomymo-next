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

/**
 * The build's own identity, stamped in by the Vite plugin in `vite.config.ts` at build time.
 *
 * This must NOT be a hand-written constant. A browser installs a new service worker only when the
 * bytes of this file change, and the build used to copy it verbatim — so two different releases
 * shipped an identical worker, no update was ever installed, `activate` never ran, and the cache
 * trim below was dead code in every deployment after the first. Measured before the fix: two builds
 * with different app bundles both produced `sw.js` sha256 9b2641933d58a6f7.
 *
 * Deriving it from the build also removes the failure mode that a human forgets to bump it, which
 * is what the old `phomymo-v3` literal relied on. If the stamp is missing the build fails rather
 * than shipping this token.
 *
 * It is deliberately NOT part of the cache names. It used to be: the caches were `${VERSION}-shell`
 * and `${VERSION}-assets`, so `activate` discarded the previous release's caches wholesale and the
 * trim below had nothing left to do. That made the trim machinery pointless and, worse, threw away
 * chunks that had not changed — pdf.js's worker, jsPDF and html2canvas keep the same hashed names
 * between releases, and this app is meant to open with no network, so every release made the user
 * re-download about 2 MB of them. The id's only job is to make these bytes differ; the cache names
 * are governed by CACHE_VERSION, which changes when the cache layout does.
 */
const BUILD_ID = '__PHOMYMO_BUILD_ID__';
// Kept reachable so nothing can treat the constant as dead and drop the bytes the browser compares.
// The name deliberately does not repeat the token above: the build stamps every occurrence of it,
// and a second one in an identifier would ship a placeholder in a name.
self.__phomymoBuildId = BUILD_ID;

/**
 * The cache layout's version. Bump this when what is stored, or how, changes — a cache-first asset
 * that is no longer immutable, a revalidation rule, the shell's URL list.
 *
 * Not per build: see BUILD_ID.
 */
const CACHE_PREFIX = 'phomymo';
const CACHE_VERSION = 'v1';
const SHELL = `${CACHE_PREFIX}-${CACHE_VERSION}-shell`;
const ASSETS = `${CACHE_PREFIX}-${CACHE_VERSION}-assets`;

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
 * updates leaves a browser holding megabytes of orphaned JavaScript.
 *
 * This is the only thing that removes them, and it now has to be. The cache names used to embed the
 * build id, which meant `activate` threw the whole cache away on every release and this function had
 * nothing to do — at the cost of re-downloading every unchanged chunk. The names are stable now, so
 * the cache survives a release and the trim is what keeps it honest.
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
      // Every cache of ours that is not one of these two. That covers `phomymo-<build id>-shell`
      // from every release up to 1.0.24, which would otherwise leak forever now that the names no
      // longer carry the id.
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith(`${CACHE_PREFIX}-`) && k !== SHELL && k !== ASSETS)
            .map((k) => caches.delete(k)),
        ),
      )
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
