/**
 * F-06 / F-08 / F-11 / F-16: USB transport lifecycle.
 *
 *  F-06  connect() had no in-flight guard, so a Connect click racing a Ctrl+P started a second
 *        chooser on the same singleton.
 *  F-08  a disconnect listener was added on every connect and only the newest could be removed,
 *        so closures accumulated on navigator.usb across connect/unplug cycles.
 *  F-11  USB endpoint number 0 is legal, but `if (!this.endpointOut)` reported it as missing.
 *  F-16  a bulk OUT endpoint may accept fewer bytes than offered with status 'ok'; treating that
 *        as a failure threw away the unwritten tail of the chunk.
 *  F-09  a failure after open() left the device open and this.device pointing at it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { USBTransport } from '../src/transport/usb';

/** navigator.usb stand-in that counts listeners so leaks are observable. */
function fakeNavigator(devices: any[] = []) {
  const listeners: Record<string, ((e: any) => void)[]> = {};
  const usb = {
    live: () => Object.values(listeners).reduce((n, a) => n + a.length, 0),
    addEventListener: (t: string, fn: (e: any) => void) => { (listeners[t] ??= []).push(fn); },
    removeEventListener: (t: string, fn: (e: any) => void) => {
      const a = listeners[t] ?? []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1);
    },
    fire: (t: string, e: any) => { for (const fn of [...(listeners[t] ?? [])]) fn(e); },
    getDevices: async () => devices,
    requestDevice: async () => devices[0],
  };
  Object.defineProperty(globalThis, 'navigator', { value: { usb }, configurable: true, writable: true });
  return usb;
}

