import { defineConfig, type Plugin } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

/**
 * Write dist/asset-manifest.json listing every file the build emits.
 *
 * The service worker cannot know which hashed filenames belong to the running build — it only
 * knows what it happens to have cached, which is exactly the set with dead entries in it. It reads
 * this file to tell "what this build ships" from "what a previous build left behind", and deletes
 * the difference. Without it the asset cache only shrinks when a human bumps the worker's version
 * string by hand.
 */
function assetManifest(): Plugin {
  return {
    name: 'phomymo-asset-manifest',
    apply: 'build',
    generateBundle(_options, bundle) {
      const files = Object.keys(bundle).map((f) => `/${f}`);
      this.emitFile({
        type: 'asset',
        fileName: 'asset-manifest.json',
        source: JSON.stringify([...new Set(['/index.html', ...files])], null, 2),
      });
    },
  };
}

/**
 * Stamp `dist/sw.js` with an id derived from this build.
 *
 * A browser installs a new service worker only when the bytes of the worker change. Vite copies
 * `public/` verbatim, so before this plugin two releases shipped a byte-identical `sw.js`: no
 * update was installed, `activate` never fired, and the cache trim that `sw.js` performs was dead
 * code in every deployment after the first. Measured: two builds with different bundles both
 * produced `sw.js` sha256 9b2641933d58a6f7.
 *
 * The id hashes the emitted file names and contents, so it changes whenever the application does
 * and stays identical when it does not — a reproducible build still produces a reproducible worker.
 *
 * The stamping happens in `closeBundle` because that is the first point at which Vite has finished
 * copying `public/`. If the token is not there, the build throws: shipping an unstamped worker
 * would freeze the cache name forever and silently restore the original defect.
 */
function buildStamp(): Plugin {
  const TOKEN = '__PHOMYMO_BUILD_ID__';
  let outDir = 'dist';
  let id: string | null = null;
  return {
    name: 'phomymo-build-stamp',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir;
    },
    generateBundle(_options, bundle) {
      const hash = createHash('sha256');
      for (const name of Object.keys(bundle).sort()) {
        hash.update(name);
        const source = (bundle[name] as { source?: string | Uint8Array }).source;
        hash.update(typeof source === 'string' ? source : Buffer.from(source ?? []));
      }
      id = hash.digest('hex').slice(0, 12);
    },
    closeBundle() {
      const file = resolve(outDir, 'sw.js');
      const source = readFileSync(file, 'utf8');
      if (!source.includes(TOKEN)) {
        throw new Error(`sw.js has no ${TOKEN} token to stamp — the service worker would never update`);
      }
      if (!id) throw new Error('sw.js was not stamped: no build id was computed');
      writeFileSync(file, source.replace(TOKEN, `phomymo-${id}`));
    },
  };
}

export default defineConfig({
  plugins: [react(), assetManifest(), buildStamp()],
  // The About dialog shows the running version, so bumping package.json is the only
  // step a release needs. It stays in English even in the Arabic UI: "v1.0.2" is a
  // version number, not a word, and needs no RTL marker to read correctly.
  envPrefix: ['VITE_', 'APP_'],
  define: { 'import.meta.env.APP_VERSION': JSON.stringify(pkg.version) },
  build: { target: 'es2022', chunkSizeWarningLimit: 900 },
  test: {
    // Pure-logic tests run in plain node (fast, no DOM). Component tests opt into jsdom with a
    // `// @vitest-environment jsdom` docblock, and use the .dom.test.tsx suffix so the include
    // pattern picks them up.
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    setupFiles: ['tests/setup-dom.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: [
        'src/main.tsx',          // entry point
        'src/vite-env.d.ts',
        'src/**/*.d.ts',
        'src/transport/webapis.d.ts',
      ],
      // A single global figure hides which layer is thin, so per-file numbers matter here.
      reporter: ['text-summary', 'text'],
      thresholds: {
        // The suite is at 80% statements today; hold the line rather than let it slide.
        statements: 80,
        branches: 70,
        functions: 75,
        lines: 80,
      },
    },
  },
});