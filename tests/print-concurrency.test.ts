/**
 * Print concurrency invariant: at most ONE print job may write to the transport at a time.
 *
 * services/printing.ts declares a module-level `printing` guard whose own comment says it exists
 * "so no future caller can bypass it" — two jobs interleaving their chunks on the same BLE
 * transport produce a garbled label.
 *
 * These tests exercise that invariant against the real code path. printCurrent() and
 * printDensityTest() are both print jobs; starting the second while the first is in flight must
 * NOT interleave bytes on the wire.
 *
 * The transport and the rasteriser are mocked so the test runs headless (no Web Bluetooth, no
 * canvas) while still driving the genuine op-streams from core/protocols/encoders.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// --- hoisted holders so the vi.mock factories below can see them -------------------------
const h = vi.hoisted(() => ({
  events: [] as string[],
  // Filled in beforeEach with a controllable fake.
  transport: null as any,
}));

vi.mock('../src/transport/ble', () => ({
  BLETransport: {
    isAvailable: () => true,
    getShared: () => h.transport,
  },
}));

// The rasteriser needs a DOM canvas; replace it with a fixed, recognisable raster so the only
// thing under test is job scheduling, not pixel output.
vi.mock('../src/core/render/label', () => ({
  prepareForRender: async () => {},
  buildRaster: () => ({
    // All-zero data, distinct from the density test's 0xFF strips.
    data: new Uint8Array(48 * 300),
    widthBytes: 48,
    heightLines: 300,
  }),
}));

beforeAll(() => {
  (globalThis as any).localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  // Node 24 exposes `navigator` as a getter-only global; define over it rather than assigning.
  Object.defineProperty(globalThis, 'navigator', {
    value: { bluetooth: {}, language: 'en-US' },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, 'window', {
    value: { isSecureContext: true },
    configurable: true,
    writable: true,
  });
});

/** A fake BLE transport that records every write, in order, with a small yield per write. */
function makeFakeTransport() {
  let connected = false;
  return {
    onDisconnect: null as null | (() => void),
    onPrinterInfo: null as null | ((...a: unknown[]) => void),
    async connect() { connected = true; },
    isConnected() { return connected; },
    getDeviceName() { return 'M221'; },
    async disconnect() { connected = false; },
    async queryAll() {},
    async send(data: Uint8Array) {
      h.events.push('send:' + Buffer.from(data).toString('hex'));
      await new Promise((r) => setTimeout(r, 2));
    },
    async delay(_ms: number) {
      await new Promise((r) => setTimeout(r, 0));
    },
  };
}

const HEADER = (w: number, hh: number) =>
  'send:1d7630' + '00' + w.toString(16).padStart(2, '0') + '00' + hh.toString(16).padStart(2, '0') + '00';

// printCurrent() (M221 → m-series BLE) ends with ESC J 32.
const PC_TERMINATOR = 'send:1b4a20';
// printDensityTest() raster header: widthBytes 40, 30 rows.
const DENSITY_HEADER = HEADER(40, 30);

describe('print concurrency invariant', () => {
  beforeEach(() => {
    h.events.length = 0;
    h.transport = makeFakeTransport();
    vi.resetModules();
  });

  async function connect() {
    const printing = await import('../src/services/printing');
    const ok = await printing.connectPrinter('ble');
    expect(ok).toBe(true);
    return printing;
  }

  it('sanity: printDensityTest alone does write to the transport', async () => {
    const printing = await connect();
    await printing.printDensityTest();
    expect(h.events.filter((e) => e === DENSITY_HEADER).length).toBe(8); // 8 density strips
  });

  it('sanity: printCurrent alone writes, and its terminator appears once', async () => {
    const printing = await connect();
    await printing.printCurrent();
    expect(h.events.filter((e) => e === PC_TERMINATOR).length).toBe(1);
  });

  it('printDensityTest must not interleave with an in-flight printCurrent', async () => {
    const printing = await connect();

    // Start a print and let it get going.
    const pc = printing.printCurrent();
    await new Promise((r) => setTimeout(r, 20));

    // The user opens printer settings and hits "density test" while the label is still printing.
    const dt = printing.printDensityTest();

    await Promise.all([pc, dt]);

    const firstDensity = h.events.findIndex((e) => e === DENSITY_HEADER);
    const lastPrintCurrent = h.events.lastIndexOf(PC_TERMINATOR);

    // Invariant: the density test's bytes must not land inside the running job's byte stream.
    // If the guard is respected, either nothing was sent by the density test, or it only ran
    // after the first job had finished.
    expect(
      firstDensity === -1 || firstDensity > lastPrintCurrent,
      `density test interleaved with printCurrent: first density byte at index ${firstDensity}, ` +
        `printCurrent's last byte at index ${lastPrintCurrent}, total writes ${h.events.length}`,
    ).toBe(true);
  });
});
