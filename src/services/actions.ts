/** User-level actions: adding elements, importing files, exporting designs. */
import { useStore } from '../state/store';
import { createBarcode, createImage, createQR, createShape, createText, type LabelElement, type ShapeType } from '../core/model/elements';
import { assertRenderable, paintLabel, prepareForRender } from '../core/render/label';
import { evaluateExpressions, parseCSV, substituteFields, toCSV } from '../core/template/template';
import { designExists, exportDesignJSON, parseDesignJSON, saveDesign, type Design } from '../core/storage/storage';
import { translate } from '../i18n';

const st = () => useStore.getState();
const tr = (k: Parameters<typeof translate>[1], v?: Record<string, string | number>) => translate(st().lang, k, v);

/** Centre a new element of the given size in the active label. */
function centred(w: number, h: number) {
  const l = st().layout();
  return { x: Math.round((l.labelWidth - w) / 2), y: Math.round((l.labelHeight - h) / 2), width: w, height: h };
}

export function addText() {
  const l = st().layout();
  const w = Math.min(150, Math.max(50, l.labelWidth - 16));
  st().add(createText('Text', { ...centred(w, 40), align: 'center' }));
}
export function addBarcode() {
  const l = st().layout();
  st().add(createBarcode('123456789012', centred(Math.min(180, l.labelWidth - 12), Math.min(80, l.labelHeight - 8))));
}
export function addQR() {
  const l = st().layout();
  const size = Math.max(50, Math.min(100, l.labelHeight - 8, l.labelWidth - 8));
  st().add(createQR('https://example.com', centred(size, size)));
}
export function addShape(type: ShapeType) {
  const l = st().layout();
  const w = Math.min(type === 'line' ? 120 : 80, l.labelWidth - 8);
  const h = type === 'line' ? 10 : Math.min(60, l.labelHeight - 8);
  st().add(createShape(type, { ...centred(w, h), fill: type === 'line' ? 'none' : 'black', stroke: type === 'line' ? 'black' : 'none', strokeWidth: type === 'line' ? 3 : 2 }));
}

// ---- images ---------------------------------------------------------------------------------

export interface LoadedImage { dataUrl: string; width: number; height: number }

/**
 * Longest side, in pixels, at which an image is stored. The label canvas is 8 px/mm, so even a
 * 100 mm label is only 800 px across; a 12 MP phone photo kept at full resolution is pure waste and,
 * stored as a base64 string in localStorage (~5 MB for everything), fills the quota with one image
 * and then silently stops autosaving.
 */
export const MAX_IMAGE_SIDE = 1200;

/**
 * Re-encode an image no larger than MAX_IMAGE_SIDE. Small images are returned untouched.
 *
 * JPEG stays JPEG — photos compress far better that way — and everything else stays PNG so
 * transparency survives. Every failure path returns the original rather than refusing the image:
 * a slightly too large picture is better than no picture.
 */
export function shrinkImage(source: CanvasImageSource, width: number, height: number, dataUrl: string, mime: string): LoadedImage {
  const longest = Math.max(width, height);
  if (longest <= MAX_IMAGE_SIDE) return { dataUrl, width, height };
  try {
    const k = MAX_IMAGE_SIDE / longest;
    const w = Math.max(1, Math.round(width * k));
    const h = Math.max(1, Math.round(height * k));
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext('2d');
    if (!ctx) return { dataUrl, width, height };
    ctx.drawImage(source, 0, 0, w, h);
    const out = mime === 'image/jpeg' ? cv.toDataURL('image/jpeg', 0.85) : cv.toDataURL('image/png');
    return out && out.startsWith('data:image/') ? { dataUrl: out, width: w, height: h } : { dataUrl, width, height };
  } catch {
    return { dataUrl, width, height };
  }
}

const readAsDataURL = (file: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });

/**
 * The largest file an import will read into memory.
 *
 * readAsDataURL holds the whole file as a string and a PDF additionally materialises every page,
 * so an arbitrarily large drop could exhaust the tab's heap with nothing to catch it. 25 MB is far
 * above any label image or design file and far below the point where the browser starts refusing.
 */