function fakeDevice(opts: { endpoint?: number; failAt?: 'open' | 'select' | 'claim'; class?: number } = {}) {
  const dev: any = {
    productName: 'Phomemo M221',
    vendorId: 0x0483, productId: 0x5740,
    opened: false, configuration: null,
    async open() { if (opts.failAt === 'open') throw new Error('busy'); dev.opened = true; },
    async close() { dev.opened = false; },
    async selectConfiguration() {
      if (opts.failAt === 'select') throw new Error('STALE_CONFIGURATION');
      dev.configuration = {
        interfaces: [{
          interfaceNumber: 0,
          alternates: [{ alternateSetting: 0, interfaceClass: opts.class ?? 7,
                         endpoints: [{ endpointNumber: opts.endpoint ?? 1, direction: 'out' }] }],
        }],
      };
    },
    async claimInterface() { if (opts.failAt === 'claim') throw new Error('NetworkError'); },
    async transferOut(_ep: number, data: Uint8Array) { return { status: 'ok', bytesWritten: data.length }; },
    async clearHalt() {},
  };
  return dev;
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('F-06: a concurrent connect joins the first attempt', () => {
  it('does not run two attempts for two simultaneous calls', async () => {
    const dev = fakeDevice();
    fakeNavigator([dev]);
    const t = new USBTransport();

    let attempts = 0;
    const realConnect = t.connectToDevice.bind(t);
    t.connectToDevice = async (d: any) => { attempts++; await realConnect(d); return true; };

    await Promise.all([t.connect(), t.connect()]);
    expect(attempts).toBe(1);
  });

  it('a failing attempt does not leave the guard stuck', async () => {
    const dev = fakeDevice({ failAt: 'open' });
    fakeNavigator([dev]);
    const t = new USBTransport();
    await expect(t.connect()).rejects.toThrow();
    // The guard is released, so a retry is possible rather than silently joining a dead promise.
    t.connectToDevice = async () => true;
    expect(await t.connect()).toBe(true);
  });

  it('a later connect still works once the first finished', async () => {
    const dev = fakeDevice();
    fakeNavigator([dev]);
    const t = new USBTransport();
    await t.connect();
    await t.disconnect();
    await t.connect();
    expect(t.isConnected()).toBe(true);
  });
});

describe('F-08: only one disconnect listener is ever attached', () => {
  it('a reconnect does not leave the previous handler on navigator.usb', async () => {
    const usb = fakeNavigator([fakeDevice()]);
    const t = new USBTransport();
    await t.connect();
    expect(usb.live()).toBe(1);
    await t.disconnect();
    await t.connect();
    // Still one, not two.
    expect(usb.live()).toBe(1);
  });

  it('a matching disconnect clears the state and detaches itself', async () => {
    const dev = fakeDevice();
    const usb = fakeNavigator([dev]);
    const t = new USBTransport();
    const onDisconnect = vi.fn();
    t.onDisconnect = onDisconnect;
    await t.connect();

    usb.fire('disconnect', { device: dev });
    expect(onDisconnect).toHaveBeenCalledTimes(1);
    expect(t.isConnected()).toBe(false);
    expect(usb.live()).toBe(0);   // detached from inside the handler
  });

  it('an unrelated device disconnecting is ignored', async () => {
    const dev = fakeDevice();
    const usb = fakeNavigator([dev]);
    const t = new USBTransport();
    const onDisconnect = vi.fn();
    t.onDisconnect = onDisconnect;
    await t.connect();

    usb.fire('disconnect', { device: { productName: 'Some keyboard' } });
    expect(onDisconnect).not.toHaveBeenCalled();
    expect(t.isConnected()).toBe(true);
  });
});

describe('F-11: endpoint number 0 is a valid endpoint', () => {
  it('claims and writes through an OUT endpoint numbered 0', async () => {
    const dev = fakeDevice({ endpoint: 0 });
    fakeNavigator([dev]);
    const t = new USBTransport();
    await t.connectToDevice(dev);
    expect(t.endpointOut).toBe(0);
    await expect(t.send(new Uint8Array([0xaa]))).resolves.toBeUndefined();
  });
});

describe('F-16: a short write is retried, not dropped', () => {
  it('keeps transferring until the whole buffer is written', async () => {
    const dev = fakeDevice();
    let call = 0;
    const seen: number[] = [];
    dev.transferOut = async (_ep: number, data: Uint8Array) => {
      call++;
      seen.push(data.length);
      // First call accepts only half; the rest must go in a second transfer.
      return call === 1 ? { status: 'ok', bytesWritten: Math.floor(data.length / 2) }
                        : { status: 'ok', bytesWritten: data.length };
    };
    fakeNavigator([dev]);
    const t = new USBTransport();
    await t.connectToDevice(dev);

    await t.send(new Uint8Array(10));
    expect(seen).toEqual([10, 5]);
  });

  it('a stall is cleared and retried', async () => {
    const dev = fakeDevice();
    let call = 0;
    const halted: number[] = [];
    dev.clearHalt = async (_d: string, ep: number) => { halted.push(ep); };
    dev.transferOut = async (_ep: number, data: Uint8Array) => {
      call++;
      return call === 1 ? { status: 'stall', bytesWritten: 0 } : { status: 'ok', bytesWritten: data.length };
    };
    fakeNavigator([dev]);
    const t = new USBTransport();
    await t.connectToDevice(dev);

    await expect(t.send(new Uint8Array([1, 2, 3]))).resolves.toBeUndefined();
    expect(halted).toEqual([1]);
  });

  it('a transfer that never progresses throws instead of spinning', async () => {
    const dev = fakeDevice();
    dev.transferOut = async () => ({ status: 'ok', bytesWritten: 0 });
    fakeNavigator([dev]);
    const t = new USBTransport();
    await t.connectToDevice(dev);
    await expect(t.send(new Uint8Array([1, 2, 3]))).rejects.toThrow(/incomplete/i);
  });

  it('a non-ok, non-stall status throws', async () => {
    const dev = fakeDevice();
    dev.transferOut = async () => ({ status: 'babble', bytesWritten: 0 });
    fakeNavigator([dev]);
    const t = new USBTransport();
    await t.connectToDevice(dev);
    await expect(t.send(new Uint8Array([1]))).rejects.toThrow(/failed/i);
  });
});

describe('F-09: a failure after open() releases the device', () => {
  it.each(['open', 'select', 'claim'] as const)('closes the device when %s fails', async (failAt) => {
    const dev = fakeDevice({ failAt });
    fakeNavigator([dev]);
    const t = new USBTransport();
    await expect(t.connectToDevice(dev)).rejects.toThrow();
    expect(dev.opened).toBe(false);
    expect(t.device).toBeNull();
    expect(t.connected).toBe(false);
  });

  it('a device with no printer-class interface is rejected', async () => {
    const dev = fakeDevice({ class: 0xff });
    fakeNavigator([dev]);
    const t = new USBTransport();
    await expect(t.connectToDevice(dev)).rejects.toThrow(/printer-class/i);
    expect(dev.opened).toBe(false);
    expect(t.device).toBeNull();
  });
});

describe('F-05: auto-reconnect does not depend on an unread configuration', () => {
  it('matches a known vendor/product even though configuration is null', async () => {
    // getDevices() returns devices whose `configuration` is null until they are opened, so a
    // classCode test here could never fire and auto-reconnect silently never worked.
    const dev = fakeDevice();          // configuration starts null
    fakeNavigator([dev]);
    const t = new USBTransport();
    expect(dev.configuration).toBeNull();
    expect(await t.tryReconnect()).toBe(true);
    expect(t.isConnected()).toBe(true);
  });

  it('ignores an authorised device from an unknown vendor', async () => {
    const foreign = { vendorId: 0x1234, productId: 0x5678, productName: 'Other' };
    fakeNavigator([foreign]);
    const t = new USBTransport();
    expect(await t.tryReconnect()).toBe(false);
  });
});