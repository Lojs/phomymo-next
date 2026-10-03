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
    // $host has no port, so http://ip:8444 redirected to https://ip/ where nothing listens.
    const redirect = conf.match(/return 30\d https:\/\/[^;]+;/)?.[0] ?? '';
    expect(redirect).toContain('$server_port');
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
    expect(sw).toMatch(/caches\.match\(request\)/);
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
    expect(html).toMatch(/rel="apple-touch-icon" href="\/icons\/icon-192\.png"/);
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
    expect(ep).toMatch(/DOMAIN_FILE/);
    expect(ep).toMatch(/changed to/);
  });

  it('warns before the certificate expires', () => {
    expect(ep).toMatch(/checkend/);
    expect(ep).toMatch(/expire/i);
  });

  it('adopts a pre-existing certificate rather than replacing one the user supplied', () => {
    expect(ep).toMatch(/earlier version/);
  });
});
