/**
 * Printer connection and print orchestration. Owns the transport instance;
 * pushes state into the store; everything protocol-specific lives in core/.
 */
import { BLETransport } from '../transport/ble';
import { USBTransport } from '../transport/usb';
import { useStore } from '../state/store';
import { alignmentOf, isRotated, isTspl, isTape, type ResolvedConfig } from '../core/printers/definitions';
import { buildRaster, ditherModeOf, prepareForRender, type RasterTarget } from '../core/render/label';
import { encodeDensityTest, encodePrint, type Raster } from '../core/protocols/encoders';
import { runOps } from '../core/protocols/ops';
import type { LabelElement } from '../core/model/elements';
import { evaluateExpressions, substituteFields, substituteFieldsByZone, type TemplateRecord } from '../core/template/template';
import { getDeviceModel, getDeviceTapeWidth, saveDeviceModel, saveDeviceTapeWidth } from '../core/storage/storage';
import { displayLayout, multiLayout, needsPrintRotation } from '../core/render/layout';
import type { DitherMode } from '../core/raster/raster';
import { translate } from '../i18n';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let transport: any = null;
let kind: 'ble' | 'usb' | null = null;

/**
 * One print job at a time. The Print button is disabled while `print.active`, but the
 * Ctrl/Cmd+P shortcut calls printCurrent() directly, and a batch can be started while a single
 * job runs — either way two jobs would interleave their chunks on the same transport and produce
 * a garbled label. The guard lives here, not at the call sites, so no future caller can bypass it.
 */
let printing = false;

/**
 * The periodic battery refresh. The printer's own readout is otherwise only read once, at connect
 * time, so the percentage would sit at whatever it was when you paired. A timer keeps it honest.
 *
 * It is deliberately not a blind interval: each tick skips while a print is in flight, because the
 * status command and the raster chunks share one transport — the same reason `printing` above
 * exists. It also stops itself the moment the printer disconnects.
 */
let batteryTimer: ReturnType<typeof setInterval> | null = null;
const BATTERY_REFRESH_MS = 60_000;

function stopBatteryRefresh(): void {
  if (batteryTimer !== null) {
    clearInterval(batteryTimer);
    batteryTimer = null;
  }
}

function startBatteryRefresh(): void {
  stopBatteryRefresh();
  batteryTimer = setInterval(() => {
    // Skip a tick rather than queue one: if the printer is mid-job the reading can wait 60s, and
    // sending now would interleave with the raster.
    if (printing || !transport?.isConnected?.()) {
      if (!transport?.isConnected?.()) stopBatteryRefresh();
      return;
    }
    void transport.query?.('battery').catch(() => {});
  }, BATTERY_REFRESH_MS);
}

const st = () => useStore.getState();
const tr = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate(st().lang, key, vars);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Resolve once the given dialog is no longer the open one — i.e. the user answered it (or
 * dismissed it). Resolves immediately if it is not open. Used to hold a print until the model
 * picker has been answered, so the raster is not built with a stale `printerModel`.
 */
function waitForDialogToClose(name: NonNullable<ReturnType<typeof st>['dialog']>): Promise<void> {
  if (st().dialog !== name) return Promise.resolve();
  return new Promise((resolve) => {
    const unsub = useStore.subscribe((s: { dialog: string | null }) => {
      if (s.dialog !== name) {
        unsub();
        resolve();
      }
    });
  });
}

export const secureContextOk = () => window.isSecureContext;
export const bluetoothAvailable = () => BLETransport.isAvailable();
export const usbAvailable = () => USBTransport.isAvailable();
export const isConnected = () => !!transport && !!transport.isConnected();
/** True while a print job owns the transport. Anything else that writes to it must wait. */
export const isPrinting = () => printing;

/** Turns a raw WebBluetooth/WebUSB error into a message worth showing the user. */
export function friendlyConnectError(e: unknown): string {
  const err = e as { name?: string; message?: string };
  switch (err?.name) {
    case 'SecurityError':
      return tr('permissionDenied');
    case 'NetworkError':
      return tr('deviceUnavailable');
    case 'NotSupportedError':
      return tr('btUnsupported');
    default:
      return err?.message || tr('connectFailed');
  }
}

