/**
 * The service worker, executed rather than grepped.
 *
 * The v1.0.16 review's service-worker tests asserted that certain words appear in public/sw.js. That
 * is false assurance: `expect(sw).toMatch(/trimAssets/)` passes just as happily when trimAssets is
 * an empty function, or when the branch that calls it is `if false`. The v1.0.18 review found that
 * D2 — trimAssets() kept every /assets/ entry it saw, so it could only ever delete icons — passed
 * those text tests. So the worker is loaded into a node:vm with a fake caches object and its
 * activate handler really run.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

const ROOT = resolve(__dirname, '..');
const source = readFileSync(resolve(ROOT, 'public/sw.js'), 'utf8');
const ORIGIN = 'https://printer.example';

/** One cache entry URL, as cache.keys() would report it. */
const entryUrl = (path: string) => `${ORIGIN}${path}`;

/** A fake Cache Storage, and a fetch that serves the asset manifest when asked for it. */
function harness(cached: string[], manifest: unknown) {
  // One entry set per cache name, seeded with everything the harness was given.
  const seeded = [...cached];
  const store = new Map<string, Set<string>>([['phomymo-v3-assets', new Set(seeded.map(entryUrl))], ['phomymo-v3-shell', new Set(seeded.map(entryUrl))]]);
  const deleted: string[] = [];

  const cacheFor = (name: string) => ({
    addAll: async () => {},
    match: async () => undefined,
    put: async () => {},
    keys: async () => [...(store.get(name) ?? [])].map((url) => ({ url })),
    // Mutate the store, like the real Cache API does. Merely recording the call would let a worker
    // that deletes the right URLs still appear to keep them, which is the opposite of the point.
    delete: async (req: { url: string }) => {
      deleted.push(req.url);
      return store.get(name)?.delete(req.url) ?? false;
    },
  });

  const listeners: Record<string, (e: unknown) => void> = {};
  const waitUntils: Promise<unknown>[] = [];

  const sandbox: Record<string, unknown> = {
    URL,
    Response: { error: () => new Error('error') },
    console,
    fetch: async (url: string) => {
      if (url === '/asset-manifest.json') {
        if (manifest === undefined) return { ok: false, status: 404 };
        return { ok: true, json: async () => manifest };
      }
      return { ok: true };
    },
    caches: {
      open: async (name: string) => cacheFor(name),
      keys: async () => [...store.keys()],
      delete: async (name: string) => store.delete(name),
    },
    self: {
      location: { origin: ORIGIN },
      addEventListener: (t: string, fn: (e: unknown) => void) => { listeners[t] = fn; },
      skipWaiting: async () => {},
      clients: { claim: async () => {} },
    },
  };
  (sandbox.self as Record<string, unknown>).self = sandbox.self;

  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);

  return {
    deleted,
    store,
    /** Fire `activate` and wait for everything it passed to waitUntil. */
    async activate() {
      listeners.activate!({ waitUntil: (p: Promise<unknown>) => { waitUntils.push(p); } });
      await Promise.all(waitUntils);
    },
  };
}

describe('the service worker, run for real', () => {
  const CURRENT = ['/index.html', '/assets/index-NEW.js'];

  it('deletes a hashed asset the current build no longer ships', async () => {
    const h = harness(
      ['/assets/index-OLD1.js', '/assets/index-OLD2.js', '/assets/index-NEW.js', '/icons/icon-512.png'],
      CURRENT,
    );
    await h.activate();

    const left = [...(h.store.get('phomymo-v3-assets') ?? [])].map((u) => u.replace(ORIGIN, ''));
    expect(left).toContain('/assets/index-NEW.js');      // still used
    expect(left).not.toContain('/assets/index-OLD1.js'); // dead from an earlier release
    expect(left).not.toContain('/assets/index-OLD2.js');
  });

  it('deletes a stale icon, since icons are revalidated rather than kept forever', async () => {
    const h = harness(['/icons/icon-512.png'], CURRENT);
    await h.activate();
    expect([...(h.store.get('phomymo-v3-assets') ?? [])]).toHaveLength(0);
  });

  it('keeps everything when the manifest is unavailable, rather than breaking the app', async () => {
    // Over-large cache is a cost; deleting a file the running app needs is an outage.
    const h = harness(['/assets/index-OLD.js'], undefined);
    await h.activate();
    expect([...(h.store.get('phomymo-v3-assets') ?? [])]).toHaveLength(1);
  });

  it('keeps everything when the manifest is malformed or empty', async () => {
    for (const bad of [{}, [], 'nonsense', null]) {
      const h = harness(['/assets/index-OLD.js'], bad);
      await h.activate();
      expect([...(h.store.get('phomymo-v3-assets') ?? [])]).toHaveLength(1);
    }
  });

  it('never deletes a shell URL', async () => {
    const h = harness(['/index.html', '/manifest.webmanifest', '/icon.svg'], CURRENT);
    await h.activate();
    const left = [...(h.store.get('phomymo-v3-assets') ?? [])].map((u) => u.replace(ORIGIN, ''));
    expect(left).toEqual(expect.arrayContaining(['/index.html', '/manifest.webmanifest', '/icon.svg']));
  });
});

describe('the manifest the build emits', () => {
  it('is listed in the shell so the worker can read it offline too', () => {
    expect(source).toMatch(/'\/asset-manifest\.json'/);
  });

  it('the Vite plugin writes it as a build asset, not into public/', () => {
    // In public/ it would be a hand-maintained list that drifts from reality — the same bug class
    // as the cache trimming it exists to solve.
    const config = readFileSync(resolve(ROOT, 'vite.config.ts'), 'utf8');
    expect(config).toMatch(/fileName:\s*'asset-manifest\.json'/);
    expect(config).toMatch(/generateBundle/);
  });
});