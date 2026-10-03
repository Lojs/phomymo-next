/**
 * WebUSB transport for Phomymo
 */

import { trace } from '../core/trace';

// Known USB IDs for Phomemo printers
const USB_DEVICE_FILTERS = [
  // Standard Phomemo printers (M110, M220, etc.)
  { vendorId: 0x0483, productId: 0x5740 },
  { vendorId: 0x0483 }, // Any device from this vendor
  // PM-241 shipping label printer
  { vendorId: 0x2e3c, productId: 0x5750 },
  { vendorId: 0x2e3c }, // Any device from this vendor
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

      // Get known vendor IDs from filter list
      const knownVendorIds = [...new Set(USB_DEVICE_FILTERS.map(f => f.vendorId))];

      for (const device of devices) {
        if (knownVendorIds.includes(device.vendorId)) {
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

    // Find and claim printer interface
    let interfaceNum = 0;
    for (const iface of this.device.configuration.interfaces) {
      for (const alt of iface.alternates) {
        if (alt.interfaceClass === 7) { // Printer class
          interfaceNum = iface.interfaceNumber;
          break;
        }
      }
    }

    await this.device.claimInterface(interfaceNum);
    trace(`Claimed interface ${interfaceNum}`);

    // Find OUT endpoint
    const iface = this.device.configuration.interfaces[interfaceNum];
    for (const alt of iface.alternates) {
      for (const endpoint of alt.endpoints) {
        if (endpoint.direction === 'out') {
          this.endpointOut = endpoint.endpointNumber;
          break;
        }
      }
    }

    if (!this.endpointOut) {
      throw new Error('No OUT endpoint found');
    }

    this.connected = true;
    trace('USB connected to', this.device.productName);
  }

  /**
   * Disconnect from device
   */
  async disconnect() {
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
    await this.device.transferOut(this.endpointOut, buffer);
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
  isConnected() {
    return this.connected;
  }

  /**
   * Get device name
   */
  getDeviceName() {
    return this.device?.productName || 'USB Printer';
  }
}
