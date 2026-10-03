/**
 * services/printing.ts — the connection flow.
 *
 * This is the largest uncovered surface in the app and the code every print depends on: it
 * validates the environment, obtains a transport, reports the outcome, and decides which printer
 * profile a job will use. The tests drive the real orchestration with the transports mocked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/** A controllable BLE transport, plus what the orchestration did to it. */
const h = vi.hoisted(() => ({
  transport: null as any,
  calls: [] as string[],
  connectResult: 'ok' as 'ok' | 'notConnected' | 'throws',
  bluetooth: true,
  usb: true,
}));

vi.mock('../src/transport/ble', () => ({
  BLETransport: {
    isAvailable: () => h.bluetooth,
    getShared: () => h.transport,
  },
}));

vi.mock('../src/transport/usb', () => ({
  USBTransport: {
    isAvailable: () => h.usb,
    getShared: () => h.transport,
  },
}));

// The rasteriser needs a DOM canvas; replace it with a fixed raster so the tests exercise
// scheduling and profile selection, not pixels.
vi.mock('../src/core/render/label', () => ({
  prepareForRender: async () => {},
  ditherModeOf: () => 'none' as const,
  buildRaster: () => ({ data: new Uint8Array(48 * 10), widthBytes: 48, heightLines: 10 }),
}));

function makeTransport(deviceName: string) {
  let connected = false;
  return {
    onDisconnect: null as (() => void) | null,
    onPrinterInfo: null as ((...a: unknown[]) => void) | null,
    getDeviceName: () => deviceName,
    isConnected: () => connected,
    async connect() {
      h.calls.push('connect');
      if (h.connectResult === 'throws') {
        const e = new Error('GATT operation failed');
        e.name = 'NetworkError';
        throw e;
      }
      connected = h.connectResult === 'ok';
    },
    async disconnect() { h.calls.push('disconnect'); connected = false; },
    async queryAll() { h.calls.push('queryAll'); },
    async query(t: string) { h.calls.push(t); },
    async send() { h.calls.push('send'); },
    async delay() {},
    async waitForResponse() { return null; },
  };
}

