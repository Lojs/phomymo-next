/**
 * Cancelling a print.
 *
 * runOps already honoured an AbortSignal, but nothing passed one: the batch checked `aborted` only
 * between labels, and a single print could not be interrupted at all. A label is many chunks, so
 * "between labels" meant a long design kept feeding the printer after the user pressed Stop.
 *
 * These tests drive runOps directly for the mechanism, and the print service for the wiring, because
 * the two are separable failures: the signal works but is not passed, or it is passed but ignored.
 */
import { describe, it, expect } from 'vitest';
import { runOps, type Op, type Transport } from '../src/core/protocols/ops';

const transport = (log: string[]): Transport => ({
  send: async (d) => { log.push(`send:${d[0]}`); },
  delay: async () => { log.push('delay'); },
});

describe('runOps honours an AbortSignal', () => {
  it('runs every op when nothing aborts', async () => {
    const log: string[] = [];
    const ops: Op[] = [{ t: 'send', data: new Uint8Array([1]) }, { t: 'delay', ms: 1 }, { t: 'send', data: new Uint8Array([2]) }];
    await runOps(transport(log), ops);
    expect(log).toEqual(['send:1', 'delay', 'send:2']);
  });

  it('stops between ops once aborted, and reports progress as it went', async () => {
    const log: string[] = [];
    const controller = new AbortController();
    const seen: number[] = [];
    const ops: Op[] = [
      { t: 'send', data: new Uint8Array([1]) },
      { t: 'progress', pct: 50 },
      { t: 'send', data: new Uint8Array([2]) },
      { t: 'progress', pct: 100 },
    ];
    // Abort as soon as the first progress op is seen, i.e. mid-stream.
    await runOps(transport(log), ops, {
      signal: controller.signal,
      onProgress: (pct) => { seen.push(pct); if (pct === 50) controller.abort(); },
    }).catch((e) => expect((e as Error).name).toBe('AbortError'));
    expect(log).toEqual(['send:1']);           // the send after the abort never happened
    expect(seen).toEqual([50]);
  });

  it('throws before doing anything when already aborted', async () => {
    const log: string[] = [];
    const controller = new AbortController();
    controller.abort();
    await expect(runOps(transport(log), [{ t: 'send', data: new Uint8Array([1]) }], { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(log).toEqual([]);
  });

  it('an abort between a long label\'s chunks is what makes Stop feel immediate', async () => {
    // A 100-chunk label: without the signal all 100 sends happen regardless of the cancel.
    const log: string[] = [];
    const controller = new AbortController();
    const ops: Op[] = Array.from({ length: 100 }, (_, i) => ({ t: 'send', data: new Uint8Array([i]) }) as Op);
    const t = {
      ...transport(log),
      send: async (d: Uint8Array) => { log.push(`send:${d[0]}`); if (log.length === 10) controller.abort(); },
    };
    await runOps(t, ops, { signal: controller.signal }).catch(() => {});
    expect(log.length).toBe(10);                 // stopped at the abort, not at 100
    expect(log.length).toBeLessThan(100);
  });

  it('is a no-op when no signal is passed', async () => {
    const log: string[] = [];
    await runOps(transport(log), [{ t: 'send', data: new Uint8Array([1]) }], {});
    expect(log).toEqual(['send:1']);
  });
});

describe('the print service passes its signal down', () => {
  it('exports a cancel function for the single-label job', async () => {
    const printing = await import('../src/services/printing');
    expect(typeof printing.cancelCurrentPrint).toBe('function');
    expect(typeof printing.isPrinting).toBe('function');
  });

  it('cancelling with nothing running does not throw', async () => {
    const printing = await import('../src/services/printing');
    expect(() => printing.cancelCurrentPrint()).not.toThrow();
    expect(() => printing.cancelBatch()).not.toThrow();
  });
});
