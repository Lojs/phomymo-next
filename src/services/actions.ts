/** User-level actions: adding elements, importing files, exporting designs. */
import { useStore } from '../state/store';
import { createBarcode, createImage, createQR, createShape, createText, type LabelElement, type ShapeType } from '../core/model/elements';
import { paintLabel, prepareForRender } from '../core/render/label';
import { evaluateExpressions, parseCSV, substituteFields, toCSV } from '../core/template/template';
import { exportDesignJSON, parseDesignJSON, saveDesign, type Design } from '../core/storage/storage';
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

const readAsDataURL = (file: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });

async function loadPdfFirstPage(file: File): Promise<LoadedImage> {
  const pdfjs = await import('pdfjs-dist');
  const worker = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  pdfjs.GlobalWorkerOptions.workerSrc = worker;
  const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const page = await doc.getPage(1);
  const viewport = page.getViewport({ scale: 2 });
  const cv = document.createElement('canvas');
  cv.width = viewport.width;
  cv.height = viewport.height;
  await page.render({ canvas: cv, canvasContext: cv.getContext('2d')!, viewport }).promise;
  return { dataUrl: cv.toDataURL('image/png'), width: cv.width, height: cv.height };
}

export async function loadImageFile(file: File): Promise<LoadedImage> {
  if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) return loadPdfFirstPage(file);
  const dataUrl = await readAsDataURL(file);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ dataUrl, width: img.naturalWidth, height: img.naturalHeight });
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
  } catch {
    st().toast(tr('errorImage'), 'error');
  }
}

export async function replaceImageFile(id: string, file: File): Promise<void> {
  try {
    const img = await loadImageFile(file);
    st().checkpoint();
    st().patch([id], (el) => {
      const ratio = img.width / img.height;
      return { imageData: img.dataUrl, naturalWidth: img.width, naturalHeight: img.height, height: Math.max(30, Math.round(el.width / ratio)) } as Partial<LabelElement>;
    });
  } catch {
    st().toast(tr('errorImage'), 'error');
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
const fileBase = () =>
  (st().designName ?? 'label')
    .normalize('NFC')
    // Path separators and characters no filesystem accepts, plus control characters.
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_')
    // Leading dots would hide the file, and a trailing dot or space is dropped by Windows.
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '')
    .slice(0, 120) || 'label';

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
  cv.width = layout.width * scale;
  cv.height = layout.height * scale;
  const ctx = cv.getContext('2d')!;
  ctx.scale(scale, scale);
  paintLabel(ctx, merged, layout);
  return cv;
}

export async function exportPng() {
  const cv = await labelCanvas(4);
  cv.toBlob((b) => b && download(`${fileBase()}.png`, b), 'image/png');
}

export async function exportPdf() {
  const { jsPDF } = await import('jspdf');
  const layout = st().layout();
  const wMm = layout.width / 8, hMm = layout.height / 8;
  const cv = await labelCanvas(4);
  const pdf = new jsPDF({ orientation: wMm >= hMm ? 'landscape' : 'portrait', unit: 'mm', format: [wMm, hMm] });
  pdf.addImage(cv.toDataURL('image/png'), 'PNG', 0, 0, wMm, hMm);
  pdf.save(`${fileBase()}.pdf`);
}

// ---- import -----------------------------------------------------------------------------------

export async function importDesignFile(file: File): Promise<void> {
  try {
    const { name, design } = parseDesignJSON(await file.text());
    const finalName = name || file.name.replace(/\.json$/i, '');
    saveDesign(finalName, design);
    st().loadDesign(design, finalName);
    st().toast(tr('imported'), 'success');
  } catch (e) {
    st().toast((e as Error).message || tr('errorFile'), 'error');
  }
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

export async function importCsvFile(file: File): Promise<void> {
  try {
    const { records, errors } = parseCSV(await file.text());
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
  download(`${fileBase()}-data.csv`, new Blob([toCSV(headers, st().templateData)], { type: 'text/csv' }));
}
