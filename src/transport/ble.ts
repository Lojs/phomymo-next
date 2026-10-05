/**
 * Web Bluetooth transport for Phomymo
 *
 * Features:
 * - First connection requires user to select device from picker
 * - Once connected, device is remembered for reconnection
 * - Automatic retry with exponential backoff for reliable connections
 * - Handles timing issues common with BLE GATT connections
 */

import { BLE } from './constants';
import { trace } from '../core/trace';

// Printer query commands (format: [0x1F, 0x11, X])
const QUERY_COMMANDS = {
  battery: [0x1F, 0x11, 0x08],
  firmware: [0x1F, 0x11, 0x07],
  serial: [0x1F, 0x11, 0x09],
  paper: [0x1F, 0x11, 0x11],
  cover: [0x1F, 0x11, 0x12],
  version: [0x1F, 0x11, 0x33],
  mac: [0x1F, 0x11, 0x20],
  power: [0x1F, 0x11, 0x0E],
  label: [0x1F, 0x11, 0x19],
};

// Singleton instance
let sharedInstance: any = null;

export class BLETransport {
  // Still `any`, and deliberately. @types/web-bluetooth is now installed and wired into tsconfig's
  // `types` allowlist, so navigator.bluetooth and every requestDevice option ARE checked — that was
  // the gap worth closing. These five handles are a different job: the transport stores null in them
  // on disconnect, bolts its own _hasDisconnectHandler bookkeeping onto the device, and reads a
  // DataView window the spec types but the runtime hands over loosely. Naming the spec types here
  // turns ~20 honest `possibly null` and out-of-spec-property errors into non-null assertions, which
  // would silence the compiler without making the code safer. Left as-is, and noted as the known
  // remaining `any` rather than pretending otherwise.
  device: any;
  server: any;
  service: any;
  writeChar: any;
  notifyChar: any;
  connected: boolean;
  onDisconnect: (() => void) | null;
  onPrinterInfo: ((field: string, value: unknown, info: Record<string, unknown>) => void) | null;
  _useWriteWithResponse: boolean;
  /** The part of a `characteristicvaluechanged` event the transport reads. */
  _notificationHandler: ((event: Event) => void) | null = null;
  /** Pending waitForResponse() resolvers, so a disconnect can resolve them all with null. */
  _pendingWaiters: Set<{ resolve: (v: unknown) => void; cleanup: () => void }> = new Set();
  /** The 'gattserverdisconnected' handler currently attached to `this.device`, so it can be removed. */
  _deviceDisconnectHandler: (() => void) | null = null;
  /** Bumped on every fresh attach; a handler from an older generation is ignored. */
  _generation = 0;
  /** The in-flight connect() attempt, so a concurrent caller joins it instead of starting a second. */
  _connectPromise: Promise<boolean> | null = null;
  printerInfo: Record<string, unknown>;
  _queryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.device = null;
    this.server = null;
    this.service = null;
    this.writeChar = null;
    this.notifyChar = null;
    this.connected = false;
    this.onDisconnect = null;
    this.onPrinterInfo = null; // Callback for printer info updates
    this._useWriteWithResponse = false; // Some devices need writeValue instead of writeValueWithoutResponse
    this.printerInfo = {
      battery: null,
      paper: null,
      firmware: null,
      serial: null,
      cover: null,
      version: null,
      mac: null,
      power: null,
      label: null,
    };
  }

  static getShared() {
    if (!sharedInstance) {
      sharedInstance = new BLETransport();
    }
    return sharedInstance;
  }

  static isAvailable() {
    return 'bluetooth' in navigator;
  }

  /**
   * True when a device handle is still held, so connect() can rebuild the GATT link without
   * showing the picker. gattserverdisconnected clears the characteristics but leaves `this.device`
   * in place, which is what makes a silent reconnect possible; disconnect() clears it, and so does
   * a failed reconnect, after which only the user can reconnect.
   */
  hasRememberedDevice() {
    return !!this.device;
  }

  /**
   * Main connect method
   * @param {Object} options - Connection options
   * @param {boolean} options.showAllDevices - If true, show all Bluetooth devices instead of filtering
   */
  async connect(options: { showAllDevices?: boolean } = {}): Promise<boolean> {
    // Memoize the in-flight attempt. connect() is reachable from the Connect button AND from
    // ensureConnected() (which printCurrent() calls), and the Print button is not disabled on
    // conn.busy — so Ctrl+P while the picker was open started a SECOND connect on this singleton.
    // The second requestDevice() rejects with InvalidStateError, which used to be misread as "the
    // name filter failed" and issue a THIRD request; both calls then assigned this.device while
    // connectGATT re-read it, so the first call could open GATT on the device the second picked.
    if (this._connectPromise) return this._connectPromise;
    this._connectPromise = this._connect(options).finally(() => { this._connectPromise = null; });
    return this._connectPromise;
  }

  private async _connect({ showAllDevices = false }: { showAllDevices?: boolean } = {}): Promise<boolean> {
    if (!BLETransport.isAvailable()) {
      throw new Error('Bluetooth not supported');
    }

    // Already connected?
    if (this.isConnected()) {
      trace('Already connected');
      return true;
    }

    // Try reconnecting to known device (from this session)
    if (this.device) {
      try {
        trace('Reconnecting to', this.device.name);
        await this.retryWithBackoff(
          () => this.connectGATT(),
          BLE.MAX_RETRIES,
          BLE.INITIAL_RETRY_DELAY_MS
        );
        return true;
      } catch (e) {
        trace('Reconnect failed after retries:', e.message);
        this.device = null;
      }
    }

    // Skip trying previously paired devices - they're often "ghost" entries
    // that give "Unsupported device" errors. Go straight to picker where
    // the user can select the device showing signal strength.
    if ('getDevices' in navigator.bluetooth) {
      const devices = await navigator.bluetooth.getDevices();
      trace('Skipping paired devices (may be ghosts):', devices.map((d: any) => d.name).join(', ') || 'none');
    }

    // No paired device worked - show picker
    // May need multiple picker selections due to "Unsupported device" issue on first pairing
    for (let pickerAttempt = 0; pickerAttempt < 3; pickerAttempt++) {
      trace('Showing device picker...');

      // Include all potential service UUIDs for different printer models
      const optionalServices = BLE.ALT_SERVICE_UUIDS || [BLE.SERVICE_UUID];

      if (showAllDevices) {
        // User requested to see all devices (Shift+Click on Connect)
        trace('Showing ALL Bluetooth devices (filter bypassed)');
        this.device = await navigator.bluetooth.requestDevice({
          acceptAllDevices: true,
          optionalServices,
        });
      } else {
        // Use name prefix filter to show Phomemo printers
        // This helps filter out ghost devices while still showing the printer
        try {
          this.device = await navigator.bluetooth.requestDevice({
            filters: [
              { namePrefix: 'M' },      // M110, M220, M260, etc.
              { namePrefix: 'D' },      // D30, D110, etc.
              { namePrefix: 'P' },      // P12, P12 Pro, PM-241
              { namePrefix: 'Q' },      // M110S (advertises as Q199E... pattern)
              { namePrefix: 'T' },      // T02
              { namePrefix: 'A' },      // A30
              { namePrefix: 'Mr.in' },  // Mr.in series
              { namePrefix: 'Phomemo' },
            ],
            optionalServices,
          });
        } catch (filterError) {
          // Only fall back to acceptAllDevices if the failure is NOT a user cancel.
          // NotFoundError means the user closed the chooser — opening a second one
          // makes it look like the first cancel didn't work.
          if ((filterError as Error)?.name === 'NotFoundError') throw filterError;
          trace('Name filter failed, trying acceptAllDevices:', (filterError as Error).message);
          this.device = await navigator.bluetooth.requestDevice({
            acceptAllDevices: true,
            optionalServices,
          });
        }
      }

      // Log device name prominently so users can report unrecognized devices
      trace('═══════════════════════════════════════════════════');
      trace('SELECTED DEVICE NAME:', this.device.name);
      trace('If this device is not recognized, please report this name');
      trace('═══════════════════════════════════════════════════');

      // Wait for device to be ready
      await this.waitForDeviceReady();

      try {
        // Try to connect with retries
        await this.retryWithBackoff(
          () => this.connectGATT(),
          BLE.MAX_RETRIES,
          BLE.INITIAL_RETRY_DELAY_MS,
          (attempt: number) => trace(`Connection attempt ${attempt} failed, retrying...`)
        );
        return true; // Success!
      } catch (error) {
        // If we get "Unsupported device", the device object from this requestDevice is broken
        // Clear it and try getting a fresh one from the picker
        if (error.message && error.message.includes('Unsupported')) {
          trace('Device object appears broken, will request fresh device from picker...');
          this.device = null;
          // Small delay before showing picker again
          await this.delay(500);
          continue; // Try picker again
        }
        throw error; // Other errors, propagate up
      }
    }

    throw new Error('Failed to connect after multiple attempts');
  }

  /**
   * Wait for device to be ready by watching for advertisements
   * This helps with first-time pairing where the device isn't immediately usable
   */
  async waitForDeviceReady(timeout = 5000) {
    // Check if watchAdvertisements is supported
    if (!this.device.watchAdvertisements) {
      trace('watchAdvertisements not supported, using 3s delay for pairing to complete...');
      await this.delay(3000);
      return;
    }

    return new Promise((resolve: any) => {
      const abortController = new AbortController();
      const device = this.device;
      let settled = false;

      // One finish path for all three exits. The listener is `{ once: true }`, so the
      // advertisement branch self-cleans — but the TIMEOUT and watchAdvertisements branches did not
      // remove it, and connect() calls waitForDeviceReady() once per picker attempt (up to three)
      // against a device the spec keeps alive for the page's lifetime, so the closures accumulated.
      const onAdvertisement = () => {
        trace('Device advertisement received, device is ready');
        finish();
      };
      function finish() {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        device.removeEventListener('advertisementreceived', onAdvertisement);
        try { abortController.abort(); } catch { /* already aborted */ }
        resolve();
      }

      const timeoutId = setTimeout(() => {
        if (!settled) trace('Device ready timeout, proceeding anyway...');
        finish();
      }, timeout);

      device.addEventListener('advertisementreceived', onAdvertisement, { once: true });

      // Start watching
      trace('Waiting for device to be ready...');
      device.watchAdvertisements({ signal: abortController.signal })
        .catch((e: any) => {
          // watchAdvertisements may fail or be aborted, that's okay
          if (!settled) trace('watchAdvertisements ended:', e.message);
          finish();
        });
    });
  }

  /**
   * Connect to GATT server and get characteristics
   */
  async connectGATT() {
    // Setup disconnect handler.
    //
    // The handler is tracked so it can be DETACHED, and stamped with a generation counter so a
    // handler left over from an earlier device can never tear down a newer, healthy connection.
    // Per the Web Bluetooth spec a BluetoothDevice lives for the lifetime of the global, so an
    // attached listener is retained for the whole session, not merely until GC — with two printers
    // A and B, connect A, pick B, and every later flap of A fired this handler and nulled B's
    // writeChar while `this.device` was B. That made a working printer report "Not connected" until
    // the user reconnected, silently and repeatedly.
    if (!this.device._hasDisconnectHandler) {
      const device = this.device;
      this._generation += 1;
      const gen = this._generation;
      const handler = () => {
        if (gen !== this._generation) return;   // stale handler from an older device
        trace('Disconnected');
        this.connected = false;
        this.server = null;
        this.service = null;
        this.writeChar = null;
        // Remove notification listener to prevent memory leaks
        if (this.notifyChar && this._notificationHandler) {
          this.notifyChar.removeEventListener('characteristicvaluechanged', this._notificationHandler);
        }
        this.notifyChar = null;
        this._notificationHandler = null;
        // Resolve any pending waitForResponse() calls so they don't hang forever. Each waiter's own
        // cleanup runs too, so its timer and listener are released rather than left armed until
        // the timeout — this is the one place add/removeEventListener were not paired.
        for (const w of [...this._pendingWaiters]) { w.cleanup(); w.resolve(null); }
        this._pendingWaiters.clear();
        // Detach from the device that disconnected, so it cannot fire again.
        if (device && this._deviceDisconnectHandler) {
          device.removeEventListener('gattserverdisconnected', this._deviceDisconnectHandler);
          this._deviceDisconnectHandler = null;
          delete device._hasDisconnectHandler;
        }
        if (this.onDisconnect) this.onDisconnect();
      };
      this._deviceDisconnectHandler = handler;
      device.addEventListener('gattserverdisconnected', handler);
      device._hasDisconnectHandler = true;
    }

    // Reset state before attempting connection (important for retries)
    this.connected = false;
    this.server = null;
    this.service = null;
    this.writeChar = null;
    this.notifyChar = null;

    trace('Connecting GATT...');
    this.server = await this.device.gatt.connect();

    // From here the radio link is UP, so every failure below must give it back. Previously a
    // missing service or an absent write characteristic threw with the GATT connection still
    // open: retryWithBackoff then re-ran connectGATT, whose gatt.connect() resolves immediately
    // on an already-connected device, so both attempts spun on the same dead link. On the silent
    // reconnect path this.device was then set to null and nothing held a reference — the printer
    // stayed connected to this page for the rest of the session, holding the radio, with no way
    // for the user to release it short of a reload.
    try {
      // Small delay after GATT connect before service discovery
      // This helps with timing issues on some devices
      await this.delay(100);

      // Try to find a working service (some printers use different UUIDs)
      trace('Getting service...');
      const servicesToTry = BLE.ALT_SERVICE_UUIDS || [BLE.SERVICE_UUID];
      let lastError = null;

      for (const serviceUuid of servicesToTry) {
        try {
          trace(`Trying service UUID: ${typeof serviceUuid === 'number' ? '0x' + serviceUuid.toString(16) : serviceUuid}`);
          this.service = await this.server.getPrimaryService(serviceUuid);
          trace('Service found!');
          break;
        } catch (e) {
          lastError = e;
          trace(`Service ${typeof serviceUuid === 'number' ? '0x' + serviceUuid.toString(16) : serviceUuid} not found`);
        }
      }

      if (!this.service) {
        throw new Error(`No compatible Bluetooth service found. Last error: ${lastError?.message}`);
      }

      trace('Getting characteristics...');
      this.writeChar = await this.service.getCharacteristic(BLE.WRITE_CHAR_UUID);

      // Log characteristic properties for debugging
      const props = this.writeChar.properties;
      trace('Write characteristic properties:', {
        write: props.write,
        writeWithoutResponse: props.writeWithoutResponse,
        read: props.read,
        notify: props.notify,
      });

      // Determine if we need to use writeValue instead of writeValueWithoutResponse
      this._useWriteWithResponse = !props.writeWithoutResponse && props.write;
      if (this._useWriteWithResponse) {
        trace('Device requires writeValue (with response)');
      }

      try {
        this.notifyChar = await this.service.getCharacteristic(BLE.NOTIFY_CHAR_UUID);
        await this.notifyChar.startNotifications();

        // Set up notification handler (store reference for cleanup)
        this._notificationHandler = (event: any) => {
          this.handleNotification(event);
        };
        this.notifyChar.addEventListener('characteristicvaluechanged', this._notificationHandler);

        trace('Notifications enabled');
      } catch (e) {
        console.warn('Notifications not available:', e.message);
      }

      // The device may have dropped between startNotifications() and here, in which case the
      // disconnect handler has already nulled writeChar/notifyChar. Stamping connected = true
      // onto a dead link leaves the transport in an inconsistent half-open state.
      if (!this.device?.gatt?.connected) {
        throw new Error('GATT connection dropped during setup');
      }
      this.connected = true;
      trace('Connected to', this.device.name);
    } catch (e) {
      // Detach the disconnect handler and bump the generation BEFORE dropping the link.
      // gatt.disconnect() makes the browser fire 'gattserverdisconnected', and with the handler
      // still current that ran the whole teardown — including onDisconnect(). The app then showed
      // "disconnected" while connectPrinter() was still retrying, which re-enabled the Connect and
      // Print buttons so a second connect could start alongside the first, and set
      // droppedByItself, which could trigger an unwanted auto-reconnect when the tab regained
      // focus. Bumping the generation first makes the event our own cleanup caused a no-op.
      const device = this.device;
      if (device && this._deviceDisconnectHandler) {
        device.removeEventListener('gattserverdisconnected', this._deviceDisconnectHandler);
        delete device._hasDisconnectHandler;
      }
      this._deviceDisconnectHandler = null;
      this._generation += 1;
      try { device?.gatt?.disconnect(); } catch { /* already gone */ }
      this.connected = false;
      this.server = null;
      this.service = null;
      this.writeChar = null;
      this.notifyChar = null;
      this._notificationHandler = null;
      throw e;
    }
  }

  /**
   * Disconnect from device
   */
  async disconnect() {
    // Stop notifications and remove listener before disconnecting
    if (this.notifyChar) {
      try {
        if (this._notificationHandler) {
          this.notifyChar.removeEventListener('characteristicvaluechanged', this._notificationHandler);
        }
        await this.notifyChar.stopNotifications();
      } catch (e) {
        // Ignore errors during cleanup (device may already be disconnected)
      }
    }
    if (this.device && this.device.gatt?.connected) {
      this.device.gatt.disconnect();
    }
    // Detach the 'gattserverdisconnected' handler too. Without this the listener survives on the
    // BluetoothDevice — which the spec keeps alive for the lifetime of the global — and a later
    // flap of that device fires a handler that nulls `this.server`/`writeChar` for whatever
    // printer is connected NOW. Bumping the generation makes any already-queued handler a no-op.
    if (this.device && this._deviceDisconnectHandler) {
      this.device.removeEventListener('gattserverdisconnected', this._deviceDisconnectHandler);
      delete this.device._hasDisconnectHandler;
    }
    this._deviceDisconnectHandler = null;
    this._generation += 1;
    this.connected = false;
    this.device = null;
    this.server = null;
    this.service = null;
    this.writeChar = null;
    this.notifyChar = null;
    this._notificationHandler = null;
    // Release any waiter still armed: its timer and listener go with it.
    for (const w of [...this._pendingWaiters]) { w.cleanup(); w.resolve(null); }
    this._pendingWaiters.clear();
    this.resetPrinterInfo();
  }

  /**
   * Send data to the printer
   */
  async send(data: any) {
    if (!this.isConnected()) {
      throw new Error('Not connected');
    }

    // Normalise whatever the encoders handed us into an exact byte range.
    //
    // `new Uint8Array(data)` on an object that is neither iterable nor array-like yields a
    // ZERO-LENGTH array. A DataView is exactly that: it has byteLength/byteOffset but no
    // length. So a DataView would have produced an empty payload, and in USB the
    // bytesWritten check could never fire because both sides were 0 — a completely silent
    // no-op in a byte-exact path.
    let view: Uint8Array;
    if (data instanceof ArrayBuffer) {
      view = new Uint8Array(data);
    } else if (ArrayBuffer.isView(data)) {
      // Any typed array or DataView: honour its window rather than its backing buffer. This is
      // also the path a raster chunk takes — a subarray of a much larger buffer, where writing
      // the backing buffer would send megabytes of unrelated pixels.
      view = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    } else if (Array.isArray(data)) {
      view = new Uint8Array(data);
    } else if (data != null && typeof (data as ArrayLike<number>).length === 'number') {
      // A plain array-like (an arguments object, say).
      view = new Uint8Array(Array.from(data as ArrayLike<number>));
    } else {
      throw new Error('send() expects an ArrayBuffer, a typed array, or an array of bytes');
    }
    if (view.length === 0) throw new Error('send() was given an empty buffer');
    const buffer = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);

    // Use the appropriate write method based on characteristic properties
    if (this._useWriteWithResponse) {
      await this.writeChar.writeValue(buffer);
    } else {
      try {
        await this.writeChar.writeValueWithoutResponse(buffer);
      } catch (e) {
        // Fallback to writeValue if writeValueWithoutResponse fails.
        //
        // Only a PERSISTENT capability failure flips the mode. In Web Bluetooth, InvalidStateError
        // from writeValueWithoutResponse is the canonical TRANSIENT "GATT connection is gone"
        // error — what you get when the printer drops mid-job, not when the characteristic lacks
        // the capability. Including it here halved throughput for the rest of the session after
        // every mid-job disconnect (one round-trip per chunk instead of fire-and-forget).
        const name = (e as Error)?.name;
        if (name === 'NotSupportedError') {
          this._useWriteWithResponse = true;
        }
        await this.writeChar.writeValue(buffer);
      }
    }
  }

  /**
   * Wait for a response from the printer (BLE notification)
   *
   * Resolves on the FIRST notification of any kind, including the unsolicited frames the printer
   * pushes on its own (cover 1a 05 99, paper-out 1a 06 88, print-status 1a 0b ..). A filter to wait
   * for one specific frame existed as an `expect` argument, but no caller ever passed one, so the
   * P12 handshake concern it was written for was never addressed; it has been removed rather than
   * left as an unused path into a waiter.
   *
   * @param {number} timeout - Maximum time to wait in ms (default 500)
   * @returns {Promise<DataView|null>} Response data, or null on timeout/disconnect
   */
  async waitForResponse(timeout = 500, signal?: AbortSignal) {
    if (!this.notifyChar) {
      // No notification characteristic, use delay fallback
      await this.delay(timeout, signal);
      return null;
    }

    // Capture the characteristic in a local so a disconnect during the wait
    // cannot null it out from under the timer/handler.
    const ch = this.notifyChar;

    return new Promise((resolve: any, reject: any) => {
      const waiter: { resolve: (v: unknown) => void; cleanup: () => void } = { resolve, cleanup: () => {} };
      this._pendingWaiters.add(waiter);

      const cleanup = () => {
        this._pendingWaiters.delete(waiter);
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        ch.removeEventListener('characteristicvaluechanged', handler);
      };
      waiter.cleanup = cleanup;

      const onAbort = () => { cleanup(); reject(new DOMException('Print cancelled', 'AbortError')); };
      const timer = setTimeout(() => {
        cleanup();
        resolve(null);
      }, timeout);

      if (signal?.aborted) { cleanup(); reject(new DOMException('Print cancelled', 'AbortError')); return; }
      signal?.addEventListener('abort', onAbort, { once: true });

      const handler = (event: any) => {
        const v = event.target.value;
        // Honour the DataView's window. `new Uint8Array(v.buffer)` ignored byteOffset/byteLength
        // and printed the whole backing buffer, so the [BLE Response] trace showed bytes the
        // printer never sent. handleNotification reads it correctly; this was the odd one out.
        const data = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
        cleanup();
        trace('[BLE Response]', Array.from(data).map(b => b.toString(16).padStart(2, '0')).join(' '));
        resolve(v);
      };

      ch.addEventListener('characteristicvaluechanged', handler);
    });
  }

  /**
   * Send data in chunks with delays
   */
  async sendChunked(data: any, onProgress: any = null) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const totalChunks = Math.ceil(bytes.length / BLE.CHUNK_SIZE);

    for (let i = 0; i < bytes.length; i += BLE.CHUNK_SIZE) {
      const chunk = bytes.slice(i, Math.min(i + BLE.CHUNK_SIZE, bytes.length));
      await this.send(chunk);
      await this.delay(BLE.CHUNK_DELAY_MS);

      if (onProgress) {
        const chunkNum = Math.floor(i / BLE.CHUNK_SIZE) + 1;
        const progress = Math.round((i + chunk.length) / bytes.length * 100);
        onProgress(chunkNum, totalChunks, progress);
      }
    }
  }

  /**
   * Delay helper. Honours an AbortSignal so a cancel does not have to wait the delay out —
   * the mSeries post-feed is 800 ms, which was the worst case between pressing Cancel and the
   * printer going quiet.
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
   * Retry a function with exponential backoff
   * @param {Function} fn - Async function to retry
   * @param {number} maxRetries - Maximum number of retries
   * @param {number} delay - Initial delay in ms (doubles each retry)
   * @param {Function} onRetry - Optional callback on retry (receives attempt number, error)
   */
  async retryWithBackoff(fn: any, maxRetries: any = BLE.MAX_RETRIES, delay: any = BLE.INITIAL_RETRY_DELAY_MS, onRetry: any = null) {
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        if (attempt < maxRetries) {
          const waitTime = delay * Math.pow(2, attempt);
          trace(`Attempt ${attempt + 1} failed: ${error.message}. Retrying in ${waitTime}ms...`);
          if (onRetry) onRetry(attempt + 1, error);
          await this.delay(waitTime);
        }
      }
    }
    throw lastError;
  }

  /**
   * Check if connected and ready to send data
   */
  isConnected(): boolean {
    return !!(this.connected &&
           this.device?.gatt?.connected &&
           this.writeChar !== null);
  }

  /**
   * Get device name
   */
  getDeviceName() {
    return this.device?.name || 'Unknown';
  }

  /**
   * Handle notification data from printer
   * Response format: 0x1A, type, data...
   */
  handleNotification(event: any) {
    const v = event.target.value;
    const data = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    trace('[BLE <<<]', Array.from(data).map(b => b.toString(16).padStart(2, '0')).join(' '));

    if (data.length < 2) return;

    // Handle special result/printer type responses (2-3 bytes)
    if (data.length === 2 && data[0] === 0x01) {
      trace('Result:', data[1]);
      return;
    }
    if (data.length === 3 && data[0] === 0x02) {
      trace('Printer type:', data[1]);
      return;
    }

    // Standard response format: 0x1A, type, data...
    if (data[0] !== 0x1A) return;
    if (data.length < 3) return; // Need at least 3 bytes for type + value

    const type = data[1];
    let value = null;
    let field = null;

    switch (type) {
      case 0x03: // Hot/heating status
        if (data[2] === 0xA9) value = -1;
        else if (data[2] === 0xA8) value = 0;
        else value = 1;
        field = 'hot';
        break;

      case 0x04: // Battery
        if (data[2] === 0xA4) value = 0;
        else if (data[2] === 0xA3) value = 3;
        else if (data[2] === 0xA2) value = 5;
        else if (data[2] === 0xA1) value = 10;
        else value = data[2];
        field = 'battery';
        this.printerInfo.battery = value;
        break;

      case 0x05: // Cover
        // 0x98 = closed, 0x99 = open. The upstream app had these two swapped, which displayed
        // "Open" for a closed lid (and vice versa). Confirmed by two independent M02-family
        // protocol references: sgrankin/phomemo PROTOCOL.md ("0x98 closed / 0x99 open") and the
        // M08F reference's spontaneous-event table (`1a 05 99` lid opened, `1a 05 98` lid closed).
        value = data[2] === 0x98 ? 'closed' : (data[2] === 0x99 ? 'open' : 'unknown');
        field = 'cover';
        this.printerInfo.cover = value;
        break;

      case 0x06: // Paper
        value = data[2] === 0x88 ? 'out' : 'ok';
        field = 'paper';
        this.printerInfo.paper = value;
        break;

      case 0x07: // Firmware
        value = this.data2dots(data, 2);
        field = 'firmware';
        this.printerInfo.firmware = value;
        break;

      case 0x08: // Serial
        value = this.data2string(data, 2);
        field = 'serial';
        this.printerInfo.serial = value;
        break;

      case 0x09: // Power
        value = data[2];
        field = 'power';
        this.printerInfo.power = value;
        break;

      case 0x0B: // Print status
        value = data[2] === 0xB8 ? -1 : data[2];
        field = 'print';
        break;

      case 0x0C: // Label
        if (data[2] === 0x0B) value = 0;
        else if (data[2] === 0x26) value = 3;
        else value = 2;
        field = 'label';
        this.printerInfo.label = value;
        break;

      case 0x0D: // MAC
        value = this.data2string(data, 2);
        field = 'mac';
        this.printerInfo.mac = value;
        break;

      case 0x0F: // Print status alt
        value = data[2] === 0x0C ? 1 : data[2];
        field = 'print';
        break;

      case 0x11: // Version
        value = this.data2dots(data, 2);
        field = 'version';
        this.printerInfo.version = value;
        break;

      case 0x17: // Chip
        value = data[2];
        field = 'chip';
        break;

      default:
        trace('Unknown response type:', type.toString(16));
        return;
    }

    trace(`Printer ${field}:`, value);

    // Notify callback if set
    if (this.onPrinterInfo) {
      this.onPrinterInfo(field, value, this.printerInfo);
    }
  }

  /**
   * Convert data bytes to dot-separated string (for firmware/version)
   */
  data2dots(data: any, start: any) {
    let str = '';
    for (let i = start; i < data.length; i++) {
      str += data[i];
      if (i < data.length - 1) str += '.';
    }
    return str;
  }

  /**
   * Convert data bytes to ASCII string
   */
  data2string(data: any, start: any) {
    let str = '';
    for (let i = start; i < data.length; i++) {
      str += String.fromCharCode(data[i]);
    }
    return str;
  }

  /**
   * Query printer for status information
   * @param {string} queryType - One of: battery, firmware, serial, paper, cover, version, mac, power, label
   */
  async query(queryType: any) {
    if (!this.isConnected()) {
      throw new Error('Not connected');
    }

    const command = (QUERY_COMMANDS as Record<string, number[]>)[queryType];
    if (!command) {
      throw new Error(`Unknown query type: ${queryType}`);
    }

    trace(`Querying ${queryType}...`);
    await this.send(new Uint8Array(command));
  }

  /**
   * Query all available printer info
   */
  async queryAll() {
    if (!this.isConnected()) {
      throw new Error('Not connected');
    }

    trace('Querying all printer info...');

    // Query each type with a small delay between. Cover is included: the printer also pushes it
    // unprompted when the lid moves, but asking on connect means a lid that was already closed
    // (so never generated an event) still reports its state instead of showing nothing.
    const queries = ['battery', 'paper', 'cover', 'firmware', 'serial'];
    for (const q of queries) {
      try {
        await this.query(q);
        await this.delay(100);
      } catch (e) {
        console.warn(`Query ${q} failed:`, e.message);
      }
    }
  }

  /**
   * Get current printer info
   */
  getPrinterInfo() {
    return { ...this.printerInfo };
  }

  /**
   * Reset printer info (on disconnect)
   */
  resetPrinterInfo() {
    this.printerInfo = {
      battery: null,
      paper: null,
      firmware: null,
      serial: null,
      cover: null,
      version: null,
      mac: null,
      power: null,
      label: null,
    };
  }
}