export const MAX_IMPORT_BYTES = 25 * 1024 * 1024;

/** Refuse a file too large to import safely, naming the limit rather than failing later. */
export function assertImportable(file: File): void {
  if (file.size > MAX_IMPORT_BYTES) {
    throw new RangeError(`${file.name} is ${(file.size / 1048576).toFixed(1)} MB; the limit is ${MAX_IMPORT_BYTES / 1048576} MB`);
  }
}

async function loadPdfFirstPage(file: File): Promise<LoadedImage> {
  const pdfjs = await import('pdfjs-dist');
  const worker = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  pdfjs.GlobalWorkerOptions.workerSrc = worker;
  // Keep the loading task, not just the document: destroy() — which tears down the worker — belongs
  // to the task in pdf.js 6. Without it, importing several PDFs in one session accumulated workers.
  const task = pdfjs.getDocument({ data: await file.arrayBuffer() });
  const doc = await task.promise;
  const page = await doc.getPage(1);
  // Cap the render scale so a poster-sized PDF page doesn't exceed canvas limits.
  // At scale 2 a 595×842 pt A4 page is ~1684×2339 px — fine. But a 24×36 inch poster
  // at scale 2 would be 3456×5184 px, which exceeds some browsers' canvas limits.
  const baseViewport = page.getViewport({ scale: 1 });
  const maxDim = 3000;
  const scale = Math.min(2, maxDim / Math.max(baseViewport.width, baseViewport.height));
  const viewport = page.getViewport({ scale });
  const cv = document.createElement('canvas');
  cv.width = viewport.width;
  cv.height = viewport.height;
  try {
    await page.render({ canvas: cv, canvasContext: cv.getContext('2d')!, viewport }).promise;
    return shrinkImage(cv, cv.width, cv.height, cv.toDataURL('image/png'), 'image/png');
  } finally {
    await task.destroy();
  }
}

export async function loadImageFile(file: File): Promise<LoadedImage> {
  assertImportable(file);
  if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) return loadPdfFirstPage(file);
  const dataUrl = await readAsDataURL(file);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(shrinkImage(img, img.naturalWidth, img.naturalHeight, dataUrl, file.type));
    img.onerror = () => reject(new Error('image'));
    img.src = dataUrl;
  });
}

export async function addImageFile(file: File): Promise<void> {
  try {
    const img = await loadImageFile(file);
    const l = st().layout();
    const scale = Math.min((l.labelWidth * 0.8) / img.width, (l.labelHeight * 0.8) / img.height, 1);
    const w = Math.max(30, Math.round(img.width * scale));
    const h = Math.max(30, Math.round(img.height * scale));
    st().add(createImage(img.dataUrl, { ...centred(w, h), naturalWidth: img.width, naturalHeight: img.height }));
  } catch (e) {
    st().toast(importError(e), 'error');
  }
}

/**
 * The message for a failed import.
 *
 * A RangeError is this app's own "that file is too large" refusal, and its message names the file
 * and the limit — the one sentence that tells the user what to do differently. Swallowing it for
 * the generic "could not read that image" is how a 25 MB limit looked like a corrupt file.
 */
const importError = (e: unknown): string =>
  e instanceof RangeError ? e.message : tr('errorImage');

export async function replaceImageFile(id: string, file: File): Promise<void> {
  try {
    const img = await loadImageFile(file);
    st().checkpoint();
    st().patch([id], (el) => {
      // Guard against zero intrinsic size (e.g. SVG without width/height/viewBox)
      const ratio = img.height > 0 ? img.width / img.height : 1;
      return { imageData: img.dataUrl, naturalWidth: img.width, naturalHeight: img.height, height: Math.max(30, Math.round(el.width / ratio)) } as Partial<LabelElement>;
    });
  } catch (e) {
    st().toast(importError(e), 'error');
  }
}

// ---- export -----------------------------------------------------------------------------------

