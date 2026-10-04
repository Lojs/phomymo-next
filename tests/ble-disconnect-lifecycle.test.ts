/**
 * F-01: the BLE disconnect listener outlived the connection it belonged to.
 *
 * connectGATT() attached a 'gattserverdisconnected' handler to `this.device` and never removed it.
 * A BluetoothDevice lives for the lifetime of the global, so with two printers the handler from
 * the first survived on its device and, on every later drop of that device, nulled the transport
 * state for whichever printer was connected NOW. A healthy printer reported "Not connected", with
 * no error shown, until the user reconnected by hand.
 *
 * The fix detaches the handler on disconnect and stamps it with a generation counter so a handler
 * from an older connection can never act on a newer one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BLETransport } from '../src/transport/ble';

beforeEach(() => vi.spyOn(console, 'log').mockImplementation(() => {}));

/** A fake BluetoothDevice that records its listeners so a test can fire them at will. */
function fakeDevice(name: string) {
  const listeners: Record<string, (() => void)[]> = {};
  const device: any = {
    name,
    _liveHandlers: () => (listeners['gattserverdisconnected'] ?? []).length,
    addEventListener(type: string, fn: () => void) {
      (listeners[type] ??= []).push(fn);
    },
    removeEventListener(type: string, fn: () => void) {
      const arr = listeners[type];
      if (!arr) return;
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    },
    /** Fire the event the way the browser does. */
    fire(type: string) { for (const fn of [...(listeners[type] ?? [])]) fn(); },
    gatt: {
      connected: false,
      connect: async () => { device.gatt.connected = true; return device._server; },
      disconnect: () => { device.gatt.connected = false; },
    },
    _server: {
      getPrimaryService: async () => ({
        getCharacteristic: async (uuid: number) =>
          uuid === 0xff02
            ? { properties: { write: true, writeWithoutResponse: true }, writeValue: async () => {}, writeValueWithoutResponse: async () => {}, addEventListener() {}, removeEventListener() {} }
            : { startNotifications: async () => {}, stopNotifications: async () => {}, addEventListener() {}, removeEventListener() {} },
      }),
    },
  };
  return device;
}

describe('F-06: a concurrent BLE connect joins the first attempt', () => {
  it('a second call joins the running one instead of opening a second picker', async () => {
    const a = fakeDevice('M-A');
    const t = new BLETransport();
    t.delay = async () => {};
    let pickers = 0;
    // Each pick blocks until we release it, so both calls would overlap without the guard.
    let release!: (d: any) => void;
    const picked = new Promise<any>((r) => { release = r; });
    Object.defineProperty(globalThis, 'navigator', {
      value: { bluetooth: { requestDevice: async () => { pickers++; return picked; } } },
      configurable: true, writable: true,
    });

    const first = t.connect();
    const second = t.connect();
    release(a);
    await Promise.all([first, second]);

    expect(pickers).toBe(1);
    expect(t.device).toBe(a);
  });
});

describe('F-01: a stale disconnect handler cannot tear down a newer connection', () => {
  it('a handler from a previous device is ignored after a new one attaches', async () => {
    const t = new BLETransport();
    t.delay = async () => {};
    const onDisconnect = vi.fn();
    t.onDisconnect = onDisconnect;

    // Printer A: connect, so a handler is attached to A.
    const a = fakeDevice('M-A');
    t.device = a;
    await t.connectGATT();
    expect(a._liveHandlers()).toBe(1);

    // The user picks printer B instead. B gets its own handler.
    const b = fakeDevice('M-B');
    t.device = b;
    await t.connectGATT();
    expect(b._liveHandlers()).toBe(1);

    // A comes back into range and drops again — routine for a printer across the room.
    a.fire('gattserverdisconnected');

    // B's connection must be untouched: still connected, writeChar intact.
    expect(onDisconnect).not.toHaveBeenCalled();
    expect(t.device).toBe(b);
    expect(t.connected).toBe(true);
    expect(t.writeChar).not.toBeNull();
  });

  it('disconnect() detaches the handler it attached', async () => {
    const t = new BLETransport();
    t.delay = async () => {};
    const a = fakeDevice('M-A');
    t.device = a;
    await t.connectGATT();
    expect(a._liveHandlers()).toBe(1);

    await t.disconnect();
    // Nothing left on the device, so a later flap cannot reach the transport.
    expect(a._liveHandlers()).toBe(0);
  });

  it('a handler fired after disconnect() does not touch the cleared state', async () => {
    const t = new BLETransport();
    t.delay = async () => {};
    const onDisconnect = vi.fn();
    t.onDisconnect = onDisconnect;
    const a = fakeDevice('M-A');
    t.device = a;
    await t.connectGATT();

    // Capture the handler the way a browser would queue it, then disconnect.
    const queued = (a as any).fire;
    await t.disconnect();
    onDisconnect.mockClear();
    queued('gattserverdisconnected');
    expect(onDisconnect).not.toHaveBeenCalled();
  });

  it('the current device DOES tear the connection down', async () => {
    const t = new BLETransport();
    t.delay = async () => {};
    const onDisconnect = vi.fn();
    t.onDisconnect = onDisconnect;
    const b = fakeDevice('M-B');
    t.device = b;
    await t.connectGATT();

    b.fire('gattserverdisconnected');
    expect(onDisconnect).toHaveBeenCalledTimes(1);
    expect(t.connected).toBe(false);
  });
});