export async function connectPrinter(type: 'ble' | 'usb', showAllDevices = false): Promise<boolean> {
  if (!secureContextOk()) {
    st().setConn({ status: 'failed', error: tr('needsHttps') });
    st().toast(tr('needsHttps'), 'error');
    return false;
  }
  if (type === 'ble' && !bluetoothAvailable()) {
    st().setConn({ status: 'failed', error: tr('btUnsupported') });
    st().toast(tr('btUnsupported'), 'error');
    return false;
  }
  if (type === 'usb' && !usbAvailable()) {
    st().setConn({ status: 'failed', error: tr('usbUnsupported') });
    st().toast(tr('usbUnsupported'), 'error');
    return false;
  }

  st().setConn({ busy: true, status: 'connecting', error: null });
  try {
    transport = type === 'ble' ? BLETransport.getShared() : USBTransport.getShared();
    kind = type;
    transport.onDisconnect = () => {
      st().setConn({ connected: false, type: null, busy: false, status: 'disconnected', error: null });
      st().setPrinterInfo(null);
    };
    await transport.connect({ showAllDevices });
    if (!transport.isConnected()) throw new Error(tr('connectFailed'));

    const deviceName: string = transport.getDeviceName?.() || '';
    st().setConn({ type, connected: true, deviceName, busy: false, status: 'connected', error: null });
    await afterConnect(type, deviceName);
    return true;
  } catch (e) {
    const err = e as Error;
    if (err?.name === 'NotFoundError') {
      // The user closed the device picker without choosing anything — not a failure.
      st().setConn({ connected: false, type: null, busy: false, status: 'disconnected', error: null });
      return false;
    }
    const message = friendlyConnectError(err);
    st().setConn({ connected: false, type: null, busy: false, status: 'failed', error: message });
    st().toast(message, 'error');
    return false;
  }
}

async function afterConnect(type: 'ble' | 'usb', deviceName: string): Promise<void> {
  const { registry, settings, updateSettings } = st();
  const recognized = registry.detect(deviceName).recognized;
  const saved = getDeviceModel(deviceName);

  // Same rules as the original: recognised devices always auto-detect; otherwise use the saved model or ask.
  if (recognized) {
    if (settings.printerModel !== 'auto') updateSettings({ printerModel: 'auto' });
  } else if (saved && settings.printerModel === 'auto') {
    updateSettings({ printerModel: saved });
  } else if (settings.printerModel === 'auto') {
    st().openDialog('model');
    // The picker is modal and resolves later, but connectPrinter() used to return immediately —
    // so a print started right after connecting built its raster while printerModel was still
    // 'auto' and silently used the wrong profile (dpi/encoding). Wait for the dialog to close,
    // then re-read settings, so the model the user chose is the one that prints.
    await waitForDialogToClose('model');
  }

  const cfg = currentConfig();
  if (isTape(cfg)) {
    const tw = getDeviceTapeWidth(deviceName) ?? (cfg.definition?.id === 'a30' ? 15 : cfg.definition?.defaultTapeWidth ?? 12);
    updateSettings({ tapeWidth: tw });
  }
  st().applyPrinterFamily();

  if (type === 'ble') {
    transport.onPrinterInfo = (_field: string, _value: unknown, info: Record<string, unknown>) => st().setPrinterInfo({ ...(info as object) } as never);
    setTimeout(() => void transport.queryAll?.().catch(() => {}), 500);
    // Battery is the one field worth re-reading: it is the only reading that goes stale on its own
    // while the printer sits idle. The rest change only when you touch the hardware, and they
    // arrive as events when they do.
    startBatteryRefresh();
  }
}

export async function disconnectPrinter(): Promise<void> {
  stopBatteryRefresh();
  try {
    await transport?.disconnect?.();
  } finally {
    // Clear the module-level handles too. Leaving `kind` set made ensureConnected() reuse the
    // previous transport type forever — after one USB session every later auto-reconnect defaulted
    // to USB even when BLE was the only one available.
    transport = null;
    kind = null;
    st().setConn({ connected: false, type: null, deviceName: '', status: 'disconnected', error: null });
    st().setPrinterInfo(null);
    st().applyPrinterFamily();
  }
}

