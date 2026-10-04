/**
 * The remaining transport findings: F-12, F-13, F-14, F-15, F-17, F-18.
 *
 *  F-12  InvalidStateError from writeValueWithoutResponse is the TRANSIENT "link is gone" error,
 *        not a missing capability, so flipping the write mode on it halved throughput for the
 *        rest of the session after every mid-job disconnect.
 *  F-13  waitForResponse resolved on the FIRST notification of any kind, including the frames
 *        the printer pushes unprompted (cover, paper, print status).
 *  F-14  the [BLE Response] trace ignored the DataView's byteOffset/byteLength.
 *  F-15  waitForDeviceReady left its advertisementreceived listener attached on the timeout and
 *        watchAdvertisements paths.
 *  F-17  new Uint8Array(dataView) yields zero bytes, so a DataView produced a silent no-op write.
 *  F-18  cancel had to wait out an in-flight delay — up to 800 ms on the mSeries post-feed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BLETransport } from '../src/transport/ble';
import { runOps } from '../src/core/protocols/ops';

beforeEach(() => vi.spyOn(console, 'log').mockImplementation(() => {}));

/** A transport wired up so send()/waitForResponse() can be exercised directly. */
function connected() {
  const writes: { method: string; bytes: number[] }[] = [];
  const t = new BLETransport();
  t.connected = true;
  t.device = { gatt: { connected: true }, name: 'M221' };
  t.writeChar = {
    properties: { write: true, writeWithoutResponse: true },
    writeValueWithoutResponse: async (b: ArrayBuffer) => void writes.push({ method: 'withoutResponse', bytes: [...new Uint8Array(b)] }),
    writeValue: async (b: ArrayBuffer) => void writes.push({ method: 'withResponse', bytes: [...new Uint8Array(b)] }),
  };
  return { t, writes };
}

/** A characteristic that records its listeners so a test can fire or count them. */
function fakeNotifyChar() {
  const listeners: ((e: any) => void)[] = [];
  const ch: any = {
    live: () => listeners.length,
    addEventListener: (_t: string, fn: (e: any) => void) => { listeners.push(fn); },
    removeEventListener: (_t: string, fn: (e: any) => void) => {
      const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1);
    },
    fire: (bytes: number[]) => {
      const backing = new Uint8Array(16).fill(0xee);
      backing.set(bytes, 4);
      // A window into the middle of the backing buffer, the shape Web Bluetooth produces.
      const view = new DataView(backing.buffer, 4, bytes.length);
      for (const fn of [...listeners]) fn({ target: { value: view } });
    },
    startNotifications: async () => {},
    stopNotifications: async () => {},
  };
  return ch;
}

describe('F-12: a transient link error does not change the write mode', () => {
  it('InvalidStateError does not flip to write-with-response', async () => {
    const { t } = connected();
    t.writeChar.writeValueWithoutResponse = async () => {
      throw new DOMException('gatt gone', 'InvalidStateError');
    };
    await t.send(new Uint8Array([1]));
    expect(t._useWriteWithResponse).toBe(false);
  });

  it('NotSupportedError does flip, and is remembered', async () => {
    const { t } = connected();
    t.writeChar.writeValueWithoutResponse = async () => {
      throw new DOMException('nope', 'NotSupportedError');
    };
    await t.send(new Uint8Array([1]));
    expect(t._useWriteWithResponse).toBe(true);
  });
});

describe('F-13: a wait can require a specific frame', () => {
  it('an unsolicited frame does not satisfy a filtered wait', async () => {
    const { t } = connected();
    const ch = fakeNotifyChar();
    t.notifyChar = ch;

    const isAck = (d: Uint8Array) => d[0] === 0x1a && d[1] === 0x07;   // firmware
    const waiting = t.waitForResponse(1000, isAck);

    // The printer pushes a cover event first — it must NOT resolve the wait.
    ch.fire([0x1a, 0x05, 0x99]);
    // Then the frame we actually asked for.
    ch.fire([0x1a, 0x07, 0x01]);

    const got = (await waiting) as DataView;
    expect(got).not.toBeNull();
    expect(new Uint8Array(got.buffer, got.byteOffset, got.byteLength)).toEqual(new Uint8Array([0x1a, 0x07, 0x01]));
  });

  it('without a predicate, the first frame of any kind resolves it', async () => {
    const { t } = connected();
    const ch = fakeNotifyChar();
    t.notifyChar = ch;
    const waiting = t.waitForResponse(1000);
    ch.fire([0x1a, 0x05, 0x99]);
    expect(await waiting).not.toBeNull();
  });

  it('a filtered wait that never matches times out to null', async () => {
    const { t } = connected();
    const ch = fakeNotifyChar();
    t.notifyChar = ch;
    const waiting = t.waitForResponse(20, (d) => d[0] === 0xff);
    ch.fire([0x1a, 0x05, 0x99]);
    expect(await waiting).toBeNull();
    expect(ch.live()).toBe(0);   // listener removed on timeout
  });
});

