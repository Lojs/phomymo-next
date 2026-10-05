/**
 * runOps must not accumulate abort listeners, from a review of v1.0.12.
 *
 * Each delay registered a `{ once: true }` abort listener that was only removed if the signal
 * actually fired. `{ once: true }` means "remove after one fire", not "remove after the promise
 * settles" — so a job that ran to completion kept one listener per op attached to a signal that
 * outlives the whole job. After 200 delay ops the signal carried 200 listeners.
 *
 * The transport's own delay() already cleaned up after itself; it was runOps' race() that did not.
 */
import { describe, it, expect } from 'vitest';
import { runOps, type Op, type Transport } from '../src/core/protocols/ops';

/** A transport whose delay() ignores the signal, which is what makes runOps wrap it in race(). */
const passiveTransport: Transport = {
  send: async () => {},
  delay: () => new Promise<void>((r) => setTimeout(r, 0)),
  waitForResponse: async () => null,
};

const delays = (n: number): Op[] => Array.from({ length: n }, () => ({ t: 'delay', ms: 0 }) as Op);

describe('runOps does not accumulate abort listeners', () => {
  it('takes back every listener it adds once the ops settle', async () => {
    const controller = new AbortController();
    const signal = controller.signal;
    let added = 0;
    let removed = 0;
    const realAdd = signal.addEventListener.bind(signal);
    const realRemove = signal.removeEventListener.bind(signal);
    signal.addEventListener = ((...a: Parameters<typeof realAdd>) => { added++; return realAdd(...a); }) as typeof signal.addEventListener;
    signal.removeEventListener = ((...a: Parameters<typeof realRemove>) => { removed++; return realRemove(...a); }) as typeof signal.removeEventListener;

    // 200 delay ops, none cancelled — the signal is never aborted, which is exactly the case
    // `{ once: true }` fails to clean up.
    await runOps(passiveTransport, delays(200), { signal });

    expect(added).toBeGreaterThan(0);
    expect(added).toBe(removed);
  });

  it('a job that runs 200 delays does not trip the 10-listener warning', async () => {
    const warnings: string[] = [];
    const onWarn = (w: unknown) => warnings.push(String((w as Error)?.message ?? w));
    process.on('warning', onWarn);
    try {
      await runOps(passiveTransport, delays(200), { signal: new AbortController().signal });
    } finally {
      process.off('warning', onWarn);
    }
    expect(warnings.filter((w) => w.includes('MaxListeners'))).toHaveLength(0);
  });

  it('a cancel still takes effect immediately, not after the delay elapses', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const p = runOps(passiveTransport, [{ t: 'delay', ms: 30_000 } as Op], { signal: controller.signal });
    controller.abort();
    await expect(p).rejects.toThrow(/cancel/i);
    // The whole point of racing the signal: Stop must not wait 30 seconds.
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('an already-aborted signal rejects before any op runs', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(runOps(passiveTransport, delays(3), { signal: controller.signal }))
      .rejects.toThrow(/cancel/i);
  });
});
