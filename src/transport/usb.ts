/**
 * WebUSB transport for Phomymo
 */

import { trace } from '../core/trace';

// Known USB IDs for Phomemo printers.
// Vendor-only filters (e.g. { vendorId: 0x0483 }) are intentionally omitted: 0x0483 is
// STMicroelectronics, whose ID is used by a huge number of unrelated devices (ST-Link
// programmers, microcontroller boards, CDC gadgets). Filtering on classCode 7 (printer)
// is the safe catch-all — it matches any printer-class device without opening non-printers.
const USB_DEVICE_FILTERS = [
  // Standard Phomemo printers (M110, M220, etc.)
  { vendorId: 0x0483, productId: 0x5740 },
  // PM-241 shipping label printer
  { vendorId: 0x2e3c, productId: 0x5750 },
  // Any printer-class device (classCode 7)
  { classCode: 7 },
];

// Chunk size and delay for USB transfers
const CHUNK_SIZE = 512;
const CHUNK_DELAY = 20;

// Singleton instance for persistent connection
let sharedInstance: any = null;

/**
 * USB Transport class for WebUSB API
 */
export class USBTransport {
  device: any;
  connected: any;
  onDisconnect: any;
  endpoint: any;
  endpointOut: any;
  interfaceNumber: any;
  _endpointNumber: any;
  _usbDisconnectHandler: ((event: any) => void) | null = null;
  /** The in-flight connect() attempt, so a concurrent caller joins it instead of starting a second. */
  _connectPromise: Promise<boolean> | null = null;

  constructor() {
    this.device = null;
    this.endpointOut = null;
    this.connected = false;

    this.onDisconnect = null;
  }

  /**
   * Get shared instance (singleton pattern for persistent connection)
   */
  static getShared() {
    if (!sharedInstance) {
      sharedInstance = new USBTransport();
    }
    return sharedInstance;
  }

  /**
   * Check if WebUSB is available
   */
  static isAvailable() {
    return 'usb' in navigator;
  }

  /**
   * Try to reconnect to a previously authorized device
   */
  async tryReconnect() {
    // If already connected, verify connection
    if (this.connected && this.device) {
      trace('Already connected to', this.device.productName);
      return true;
    }

    // Try to get previously authorized devices
    try {
      const devices = await navigator.usb.getDevices();
      trace('Found authorized USB devices:', devices.length);

      for (const device of devices) {
        // Match on what is available WITHOUT opening: a USBDevice's `configuration` is null
        // until this page calls open() + selectConfiguration(), so the { classCode: 7 } branch
        // could never fire here and auto-reconnect silently did not work for any printer whose
        // PID is not one of the two hardcoded pairs. getDevices() returns only devices this
        // origin already has permission for, so trying them is safe; the class test happens
        // inside connectToDevice(), after the device is open and configured.
        if (!this._matchesVendorFilters(device)) continue;
        trace('Found authorized candidate:', device.productName);
        try {
          await this.connectToDevice(device);
          return true;
        } catch (e) {
          trace('Could not connect to', device.productName);
        }
      }
    } catch (e) {
      trace('getDevices failed:', e.message);
    }

    return false;
  }

  /**
   * True when the device matches a vendor+product filter, i.e. a printer we know by identity.
   *
   * Only the VID/PID pairs are checked here, never the interface class: `configuration` is null
   * on a device returned by getDevices() until it has been opened, so a classCode test would
   * always fail here. The class check lives in connectToDevice(), once the device is open.
   */
  _matchesVendorFilters(device: any): boolean {
    return USB_DEVICE_FILTERS.some(
      (f) => f.vendorId !== undefined && f.productId !== undefined &&
             device.vendorId === f.vendorId && device.productId === f.productId,
    );
  }

  /**
   * Check if a device matches our USB filters (vendor+product or printer class).
   */
  _matchesFilters(device: any): boolean {
    for (const f of USB_DEVICE_FILTERS) {
      if (f.classCode !== undefined) {
        // Printer-class filter: check the device's interface class
        if (device.configuration?.interfaces) {
          for (const iface of device.configuration.interfaces) {
            for (const alt of iface.alternates) {
              if (alt.interfaceClass === f.classCode) return true;
            }
          }
        }
      } else if (f.vendorId !== undefined && f.productId !== undefined) {
        if (device.vendorId === f.vendorId && device.productId === f.productId) return true;
      }
    }
    return false;
  }

