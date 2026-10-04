/**
 * Regression tests for the problems found in v1.0.11:
 *   - zero was exempt from range clamping, so a 0x0 label and `labelsAcross: 0` (Infinity rows) loaded
 *   - download file names were cut by UTF-16 unit and could end in a lone surrogate
 *   - the entrypoint wrote an IPv6 address into the certificate as a DNS name
 *   - pull requests could publish an image
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');

function memStorage() {
  const m = new Map<string, string>();
  return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
}

beforeEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  (globalThis as any).localStorage = memStorage();
  Object.defineProperty(globalThis, 'navigator', { value: { language: 'en-US' }, configurable: true, writable: true });
});

describe('zero is not exempt from range clamping', () => {
  const base = { elements: [] };

  it('a 0 x 0 label in an imported file is raised to the minimum size', async () => {
    const { parseDesignJSON } = await import('../src/core/storage/storage');
    const { LIMITS } = await import('../src/core/printers/presets');
    const { design } = parseDesignJSON(JSON.stringify({ ...base, labelSize: { width: 0, height: 0 } }));
    expect(design.labelSize.width).toBe(LIMITS.label.minW);
    expect(design.labelSize.height).toBe(LIMITS.label.minH);
  });

  it('labelsAcross: 0 becomes 1, so a batch cannot need Infinity rows', async () => {
    const { parseDesignJSON } = await import('../src/core/storage/storage');
    const { LIMITS } = await import('../src/core/printers/presets');
    const { design } = parseDesignJSON(JSON.stringify({ ...base, labelSize: { width: 40, height: 30 }, multiLabel: { enabled: true, cloneMode: false, labelsAcross: 0, labelWidth: 0, labelHeight: 0, gapMm: 0 } }));
    const m = design.multiLabel!;
    expect(m.labelsAcross).toBe(1);
    expect(Number.isFinite(Math.ceil(5 / m.labelsAcross))).toBe(true);
    expect(m.labelWidth).toBe(LIMITS.multi.minLabelW);
    expect(m.labelHeight).toBe(LIMITS.multi.minLabelH);
    expect(m.gapMm).toBe(0); // zero is a genuinely valid gap and is the clamp's own minimum
  });

  it('still clamps values above the maximum', async () => {
    const { parseDesignJSON } = await import('../src/core/storage/storage');
    const { LIMITS } = await import('../src/core/printers/presets');
    const { design } = parseDesignJSON(JSON.stringify({ ...base, labelSize: { width: 1e9, height: -5 } }));
    expect(design.labelSize).toMatchObject({ width: LIMITS.label.maxW, height: LIMITS.label.minH });
  });

  it('the same holds for a damaged autosave', async () => {
    const S = await import('../src/core/storage/storage');
    (globalThis as any).localStorage.setItem(S.KEYS.AUTOSAVE, JSON.stringify({ elements: [], labelSize: { width: 0, height: 0 }, multiLabel: { enabled: true, labelsAcross: 0 } }));
    const d = S.loadAutosave()!;
    expect(d.labelSize.width).toBeGreaterThan(0);
    expect(d.multiLabel!.labelsAcross).toBe(1);
  });

  it('settings from storage are clamped, including zero copies', async () => {
    const S = await import('../src/core/storage/storage');
    (globalThis as any).localStorage.setItem(S.KEYS.SETTINGS, JSON.stringify({ copies: 0, density: 0, feed: 9999, tapeWidth: 12 }));
    const s = S.loadSettings();
    expect(s.copies).toBe(1);
    expect(s.density).toBe(1);
    expect(s.feed).toBe(255);
    expect(s.tapeWidth).toBe(12);
  });
});

describe('download file names', () => {
  async function exported(name: string) {
    const saved: string[] = [];
    (globalThis as any).document = {
      createElement: () => {
        const a: { download: string; click(): void; remove(): void } = { download: '', click() { saved.push(a.download); }, remove() {} };
        return a;
      },
      body: { appendChild() {} },
      addEventListener() {},
    };
    (URL as any).createObjectURL = () => 'blob:x';
    (URL as any).revokeObjectURL = () => {};
    const { useStore } = await import('../src/state/store');
    const { exportJson } = await import('../src/services/actions');
    useStore.setState({ designName: name });
    exportJson();
    return saved[0].replace(/\.json$/, '');
  }
  const hasLoneSurrogate = (s: string) => /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s);

  it('never ends in half an emoji when the name is cut at 120 characters', async () => {
    const n = await exported('a'.repeat(119) + '😀tail');
    expect(hasLoneSurrogate(n)).toBe(false);
    expect(Array.from(n).length).toBeLessThanOrEqual(120);
  });

  it('keeps a 120-character Arabic name intact', async () => {
    const name = 'م'.repeat(120);
    expect(await exported(name)).toBe(name);
  });

  it('prefixes Windows reserved names and still falls back to "label" for an empty name', async () => {
    expect(await exported('CON')).toBe('_CON');
    expect(await exported('')).toBe('label');
  });

  it('strips bidirectional overrides and control characters', async () => {
    expect(await exported('a\u202eb\u0007c')).toBe('a_b_c');
  });
});

describe('docker/entrypoint.sh', () => {
  const hasOpenssl = spawnSync('openssl', ['version']).status === 0 && spawnSync('perl', ['-v']).status === 0;
  let dir: string;

  function run(domain: string) {
    dir = mkdtempSync(join(tmpdir(), 'phomymo-ep-'));
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'envsubst'), String.raw`#!/bin/sh
exec perl -pe 's/\$\{(\w+)\}/$ENV{$1}/ge'
`);
    chmodSync(join(bin, 'envsubst'), 0o755);
    const r = spawnSync('sh', [join(ROOT, 'docker/entrypoint.sh'), 'true'], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PHOMYMO_DOMAIN: domain, CERT_DIR: join(dir, 'certs'), CONF_TEMPLATE: join(ROOT, 'docker/nginx.conf'), CONF_OUT: join(dir, 'out.conf') },
      encoding: 'utf8',
    });
    const san = spawnSync('openssl', ['x509', '-in', join(dir, 'certs/cert.pem'), '-noout', '-ext', 'subjectAltName'], { encoding: 'utf8' }).stdout;
    return { r, san };
  }

  it.skipIf(!hasOpenssl)('puts an IPv6 address under IP:, not DNS:', () => {
    const { r, san } = run('::1');
    expect(r.status, r.stderr).toBe(0);
    expect(san).not.toMatch(/DNS:::1/);
    expect(san).toMatch(/IP Address:0:0:0:0:0:0:0:1/);
    rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(!hasOpenssl)('still puts an IPv4 address under IP: and a hostname under DNS:', () => {
    expect(run('192.168.1.50').san).toContain('IP Address:192.168.1.50');
    expect(run('pi.local').san).toContain('DNS:pi.local');
  });

  it.skipIf(!hasOpenssl)('rejects a domain that would corrupt the certificate subject or the nginx config', () => {
    for (const bad of ['a/b', 'a;b', 'a}b', 'my_host', 'a b']) {
      const { r } = run(bad);
      expect(r.status, bad).toBe(1);
      expect(r.stderr, bad).toContain('invalid characters');
    }
  });

  it.skipIf(!hasOpenssl)('reads the template from a different directory than it writes to', () => {
    // compose mounts a tmpfs over the directory the config is WRITTEN to; the template must survive
    // that, so it is read from somewhere else. Pointing the two at different directories is the
    // closest a test can get to that without Docker.
    const { r } = run('localhost');
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(join(dir, 'out.conf'), 'utf8')).toContain('server_name localhost');
  });
});

describe('the publishing workflow', () => {
  const wf = readFileSync(join(ROOT, '.github/workflows/docker-publish.yml'), 'utf8');
  const jobBlock = (name: string) => {
    const i = wf.indexOf(`\n  ${name}:`);
    const rest = wf.slice(i + 1);
    const next = rest.slice(1).search(/\n  [a-z][\w-]*:\s*\n/);
    return next === -1 ? rest : rest.slice(0, next + 1);
  };

  it('verifies pull requests', () => {
    expect(wf).toMatch(/pull_request:/);
  });

  it('never publishes an image from a pull request', () => {
    const publish = jobBlock('build-and-push');
    expect(publish).toMatch(/if:\s*github\.event_name\s*!=\s*'pull_request'/);
    expect(publish).toMatch(/needs:\s*verify/);
  });

  it('the verify job does not need registry write access', () => {
    expect(jobBlock('verify')).not.toMatch(/packages:\s*write/);
    expect(wf).toMatch(/^permissions:\s*\n\s+contents:\s*read/m);
  });
});

describe('the coverage gate', () => {
  it('holds the 80% statement threshold the suite actually reaches', () => {
    const cfg = readFileSync(join(ROOT, 'vite.config.ts'), 'utf8');
    const get = (k: string) => Number(new RegExp(`${k}:\\s*(\\d+)`).exec(cfg.slice(cfg.indexOf('thresholds')))?.[1]);
    // The suite measures 80.1 statements / 73.5 branches / 82.4 functions / 82.0 lines, so 80/70/75/80
    // is a real gate. Lowering it to just above a thinner measurement would make the gate pass by
    // construction and stop protecting anything — the point is to notice a drop, not to absorb one.
    expect(get('statements')).toBeGreaterThanOrEqual(80);
    expect(get('lines')).toBeGreaterThanOrEqual(80);
    expect(get('branches')).toBeGreaterThanOrEqual(70);
    expect(get('functions')).toBeGreaterThanOrEqual(75);
  });

  it('CI runs the gate', () => {
    expect(readFileSync(join(ROOT, 'package.json'), 'utf8')).toContain('"test:ci": "vitest run --coverage"');
  });
});
