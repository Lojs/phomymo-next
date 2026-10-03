/**
 * BLETransport — notification decoding and connection bookkeeping.
 *
 * This is the layer that talks to the printer directly, and it was the largest untested file in
 * the tree. Two things are covered here:
 *
 *  1. Response decoding. Every byte the printer sends is turned into a user-visible value, so a
 *     wrong mapping shows the user the wrong thing. The cover bit is checked against the
 *     independent M02-family protocol references (sgrankin/phomemo, PassionateBytes/phomemo),
 *     which both agree on 0x98 = closed / 0x99 = open.
 *  2. Connection state. isConnected() gates every send, and the write fallback / chunking logic
 *     must not silently drop bytes.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BLETransport } from '../src/transport/ble';

/** Build the event object Web Bluetooth hands to a characteristicvaluechanged listener. */
function notify(...bytes: number[]) {
  const value = new DataView(Uint8Array.from(bytes).buffer);
  return { target: { value } } as unknown as Event;
}

/** Capture what handleNotification reports for a given wire message. */
function decode(transport: BLETransport, ...bytes: number[]) {
  const seen: { field: string; value: unknown }[] = [];
  transport.onPrinterInfo = (field: string, value: unknown) => seen.push({ field, value });
  transport.handleNotification(notify(...bytes));
  return seen;
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('notification decoding', () => {
  it('ignores frames too short to carry a type and value', () => {
    const t = new BLETransport();
    expect(decode(t, 0x1a)).toEqual([]);
    expect(decode(t, 0x1a, 0x04)).toEqual([]);
  });

  it('ignores frames that do not start with the 0x1A message marker', () => {
    const t = new BLETransport();
    expect(decode(t, 0x00, 0x04, 0x50)).toEqual([]);
    expect(decode(t, 0xff, 0x04, 0x50)).toEqual([]);
  });

  it('ignores unknown sub-types instead of reporting a bogus field', () => {
    const t = new BLETransport();
    expect(decode(t, 0x1a, 0x99, 0x01)).toEqual([]);
  });

  it('swallows the 2-byte result and 3-byte printer-type frames', () => {
    const t = new BLETransport();
    expect(decode(t, 0x01, 0x07)).toEqual([]);
    expect(decode(t, 0x02, 0xf4, 0x00)).toEqual([]);
  });

  it('decodes battery percentage', () => {
    const t = new BLETransport();
    expect(decode(t, 0x1a, 0x04, 0x41)).toEqual([{ field: 'battery', value: 65 }]);
    expect(t.getPrinterInfo().battery).toBe(65);
  });

  it('decodes the battery sentinel values', () => {
    const t = new BLETransport();
    expect(decode(t, 0x1a, 0x04, 0xa4)[0].value).toBe(0);
    expect(decode(t, 0x1a, 0x04, 0xa3)[0].value).toBe(3);
    expect(decode(t, 0x1a, 0x04, 0xa2)[0].value).toBe(5);
    expect(decode(t, 0x1a, 0x04, 0xa1)[0].value).toBe(10);
  });

  it('decodes paper state (0x88 = out)', () => {
    const t = new BLETransport();
    expect(decode(t, 0x1a, 0x06, 0x88)).toEqual([{ field: 'paper', value: 'out' }]);
    expect(decode(t, 0x1a, 0x06, 0x89)).toEqual([{ field: 'paper', value: 'ok' }]);
  });

  it('decodes cover state (0x98 = closed, 0x99 = open)', () => {
    // Cross-checked against two independent M02-family protocol references. The legacy app had
    // these two swapped, which showed the user "Open" for a closed lid and vice versa.
    const t = new BLETransport();
    expect(decode(t, 0x1a, 0x05, 0x98)).toEqual([{ field: 'cover', value: 'closed' }]);
    expect(decode(t, 0x1a, 0x05, 0x99)).toEqual([{ field: 'cover', value: 'open' }]);
  });

  it('decodes firmware as a dotted version', () => {
    const t = new BLETransport();
    expect(decode(t, 0x1a, 0x07, 0x01, 0x01, 0x03)).toEqual([{ field: 'firmware', value: '1.1.3' }]);
  });

  it('decodes serial and MAC as ASCII', () => {
    const t = new BLETransport();
    const serial = [...'Q059E35I0030870'].map((c) => c.charCodeAt(0));
    expect(decode(t, 0x1a, 0x08, ...serial)[0].value).toBe('Q059E35I0030870');
    const mac = [...'606E4123'].map((c) => c.charCodeAt(0));
    expect(decode(t, 0x1a, 0x0d, ...mac)[0].value).toBe('606E4123');
  });

  it('decodes the temperature/hot sentinel triple', () => {
    const t = new BLETransport();
    expect(decode(t, 0x1a, 0x03, 0xa9)[0].value).toBe(-1); // too hot
    expect(decode(t, 0x1a, 0x03, 0xa8)[0].value).toBe(0); // normal
    expect(decode(t, 0x1a, 0x03, 0x01)[0].value).toBe(1);
  });

  it('reports every decoded field to onPrinterInfo and keeps it in printerInfo', () => {
    const t = new BLETransport();
    decode(t, 0x1a, 0x04, 0x50);
    decode(t, 0x1a, 0x08, 0x41, 0x42);
    const info = t.getPrinterInfo();
    expect(info.battery).toBe(80);
    expect(info.serial).toBe('AB');
  });

  it('does not crash when no onPrinterInfo callback is registered', () => {
    const t = new BLETransport();
    t.onPrinterInfo = null;
    expect(() => t.handleNotification(notify(0x1a, 0x04, 0x50))).not.toThrow();
  });

  it('resetPrinterInfo clears every cached field', () => {
    const t = new BLETransport();
    decode(t, 0x1a, 0x04, 0x50);
    decode(t, 0x1a, 0x05, 0x99);
    t.resetPrinterInfo();
    expect(t.getPrinterInfo()).toMatchObject({ battery: null, paper: null, cover: null, firmware: null, serial: null });
  });
});

describe('connection state', () => {
  it('isConnected() is false before any GATT connection', () => {
    const t = new BLETransport();
    expect(t.isConnected()).toBe(false);
  });

  it('isConnected() requires the device GATT link and a write characteristic', () => {
    const t = new BLETransport();
    t.connected = true;
    t.writeChar = {};
    // connected flag set but the device link is gone — must still report disconnected.
    t.device = { gatt: { connected: false } };
    expect(t.isConnected()).toBe(false);

    t.device = { gatt: { connected: true } };
    expect(t.isConnected()).toBe(true);

    t.writeChar = null;
    expect(t.isConnected()).toBe(false);
  });

  it('getDeviceName() falls back to "Unknown" when the device has no name', () => {
    const t = new BLETransport();
    expect(t.getDeviceName()).toBe('Unknown');
    t.device = { name: 'M221' };
    expect(t.getDeviceName()).toBe('M221');
  });

  it('send() refuses to write while disconnected', async () => {
    const t = new BLETransport();
    await expect(t.send(new Uint8Array([1, 2, 3]))).rejects.toThrow(/not connected/i);
  });
});

describe('sending', () => {
  function connectedTransport() {
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

  it('writes exactly the bytes it was given', async () => {
    const { t, writes } = connectedTransport();
    await t.send(new Uint8Array([0x1b, 0x40]));
    expect(writes).toEqual([{ method: 'withoutResponse', bytes: [0x1b, 0x40] }]);
  });

  it('sends only the slice of a subarray, not the whole backing buffer', async () => {
    // A raster chunk is a subarray of a much larger buffer; writing the backing buffer would
    // send megabytes of unrelated pixels.
    const { t, writes } = connectedTransport();
    const backing = new Uint8Array([9, 9, 0xaa, 0xbb, 9, 9]);
    await t.send(backing.subarray(2, 4));
    expect(writes[0].bytes).toEqual([0xaa, 0xbb]);
  });

  it('falls back to writeValue when writeValueWithoutResponse rejects', async () => {
    const { t, writes } = connectedTransport();
    let calls = 0;
    t.writeChar.writeValueWithoutResponse = async () => { calls++; throw new Error('not supported'); };
    await t.send(new Uint8Array([1]));
    expect(calls).toBe(1);
    expect(writes).toEqual([{ method: 'withResponse', bytes: [1] }]);
    // The fallback is remembered, so later writes skip the failing path.
    expect(t._useWriteWithResponse).toBe(true);
  });

  it('chunks a large payload without losing or duplicating bytes', async () => {
    const { t, writes } = connectedTransport();
    t.delay = async () => {}; // no need to wait in a test
    const payload = Uint8Array.from({ length: 128 * 3 + 7 }, (_, i) => i & 0xff);
    await t.sendChunked(payload);
    const sent = Uint8Array.from(writes.flatMap((w) => w.bytes));
    expect(sent.length).toBe(payload.length);
    expect([...sent]).toEqual([...payload]);
    expect(writes.length).toBe(4); // 128, 128, 128, 7
  });

  it('reports progress per chunk while chunking', async () => {
    const { t } = connectedTransport();
    t.delay = async () => {};
    const progress: number[] = [];
    await t.sendChunked(new Uint8Array(256), (_n: number, _total: number, pct: number) => progress.push(pct));
    expect(progress).toEqual([50, 100]);
  });
});

describe('retryWithBackoff', () => {
  it('returns the first successful result without retrying', async () => {
    const t = new BLETransport();
    t.delay = async () => {};
    let calls = 0;
    const result = await t.retryWithBackoff(async () => { calls++; return 'ok'; }, 3, 1);
    expect(result).toBe('ok');
    expect(calls).toBe(1);
  });

  it('retries up to maxRetries then rethrows the last error', async () => {
    const t = new BLETransport();
    t.delay = async () => {};
    let calls = 0;
    await expect(
      t.retryWithBackoff(async () => { calls++; throw new Error('boom'); }, 2, 1),
    ).rejects.toThrow('boom');
    expect(calls).toBe(3); // initial attempt + 2 retries
  });

  it('succeeds on a later attempt', async () => {
    const t = new BLETransport();
    t.delay = async () => {};
    let calls = 0;
    const result = await t.retryWithBackoff(async () => {
      calls++;
      if (calls < 3) throw new Error('not yet');
      return 'finally';
    }, 3, 1);
    expect(result).toBe('finally');
    expect(calls).toBe(3);
  });
});

describe('query commands', () => {
  it('sends the documented opcode for each query type', async () => {
    const sent: number[][] = [];
    const t = new BLETransport();
    t.connected = true;
    t.device = { gatt: { connected: true }, name: 'M221' };
    t.writeChar = {
      properties: { write: true, writeWithoutResponse: true },
      writeValueWithoutResponse: async (b: ArrayBuffer) => void sent.push([...new Uint8Array(b)]),
      writeValue: async () => {},
    };
    await t.query('battery');
    await t.query('paper');
    await t.query('cover');
    expect(sent).toEqual([
      [0x1f, 0x11, 0x08],
      [0x1f, 0x11, 0x11],
      [0x1f, 0x11, 0x12],
    ]);
  });

  it('asks for every field on connect, cover included', async () => {
    // Cover used to be left out of queryAll, so a lid that was already closed never generated its
    // unprompted event and the field stayed blank in the UI. queryAll must ask for it.
    const t = new BLETransport();
    const sent: number[][] = [];
    t.connected = true;
    t.device = { gatt: { connected: true } };
    t.writeChar = {
      properties: { write: true, writeWithoutResponse: true },
      writeValueWithoutResponse: async (b: ArrayBuffer) => void sent.push([...new Uint8Array(b)]),
      writeValue: async () => {},
    };
    t.delay = async () => {}; // no need to wait 100ms per query
    await t.queryAll();
    expect(sent).toEqual([
      [0x1f, 0x11, 0x08], // battery
      [0x1f, 0x11, 0x11], // paper
      [0x1f, 0x11, 0x12], // cover
      [0x1f, 0x11, 0x07], // firmware
      [0x1f, 0x11, 0x09], // serial
    ]);
  });

  it('keeps going when one query fails, so the rest still arrive', async () => {
    // send() retries through writeValue when writeValueWithoutResponse throws, so to make a query
    // genuinely fail both write paths must reject.
    const t = new BLETransport();
    const sent: number[][] = [];
    t.connected = true;
    t.device = { gatt: { connected: true } };
    // Fail only for the paper command, so the failure is about one field rather than a counter
    // that would keep failing for everything after it.
    const isPaper = (b: ArrayBuffer) => {
      const a = [...new Uint8Array(b)];
      return a[0] === 0x1f && a[1] === 0x11 && a[2] === 0x11;
    };
    const record = (b: ArrayBuffer) => {
      if (isPaper(b)) throw new Error('write failed');
      sent.push([...new Uint8Array(b)]);
    };
    t.writeChar = {
      properties: { write: true, writeWithoutResponse: true },
      writeValueWithoutResponse: async (b: ArrayBuffer) => record(b),
      writeValue: async (b: ArrayBuffer) => record(b),
    };
    t.delay = async () => {};
    await expect(t.queryAll()).resolves.toBeUndefined();
    // Battery, cover, firmware and serial still went out; only paper was lost.
    expect(sent).toContainEqual([0x1f, 0x11, 0x08]);
    expect(sent).toContainEqual([0x1f, 0x11, 0x12]);
    expect(sent).toContainEqual([0x1f, 0x11, 0x09]);
    expect(sent).not.toContainEqual([0x1f, 0x11, 0x11]);
  });

  it('a failed write falls back to the write-with-response path', async () => {
    // Worth pinning: after the first fallback every later write takes that path, because the
    // transport remembers the choice rather than retrying the failing method each time.
    const t = new BLETransport();
    t.connected = true;
    t.device = { gatt: { connected: true } };
    let withoutResponse = 0;
    let withResponse = 0;
    t.writeChar = {
      properties: { write: true, writeWithoutResponse: true },
      writeValueWithoutResponse: async () => { withoutResponse += 1; throw new Error('nope'); },
      writeValue: async () => { withResponse += 1; },
    };
    await t.send(new Uint8Array([1]));
    expect(withoutResponse).toBe(1);
    expect(withResponse).toBe(1);
    expect(t._useWriteWithResponse).toBe(true);
    await t.send(new Uint8Array([2]));
    // Second send goes straight to writeValue; it does not retry the failing method.
    expect(withoutResponse).toBe(1);
    expect(withResponse).toBe(2);
  });

  it('rejects an unknown query type', async () => {
    const t = new BLETransport();
    t.connected = true;
    t.device = { gatt: { connected: true } };
    t.writeChar = {};
    await expect(t.query('nonsense')).rejects.toThrow(/unknown query/i);
  });
});