  /**
   * Connect to a Phomemo printer via USB
   * @param {Object} options - Connection options (unused for USB, for API consistency)
   */
  async connect(options: any = {}): Promise<boolean> {
    // Memoise the in-flight attempt, so a concurrent caller (the Connect button racing
    // ensureConnected() from a Ctrl+P) joins it instead of opening a second chooser.
    if (this._connectPromise) return this._connectPromise;
    this._connectPromise = this._connect(options).finally(() => { this._connectPromise = null; });
    return this._connectPromise;
  }

  private async _connect(_options: any = {}): Promise<boolean> {
    if (!USBTransport.isAvailable()) {
      throw new Error('WebUSB is not supported in this browser');
    }

    // Try to reconnect to existing device first
    if (await this.tryReconnect()) {
      return true;
    }

    try {
      // Request device - show picker
      trace('Requesting USB device...');
      this.device = await navigator.usb.requestDevice({
        filters: USB_DEVICE_FILTERS
      });

      trace(`Selected device: ${this.device.productName || 'USB Device'}`);

      await this.connectToDevice(this.device);
      return true;
    } catch (error) {
      console.error('USB connection error:', error);
      throw error;
    }
  }

  /**
   * Connect to a specific device (used for initial connect and reconnect)
   */
  async connectToDevice(device: any): Promise<boolean> {
    this.device = device;

    // One block owns everything after the device is taken on. Previously only two paths cleaned
    // up, so a failure at open(), selectConfiguration() or claimInterface() propagated with the
    // device STILL OPEN and this.device pointing at it while connected was false — the page kept
    // the handle, and tryReconnect's catch only logged and moved on.
    try {
      await this.device.open();

      // Select configuration
      if (this.device.configuration === null) {
        await this.device.selectConfiguration(1);
      }

      // Find and claim printer interface.
      // Remember the interface object itself — indexing by interfaceNumber into the
      // interfaces array is wrong on composite devices (number ≠ array position).
      let printerIface: any = null;
      for (const iface of this.device.configuration.interfaces) {
        for (const alt of iface.alternates) {
          if (alt.interfaceClass === 7) { // Printer class
            printerIface = iface;
            break;
          }
        }
        if (printerIface) break;
      }
      if (!printerIface) throw new Error('No printer-class interface found');

      await this.device.claimInterface(printerIface.interfaceNumber);
      trace(`Claimed interface ${printerIface.interfaceNumber}`);

      // Find the OUT endpoint on the same interface object.
      // An explicit `found` flag, not a falsy test: USB endpoint number 0 is legal, and
      // `if (!this.endpointOut)` reported a printer whose data endpoint is 0 as having none.
      let foundOut = false;
      for (const alt of printerIface.alternates) {
        for (const endpoint of alt.endpoints) {
          if (endpoint.direction === 'out') {
            this.endpointOut = endpoint.endpointNumber;
            foundOut = true;
            break;
          }
        }
        if (foundOut) break;
      }
      if (!foundOut) throw new Error('No OUT endpoint found');

      // Watch for the cable being pulled. Detach any previous handler first: the field was
      // overwritten on each connect, so every earlier closure stayed attached to navigator.usb
      // for the life of the page, and after five connect/unplug cycles five live handlers ran on
      // every disconnect event.
      if (typeof navigator !== 'undefined' && navigator.usb?.removeEventListener && this._usbDisconnectHandler) {
        navigator.usb.removeEventListener('disconnect', this._usbDisconnectHandler);
        this._usbDisconnectHandler = null;
      }
      if (typeof navigator !== 'undefined' && navigator.usb?.addEventListener) {
        this._usbDisconnectHandler = (event: any) => {
          if (event.device !== this.device) return;
          trace('USB device disconnected');
          this.connected = false;
          this.device = null;
          this.endpointOut = null;
          // Detach from inside the handler: it will never be needed again for this device.
          if (typeof navigator !== 'undefined' && navigator.usb?.removeEventListener) {
            navigator.usb.removeEventListener('disconnect', this._usbDisconnectHandler!);
          }
          this._usbDisconnectHandler = null;
          if (this.onDisconnect) this.onDisconnect();
        };
        navigator.usb.addEventListener('disconnect', this._usbDisconnectHandler);
      }

      this.connected = true;
      trace('USB connected to', this.device.productName);
      return true;
    } catch (e) {
      try { await device.close(); } catch { /* already gone */ }
      this.device = null;
      this.connected = false;
      this.endpointOut = null;
      throw e;
    }
  }

