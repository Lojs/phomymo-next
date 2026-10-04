/**
 * USBTransport — device setup, endpoint discovery, and byte transfer.
 *
 * This was the second-largest untested file. Two things matter here:
 *  - picking the right interface and endpoint (a wrong pick = the printer never receives a byte)
 *  - never throwing on a normal disconnect, and never reporting connected when it is not
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { USBTransport } from '../src/transport/usb';

/**
 * A fake WebUSB device. Interfaces are declared as [interfaceNumber, interfaceClass]; the first
 * class-7 (printer) interface is the one the transport should claim.
 */
function fakeDevice(opts: {
  interfaces: { number: number; cls: number; alt: number; endpoints: { number: number; dir: 'in' | 'out' }[] }[];
  configuration?: unknown;
  productName?: string;
}) {
  const claimed: number[] = [];
  const transfers: { endpoint: number; bytes: number[] }[] = [];
  const device: any = {
    productName: opts.productName ?? 'USB Printer',
    // `configuration: null` explicitly means "the device has not selected one yet", which forces
    // the transport through selectConfiguration(). Otherwise the interfaces are already present.
    configuration:
      opts.configuration === undefined ? { interfaces: buildInterfaces(opts.interfaces) } : opts.configuration,
    opened: false,
    async open() { device.opened = true; },
    async close() { device.opened = false; },
    async selectConfiguration(n: number) {
      device.configuration = { interfaces: buildInterfaces(opts.interfaces) };
      device.selected = n;
    },
    async claimInterface(n: number) { claimed.push(n); },
    async transferOut(ep: number, data: Uint8Array) { transfers.push({ endpoint: ep, bytes: [...data] }); return { status: 'ok', bytesWritten: data.length }; },
  };
  return { device, claimed, transfers };
}

function buildInterfaces(spec: { number: number; cls: number; alt: number; endpoints: { number: number; dir: 'in' | 'out' }[] }[]) {
  const byNumber = new Map<number, any>();
  for (const s of spec) {
    if (!byNumber.has(s.number)) byNumber.set(s.number, { interfaceNumber: s.number, alternates: [] });
    byNumber.get(s.number).alternates.push({
      alternateSetting: s.alt,
      interfaceClass: s.cls,
      endpoints: s.endpoints.map((e) => ({ endpointNumber: e.number, direction: e.dir })),
    });
  }
  // WebUSB indexes `configuration.interfaces` by interface number, so the array must be dense:
  // interfaces[2] has to exist whenever interface 2 does. Real devices always satisfy this.
  const max = Math.max(-1, ...[...byNumber.keys()]);
  const out: any[] = [];
  for (let i = 0; i <= max; i++) {
    out.push(byNumber.get(i) ?? { interfaceNumber: i, alternates: [] });
  }
  return out;
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  Object.defineProperty(globalThis, 'navigator', {
    value: { usb: {} },
    configurable: true,
    writable: true,
  });
});

describe('isAvailable', () => {
  it('reports support based on navigator.usb', () => {
    expect(USBTransport.isAvailable()).toBe(true);
    Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });
    expect(USBTransport.isAvailable()).toBe(false);
  });
});

describe('endpoint discovery', () => {
  it('claims the printer-class interface, not interface 0, when they differ', async () => {
    // Interface 0 is a vendor/control interface; the printer is interface 2.
    const { device, claimed } = fakeDevice({
      interfaces: [
        { number: 0, cls: 0xff, alt: 0, endpoints: [{ number: 1, dir: 'out' }] },
        { number: 2, cls: 7, alt: 0, endpoints: [{ number: 3, dir: 'out' }] },
      ],
    });
    const t = new USBTransport();
    await t.connectToDevice(device);
    expect(claimed).toEqual([2]);
  });

  it('throws when no interface is printer-class', async () => {
    const { device } = fakeDevice({
      interfaces: [{ number: 0, cls: 0xff, alt: 0, endpoints: [{ number: 1, dir: 'out' }] }],
    });
    const t = new USBTransport();
    await expect(t.connectToDevice(device)).rejects.toThrow(/printer-class/i);
  });

  it('picks an OUT endpoint and ignores IN endpoints', async () => {
    const { device, transfers } = fakeDevice({
      interfaces: [
        { number: 0, cls: 7, alt: 0, endpoints: [{ number: 1, dir: 'in' }, { number: 2, dir: 'out' }] },
      ],
    });
    const t = new USBTransport();
    await t.connectToDevice(device);
    expect(t.endpointOut).toBe(2);
    await t.send(new Uint8Array([0xaa]));
    expect(transfers).toEqual([{ endpoint: 2, bytes: [0xaa] }]);
  });

  it('throws when the interface has no OUT endpoint', async () => {
    const { device } = fakeDevice({
      interfaces: [{ number: 0, cls: 7, alt: 0, endpoints: [{ number: 1, dir: 'in' }] }],
    });
    const t = new USBTransport();
    await expect(t.connectToDevice(device)).rejects.toThrow(/out endpoint/i);
  });

  it('selects a configuration only when the device reports none', async () => {
    const { device } = fakeDevice({
      interfaces: [{ number: 0, cls: 7, alt: 0, endpoints: [{ number: 1, dir: 'out' }] }],
      configuration: null,
    });
    const t = new USBTransport();
    await t.connectToDevice(device);
    expect(device.selected).toBe(1);
  });
});