export function rememberModel(deviceName: string, model: string): void {
  saveDeviceModel(deviceName, model);
}
export function rememberTapeWidth(deviceName: string, width: number): void {
  if (deviceName) saveDeviceTapeWidth(deviceName, width);
}

// ---- resolution -------------------------------------------------------------------------

export function currentConfig(): ResolvedConfig {
  const { registry, conn, settings } = st();
  return registry.resolve(conn.deviceName, settings.printerModel);
}

export function currentTarget(): { cfg: ResolvedConfig; target: RasterTarget } {
  const { registry, conn, settings } = st();
  const cfg = registry.resolve(conn.deviceName, settings.printerModel);
  return {
    cfg,
    target: {
      widthBytes: registry.widthBytes(conn.deviceName, settings.printerModel),
      dpi: cfg.dpi || 203,
      alignment: alignmentOf(cfg),
      rotated: isRotated(cfg),
    },
  };
}

/** TSPL printers need crisp barcodes: force threshold when the label leaves dithering on auto. */
function modeFor(elements: LabelElement[], cfg: ResolvedConfig): DitherMode {
  const m = ditherModeOf(elements);
  return m === 'auto' && isTspl(cfg) ? 'threshold' : m;
}

export async function rasterFor(elements: LabelElement[]): Promise<Raster> {
  const { multi, labelSize } = st();
  // `layout` here is the DISPLAY layout — what's on screen, landscape included. buildRaster
  // rotates it back to the label's physical axes (rotateForPrint) before anything
  // printer/protocol-specific runs, so that stage is unaffected by user orientation.
  const layout = multi.enabled ? multiLayout(multi) : displayLayout(labelSize);
  const rotateForPrint = !multi.enabled && needsPrintRotation(labelSize);
  const { cfg, target } = currentTarget();
  // Expressions are already resolved by the caller, which must do it BEFORE field substitution
  // (see printCurrent). Evaluating again here would re-scan substituted CSV data and reintroduce
  // the bug where a value containing "[[date]]" prints the current date.
  const ready = elements;
  await prepareForRender(ready);
  return buildRaster(ready, layout, target, modeFor(ready, cfg), rotateForPrint);
}

async function sendRaster(raster: Raster, onProgress?: (pct: number) => void): Promise<void> {
  const { settings, labelSize } = st();
  const { cfg } = currentTarget();
  const ops = encodePrint(raster, {
    cfg,
    isBLE: kind === 'ble',
    density: settings.density,
    feed: settings.feed,
    continuous: !!labelSize.continuous,
  });
  await runOps(transport, ops, { onProgress });
}

async function ensureConnected(): Promise<boolean> {
  if (isConnected()) return true;
  const type = kind ?? (bluetoothAvailable() ? 'ble' : 'usb');
  const ok = await connectPrinter(type);
  if (!ok) st().toast(tr('connectFirst'), 'error');
  return ok;
}

// ---- jobs ----------------------------------------------------------------------------------------

/** Print the design (using the first data record if template data is loaded), N copies. */
export async function printCurrent(): Promise<boolean> {
  // Claim the slot BEFORE the first await. Setting `printing` after ensureConnected() would leave
  // a window where two same-tick calls (e.g. a double Ctrl+P) both pass this check and interleave
  // their chunks on one transport — the exact bug this guard exists to prevent.
  if (printing) return false;
  printing = true;
  try {
    if (!(await ensureConnected())) return false;
    const { elements, templateData, settings } = st();
    // Order matters: expressions ([[date]]) are authored in the design and must resolve first;
    // field substitution ({{SKU}}) then inserts data. Doing it the other way round made a CSV value
    // that happened to contain "[[date]]" print the current date instead of the literal text.
    const base = evaluateExpressions(elements);
    const merged = templateData.length ? substituteFields(base, templateData[0]) : base;
    // Settings come from localStorage and are not validated on load, so a corrupt value must not
    // silently print nothing and then report success.
    const copies = Math.max(1, Math.floor(settings.copies) || 1);

    st().setPrint({ active: true, label: tr('printing'), current: 0, total: copies, sub: '' });
    const raster = await rasterFor(merged);
    for (let c = 1; c <= copies; c++) {
      st().setPrint({ active: true, label: tr('printing'), current: c - 1, total: copies, sub: copies > 1 ? `${c}/${copies}` : '' });
      await sendRaster(raster, (pct) =>
        st().setPrint({ active: true, label: tr('printing'), current: c - 1, total: copies, sub: tr('sending', { pct }) }),
      );
      if (c < copies) await sleep(500);
    }
    st().toast(copies > 1 ? tr('printedCopies', { n: copies }) : tr('printComplete'), 'success');
    return true;
  } catch (e) {
    st().toast(`${tr('printFailed')}: ${(e as Error).message}`, 'error');
    return false;
  } finally {
    printing = false;
    st().setPrint(null);
  }
}