  /**
   * Disconnect from device
   */
  async disconnect() {
    if (this._usbDisconnectHandler && typeof navigator !== 'undefined' && navigator.usb?.removeEventListener) {
      navigator.usb.removeEventListener('disconnect', this._usbDisconnectHandler);
      this._usbDisconnectHandler = null;
    }
    if (this.device) {
      try {
        await this.device.close();
      } catch (e) {
        console.warn('Error closing device:', e);
      }
    }
    this.connected = false;
    this.device = null;
    this.endpointOut = null;
  }

  /**
   * Send data to the printer
   */
  async send(data: any) {
    // `this.endpointOut === null` rather than a falsy test: endpoint number 0 is legal.
    if (!this.connected || !this.device || this.endpointOut === null || this.endpointOut === undefined) {
      throw new Error('Not connected');
    }

    // Same normalisation as the BLE transport: a DataView has byteLength/byteOffset but no
    // `length`, so `new Uint8Array(data)` yields an empty array and send() would report a
    // complete zero-byte transfer — a silent no-op in a byte-exact path.
    let view: Uint8Array;
    if (ArrayBuffer.isView(data)) {
      view = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    } else if (Array.isArray(data)) {
      view = new Uint8Array(data);
    } else if (data != null && typeof (data as ArrayLike<number>).length === 'number') {
      view = new Uint8Array(Array.from(data as ArrayLike<number>));
    } else {
      throw new Error('send() expects an ArrayBuffer, a typed array, or an array of bytes');
    }
    if (view.length === 0) throw new Error('send() was given an empty buffer');
    const buffer = view;

    // A bulk OUT endpoint is PERMITTED to accept fewer bytes than offered while reporting
    // status 'ok'. Treating that as a hard failure threw away the unwritten tail of a raster
    // chunk, and runOps has no retry — so the label lost bytes silently. Loop over the
    // remainder instead; a transfer that writes nothing is a real failure and is bounded.
    let written = 0;
    for (let attempt = 0; written < buffer.length && attempt < 8; attempt++) {
      const result = await this.device.transferOut(this.endpointOut, buffer.subarray(written));

      if (result.status === 'stall') {
        // Clear the endpoint and retry the same offset once per pass.
        try { await this.device.clearHalt('out', this.endpointOut); } catch { /* fall through */ }
        continue;
      }
      if (result.status !== 'ok') {
        throw new Error(`USB transfer failed: status=${result.status}, written=${written}/${buffer.length}`);
      }
      if (!result.bytesWritten) break;   // no progress; the loop would spin
      written += result.bytesWritten;
    }

    if (written < buffer.length) {
      throw new Error(`USB transfer incomplete: ${written}/${buffer.length} bytes written`);
    }
  }

  /**
   * Send data in chunks with delays
   */
  async sendChunked(data: any, onProgress: any = null) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const totalChunks = Math.ceil(bytes.length / CHUNK_SIZE);

    for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
      const chunk = bytes.slice(i, Math.min(i + CHUNK_SIZE, bytes.length));
      await this.send(chunk);
      await this.delay(CHUNK_DELAY);

      if (onProgress) {
        const chunkNum = Math.floor(i / CHUNK_SIZE) + 1;
        const progress = Math.round((i + chunk.length) / bytes.length * 100);
        onProgress(chunkNum, totalChunks, progress);
      }
    }
  }

  /**
   * Delay helper. Honours an AbortSignal so a cancel takes effect immediately.
   */
  delay(ms: number, signal?: AbortSignal) {
    if (signal?.aborted) return Promise.reject(new DOMException('Print cancelled', 'AbortError'));
    return new Promise((resolve: any, reject: any) => {
      const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
      const onAbort = () => { clearTimeout(timer); reject(new DOMException('Print cancelled', 'AbortError')); };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.connected && !!this.device?.opened;
  }

  /**
   * Get device name
   */
  getDeviceName() {
    return this.device?.productName || 'USB Printer';
  }
}
