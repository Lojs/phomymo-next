/**
 * Printer connection and print orchestration. Owns the transport instance;
 * pushes state into the store; everything protocol-specific lives in core/.
 */
import { BLETransport } from '../transport/ble';
import { USBTransport } from '../transport/usb';
import { useStore } from '../state/store';
import { alignmentOf, isRotated, isTape, widthBytesToMm, type ResolvedConfig } from '../core/printers/definitions';
import { buildRaster, prepareForRender, type RasterTarget } from '../core/render/label';
import { encodeDensityTest, encodePrint, type Raster } from '../core/protocols/encoders';
import { runOps } from '../core/protocols/ops';
import type { LabelElement } from '../core/model/elements';
import { evaluateExpressions, substituteFields, substituteFieldsByZone, type TemplateRecord } from '../core/template/template';
import { getDeviceModel, getDeviceTapeWidth, saveDeviceModel, saveDeviceTapeWidth } from '../core/storage/storage';
import { displayLayout, multiLayout, needsPrintRotation } from '../core/render/layout';
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
 * dismissed it). Resolves `true` when the user answered, `false` when the wait ran out.
 *
 * The false is the point. The bounded timeout exists so the print slot can never be held forever:
 * the subscription alone resolved only on a store transition away from `name`, and if the dialog
 * were torn down without one — a component unmount, a test harness reset — the promise never
 * settled, printCurrent's `finally` never ran, `printing` stayed true and isPrinting() returned
 * true for the rest of the session. But when the user simply walks away from the model picker, the
 * old code resumed the connection and printed on a stale `printerModel`, which is the wrong dpi
 * and the wrong encoding for a machine nobody identified. A timeout now means "not configured",
 * and the caller refuses to print.
 */
function waitForDialogToClose(name: NonNullable<ReturnType<typeof st>['dialog']>): Promise<boolean> {
  if (st().dialog !== name) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish(false), DIALOG_WAIT_TIMEOUT_MS);
    let unsub: (() => void) | null = null;
    function finish(answered: boolean) {
      clearTimeout(timer);
      unsub?.();
      unsub = null;
      resolve(answered);
    }
    unsub = useStore.subscribe((s: { dialog: string | null }) => {
      if (s.dialog !== name) finish(true);
    });
  });
}

/** How long the model picker may stay open before the connect is abandoned rather than guessed. */
const DIALOG_WAIT_TIMEOUT_MS = 60_000;

export const secureContextOk = () => window.isSecureContext;
export const bluetoothAvailable = () => BLETransport.isAvailable();
export const usbAvailable = () => USBTransport.isAvailable();
export const isConnected = () => !!transport && !!transport.isConnected();
/** True while a print job owns the transport. Anything else that writes to it must wait. */
export const isPrinting = () => printing;

/** Set for the duration of printCurrent(), so its copies loop can be interrupted like a batch is. */
let currentPrintController: AbortController | null = null;

/** Stop the running single-label job. Takes effect between chunks, not between copies only. */
export function cancelCurrentPrint(): void {
  currentPrintController?.abort();
}

/**
 * Whether we still hold a device handle, so a reconnect can happen without showing the picker.
 * After a browser-initiated drop (a frozen background tab is the usual cause) the GATT link is
 * gone but the device reference survives, and `gatt.connect()` on it is allowed without a fresh
 * user gesture. Once the picker path runs, or disconnect() clears the device, this goes false and
 * only the user can bring the link back.
 */
export const canAutoReconnect = () => kind === 'ble' && !!transport?.hasRememberedDevice?.();

/** True when the link dropped on its own rather than because the user asked it to. */
let droppedByItself = false;

/**
 * Re-establish a link that was lost, without showing the device picker. Used when the tab becomes
 * visible again after being backgrounded: the browser may have frozen it, which drops the GATT
 * link, and the user should not have to re-pick their printer just because they looked away.
 *
 * Deliberately conservative:
 *  - BLE only. A USB drop needs a user gesture to re-authorise, so there is nothing to do.
 *  - never while a print is in flight: the reconnect would interleave with the raster chunks.
 *  - only when a device is remembered, so this can never silently open the picker.
 *
 * On success the full afterConnect() path runs again, so the model, tape width and the printer's
 * own readout are all re-established rather than assumed to have survived.
 */
