/**
 * A failed GATT setup must not report a disconnect, from a review of v1.0.12.
 *
 * connectGATT()'s catch block called device.gatt.disconnect() to give the radio link back, while
 * the 'gattserverdisconnected' handler was still attached and still current. gatt.disconnect()
 * makes the browser fire that very event, so the cleanup the transport performed on the way out
 * ran the full teardown — including onDisconnect().
 *
 * In the app that meant a failed attempt announced "disconnected" while connectPrinter() was still
 * working through its retries: the Connect and Print buttons came back, so a second connect could
 * start alongside the first, and droppedByItself was set, which could trigger an unwanted
 * auto-reconnect when the tab regained focus.
 *
 * The fix detaches the handler and bumps the generation before dropping the link, so the event
 * caused by our own cleanup is ignored.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BLETransport } from '../src/transport/ble';

beforeEach(() => vi.spyOn(console, 'log').mockImplementation(() => {}));

/**
 * A fake BluetoothDevice whose gatt.disconnect() fires 'gattserverdisconnected', which is what
 * the browser does as a side effect of that call.
 */
function fakeDevice() {
  const listeners: Record<string, (() => void)[]> = {};
  const device: any = {
    name: 'M110',
    addEventListener(type: string, fn: () => void) { (listeners[type] ??= []).push(fn); },
    removeEventListener(type: string, fn: () => void) {
      const arr = listeners[type];
      if (!arr) return;
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    },
    fire(type: string) { for (const fn of [...(listeners[type] ?? [])]) fn(); },
    liveHandlers: () => (listeners['gattserverdisconnected'] ?? []).length,
    gatt: {
      connected: false,
      connect: async () => { device.gatt.connected = true; return device._server; },
      // The real browser fires the event as a side effect of this call.
      disconnect: () => { device.gatt.connected = false; device.fire('gattserverdisconnected'); },
    },
    _server: {
      getPrimaryService: async () => ({
        getCharacteristic: async (uuid: number) =>
          uuid === 0xff02
            ? { properties: { write: true, writeWithoutResponse: true }, writeValue: async () => {}, writeValueWithoutResponse: async () => {}, addEventListener() {}, removeEventListener() {} }
            // The notify characteristic comes up fine.
            // The link dies here, mid-setup — the case connectGATT()'s catch block exists for.
            : { startNotifications: async () => { device.gatt.connected = false; }, stopNotifications: async () => {}, addEventListener() {}, removeEventListener() {} },
      }),
    },
  };
  return device;
}

describe('a failed GATT setup does not report a disconnect', () => {
  it('detaches the handler before dropping the link', async () => {
    const device = fakeDevice();
    const t = new BLETransport();
    t.delay = async () => {};
    const onDisconnect = vi.fn();
    t.onDisconnect = onDisconnect;
    t.device = device;

    await expect(t.connectGATT()).rejects.toBeTruthy();

    // gatt.disconnect() fired the event; the handler must already be off the device.
    expect(device.liveHandlers()).toBe(0);
    expect(onDisconnect).not.toHaveBeenCalled();
  });

  it('still hands the radio link back', async () => {
    const device = fakeDevice();
    const t = new BLETransport();
    t.delay = async () => {};
    t.device = device;

    await expect(t.connectGATT()).rejects.toBeTruthy();

    // The link is released even though the handler did not fire — cleanup must not be skipped.
    expect(device.gatt.connected).toBe(false);
  });

  it('leaves the transport empty and disconnected', async () => {
    const device = fakeDevice();
    const t = new BLETransport();
    t.delay = async () => {};
    t.device = device;

    await expect(t.connectGATT()).rejects.toBeTruthy();

    expect(t.isConnected()).toBe(false);
    expect((t as any).server).toBeNull();
    expect((t as any).writeChar).toBeNull();
  });
});