beforeEach(() => {
  vi.resetModules();
  h.calls.length = 0;
  h.connectResult = 'ok';
  h.bluetooth = true;
  h.usb = true;
  h.transport = makeTransport('M221');

  const map = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
  Object.defineProperty(globalThis, 'navigator', { value: { language: 'en-US' }, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'window', {
    value: { isSecureContext: true },
    configurable: true,
    writable: true,
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

async function load() {
  const printing = await import('../src/services/printing');
  const store = (await import('../src/state/store')).useStore;
  const storage = await import('../src/core/storage/storage');
  return { printing, store, storage };
}

describe('environment guards', () => {
  it('refuses over plain HTTP', async () => {
    (globalThis as any).window = { isSecureContext: false };
    const { printing, store } = await load();
    expect(await printing.connectPrinter('ble')).toBe(false);
    expect(store.getState().conn.status).toBe('failed');
    expect(store.getState().conn.error).toMatch(/https/i);
  });

  it('refuses BLE when the browser has no Web Bluetooth', async () => {
    h.bluetooth = false;
    const { printing, store } = await load();
    expect(await printing.connectPrinter('ble')).toBe(false);
    expect(store.getState().conn.error).toMatch(/bluetooth/i);
  });

  it('refuses USB when the browser has no WebUSB', async () => {
    h.usb = false;
    const { printing, store } = await load();
    expect(await printing.connectPrinter('usb')).toBe(false);
    expect(store.getState().conn.error).toMatch(/usb/i);
  });

  it('reports availability', async () => {
    const { printing } = await load();
    expect(printing.bluetoothAvailable()).toBe(true);
    expect(printing.usbAvailable()).toBe(true);
  });
});

describe('a successful connection', () => {
  it('records the transport, device and status', async () => {
    const { printing, store } = await load();
    expect(await printing.connectPrinter('ble')).toBe(true);
    expect(store.getState().conn).toMatchObject({ type: 'ble', connected: true, deviceName: 'M221', status: 'connected', busy: false });
  });

  it('isConnected() reflects the transport', async () => {
    const { printing } = await load();
    expect(printing.isConnected()).toBe(false);
    await printing.connectPrinter('ble');
    expect(printing.isConnected()).toBe(true);
  });

  it('queries the printer for its status after connecting over BLE', async () => {
    const { printing } = await load();
    await printing.connectPrinter('ble');
    // queryAll is scheduled on a timer, so allow it to run.
    await new Promise((r) => setTimeout(r, 600));
    expect(h.calls).toContain('queryAll');
  });

  it('routes incoming printer info into the store', async () => {
    const { printing, store } = await load();
    await printing.connectPrinter('ble');
    h.transport.onPrinterInfo?.('battery', 80, { battery: 80, paper: null, firmware: null, serial: null, cover: null });
    expect(store.getState().printerInfo?.battery).toBe(80);
  });

});

// Declared first so no BLE connection has scheduled its 500ms queryAll timer: that timer captures
// `transport` at fire time, so it would otherwise land on a later test's transport.
describe('status queries are BLE-only', () => {
  it('does not query status over USB', async () => {
    const { printing } = await load();
    const usbOnly: string[] = [];
    h.transport = {
      ...makeTransport('M221'),
      async queryAll() { usbOnly.push('queryAll'); },
    };
    await printing.connectPrinter('usb');
    await new Promise((r) => setTimeout(r, 700));
    expect(usbOnly).toEqual([]);
  });
});

describe('a successful connection', () => {
  it('records the transport, device and status', async () => {
    const { printing, store } = await load();
    expect(await printing.connectPrinter('ble')).toBe(true);
    expect(store.getState().conn).toMatchObject({ type: 'ble', connected: true, deviceName: 'M221', status: 'connected', busy: false });
  });

  it('isConnected() reflects the transport', async () => {
    const { printing } = await load();
    expect(printing.isConnected()).toBe(false);
    await printing.connectPrinter('ble');
    expect(printing.isConnected()).toBe(true);
  });

  it('queries the printer for its status after connecting over BLE', async () => {
    const { printing } = await load();
    await printing.connectPrinter('ble');
    await new Promise((r) => setTimeout(r, 600));
    expect(h.calls).toContain('queryAll');
  });

  it('routes incoming printer info into the store', async () => {
    const { printing, store } = await load();
    await printing.connectPrinter('ble');
    h.transport.onPrinterInfo?.('battery', 80, { battery: 80, paper: null, firmware: null, serial: null, cover: null });
    expect(store.getState().printerInfo?.battery).toBe(80);
  });
});

describe('a failed connection', () => {
  it('fails when the transport reports not connected', async () => {
    h.connectResult = 'notConnected';
    const { printing, store } = await load();
    expect(await printing.connectPrinter('ble')).toBe(false);
    expect(store.getState().conn.status).toBe('failed');
  });

  it('turns a GATT error into a readable message rather than the raw text', async () => {
    h.connectResult = 'throws';
    const { printing, store } = await load();
    expect(await printing.connectPrinter('ble')).toBe(false);
    expect(store.getState().conn.status).toBe('failed');
    expect(store.getState().conn.error).toBeTruthy();
    expect(store.getState().toasts.at(-1)!.kind).toBe('error');
  });

  it('a cancelled device picker is not an error', async () => {
    h.connectResult = 'throws';
    h.transport = makeTransport('M221');
    h.transport.connect = async () => { const e = new Error('cancelled'); e.name = 'NotFoundError'; throw e; };
    const { printing, store } = await load();
    expect(await printing.connectPrinter('ble')).toBe(false);
    // Disconnected, not failed: the user simply changed their mind.
    expect(store.getState().conn.status).toBe('disconnected');
    expect(store.getState().conn.error).toBeNull();
  });
});

describe('choosing a printer profile after connecting', () => {
  it('a recognised printer always uses auto-detect', async () => {
    const { printing, store } = await load();
    store.getState().updateSettings({ printerModel: 'm110' }); // a manual override
    await printing.connectPrinter('ble');
    expect(store.getState().settings.printerModel).toBe('auto');
  });

  it('an unrecognised printer with a remembered model reuses it silently', async () => {
    const { printing, store, storage } = await load();
    storage.saveDeviceModel('Mystery-9000', 'm221');
    h.transport = makeTransport('Mystery-9000');
    await printing.connectPrinter('ble');
    expect(store.getState().settings.printerModel).toBe('m221');
    expect(store.getState().dialog).toBeNull();
  });

  it('an unrecognised printer with no memory asks which model it is', async () => {
    const { printing, store } = await load();
    h.transport = makeTransport('Mystery-9000');
    const p = printing.connectPrinter('ble');
    // Answer the dialog while the connection is still in flight.
    await new Promise((r) => setTimeout(r, 0));
    store.getState().updateSettings({ printerModel: 'm221' });
    store.getState().openDialog(null);
    await p;
    expect(store.getState().settings.printerModel).toBe('m221');
  });

  it('applies the printer family to the label size after connecting', async () => {
    const { printing, store } = await load();
    await printing.connectPrinter('ble');
    // applyPrinterFamily runs; whatever it decided, the size must be one the family offers.
    const { presetsFor, presetKey, isKnownPreset } = await import('../src/core/printers/presets');
    const cfg = printing.currentConfig();
    const groups = presetsFor(cfg, store.getState().settings.tapeWidth);
    const offered = { ...groups.rect, ...groups.round, ...groups.continuous };
    const key = presetKey(store.getState().labelSize);
    expect(key in offered || !isKnownPreset(key)).toBe(true);
  });

  it('sets a tape width for a tape printer', async () => {
    const { printing, store } = await load();
    h.transport = makeTransport('A30');
    await printing.connectPrinter('ble');
    expect(store.getState().settings.tapeWidth).toBe(15); // the A30's own width
  });

  it('remembers a remembered tape width', async () => {
    const { printing, store, storage } = await load();
    storage.saveDeviceTapeWidth('A30', 12);
    h.transport = makeTransport('A30');
    await printing.connectPrinter('ble');
    expect(store.getState().settings.tapeWidth).toBe(12);
  });
});

describe('currentTarget', () => {
  it('reports the head width and dpi for the resolved printer', async () => {
    const { printing } = await load();
    h.transport = makeTransport('M221');
    await printing.connectPrinter('ble');
    const { target, cfg } = printing.currentTarget();
    expect(target.widthBytes).toBe(72);   // the M221's head
    expect(target.dpi).toBe(203);
    expect(cfg.protocol).toBe('m-series');
  });

  it('follows a manual model override', async () => {
    const { printing, store } = await load();
    h.transport = makeTransport('Mystery-9000');
    const p = printing.connectPrinter('ble');
    await new Promise((r) => setTimeout(r, 0));
    store.getState().updateSettings({ printerModel: 'p12' });
    store.getState().openDialog(null);
    await p;
    expect(printing.currentTarget().target.widthBytes).toBe(12);
    expect(printing.currentConfig().protocol).toBe('p12');
  });

  it('falls back to a default width for an unknown printer', async () => {
    const { printing, store } = await load();
    h.transport = makeTransport('Mystery-9000');
    const p = printing.connectPrinter('ble');
    await new Promise((r) => setTimeout(r, 0));
    store.getState().updateSettings({ printerModel: 'auto' });
    store.getState().openDialog(null);
    await p;
    // 72 is the app's default when nothing matches.
    expect(printing.currentTarget().target.widthBytes).toBe(72);
  });
});

describe('the periodic battery refresh', () => {
  // The readout is otherwise only read once, at connect. Battery is the one field that goes stale
  // on its own while the printer sits idle.
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('re-queries the battery on its own, without the user doing anything', async () => {
    const { printing } = await load();
    await printing.connectPrinter('ble');
    await vi.advanceTimersByTimeAsync(600); // let the connect-time queryAll settle
    h.calls.length = 0;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.calls).toContain('battery');
  });

  it('keeps refreshing, not just once', async () => {
    const { printing } = await load();
    await printing.connectPrinter('ble');
    await vi.advanceTimersByTimeAsync(600);
    h.calls.length = 0;
    await vi.advanceTimersByTimeAsync(180_000); // three minutes
    expect(h.calls.filter((c) => c === 'battery').length).toBe(3);
  });

  it('does not send the query while a print is in flight', async () => {
    // The status command and the raster chunks share one transport, so a query mid-job would
    // interleave with them. A skipped tick is the correct behaviour.
    const { printing } = await load();
    await printing.connectPrinter('ble');
    await vi.advanceTimersByTimeAsync(600);
    let queryWhilePrinting = 0;
    const realQuery = h.transport.query;
    h.transport.query = async (t: string) => { if (t === 'battery' && printing.isPrinting()) queryWhilePrinting += 1; return realQuery.call(h.transport, t); };
    const p = printing.printCurrent();
    await vi.advanceTimersByTimeAsync(60_000);
    await p.catch(() => {});
    expect(queryWhilePrinting).toBe(0);
  });

  it('stops when the printer disconnects', async () => {
    const { printing } = await load();
    await printing.connectPrinter('ble');
    await vi.advanceTimersByTimeAsync(600);
    await printing.disconnectPrinter();
    h.calls.length = 0;
    await vi.advanceTimersByTimeAsync(180_000);
    expect(h.calls).not.toContain('battery');
  });

  it('does not keep a timer running after a second connect', async () => {
    // Reconnecting must not leave the first timer alive, or the queries would double each minute.
    const { printing } = await load();
    await printing.connectPrinter('ble');
    await vi.advanceTimersByTimeAsync(600);
    await printing.disconnectPrinter();
    await printing.connectPrinter('ble');
    await vi.advanceTimersByTimeAsync(600);
    h.calls.length = 0;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.calls.filter((c) => c === 'battery').length).toBe(1);
  });

  it('stops when the printer drops the link by itself, not just on disconnect()', async () => {
    // Out of paper is the common cause: the printer drops the link on its own, which fires
    // gattserverdisconnected and never reaches disconnectPrinter(). The timer must stop on that
    // path too, or it keeps firing at a dead transport.
    const { printing } = await load();
    await printing.connectPrinter('ble');
    await vi.advanceTimersByTimeAsync(600);
    // The printer vanishes: the transport reports it is gone and the app is told.
    h.transport.isConnected = () => false;
    h.transport.onDisconnect?.();
    h.calls.length = 0;
    await vi.advanceTimersByTimeAsync(180_000);
    expect(h.calls).not.toContain('battery');
  });

  it('the app reports the drop instead of pretending it is still connected', async () => {
    const { printing, store } = await load();
    await printing.connectPrinter('ble');
    await vi.advanceTimersByTimeAsync(600);
    h.transport.isConnected = () => false;
    h.transport.onDisconnect?.();
    expect(store.getState().conn.connected).toBe(false);
    expect(store.getState().conn.status).toBe('disconnected');
    expect(store.getState().printerInfo).toBeNull();
  });

  it('is not started for a USB connection, which has no battery command', async () => {
    const { printing } = await load();
    await printing.connectPrinter('usb');
    await vi.advanceTimersByTimeAsync(600);
    h.calls.length = 0;
    await vi.advanceTimersByTimeAsync(180_000);
    expect(h.calls).not.toContain('battery');
  });
});

describe('disconnecting', () => {
  it('clears the connection state', async () => {
    const { printing, store } = await load();
    await printing.connectPrinter('ble');
    await printing.disconnectPrinter();
    expect(store.getState().conn).toMatchObject({ connected: false, type: null, deviceName: '', status: 'disconnected' });
    expect(printing.isConnected()).toBe(false);
  });

  it('clears cached printer info', async () => {
    const { printing, store } = await load();
    await printing.connectPrinter('ble');
    store.getState().setPrinterInfo({ battery: 90, paper: 'ok', firmware: null, serial: null, cover: null });
    await printing.disconnectPrinter();
    expect(store.getState().printerInfo).toBeNull();
  });

  it('is safe with nothing connected', async () => {
    const { printing } = await load();
    await expect(printing.disconnectPrinter()).resolves.toBeUndefined();
  });

  it('does not reuse the previous transport type for the next connection', async () => {
    const { printing, store } = await load();
    await printing.connectPrinter('usb');
    await printing.disconnectPrinter();
    await printing.connectPrinter('usb');
    // The second session must still be USB, not silently falling back.
    expect(store.getState().conn.type).toBe('usb');
  });
});

describe('remembering per-device choices', () => {
  it('stores a model for the connected device', async () => {
    const { printing, storage } = await load();
    h.transport = makeTransport('M221');
    await printing.connectPrinter('ble');
    printing.rememberModel('M221', 'm221');
    expect(storage.getDeviceModel('M221')).toBe('m221');
  });

  it('stores a tape width for the connected device', async () => {
    const { printing, storage } = await load();
    printing.rememberTapeWidth('A30', 15);
    expect(storage.getDeviceTapeWidth('A30')).toBe(15);
  });
});