function download(name: string, blob: Blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/**
 * A safe download filename derived from the design name.
 *
 * `\w` is ASCII-only, so the previous pattern replaced every Arabic character with an underscore:
 * "ملصق القهوة" became "_____.json" — the Arabic app's own exports were unopenable and all
 * indistinguishable. `\p{L}\p{N}` keeps letters of any script, which is the whole point for an app
 * whose interface is Arabic-first.
 */
const fileBase = () => {
  const name = (st().designName ?? 'label')
    .normalize('NFC')
    // Path separators and characters no filesystem accepts, plus control characters,
    // bidi overrides, and C1 controls.
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]+/g, '_')
    // Leading dots would hide the file, and a trailing dot or space is dropped by Windows.
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '');
  // Cut by code point, not by UTF-16 code unit: String.slice(0, 120) can end in the first half of a
  // surrogate pair (an emoji, some CJK) and leave a lone surrogate in the file name.
  const cut = Array.from(name).slice(0, 120).join('');
  // Windows reserved names (CON, NUL, COM1, etc.) — prefix with underscore.
  return (cut ? (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(cut) ? '_' : '') + cut : 'label');
};

export function exportJson() {
  const name = st().designName ?? tr('untitled');
  download(`${fileBase()}.json`, new Blob([exportDesignJSON(name, st().currentDesign())], { type: 'application/json' }));
}

async function labelCanvas(scale: number): Promise<HTMLCanvasElement> {
  const { elements, templateData } = st();
  // Expressions first, then data (see printCurrent in printing.ts).
  const base = evaluateExpressions(elements);
  const merged = templateData.length ? substituteFields(base, templateData[0]) : base;
  await prepareForRender(merged);
  const layout = st().layout();
  const cv = document.createElement('canvas');
  // The same guard the print path uses, at the export scale. Exporting at 4x a 500 mm label
  // asked for a canvas of tens of thousands of pixels a side; assigning that to cv.width throws
  // inside the browser or silently produces a blank image, and there was no check here at all.
  assertRenderable(Math.round(layout.width * scale), Math.round(layout.height * scale));
  cv.width = layout.width * scale;
  cv.height = layout.height * scale;
  const ctx = cv.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  ctx.scale(scale, scale);
  paintLabel(ctx, merged, layout);
  return cv;
}

export async function exportPng() {
  try {
    const cv = await labelCanvas(4);
    cv.toBlob((b) => {
      if (b) download(`${fileBase()}.png`, b);
      else st().toast(tr('errorFile'), 'error');
    }, 'image/png');
  } catch (e) {
    st().toast(`${tr('errorFile')}: ${(e as Error).message}`, 'error');
  }
}

export async function exportPdf() {
  try {
    const { jsPDF } = await import('jspdf');
    const layout = st().layout();
    const wMm = layout.width / 8, hMm = layout.height / 8;
    const cv = await labelCanvas(4);
    const pdf = new jsPDF({ orientation: wMm >= hMm ? 'landscape' : 'portrait', unit: 'mm', format: [wMm, hMm] });
    pdf.addImage(cv.toDataURL('image/png'), 'PNG', 0, 0, wMm, hMm);
    pdf.save(`${fileBase()}.pdf`);
  } catch (e) {
    st().toast(`${tr('errorFile')}: ${(e as Error).message}`, 'error');
  }
}

// ---- import -----------------------------------------------------------------------------------

/**
 * Read a design file and open it.
 *
 * Refuses to overwrite an existing design of the same name. Previously it called saveDesign()
 * unconditionally, so importing a file whose name matched a saved design replaced it with no question
 * and no undo — the user only found out when the design they had been editing was gone.
 *
 * The decision belongs to the caller, because only it can ask: returning the conflicting name lets the
 * UI show a translated confirmation, and keeps this function testable without a global confirm().
 */