describe('connection state', () => {
  it('isConnected() is false before connecting', () => {
    expect(new USBTransport().isConnected()).toBe(false);
  });

  it('reports connected after a successful setup and false after disconnect', async () => {
    const { device } = fakeDevice({
      interfaces: [{ number: 0, cls: 7, alt: 0, endpoints: [{ number: 1, dir: 'out' }] }],
    });
    const t = new USBTransport();
    await t.connectToDevice(device);
    expect(t.isConnected()).toBe(true);

    await t.disconnect();
    expect(t.isConnected()).toBe(false);
    expect(t.device).toBeNull();
    expect(t.endpointOut).toBeNull();
  });

  it('send() refuses while disconnected', async () => {
    const t = new USBTransport();
    await expect(t.send(new Uint8Array([1]))).rejects.toThrow(/not connected/i);
  });

  it('getDeviceName() falls back when the product has no name', async () => {
    const t = new USBTransport();
    expect(t.getDeviceName()).toBe('USB Printer');
    const { device } = fakeDevice({
      interfaces: [{ number: 0, cls: 7, alt: 0, endpoints: [{ number: 1, dir: 'out' }] }],
      productName: 'Phomemo M221',
    });
    await t.connectToDevice(device);
    expect(t.getDeviceName()).toBe('Phomemo M221');
  });

  it('disconnect() is safe to call twice', async () => {
    const { device } = fakeDevice({
      interfaces: [{ number: 0, cls: 7, alt: 0, endpoints: [{ number: 1, dir: 'out' }] }],
    });
    const t = new USBTransport();
    await t.connectToDevice(device);
    await t.disconnect();
    await expect(t.disconnect()).resolves.toBeUndefined();
  });

  it('disconnect() does not throw when closing the device fails', async () => {
    const { device } = fakeDevice({
      interfaces: [{ number: 0, cls: 7, alt: 0, endpoints: [{ number: 1, dir: 'out' }] }],
    });
    device.close = async () => { throw new Error('device already gone'); };
    const t = new USBTransport();
    await t.connectToDevice(device);
    await expect(t.disconnect()).resolves.toBeUndefined();
    expect(t.isConnected()).toBe(false);
  });
});

describe('sending', () => {
  async function connected() {
    const { device, transfers } = fakeDevice({
      interfaces: [{ number: 0, cls: 7, alt: 0, endpoints: [{ number: 1, dir: 'out' }] }],
    });
    const t = new USBTransport();
    await t.connectToDevice(device);
    return { t, transfers };
  }

  it('writes the exact bytes to the OUT endpoint', async () => {
    const { t, transfers } = await connected();
    await t.send(new Uint8Array([0x1b, 0x40]));
    expect(transfers).toEqual([{ endpoint: 1, bytes: [0x1b, 0x40] }]);
  });

  it('accepts a plain array as well as a Uint8Array', async () => {
    const { t, transfers } = await connected();
    await t.send([1, 2, 3]);
    expect(transfers[0].bytes).toEqual([1, 2, 3]);
  });

  it('sendChunked splits at 512 bytes without losing or duplicating a byte', async () => {
    const { t, transfers } = await connected();
    t.delay = async () => {};
    const payload = Uint8Array.from({ length: 512 * 2 + 100 }, (_, i) => i & 0xff);
    await t.sendChunked(payload);
    expect(transfers.length).toBe(3);
    const sent = Uint8Array.from(transfers.flatMap((x) => x.bytes));
    expect([...sent]).toEqual([...payload]);
  });

  it('sendChunked reports progress per chunk', async () => {
    const { t } = await connected();
    t.delay = async () => {};
    const seen: number[] = [];
    await t.sendChunked(new Uint8Array(1024), (_n: number, _tot: number, pct: number) => seen.push(pct));
    expect(seen).toEqual([50, 100]);
  });
});

describe('tryReconnect', () => {
  it('returns false when nothing is authorised', async () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: { usb: { getDevices: async () => [] } },
      configurable: true,
      writable: true,
    });
    const t = new USBTransport();
    expect(await t.tryReconnect()).toBe(false);
  });

  it('ignores authorised devices from unknown vendors', async () => {
    const foreign = { vendorId: 0x1234, productId: 0x5678, productName: 'Something else' };
    Object.defineProperty(globalThis, 'navigator', {
      value: { usb: { getDevices: async () => [foreign] } },
      configurable: true,
      writable: true,
    });
    const t = new USBTransport();
    expect(await t.tryReconnect()).toBe(false);
  });

  it('does not throw when getDevices itself fails', async () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: { usb: { getDevices: async () => { throw new Error('permission'); } } },
      configurable: true,
      writable: true,
    });
    const t = new USBTransport();
    await expect(t.tryReconnect()).resolves.toBe(false);
  });

  it('is a no-op when already connected', async () => {
    const { device } = fakeDevice({
      interfaces: [{ number: 0, cls: 7, alt: 0, endpoints: [{ number: 1, dir: 'out' }] }],
    });
    const t = new USBTransport();
    await t.connectToDevice(device);
    expect(await t.tryReconnect()).toBe(true);
  });
});
