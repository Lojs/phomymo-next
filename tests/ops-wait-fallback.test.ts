/**
 * runOps' interruptible waits.
 *
 * `sleep()` — the fallback for a transport with no waitForResponse — and `race()`'s
 * already-aborted short-circuit were uncovered. Both are reachable: every protocol whose
 * transport lacks notifications falls into the sleep path on each `wait` op.
 */
import { describe, it, expect } from 'vitest';
import { runOps, type Transport } from '../src/core/protocols/ops';

/** A transport with no waitForResponse, so `wait` ops take the sleep fallback. */
const bareTransport: Transport = {
  send: async () => {},
  delay: async () => {},
};

describe("runOps' wait fallback", () => {
  it('a wait op on a transport without notifications completes', async () => {
    // ~100 ms of real sleep; long enough to prove the path runs, short enough for a test.
    await expect(runOps(bareTransport, [{ t: 'wait', ms: 5 }])).resolves.toBeUndefined();
  });

  it('that fallback is interruptible', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const running = runOps(bareTransport, [{ t: 'wait', ms: 5000 }], { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('an already-aborted signal short-circuits the fallback immediately', async () => {
    const controller = new AbortController();
    controller.abort();
    const started = Date.now();
    await expect(runOps(bareTransport, [{ t: 'wait', ms: 5000 }], { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    // The 5 s sleep never started, so this returns at once rather than after the race loses.
    expect(Date.now() - started).toBeLessThan(200);
  });

  it('an already-aborted signal short-circuits a delay too', async () => {
    const controller = new AbortController();
    controller.abort();
    const started = Date.now();
    await expect(runOps(bareTransport, [{ t: 'delay', ms: 5000 }], { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - started).toBeLessThan(200);
  });
});

describe('a transport that does have waitForResponse', () => {
  // F7 removed the `expect` predicate: no caller passed one, so the handshake filter it was meant
  // to provide never existed in practice. What must survive is the timeout and the cancel signal.
  it('forwards the timeout and the signal', async () => {
    const seen: { ms: number; signal?: AbortSignal }[] = [];
    const t: Transport = {
      send: async () => {},
      delay: async () => {},
      waitForResponse: async (ms, signal) => { seen.push({ ms, signal }); return null; },
    };
    const controller = new AbortController();
    await runOps(t, [{ t: 'wait', ms: 250 }], { signal: controller.signal });
    expect(seen).toHaveLength(1);
    expect(seen[0].ms).toBe(250);
    expect(seen[0].signal).toBe(controller.signal);
  });
});