export async function importDesignFile(file: File): Promise<{ ok: boolean; name: string | null; conflict: string | null }> {
  let finalName: string;
  let design: Design;
  try {
    assertImportable(file);
    const parsed = parseDesignJSON(await file.text());
    design = parsed.design;
    finalName = parsed.name || file.name.replace(/\.json$/i, '');
  } catch (e) {
    st().toast((e as Error).message || tr('errorFile'), 'error');
    return { ok: false, name: null, conflict: null };
  }
  if (designExists(finalName)) return { ok: false, name: finalName, conflict: finalName };
  try {
    saveDesign(finalName, design);
    st().loadDesign(design, finalName);
    st().toast(tr('imported'), 'success');
    return { ok: true, name: finalName, conflict: null };
  } catch (e) {
    st().toast((e as Error).message || tr('errorFile'), 'error');
    return { ok: false, name: finalName, conflict: null };
  }
}

/** Write a design the caller has already confirmed the name for. */
export function importDesignAs(name: string, design: Design): boolean {
  try {
    saveDesign(name, design);
    st().loadDesign(design, name);
    st().toast(tr('imported'), 'success');
    return true;
  } catch (e) {
    st().toast((e as Error).message || tr('errorFile'), 'error');
    return false;
  }
}

/** Parse a design file without saving anything — used to preview it before a confirmation. */
export async function readDesignFile(file: File): Promise<{ name: string; design: Design }> {
  assertImportable(file);
  const parsed = parseDesignJSON(await file.text());
  const name = parsed.name || file.name.replace(/\.json$/i, '');
  return { name, design: parsed.design };
}

export function saveCurrentDesign(name: string): boolean {
  try {
    const d: Design = st().currentDesign();
    saveDesign(name, d);
    useStore.setState({ designName: name, dirty: false });
    st().toast(tr('saved'), 'success');
    return true;
  } catch (e) {
    st().toast((e as Error).message || tr('storageFull'), 'error');
    return false;
  }
}

/**
 * File text, tolerant of the encodings real CSVs arrive in.
 *
 * Excel's "CSV (Comma delimited)" — not "CSV UTF-8" — is Windows-1256 on an Arabic system and
 * Windows-1252 on a Western one. Decoded as UTF-8 it yields U+FFFD replacement characters, so every
 * Arabic cell arrives as mojibake. `fatal: true` is what distinguishes the two: valid UTF-8 decodes,
 * anything else throws and is retried as Windows-1256, which also covers Latin accents correctly.
 */
export async function readCsvText(file: File): Promise<string> {
  assertImportable(file);
  if (typeof file.arrayBuffer !== 'function') return file.text();
  const buf = await file.arrayBuffer();
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    try {
      return new TextDecoder('windows-1256').decode(buf);
    } catch {
      return new TextDecoder().decode(buf);   // last resort: never lose the file to a decode error
    }
  }
}

export async function importCsvFile(file: File): Promise<void> {
  try {
    const { records, errors } = parseCSV(await readCsvText(file));
    // "No records" is a failure however it happened. The old guard also required `errors.length`,
    // so an empty file — which yields zero records AND zero errors — fell through and reported
    // "Imported 0 records" as a success.
    if (!records.length) {
      st().toast(errors[0] ?? tr('csvNoRecords'), 'error');
      return;
    }
    st().setTemplateData(records);
    st().toast(errors.length ? `${tr('csvImported', { n: records.length })} · ${errors.length} ${tr('csvErrors')}` : tr('csvImported', { n: records.length }), errors.length ? 'info' : 'success');
  } catch {
    st().toast(tr('errorFile'), 'error');
  }
}

export function exportCsv() {
  const fields = st().fields();
  const headers = fields.length ? fields : Object.keys(st().templateData[0] ?? {});
  // The BOM is what makes Excel read the file as UTF-8 instead of guessing the local codepage, which
  // on an Arabic system is Windows-1256 and renders every Arabic cell as mojibake.
  download(`${fileBase()}-data.csv`, new Blob(['\uFEFF', toCSV(headers, st().templateData)], { type: 'text/csv;charset=utf-8' }));
}
