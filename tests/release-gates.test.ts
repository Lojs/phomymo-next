/**
 * The publishing workflow must not be able to ship untested code.
 *
 * This is a test about a YAML file, which is unusual, and it is here because the failure it guards
 * against is silent and expensive: the image is a published artefact that the Pi pulls
 * automatically, so a green "Build and publish" run with a red test run means a broken release
 * reached a live printer while CI looked half-green.
 *
 * It parses the workflow as text rather than as YAML on purpose — there is no YAML parser in the
 * dependency tree, and the assertions only need to know which jobs exist and what they depend on.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const WORKFLOWS = '.github/workflows';
const files = existsSync(WORKFLOWS) ? readdirSync(WORKFLOWS).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml')) : [];
const publish = files.find((f) => /publish/i.test(f));

const read = (f: string) => readFileSync(join(WORKFLOWS, f), 'utf8');

describe('the publishing workflow', () => {
  it('exists', () => {
    expect(publish).toBeDefined();
  });

  it('has a job that runs the tests', () => {
    const src = read(publish!);
    expect(src).toMatch(/run:\s*npm run test:ci/);
    expect(src).toMatch(/run:\s*npm run typecheck/);
  });

  it('makes the publish job depend on that job', () => {
    // The whole point. A separate workflow cannot gate this one: both run on the same push,
    // independently, so a failing test never stopped the image being pushed.
    const src = read(publish!);
    expect(src).toMatch(/needs:\s*verify/);
  });

  it('puts the verification job before the publish job', () => {
    // `needs` referencing a job defined later in the file is valid YAML but reads as broken, and
    // anyone editing this file later needs the order to make sense.
    const src = read(publish!);
    expect(src.indexOf('verify:')).toBeGreaterThan(-1);
    expect(src.indexOf('verify:')).toBeLessThan(src.indexOf('build-and-push:'));
  });

  it('still pushes on both a branch push and a tag', () => {
    const src = read(publish!);
    expect(src).toMatch(/branches:\s*\["main"\]/);
    expect(src).toMatch(/tags:\s*\["v\*\.\*\.\*"\]/);
    expect(src).toMatch(/push:\s*true/);
  });
});

describe('the Dockerfile', () => {
  const dockerfile = readFileSync('Dockerfile', 'utf8');

  it('builds on the native platform, so arm64 does not run the Node build under QEMU', () => {
    // An npm install plus a Vite build under emulation is roughly an order of magnitude slower, and
    // the build output is plain JS/CSS that is identical whichever machine produced it.
    expect(dockerfile).toMatch(/FROM --platform=\$BUILDPLATFORM/);
  });

  it('has a healthcheck, so a wedged container is distinguishable from a healthy one', () => {
    expect(dockerfile).toMatch(/HEALTHCHECK/);
  });

  it('documents only the port that is actually published', () => {
    // 80 exists solely to redirect to HTTPS, and the compose file maps a single port.
    expect(dockerfile).not.toMatch(/EXPOSE 80\b/);
    expect(dockerfile).toMatch(/EXPOSE 443/);
  });

  it('installs curl, which the healthcheck uses', () => {
    expect(dockerfile).toMatch(/apk add[^\n]*curl/);
  });
});

describe('package.json', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

  it('pins the Node version it is developed against', () => {
    // CI runs Node 24 and the local toolchain is 24; without this a contributor or a CI change can
    // drift onto a version the code was never tested on.
    expect(pkg.engines?.node).toBeTruthy();
  });
});
