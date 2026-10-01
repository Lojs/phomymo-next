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

const st = () => useStore.getState();
const tr = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate(st().lang, key, vars);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const secureContextOk = () => window.isSecureContext;
export const bluetoothAvailable = () => BLETransport.isAvailable();
export const usbAvailable = () => USBTransport.isAvailable();
export const isConnected = () => !!transport && !!transport.isConnected();

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
  }
}

export async function disconnectPrinter(): Promise<void> {
  try {
    await transport?.disconnect?.();
  } finally {
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
  const ready = evaluateExpressions(elements);
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
  if (!(await ensureConnected())) return false;
  const { elements, templateData, settings } = st();
  const merged = templateData.length ? substituteFields(elements, templateData[0]) : elements;
  const copies = settings.copies;

  st().setPrint({ active: true, label: tr('printing'), current: 0, total: copies, sub: '' });
  try {
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
      if (perRow) {
        const recs: (TemplateRecord | undefined)[] = [];
        for (let z = 0; z < across; z++) {
          const idx = recordIndexes[row * across + z];
          recs[z] = idx === undefined ? undefined : templateData[idx];
        }
        merged = substituteFieldsByZone(elements, recs);
      } else {
        merged = substituteFields(elements, templateData[recordIndexes[row]]);
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

export async function printDensityTest(): Promise<void> {
  if (!(await ensureConnected())) return;
  st().setPrint({ active: true, label: tr('densityTest'), current: 0, total: 1, sub: '' });
  try {
    await runOps(transport, encodeDensityTest(kind === 'ble'));
  } catch (e) {
    st().toast(`${tr('printFailed')}: ${(e as Error).message}`, 'error');
  } finally {
    st().setPrint(null);
  }
}

let abort: AbortController | null = null;
export const isBatchRunning = () => abort !== null;
export const cancelBatch = () => abort?.abort();
export async function runBatch(indexes: number[]): Promise<boolean> {
  abort = new AbortController();
  try {
    return await printBatch(indexes, abort.signal);
  } finally {
    abort = null;
  }
}
