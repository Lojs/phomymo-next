// @vitest-environment node
/**
 * The service worker must differ between releases.
 *
 * A browser installs a new service worker only when the bytes of the worker file change. Vite copies
 * `public/` verbatim, so before this fix every release shipped a byte-identical `sw.js`: no update
 * was ever installed, `activate` never ran, and the cache trim inside it was dead code in every
 * deployment after the first. Two builds with different application bundles both produced
 * `sw.js` sha256 9b2641933d58a6f7.
 *
 * The tests that already existed could not catch this. They call the worker's `activate` handler
 * directly, which proves "if activate runs, it trims" — it cannot show that activate runs. This file
 * tests the precondition instead, by running the real build.
 *
 * These are real builds (~300 ms each), so this is the slowest test file in the suite. That is the
 * point: the defect lived precisely in the gap between "the handler works" and "the handler is
 * reached", and only a build can close it.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { build } from 'vite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');
const TOKEN = '__PHOMYMO_BUILD_ID__';
const STAMPED = /const VERSION = 'phomymo-[0-9a-f]{12}';/;

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/**
 * Build the real project into a throwaway directory.
 *
 * `APP_VERSION` is overridden so two builds can be made to differ in application code without
 * touching the working tree — it is compiled into the bundle, so changing it changes the emitted
 * chunks and therefore the build's identity.
 */
async function buildInto(version: string): Promise<string> {
  const outDir = mkdtempSync(join(tmpdir(), 'phomymo-stamp-'));
  made.push(outDir);
  await build({
    root: ROOT,
    configFile: resolve(ROOT, 'vite.config.ts'),
    logLevel: 'silent',
    define: { 'import.meta.env.APP_VERSION': JSON.stringify(version) },
    build: { outDir, emptyOutDir: true },
  });
  return readFileSync(join(outDir, 'sw.js'), 'utf8');
}

describe('the built service worker carries this build\'s identity', () => {
  it('is stamped, and no longer contains the placeholder', async () => {
    const sw = await buildInto('1.0.0');
    expect(sw).toMatch(STAMPED);
    expect(sw).not.toContain(TOKEN);
  }, 60_000);

  it('differs between two builds of different code', async () => {
    // The defect in one assertion: this failed when sw.js was copied verbatim, because both builds
    // produced the same bytes and the browser had nothing to update to.
    const a = await buildInto('1.0.0');
    const b = await buildInto('9.9.9');
    const stamp = (sw: string) => sw.match(STAMPED)?.[0];
    expect(stamp(a)).toBeTruthy();
    expect(stamp(b)).toBeTruthy();
    expect(stamp(a)).not.toBe(stamp(b));
    expect(a).not.toBe(b);
  }, 120_000);

  it('is identical for two builds of the same code', async () => {
    // A reproducible build must stay reproducible: the id comes from the emitted content, not from
    // a clock or a counter, so rebuilding the same source gives the same worker and the browser
    // does not reinstall for nothing.
    const first = await buildInto('1.0.0');
    const second = await buildInto('1.0.0');
    expect(first).toBe(second);
  }, 120_000);
});