export async function reconnectIfNeeded(): Promise<boolean> {
  if (isConnected()) return false;
  if (printing) return false;
  if (!droppedByItself) return false;
  if (!canAutoReconnect()) return false;
  const type = kind;
  if (type !== 'ble') return false;
  try {
    await transport.connect();
    if (!transport.isConnected()) return false;
    const deviceName: string = transport.getDeviceName?.() || '';
    st().setConn({ type, connected: true, deviceName, busy: false, status: 'connected', error: null });
    droppedByItself = false;
    await afterConnect(type, deviceName);
    return true;
  } catch {
    // Stay disconnected and quiet: the user still has the menu to reconnect by hand.
    return false;
  }
}

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
  // A connect is already running (picker open, or GATT being established). The transports now
  // memoise their in-flight attempt, so a second call would JOIN it — but the two callers would
  // then race to write conn state, and the loser's failure could land last and show a working
  // printer as failed. Refuse instead, and let the running attempt report its own outcome.
  if (st().conn.busy) return false;

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
      // Stop the battery timer here, not only in disconnectPrinter(). The printer can drop the
      // link on its own — out of paper is the common one — and that path never reaches
      // disconnectPrinter(), so without this the timer keeps firing at a dead transport.
      stopBatteryRefresh();
      // Record that this drop was not the user's doing, so returning to the tab can restore it.
      // `kind` is deliberately left set: it is what reconnectIfNeeded() needs to know which
      // transport to rebuild.
      droppedByItself = true;
    };
    await transport.connect({ showAllDevices });
    if (!transport.isConnected()) throw new Error(tr('connectFailed'));

    const deviceName: string = transport.getDeviceName?.() || '';
    st().setConn({ type, connected: true, deviceName, busy: false, status: 'connected', error: null });
    if (!(await afterConnect(type, deviceName))) {
      // afterConnect has already cleared the connection state and torn the transport down.
      return false;
    }
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

/** Resolve the printer's profile after connecting. False when the user never picked a model. */
async function afterConnect(type: 'ble' | 'usb', deviceName: string): Promise<boolean> {
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
    //
    // `false` means the picker was still open after the timeout: nobody chose a model. Carry on
    // and the print goes out on 'auto' — a guess — so the connect is abandoned instead and the
    // caller reports failure. The user reopens the picker explicitly.
    if (!(await waitForDialogToClose('model'))) {
      // Close the link, not just the state: nulling the handles alone left the GATT connection up
      // while the UI reported "disconnected" (see teardown()).
      await teardown();
      st().toast(tr('modelUnanswered'), 'error');
      return false;
    }
  }

  const cfg = currentConfig();
  if (isTape(cfg)) {
    const tw = getDeviceTapeWidth(deviceName) ?? (cfg.definition?.id === 'a30' ? 15 : cfg.definition?.defaultTapeWidth ?? 12);
    updateSettings({ tapeWidth: tw });
  }
  st().applyPrinterFamily();

  if (type === 'ble') {
    transport.onPrinterInfo = (_field: string, _value: unknown, info: Record<string, unknown>) => st().setPrinterInfo({ ...(info as object) } as never);
    setTimeout(() => void transport?.queryAll?.().catch(() => {}), 500);
    // Battery is the one field worth re-reading: it is the only reading that goes stale on its own
    // while the printer sits idle. The rest change only when you touch the hardware, and they
    // arrive as events when they do.
    startBatteryRefresh();
  }
  return true;
}

/**
 * Close the link and forget everything about it, in one place.
 *
 * Three paths used to do this by hand — the transport's own onDisconnect, disconnectPrinter(), and
 * the abandon path when the model dialog is never answered — and they did not do the same things.
 * The abandon path, added in v1.0.17, nulled the handles without ever calling disconnect(), so the
 * radio link stayed up while the UI said "disconnected": the printer remained occupied so no other
 * device could take it, and the next Connect hit `if (this.isConnected()) return true` inside
 * _connect() and silently reused the old printer instead of offering the chooser. One function,
 * used by all three, removes the whole class of bug.
 *
 * Every caller here is deliberate — the user pressed Disconnect, or the connect is being abandoned —
 * so the link is never remembered as restorable. A spontaneous drop is handled by the transport's
 * own onDisconnect instead, which is the one path that does set droppedByItself.
 */