describe('F-14: the response trace honours the DataView window', () => {
  it('does not read past byteLength', async () => {
    const { t } = connected();
    const ch = fakeNotifyChar();
    t.notifyChar = ch;
    const seen: number[][] = [];
    t.onPrinterInfo = () => {};

    const waiting = t.waitForResponse(50, (d) => { seen.push([...d]); return true; });
    ch.fire([0x1a, 0x07, 0x02]);
    await waiting;

    // Exactly three bytes, not the 16-byte backing buffer.
    expect(seen[0]).toEqual([0x1a, 0x07, 0x02]);
  });
});

describe('F-15: waitForDeviceReady cleans up its listener', () => {
  it.each(['timeout', 'watch-fails'] as const)('removes it on the %s path', async (path) => {
    const listeners: Record<string, (() => void)[]> = {};
    const dev: any = {
      addEventListener: (ty: string, fn: () => void) => { (listeners[ty] ??= []).push(fn); },
      removeEventListener: (ty: string, fn: () => void) => {
        const a = listeners[ty] ?? []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1);
      },
      watchAdvertisements: async () => { if (path === 'watch-fails') throw new Error('nope'); },
    };
    const t = new BLETransport();
    t.device = dev;
    await t.waitForDeviceReady(20);
    expect((listeners['advertisementreceived'] ?? []).length).toBe(0);
  });

  it('removes it when the advertisement arrives', async () => {
    const listeners: Record<string, (() => void)[]> = {};
    const dev: any = {
      addEventListener: (ty: string, fn: () => void) => { (listeners[ty] ??= []).push(fn); },
      removeEventListener: (ty: string, fn: () => void) => {
        const a = listeners[ty] ?? []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1);
      },
      watchAdvertisements: () => new Promise(() => {}),   // never settles
    };
    const t = new BLETransport();
    t.device = dev;
    const waiting = t.waitForDeviceReady(5000);
    for (const fn of [...(listeners['advertisementreceived'] ?? [])]) fn();
    await waiting;
    expect((listeners['advertisementreceived'] ?? []).length).toBe(0);
  });
});

describe('F-17: a DataView is not silently zero bytes', () => {
  it('sends the DataView window rather than nothing', async () => {
    const { t, writes } = connected();
    const backing = new Uint8Array(8).fill(0xee);
    backing.set([1, 2, 3], 2);
    const view = new DataView(backing.buffer, 2, 3);
    await t.send(view);
    expect(writes[0].bytes).toEqual([1, 2, 3]);
  });

  it('refuses an empty buffer instead of writing nothing', async () => {
    const { t, writes } = connected();
    await expect(t.send(new Uint8Array(0))).rejects.toThrow(/empty/i);
    expect(writes).toHaveLength(0);
  });

  it('rejects an object that is neither bytes nor array-like', async () => {
    const { t } = connected();
    await expect(t.send({ nope: true } as never)).rejects.toThrow(/expects/i);
  });
});

describe('F-18: a cancel does not wait out an in-flight delay', () => {
  it('aborts during an 800ms post-feed immediately', async () => {
    const log: string[] = [];
    const t = {
      send: async () => { log.push('send'); },
      delay: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    };
    const controller = new AbortController();
    const started = Date.now();
    const running = runOps(t, [{ t: 'delay', ms: 800 }], { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - started).toBeLessThan(400);   // not 800
  });

  it('still delays fully when nothing aborts', async () => {
    const log: string[] = [];
    const t = {
      send: async () => { log.push('send'); },
      delay: async (ms: number) => { log.push(`delay:${ms}`); },
    };
    await runOps(t, [{ t: 'send', data: new Uint8Array([1]) }, { t: 'delay', ms: 5 }, { t: 'send', data: new Uint8Array([2]) }]);
    expect(log).toEqual(['send', 'delay:5', 'send']);
  });

  it('an already-aborted signal rejects before any op runs', async () => {
    const log: string[] = [];
    const t = { send: async () => { log.push('send'); }, delay: async () => {} };
    const controller = new AbortController();
    controller.abort();
    await expect(runOps(t, [{ t: 'send', data: new Uint8Array([1]) }], { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(log).toEqual([]);
  });
});