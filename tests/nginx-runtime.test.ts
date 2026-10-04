/**
 * The nginx config, run for real.
 *
 * deploy-artefacts.test.ts reads docker/nginx.conf as text, which cannot tell whether nginx accepts
 * it or how it routes a request. This starts an actual nginx on high ports with the config the
 * entrypoint renders, and makes real HTTPS requests. It skips itself when nginx or openssl is not
 * installed, and CI installs nginx so it runs there.
 *
 * Two defects it was written for: the SPA fallback used $request_uri, which includes the query string,
 * so "/?v=1.5" looked like a request for a file called "5" and got a 404 instead of the app; and the
 * nginx template lived in a directory that compose mounts a tmpfs over.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import https from 'node:https';
import http from 'node:http';

const NGINX = ['/usr/sbin/nginx', '/usr/local/sbin/nginx', '/usr/bin/nginx'].find((p) => spawnSync(p, ['-v']).status === 0);
const hasTools = !!NGINX && spawnSync('openssl', ['version']).status === 0 && spawnSync('perl', ['-v']).status === 0;
const ROOT = resolve(__dirname, '..');

const freePort = () =>
  new Promise<number>((res) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
  });

interface Resp { status: number; headers: http.IncomingHttpHeaders; body: string }
const get = (url: string, headers: Record<string, string> = {}) =>
  new Promise<Resp>((res, rej) => {
    const mod = url.startsWith('https') ? https : http;
    mod
      .get(url, { rejectUnauthorized: false, headers }, (r) => {
        const chunks: Buffer[] = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => res({ status: r.statusCode ?? 0, headers: r.headers, body: Buffer.concat(chunks).toString('utf8') }));
      })
      .on('error', rej);
  });

describe.skipIf(!hasTools)('nginx serving the rendered config', () => {
  let dir: string;
  let httpsPort: number;
  let httpPort: number;
  let proc: ChildProcess;
  const log: string[] = [];

  /** Render docker/nginx.conf through the real entrypoint, then point it at a temp tree. */
  function render(name: string, env: Record<string, string>, https: number, plain: number): string {
    const certs = join(dir, 'certs');
    const bin = join(dir, 'bin');
    mkdirSync(bin, { recursive: true });
    // Stand-in for gettext's envsubst: substitute ${VAR} from the environment.
    writeFileSync(join(bin, 'envsubst'), String.raw`#!/bin/sh
exec perl -pe 's/\$\{(\w+)\}/$ENV{$1}/ge'
`);
    chmodSync(join(bin, 'envsubst'), 0o755);
    const out = join(dir, `${name}.rendered`);
    const r = spawnSync('sh', [join(ROOT, 'docker/entrypoint.sh'), 'true'], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CERT_DIR: certs, CONF_TEMPLATE: join(ROOT, 'docker/nginx.conf'), CONF_OUT: out, ...env },
      encoding: 'utf8',
    });
    expect(r.status, r.stderr).toBe(0);

    const version = /nginx\/(\d+)\.(\d+)\.(\d+)/.exec(spawnSync(NGINX!, ['-v'], { encoding: 'utf8' }).stderr) ?? [];
    const [maj, min, pat] = [Number(version[1]), Number(version[2]), Number(version[3])];
    const hasHttp2Directive = maj > 1 || min > 25 || (min === 25 && pat >= 1);

    let conf = readFileSync(out, 'utf8')
      .replaceAll('/certs/', `${certs}/`)
      .replaceAll('/usr/share/nginx/html', join(dir, 'html'))
      .replaceAll('/etc/nginx/snippets/phomymo-security-headers.conf', join(ROOT, 'docker/security-headers.conf'))
      .replace('listen 443 ssl;', `listen ${https} ssl;`)
      .replace('listen 80;', `listen ${plain};`);
    if (!hasHttp2Directive) conf = conf.replace('http2 on;', '');

    const main = join(dir, `${name}.main.conf`);
    writeFileSync(
      main,
      `worker_processes 1;
pid ${dir}/${name}.pid;
error_log ${dir}/${name}.err.log;
events { worker_connections 64; }
http {
  types { text/html html; text/javascript js; text/css css; application/manifest+json webmanifest; image/png png; }
  access_log off;
  client_body_temp_path ${dir}/tmp; proxy_temp_path ${dir}/tmp; fastcgi_temp_path ${dir}/tmp; uwsgi_temp_path ${dir}/tmp; scgi_temp_path ${dir}/tmp;
${conf}
}
`,
    );
    return main;
  }

  async function start(name: string, env: Record<string, string>) {
    httpsPort = await freePort();
    httpPort = await freePort();
    const main = render(name, env, httpsPort, httpPort);
    const t = spawnSync(NGINX!, ['-t', '-c', main], { encoding: 'utf8' });
    log.push(t.stderr);
    expect(t.status, t.stderr).toBe(0);
    proc = spawn(NGINX!, ['-c', main, '-g', 'daemon off;'], { stdio: 'ignore' });
    for (let i = 0; i < 50; i++) {
      try {
        await get(`https://127.0.0.1:${httpsPort}/`);
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    throw new Error('nginx did not start: ' + readFileSync(join(dir, `${name}.err.log`), 'utf8'));
  }

  const stop = async () => {
    if (!proc) return;
    proc.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 150));
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'phomymo-nginx-'));
    // mkdtemp creates the directory 0700. When the suite runs as root, nginx's workers drop to an
    // unprivileged user and could not read the files — every request would 404 for the wrong reason.
    chmodSync(dir, 0o755);
    mkdirSync(join(dir, 'html/assets'), { recursive: true });
    mkdirSync(join(dir, 'tmp'));
    writeFileSync(join(dir, 'html/index.html'), '<!doctype html><title>APP</title>');
    writeFileSync(join(dir, 'html/assets/app-abc.js'), 'console.log("x");\n'.repeat(200));
    writeFileSync(join(dir, 'html/sw.js'), 'self');
    writeFileSync(join(dir, 'html/manifest.webmanifest'), '{}');
    await start('main', { PHOMYMO_DOMAIN: 'localhost' });
  });

  afterAll(async () => {
    await stop();
    rmSync(dir, { recursive: true, force: true });
  });

  const base = () => `https://127.0.0.1:${httpsPort}`;

  it('accepts the rendered configuration (nginx -t)', () => {
    expect(log.join('\n')).toMatch(/syntax is ok|test is successful/);
  });

  describe('single-page-app fallback', () => {
    for (const path of ['/', '/some/route', '/a.b/c', '/?v=1.5', '/route?x=a.b', '/route?file=photo.png']) {
      it(`serves the app for ${path}`, async () => {
        const r = await get(base() + path);
        expect(r.status).toBe(200);
        expect(r.body).toContain('<title>APP</title>');
      });
    }

    for (const path of ['/favicon.ico', '/missing.js', '/LOGO.PNG', '/deep/dir/file.css']) {
      it(`returns 404, not the app shell, for the missing file ${path}`, async () => {
        const r = await get(base() + path);
        expect(r.status).toBe(404);
        expect(r.body).not.toContain('<title>APP</title>');
      });
    }

    it('a missing hashed asset is a 404', async () => {
      expect((await get(base() + '/assets/missing.js')).status).toBe(404);
    });
  });

  describe('headers', () => {
    it('serves fingerprinted assets as immutable and compressed', async () => {
      const r = await get(base() + '/assets/app-abc.js', { 'accept-encoding': 'gzip' });
      expect(r.status).toBe(200);
      expect(r.headers['cache-control']).toContain('immutable');
      expect(r.headers['content-encoding']).toBe('gzip');
    });

    it('never caches the service worker', async () => {
      expect((await get(base() + '/sw.js')).headers['cache-control']).toBe('no-cache');
    });

    it('sends the security headers on every kind of response, including 404', async () => {
      for (const path of ['/', '/assets/app-abc.js', '/sw.js', '/manifest.webmanifest', '/favicon.ico']) {
        const r = await get(base() + path);
        expect(r.headers['x-content-type-options'], path).toBe('nosniff');
        expect(r.headers['content-security-policy'], path).toContain("frame-ancestors 'none'");
        expect(r.headers['permissions-policy'], path).toContain('usb=(self)');
      }
    });

    it('does not disclose the nginx version', async () => {
      const server = (await get(base() + '/')).headers['server'] ?? '';
      expect(server).not.toMatch(/\d/);
    });
  });

  describe('HTTP to HTTPS redirect', () => {
    it('redirects to the standard port when HTTPS is on 443', async () => {
      const r = await get(`http://127.0.0.1:${httpPort}/x?y=1`);
      expect(r.status).toBe(301);
      expect(r.headers.location).toBe('https://127.0.0.1/x?y=1');
    });

    it('keeps a custom HTTPS port in the redirect', async () => {
      await stop();
      await start('port', { PHOMYMO_DOMAIN: 'localhost', PHOMYMO_HTTPS_PORT: '8444' });
      const r = await get(`http://127.0.0.1:${httpPort}/x`);
      expect(r.status).toBe(301);
      expect(r.headers.location).toBe('https://127.0.0.1:8444/x');
    });
  });
});