/** Print one label per record (or one row of zones per N records on a multi-label roll). */
export async function printBatch(recordIndexes: number[], signal: AbortSignal): Promise<boolean> {
  const { elements, templateData, multi } = st();
  if (!recordIndexes.length) {
    st().toast(tr('noRecordsToPrint'), 'error');
    return false;
  }
  if (!(await ensureConnected())) return false;

  const across = multi.labelsAcross;
  const perRow = multi.enabled && !multi.cloneMode;
  const rows = perRow ? Math.ceil(recordIndexes.length / across) : recordIndexes.length;
  const title = perRow ? tr('rowsPrinting', { rows, n: recordIndexes.length }) : tr('recordsPrinting', { n: recordIndexes.length });

  try {
    for (let row = 0; row < rows; row++) {
      if (signal.aborted) {
        st().toast(tr('printCancelled'));
        return false;
      }
      let merged: LabelElement[];
      // Expressions first, then data — see the note in printCurrent().
      const base = evaluateExpressions(elements);
      if (perRow) {
        const recs: (TemplateRecord | undefined)[] = [];
        for (let z = 0; z < across; z++) {
          const idx = recordIndexes[row * across + z];
          recs[z] = idx === undefined ? undefined : templateData[idx];
        }
        merged = substituteFieldsByZone(base, recs);
      } else {
        merged = substituteFields(base, templateData[recordIndexes[row]]);
      }
      st().setPrint({ active: true, label: title, current: row, total: rows, sub: '' });
      const raster = await rasterFor(merged);
      await sendRaster(raster, (pct) => st().setPrint({ active: true, label: title, current: row, total: rows, sub: tr('sending', { pct }) }));
      if (row < rows - 1 && !signal.aborted) await sleep(500);
    }
    st().toast(tr('printedN', { n: recordIndexes.length }), 'success');
    return true;
  } catch (e) {
    st().toast(`${tr('printFailed')}: ${(e as Error).message}`, 'error');
    return false;
  } finally {
    st().setPrint(null);
  }
}

/**
 * Print the density-test strips. This is a third print job on the same transport as
 * printCurrent()/printBatch(), so it must claim the same `printing` slot: without it a density
 * test started from the printer settings while a label is printing interleaves both byte streams
 * and garbles the label. Claimed before the first await, for the same reason as printCurrent().
 */
export async function printDensityTest(): Promise<void> {
  if (printing) return;
  printing = true;
  try {
    if (!(await ensureConnected())) return;
    st().setPrint({ active: true, label: tr('densityTest'), current: 0, total: 1, sub: '' });
    await runOps(transport, encodeDensityTest(kind === 'ble'));
  } catch (e) {
    st().toast(`${tr('printFailed')}: ${(e as Error).message}`, 'error');
  } finally {
    printing = false;
    st().setPrint(null);
  }
}

let abort: AbortController | null = null;
export const isBatchRunning = () => abort !== null;
export const cancelBatch = () => abort?.abort();
export async function runBatch(indexes: number[]): Promise<boolean> {
  // Refuse to start a second batch. Overwriting `abort` would leave the running batch
  // uncancellable — cancelBatch() would only signal the new controller — and whichever batch
  // finished first would null `abort` while the other was still sending, interleaving both on
  // the same transport.
  if (abort || printing) return false;
  const controller = new AbortController();
  abort = controller;
  printing = true;
  try {
    return await printBatch(indexes, controller.signal);
  } finally {
    printing = false;
    // Only clear the slot we own, so a later batch cannot be un-registered by this one.
    if (abort === controller) abort = null;
  }
}
