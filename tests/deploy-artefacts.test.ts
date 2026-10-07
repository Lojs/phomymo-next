/**
 * The deployable artefacts: nginx, the manifest, the service worker and the icons.
 *
 * These are not exercised by any component test — they are files nginx and the browser read — so
 * nothing else would notice if one of them silently stopped being right. Each assertion here
 * corresponds to a specific defect: a JS bundle served uncompressed because the gzip type list was
 * missing text/javascript, a manifest that made Android refuse the app as installable because the
 * only icon was an inline SVG, or a redirect that dropped the port the user had typed.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { PNG } from 'pngjs';

const read = (p: string) => readFileSync(p, 'utf8');

describe('nginx', () => {
  const conf = read('docker/nginx.conf');
  const headers = read('docker/security-headers.conf');

  it('compresses JavaScript', () => {
    // nginx receives text/javascript for a Vite bundle; without it in gzip_types the ~450KB main
    // bundle went out uncompressed.
    expect(conf).toMatch(/gzip on/);
    expect(conf).toMatch(/gzip_types[^;]*text\/javascript/);
    expect(conf).toMatch(/gzip_min_length/);
  });

  it('keeps the port on the HTTP to HTTPS redirect', () => {
    // $host has no port, so http://ip:8444 redirected to https://ip/ where nothing listens. The port
    // comes from PHOMYMO_REDIRECT_PORT, which the entrypoint derives from PHOMYMO_HTTPS_PORT.
    const redirect = conf.match(/return 30\d https:\/\/[^;]+;/)?.[0] ?? '';
    expect(redirect).toContain('${PHOMYMO_REDIRECT_PORT}');
    expect(redirect).not.toContain('$server_port');   // that is the LISTENING port (80), not the target
  });

  it('sends the security headers', () => {
    for (const h of [
      'X-Content-Type-Options',
      'X-Frame-Options',
      'Referrer-Policy',
      'Permissions-Policy',
      'Content-Security-Policy',
    ]) {
      expect(headers).toContain(h);
    }
  });

  it('allows WebUSB and WebBluetooth, which the app cannot print without', () => {
    expect(headers).toMatch(/usb=\(self\)/);
    expect(headers).toMatch(/bluetooth=\(self\)/);
  });

  it('allows wasm, which the PDF and QR encoders need', () => {
    expect(headers).toMatch(/script-src[^;]*wasm-unsafe-eval/);
  });

  it('does not allow unsafe script', () => {
    expect(headers).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(headers).not.toMatch(/script-src[^;]*'unsafe-eval'/);
  });

  it('includes the headers in every location block', () => {
    // nginx's add_header does not inherit into a location that defines its own, so a server-level
    // copy alone would leave /assets/ and / with no headers at all.
    const locations = [...conf.matchAll(/location\s+[^{]+\{\n/g)].length;
    const includes = [...conf.matchAll(/include \/etc\/nginx\/snippets\/phomymo-security-headers\.conf;/g)].length;
    expect(locations).toBeGreaterThan(0);
    expect(includes).toBeGreaterThanOrEqual(locations);
  });

  it('never caches the service worker', () => {
    expect(conf).toMatch(/location = \/sw\.js[\s\S]*?no-cache/);
  });

  it('caches fingerprinted assets forever', () => {
    expect(conf).toMatch(/location \/assets\/[\s\S]*?immutable/);
  });
});

describe('the web manifest', () => {
  const manifest = JSON.parse(read('public/manifest.webmanifest'));

  it('declares the 192 and 512 PNGs Android requires to be installable', () => {
    const pngs = manifest.icons.filter((i: { type: string }) => i.type === 'image/png');
    const sizes = pngs.map((i: { sizes: string }) => i.sizes);
    expect(sizes).toContain('192x192');
    expect(sizes).toContain('512x512');
  });

  it('points every icon at a file that exists', () => {
    for (const icon of manifest.icons) {
      const path = `public${icon.src}`;
      expect(existsSync(path), `${icon.src} missing`).toBe(true);
      expect(statSync(path).size).toBeGreaterThan(0);
    }
  });

  it('has no inline data: icon, which is what made it uninstallable', () => {
    for (const icon of manifest.icons) expect(icon.src.startsWith('data:')).toBe(false);
  });

  it('offers a maskable icon for adaptive launchers', () => {
    expect(manifest.icons.some((i: { purpose?: string }) => i.purpose === 'maskable')).toBe(true);
  });

  it('sets a theme colour and a scope', () => {
    expect(manifest.theme_color).toBeTruthy();
    expect(manifest.scope).toBeTruthy();
  });
});

describe('the icons', () => {
  it.each(['icon-192.png', 'icon-512.png'])('%s is a real PNG', (name) => {
    const buf = readFileSync(`public/icons/${name}`);
    expect(buf.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    // IHDR carries the dimensions at bytes 16..24.
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    const want = Number(name.match(/(\d+)/)![1]);
    expect(width).toBe(want);
    expect(height).toBe(want);
  });
});

describe('the service worker', () => {
  const sw = read('public/sw.js');

  it('caches the shell so the app opens offline', () => {
    expect(sw).toMatch(/addEventListener\('install'/);
    expect(sw).toContain('/index.html');
  });

  it('caches fingerprinted assets cache-first, since their name fixes their content', () => {
    expect(sw).toMatch(/isImmutableAsset/);
    expect(sw).toMatch(/cache\.match\(request\)/);
  });

  it('prefers the network for the shell, so a deploy is picked up', () => {
    expect(sw).toMatch(/request\.mode === 'navigate'/);
    expect(sw).toMatch(/fetch\(request\)/);
  });

  it('never caches user data', () => {
    // Designs live in localStorage. Mirroring them into Cache Storage would duplicate them and risk
    // serving a stale label, which is the one thing this app must never print.
    for (const key of ['phomymo_designs', 'phomymo_settings', 'phomymo_autosave']) {
      expect(sw).not.toContain(key);
    }
  });

  it('drops caches from a previous version', () => {
    expect(sw).toMatch(/caches\.delete/);
  });

  it('ignores non-GET and cross-origin requests', () => {
    expect(sw).toMatch(/request\.method !== 'GET'/);
    expect(sw).toMatch(/url\.origin !== self\.location\.origin/);
  });

  it('takes its identity from the build rather than a hand-written constant', () => {
    // This is what makes a new worker install: a browser compares the bytes of this file, and it
    // used to be copied verbatim, so two releases shipped an identical worker and no update was
    // ever taken. It was then a literal a human had to remember to bump. It is stamped per build by
    // the plugin in vite.config.ts; tests/service-worker-stamp.test.ts runs two real builds and
    // proves the bytes differ, which this source-text assertion cannot.
    //
    // It is deliberately NOT part of the cache names any more — see the test below.
    expect(sw).toMatch(/const BUILD_ID = '__PHOMYMO_BUILD_ID__'/);
  });

  it('keeps the cache names independent of the build id', () => {
    // The names used to embed the stamp, so activate discarded every cache on every release: the
    // trim had nothing to do, and chunks that had not changed — pdf.js's worker, jsPDF,
    // html2canvas — were re-downloaded each time, in an app meant to work offline.
    expect(sw).toMatch(/const CACHE_VERSION = '/);
    expect(sw).toMatch(/\$\{CACHE_PREFIX\}-\$\{CACHE_VERSION\}-shell/);
    expect(sw).not.toMatch(/\$\{BUILD_ID\}-/);
  });

  it('trims the asset cache instead of letting it grow forever', () => {
    // Hashed filenames change every release, so orphaned entries *inside* the cache accumulate: one
    // dead chunk per deploy, kept indefinitely. The cache names are stable now, which makes this the
    // only thing that removes them — before, activate discarded the whole cache per release and the
    // trim was dead code.
    expect(sw).toMatch(/trimAssets/);
    expect(sw).toMatch(/cache\.keys\(\)/);
    expect(sw).toMatch(/cache\.delete\(/);
    // The trim has to run on activate, not only on install, or a returning client keeps the cache.
    expect(sw).toMatch(/activate[\s\S]*?trimAssets/);
  });

  it('awaits its cache writes instead of firing them off', () => {
    // A floating caches.open().then(put) is a promise the worker knows nothing about: when the
    // response resolves the worker can be terminated mid-write, losing the entry with no error.
    // Only the install-time cache.addAll is allowed to float, and that one is already inside
    // event.waitUntil(). Every runtime write must be awaited inside the respondWith chain.
    const floating = sw.match(/caches\.open\([^)]*\)\.then\([^)]*=>\s*cache\.put/);
    expect(floating, 'a cache write is not awaited').toBeNull();
    expect(sw).toMatch(/await cache\.put\(/);
  });
});

describe('the icon set', () => {
  const manifest = JSON.parse(read('public/manifest.webmanifest'));

  it('ships a distinct maskable icon, not the "any" one reused', () => {
    // Android crops a maskable icon to its own shape, up to 10% from each edge. Pointing it at the
    // ordinary icon meant the artwork was cropped to the launcher mask with no safe zone.
    const maskable = manifest.icons.find((i: { purpose?: string }) => i.purpose === 'maskable');
    const any512 = manifest.icons.find((i: { purpose?: string; sizes: string }) =>
      i.purpose === 'any' && i.sizes === '512x512');
    expect(maskable.src).not.toBe(any512.src);
    expect(existsSync(`public${maskable.src}`)).toBe(true);
  });

  it('gives the maskable icon a safe zone: artwork inset, background at every edge', () => {
    // The maskable icon is generated by scripts/make-icons.mjs at 80% of the canvas on the
    // manifest's background colour. If the border pixels are not the background, the artwork still
    // runs to the edge and the launcher will cut into it.
    // Decoded, not read from raw bytes: the IDAT stream is zlib-compressed, so a byte offset into
    // the file does not address a pixel. (It also runs past the buffer end for the far corner.)
    const png = PNG.sync.read(readFileSync('public/icons/icon-maskable-512.png'));
    const at = (x: number, y: number) => {
      const i = (y * png.width + x) * 4;
      return [png.data[i], png.data[i + 1], png.data[i + 2]];
    };
    const bg = at(2, 2);
    expect(at(0, 0)).toEqual(bg);
    expect(at(png.width - 1, png.height - 1)).toEqual(bg);
    expect(at(png.width - 1, 0)).toEqual(bg);
    // The centre is artwork, not background — a solid fill would satisfy the checks above.
    expect(at(png.width >> 1, png.height >> 1)).not.toEqual(bg);
  });

  it('gives iOS the 180 px icon it asks for', () => {
    // iOS reads apple-touch-icon at 180x180; a 192 px file is scaled by the OS and looks soft.
    const html = read('index.html');
    const href = html.match(/rel="apple-touch-icon" href="([^"]+)"/)![1];
    const buf = readFileSync(`public${href}`);
    expect(buf.readUInt32BE(16)).toBe(180);
    expect(buf.readUInt32BE(20)).toBe(180);
  });

  it('keeps the ordinary icons untouched, since launchers still use them', () => {
    for (const name of ['icon-192.png', 'icon-512.png']) {
      expect(existsSync(`public/icons/${name}`)).toBe(true);
    }
  });
});

describe('registration', () => {
  it('registers only in a production build', () => {
    // A service worker in dev caches the very files you are editing.
    const main = read('src/main.tsx');
    expect(main).toMatch(/serviceWorker/);
    expect(main).toMatch(/import\.meta\.env\.PROD/);
  });

  it('never lets a failed registration break the app', () => {
    expect(read('src/main.tsx')).toMatch(/\.register\('\/sw\.js'\)\.catch/);
  });
});

describe('index.html', () => {
  const html = read('index.html');

  it('links the PNG apple-touch icon and a real favicon file', () => {
    // The apple-touch icon is its own 180 px file (see "the icon set"); it used to point at
    // icon-192.png, which iOS scales down and renders soft.
    expect(html).toMatch(/rel="apple-touch-icon" href="\/icons\/apple-touch-icon\.png"/);
    expect(html).toMatch(/rel="icon" href="\/icon\.svg"/);
    expect(html).not.toMatch(/rel="icon" href="data:/);
  });

  it('declares a theme colour matching the manifest', () => {
    const m = JSON.parse(read('public/manifest.webmanifest'));
    expect(html).toContain(`content="${m.theme_color}"`);
  });
});

describe('compose', () => {
  const compose = read('compose.yaml');

  it('carries both an image and a build context, so up and up --build both work', () => {
    expect(compose).toMatch(/image:/);
    expect(compose).toMatch(/build: \./);
  });

  it('treats .env as optional, so a fresh clone starts', () => {
    expect(compose).toMatch(/required: false/);
  });

  it('drops the unused named volume', () => {
    // The service mounts ./phomymo-certs directly, so a top-level `volumes:` entry described a
    // volume nothing used.
    expect(compose).not.toMatch(/^volumes:/m);
  });
});

describe('the certificate entrypoint', () => {
  const ep = read('docker/entrypoint.sh');

  it('regenerates when the domain changes, not only when a file is missing', () => {
    expect(ep).toMatch(/MARKER=/);
    expect(ep).toMatch(/changed to/);
  });

  it('puts an IP address under IP:, not DNS:', () => {
    // Chromium ignores a DNS: entry for an IP literal, so a certificate for 192.168.x.x written as
    // DNS: reports a name mismatch on every device.
    expect(ep).toMatch(/IP:\$DOMAIN/);
    expect(ep).not.toMatch(/subjectAltName=DNS:\$DOMAIN/);
  });

  it('renews before the certificate expires', () => {
    expect(ep).toMatch(/checkend/);
    expect(ep).toMatch(/RENEW_BEFORE_SECONDS/);
  });

  it('never touches a certificate the user supplied', () => {
    // The fingerprint is what distinguishes ours from theirs: checking only that the files exist
    // cannot tell them apart, and regenerating over a real certificate breaks a working setup.
    expect(ep).toMatch(/fingerprint -sha256/);
    expect(ep).toMatch(/is_ours/);
  });

  it('validates PHOMYMO_HTTPS_PORT rather than writing a broken config', () => {
    expect(ep).toMatch(/PHOMYMO_HTTPS_PORT must be a number/);
    expect(ep).toMatch(/PHOMYMO_REDIRECT_PORT/);
  });
});

describe('the release gates CI applies', () => {
  const workflow = read('.github/workflows/docker-publish.yml');

  it('fails on a runtime advisory and only reports a dev-only one', () => {
    // M5: nothing asserted this line, so weakening it to --audit-level=critical left the suite green.
    // A runtime advisory is a release blocker; one that reaches only the test tooling is not, and
    // `npm audit` mixed the two until they were split.
    expect(workflow).toMatch(/npm audit --omit=dev --audit-level=high/);
  });

  it('keeps the full audit informational rather than fatal', () => {
    // It exists to print what --omit=dev ignores, not to block a release over a build-only package.
    // Looked at as a step rather than by searching the whole file, so an unrelated continue-on-error
    // somewhere else cannot satisfy this.
    const bare = workflow.lastIndexOf('run: npm audit');
    expect(bare).toBeGreaterThan(-1);
    const step = workflow.slice(workflow.lastIndexOf('- name:', bare), bare);
    expect(step).toContain('continue-on-error: true');
  });

  it('the lockfile agrees with package.json about the version', () => {
    // M6: the lockfile's own version field drifted — it said 1.0.24 while package.json said 1.0.25 —
    // because bumping the version does not rewrite it. Harmless to `npm ci`, and confusing to anyone
    // who reads the lockfile to find out what is pinned. A bump is a one-line edit; this keeps it one.
    const pkg = JSON.parse(read('package.json')) as { version: string };
    const lock = JSON.parse(read('package-lock.json')) as {
      version: string;
      packages: Record<string, { version?: string }>;
    };
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages['']?.version).toBe(pkg.version);
  });
});

