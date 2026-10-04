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
        // Check if this device matches our filters (vendor+product or printer class)
        if (this._matchesFilters(device)) {
          trace('Found authorized Phomemo device:', device.productName);
          try {
            await this.connectToDevice(device);
            return true;
          } catch (e) {
            trace('Could not connect to', device.productName);
          }
        }
      }
    } catch (e) {
      trace('getDevices failed:', e.message);
    }

    return false;
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
  async connect(_options: any = {}) {
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
  async connectToDevice(device: any) {
    this.device = device;

    // Open device
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

    if (!printerIface) {
      await this.device.close();
      this.device = null;
      throw new Error('No printer-class interface found');
    }

    await this.device.claimInterface(printerIface.interfaceNumber);
    trace(`Claimed interface ${printerIface.interfaceNumber}`);

    // Find OUT endpoint on the same interface object
    for (const alt of printerIface.alternates) {
      for (const endpoint of alt.endpoints) {
        if (endpoint.direction === 'out') {
          this.endpointOut = endpoint.endpointNumber;
          break;
        }
      }
      if (this.endpointOut) break;
    }

    if (!this.endpointOut) {
      await this.device.close();
      this.device = null;
      throw new Error('No OUT endpoint found');
    }

    // Listen for USB disconnect (cable pulled, device powered off)
    if (typeof navigator !== 'undefined' && navigator.usb?.addEventListener) {
      navigator.usb.addEventListener('disconnect', this._usbDisconnectHandler = (event: any) => {
        if (event.device === this.device) {
          trace('USB device disconnected');
          this.connected = false;
          this.device = null;
          this.endpointOut = null;
          if (this.onDisconnect) this.onDisconnect();
        }
      });
    }

    this.connected = true;
    trace('USB connected to', this.device.productName);
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
    if (!this.connected || !this.device || !this.endpointOut) {
      throw new Error('Not connected');
    }

    const buffer = data instanceof Uint8Array ? data : new Uint8Array(data);
    const result = await this.device.transferOut(this.endpointOut, buffer);

    if (result.status !== 'ok' || result.bytesWritten !== buffer.length) {
      // On 'stall', try clearing the endpoint and retrying once before giving up.
      if (result.status === 'stall') {
        try {
          await this.device.clearHalt('out', this.endpointOut);
          const retry = await this.device.transferOut(this.endpointOut, buffer);
          if (retry.status === 'ok' && retry.bytesWritten === buffer.length) return;
        } catch {
          // fall through to throw
        }
      }
      throw new Error(`USB transfer failed: status=${result.status}, bytesWritten=${result.bytesWritten}/${buffer.length}`);
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
   * Delay helper
   */
  delay(ms: any) {
    return new Promise((resolve: any) => setTimeout(resolve, ms));
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