async function teardown(): Promise<void> {
  stopBatteryRefresh();
  droppedByItself = false;
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
    // The async 'gattserverdisconnected' event may fire after this function returns and
    // set droppedByItself = true. Reset it here so a user-initiated disconnect is never
    // misinterpreted as a spontaneous drop.
    droppedByItself = false;
  }
}

export async function disconnectPrinter(): Promise<void> {
  await teardown();
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

export async function rasterFor(elements: LabelElement[]): Promise<Raster> {
  const { multi, labelSize } = st();
  // `layout` here is the DISPLAY layout — what's on screen, landscape included. buildRaster
  // rotates it back to the label's physical axes (rotateForPrint) before anything
  // printer/protocol-specific runs, so that stage is unaffected by user orientation.
  const layout = multi.enabled ? multiLayout(multi) : displayLayout(labelSize);
  const rotateForPrint = !multi.enabled && needsPrintRotation(labelSize);
  const { target } = currentTarget();
  // Expressions are already resolved by the caller, which must do it BEFORE field substitution
  // (see printCurrent). Evaluating again here would re-scan substituted CSV data and reintroduce
  // the bug where a value containing "[[date]]" prints the current date.
  const ready = elements;
  await prepareForRender(ready);
  warnIfWiderThanPrinter(layout, target);
  // A plain threshold, always, and there is deliberately no mode to choose here.
  //
  // Each image is binarised by its own rule while it is drawn (see draw.ts), so by the time the
  // label is one raster the only continuous-tone pixels left are the antialiased edges of text and
  // codes — and error-diffusing those is what made printed labels look speckled and hollow
  // (measured: 453 isolated dots on a text-only label, against none under a threshold).
  //
  // The decision used to be a `modeFor()` here, and it went wrong twice: first it dithered every
  // label, then it dithered any label that happened to contain an image, which speckled the text
  // beside a logo. A mode that can be set wrongly is a mode that will be; the per-image rule has
  // nowhere left to be wrong, because an image is the only thing that wants halftoning and it
  // carries its own answer.
  return buildRaster(ready, layout, target, 'threshold', rotateForPrint);
}

/**
 * Tell the user when the label is wider than the printer can physically print.
 *
 * packBits clips such a label to the printer's width, so something sensible comes out — but the
 * design the user made is not what lands on paper, and until now nothing said so. The clip
 * itself was a bug (the offset went negative and rows spilled into each other); this is the
 * remaining half: telling the user their design does not fit.
 */
/**
 * Warn once per print job that the design does not fit the printer's print width.
 *
 * rasterFor() runs once per label in a batch, so warning inside it queued one identical toast per
 * record — a hundred records meant a hundred toasts. The flag is reset at the start of each job.
 *
 * Compared and quoted from the same conversion. Rounding the head to 53 mm for display while
 * comparing against 52.8 meant a 53 mm label warned "53mm wide but this printer prints 53mm" —
 * the printer cannot print what it is quoted to print. One decimal, because the head widths that
 * exist (52.8, 57.9) are not whole millimetres.
 */
let warnedThisJob = false;

export function warnIfWiderThanPrinter(layout: { width: number }, target: { widthBytes: number; dpi: number }): void {
  if (warnedThisJob) return;
  const printableMm = widthBytesToMm(target.widthBytes, target.dpi);
  // The layout is in label pixels, 8 per millimetre.
  if (layout.width / 8 <= printableMm) return;
  warnedThisJob = true;
  st().toast(
    tr('labelTooWide', { label: Math.round(layout.width / 8), printer: formatMm(printableMm) }),
    'info',
  );
}

/**
 * A millimetre length for a user-facing message: whole numbers stay whole, 52.8 stays 52.8.
 *
 * Rounding this to 53 made a 53 mm label on a 52.8 mm head say the printer prints 53 mm, i.e. it
 * printed the very width the warning exists to report as clipped.
 */
function formatMm(mm: number): string {
  return String(Math.round(mm * 10) / 10);
}

/** Reset the once-per-job warning latch. Called at the start of every print job. */
export function beginPrintJob(): void {
  warnedThisJob = false;
}

/**
 * Send one raster.
 *
 * `signal` is forwarded to runOps, which already honours it between operations. Without it the cancel
 * button could only take effect *between* labels: a single label is many chunks, and a long one kept
 * feeding the printer after the user pressed cancel.
 */
async function sendRaster(raster: Raster, onProgress?: (pct: number) => void, signal?: AbortSignal): Promise<void> {
  const { settings, labelSize } = st();
  const { cfg } = currentTarget();
  const ops = encodePrint(raster, {
    cfg,
    isBLE: kind === 'ble',
    density: settings.density,
    feed: settings.feed,
    continuous: !!labelSize.continuous,
  });
  await runOps(transport, ops, { onProgress, signal });
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
  beginPrintJob();
  const controller = new AbortController();
  currentPrintController = controller;
  try {
    if (!(await ensureConnected())) return false;
    const { elements, templateData, settings } = st();
    // Order matters: expressions ([[date]]) are authored in the design and must resolve first;
    // field substitution ({{SKU}}) then inserts data. Doing it the other way round made a CSV value
    // that happened to contain "[[date]]" print the current date instead of the literal text.
    const base = evaluateExpressions(elements);
    const merged = templateData.length ? substituteFields(base, templateData[0]) : base;
    // Settings come from localStorage and are not validated on load, so a corrupt value must not
    // silently print nothing and then report success. Clamp to the app's limits.
    const copies = Math.min(99, Math.max(1, Math.floor(settings.copies) || 1));

    st().setPrint({ active: true, label: tr('printing'), current: 0, total: copies, sub: '' });
    const raster = await rasterFor(merged);
    for (let c = 1; c <= copies; c++) {
      // Stop between copies too: a 99-copy run could not be interrupted at all before this.
      if (controller.signal.aborted) {
        st().toast(tr('printCancelled'));
        return false;
      }
      st().setPrint({ active: true, label: tr('printing'), current: c - 1, total: copies, sub: copies > 1 ? `${c}/${copies}` : '' });
      await sendRaster(
        raster,
        (pct) => st().setPrint({ active: true, label: tr('printing'), current: c - 1, total: copies, sub: tr('sending', { pct }) }),
        controller.signal,
      );
      if (c < copies) await sleep(500);
    }
    st().toast(copies > 1 ? tr('printedCopies', { n: copies }) : tr('printComplete'), 'success');
    return true;
  } catch (e) {
    // A cancel that lands mid-label surfaces as an AbortError from runOps. It is what the user asked
    // for, so it is reported as a cancel rather than as a failure.
    if ((e as Error)?.name === 'AbortError') {
      st().toast(tr('printCancelled'));
      return false;
    }
    st().toast(`${tr('printFailed')}: ${(e as Error).message}`, 'error');
    return false;
  } finally {
    currentPrintController = null;
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
      await sendRaster(
        raster,
        (pct) => st().setPrint({ active: true, label: title, current: row, total: rows, sub: tr('sending', { pct }) }),
        signal,
      );
      if (row < rows - 1 && !signal.aborted) await sleep(500);
    }
    st().toast(tr('printedN', { n: recordIndexes.length }), 'success');
    return true;
  } catch (e) {
    // A cancel that lands mid-label surfaces as an AbortError from runOps. It is what
    // the user asked for, so it is reported as a cancel rather than as a failure —
    // the same handling as printCurrent().
    if ((e as Error)?.name === 'AbortError') {
      st().toast(tr('printCancelled'));
      return false;
    }
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
  beginPrintJob();
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
  beginPrintJob();
  try {
    return await printBatch(indexes, controller.signal);
  } finally {
    printing = false;
    // Only clear the slot we own, so a later batch cannot be un-registered by this one.
    if (abort === controller) abort = null;
  }
}