describe('the compose file and the Dockerfile agree about tmpfs', () => {
  const compose = readFileSync(join(ROOT, 'compose.yaml'), 'utf8');
  const docker = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');

  it('no file the image copies in lives under a directory compose mounts a tmpfs over', () => {
    // A tmpfs starts empty and hides the image's content at that path, so anything the entrypoint
    // must read there is gone at runtime. This is the check that would have caught the nginx
    // template being COPYed into /etc/nginx/conf.d while compose mounted a tmpfs on it.
    const tmpfsPaths = [...compose.matchAll(/^\s*-\s*(\/[^\s:]+)(?::[^\n]*)?$/gm)]
      .map((m) => m[1])
      .filter((p) => new RegExp(`tmpfs:[\\s\\S]*?-\\s*${p.replaceAll('/', '\\/')}`).test(compose));
    expect(tmpfsPaths.length).toBeGreaterThan(0);

    const copyTargets = [...docker.matchAll(/^COPY\s+(?:--from=\S+\s+)?\S+\s+(\S+)/gm)].map((m) => m[1]);
    for (const target of copyTargets) {
      for (const t of tmpfsPaths) {
        expect(target.startsWith(t + '/') || target === t, `${target} is hidden by the tmpfs on ${t}`).toBe(false);
      }
    }
  });

  it('the entrypoint reads the template from where the Dockerfile puts it', () => {
    const entry = readFileSync(join(ROOT, 'docker/entrypoint.sh'), 'utf8');
    const def = /CONF_TEMPLATE="\$\{CONF_TEMPLATE:-([^}]+)\}"/.exec(entry)?.[1];
    expect(def).toBeDefined();
    expect(docker).toContain(`docker/nginx.conf ${def}`);
  });

  it('gives back exactly the capabilities nginx needs after dropping all', () => {
    expect(compose).toMatch(/cap_drop:\s*\n\s*-\s*ALL/);
    const add = compose.match(/cap_add:\s*\n((?:\s+-\s*\w+\n?)+)/)?.[1] ?? '';
    for (const cap of ['CHOWN', 'SETUID', 'SETGID', 'NET_BIND_SERVICE']) expect(add, cap).toContain(cap);
  });
});
