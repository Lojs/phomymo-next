/**
 * Synchronous element rendering onto a 2D canvas context, ported from the
 * original renderer so printed output stays identical.
 */
import JsBarcode from 'jsbarcode';
import QRCode from 'qrcode';
import type { BarcodeElement, DitherChoice, ImageElement, LabelElement, QRElement, ShapeElement, TextElement } from '../model/elements';
import { getImage } from './images';
import { pixelsToRaster, rgbaToGrayscale, floydSteinberg, atkinson, ordered, thresholdGray, shouldUseDithering } from '../raster/raster';

type Ctx = CanvasRenderingContext2D;

export interface DrawOptions {
  /** Editor-only decorations (e.g. barcode-too-wide warning) that must never be printed. */
  preview?: boolean;
  /** Show images as they will be dithered on paper. */
  ditherImages?: boolean;
  /**
   * Device pixels per label pixel — `rasterScale(dpi)`, set by renderPixels().
   *
   * The context is scaled by this, so a coordinate-free shape scales for free. An image does not:
   * it has to be *binarised* at this resolution, because binarising at the label grid and then
   * letting the scaled context resample the result is the 203-DPI-bitmap-interpolated-up problem
   * again, one image at a time. Measured on a 300 DPI head with a black-to-white ramp, in a real
   * browser: binarise at the label grid, smooth-upscale by 1.478 and threshold, and the mean tone
   * error per band is 0.096 — the 53% grey band lands at 37% and the 30% grey band at 14%, so the
   * midtones collapse and the dot structure merges (isolated-dot share 0.267 -> 0.119). Binarising
   * at device resolution and mapping it 1:1 gives 0.0007.
   */
  scale?: number;
}

export function drawElement(ctx: Ctx, el: LabelElement, opts: DrawOptions = {}): void {
  ctx.save();
  ctx.translate(el.x + el.width / 2, el.y + el.height / 2);
  if (el.rotation) ctx.rotate((el.rotation * Math.PI) / 180);
  switch (el.type) {
    case 'text': drawText(ctx, el, el.width, el.height); break;
    case 'image': drawImage(ctx, el, el.width, el.height, opts); break;
    case 'barcode': drawBarcode(ctx, el, el.width, el.height, opts); break;
    case 'qr': drawQR(ctx, el, el.width, el.height); break;
    case 'shape': drawShape(ctx, el, el.width, el.height); break;
  }
  ctx.restore();
}

// ---- text -----------------------------------------------------------------------

const fontString = (size: number, family: string | undefined, weight?: string, style?: string) =>
  `${style === 'italic' ? 'italic' : ''} ${weight === 'bold' ? 'bold' : ''} ${size}px ${family || 'Inter, sans-serif'}`.trim();

export function wrapText(ctx: Ctx, text: string, maxWidth: number, size: number, family: string, weight: string, style: string): string[] {
  ctx.font = fontString(size, family, weight, style);
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    if (!paragraph.trim()) { lines.push(''); continue; }
    let cur = '';
    for (const word of paragraph.split(/[ \t]+/)) {
      const test = cur ? `${cur} ${word}` : word;
      if (ctx.measureText(test).width > maxWidth && cur) { lines.push(cur); cur = word; } else cur = test;
    }
    if (cur) lines.push(cur);
  }
  return lines.length ? lines : [''];
}

/**
 * Largest font size at which the whole text still fits the box. Exported so the in-place
 * editor can reproduce the canvas's font size exactly: if it measured the text with its own
 * logic the two would drift apart and the edited text would jump on blur.
 */
export function autoScaleFontSize(ctx: Ctx, el: TextElement, width: number, height: number): number {
  const availW = width - 8;
  const availH = height - 8;
  if (availW <= 0 || availH <= 0) return 8;
  let lo = 6, hi = 200, best = lo;
  while (lo <= hi) {
    const size = Math.floor((lo + hi) / 2);
    ctx.font = fontString(size, el.fontFamily, el.fontWeight, el.fontStyle);
    let fits: boolean;
    if (el.noWrap) {
      const lines = el.text.split('\n');
      const widest = Math.max(...lines.map((l) => ctx.measureText(l).width));
      fits = widest <= availW && lines.length * size * 1.2 <= availH;
    } else {
      const lines = wrapText(ctx, el.text, availW, size, el.fontFamily, el.fontWeight, el.fontStyle);
      fits = lines.length * size * 1.2 <= availH;
    }
    if (fits) { best = size; lo = size + 1; } else hi = size - 1;
  }
  return Math.max(best, 6);
}

function drawText(ctx: Ctx, el: TextElement, width: number, height: number): void {
  if (el.background && el.background !== 'transparent') {
    ctx.fillStyle = el.background;
    ctx.fillRect(-width / 2, -height / 2, width, height);
  }
  if (!el.text || !el.text.trim()) return;

  if (el.clipOverflow) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(-width / 2, -height / 2, width, height);
    ctx.clip();
  }

  const color = el.color || 'black';
  ctx.fillStyle = color;
  const size = el.autoScale ? autoScaleFontSize(ctx, el, width, height) : el.fontSize;
  ctx.font = fontString(size, el.fontFamily, el.fontWeight, el.fontStyle);
  ctx.textBaseline = 'middle';

  let textX = 0;
  if (el.align === 'left') { ctx.textAlign = 'left'; textX = -width / 2 + 4; }
  else if (el.align === 'right') { ctx.textAlign = 'right'; textX = width / 2 - 4; }
  else ctx.textAlign = 'center';

  const lines = el.noWrap ? el.text.split('\n') : wrapText(ctx, el.text, width - 8, size, el.fontFamily, el.fontWeight, el.fontStyle);
  // wrapText sets ctx.font itself, but be explicit: measurements below rely on it.
  ctx.font = fontString(size, el.fontFamily, el.fontWeight, el.fontStyle);

  const lineHeight = size * 1.2;
  const totalHeight = lines.length * lineHeight;
  const v = el.verticalAlign || 'middle';
  let y: number;
  if (v === 'top') y = -height / 2 + lineHeight / 2 + 2;
  else if (v === 'bottom') y = height / 2 - totalHeight + lineHeight / 2 - 2;
  else y = -totalHeight / 2 + lineHeight / 2;

  if (el.autoScale) {
    const unused = height - totalHeight;
    if (unused / height > 0.4) y -= unused * 0.08;
    else if (v === 'bottom') y += 1;
    else if (v === 'middle') y += 0.5;
  }

  for (const line of lines) {
    ctx.fillText(line, textX, y);
    if (el.textDecoration === 'underline') {
      const w = ctx.measureText(line).width;
      const ux = el.align === 'left' ? textX : el.align === 'right' ? textX - w : -w / 2;
      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(1, size / 16);
      ctx.moveTo(ux, y + size * 0.45);
      ctx.lineTo(ux + w, y + size * 0.45);
      ctx.stroke();
    }
    y += lineHeight;
  }
  if (el.clipOverflow) ctx.restore();
}

// ---- image ----------------------------------------------------------------------

/**
 * The CSS filter that applies an image element's brightness/contrast to a canvas draw.
 *
 * Exported because the dithering thumbnails in the element panel must show the *same* adjustment
 * the print will apply. Two copies of this formula would drift, and the preview would then promise
 * a picture the printer does not deliver.
 */
export function imageFilterString(el: ImageElement): string | null {
  const b = el.brightness || 0;
  const c = el.contrast || 0;
  return b !== 0 || c !== 0 ? `brightness(${1 + b / 100}) contrast(${1 + c / 100})` : null;
}

const ditherCache = new Map<string, HTMLCanvasElement>();

/**
 * The mode an image is actually binarised with.
 *
 * `undefined` and 'auto' both mean "decide from this image": the ported heuristic picks error
 * diffusion for a photograph and a plain threshold for flat art. The decision has to be made here,
 * per image, because the composite raster is binarised as a whole — an image still in continuous
 * tone at that point would drag the text beside it into a dither the text does not want. Binarising
 * the image first is what lets a logo and a line of Arabic share a label without either suffering.
 */
export function resolveImageMode(px: Uint8ClampedArray, w: number, h: number, declared: DitherChoice | undefined): DitherChoice {
  if (declared && declared !== 'auto') return declared;
  return shouldUseDithering(px, w, h) ? 'floyd-steinberg' : 'none';
}

/**
 * The image binarised at the resolution it will be printed at.
 *
 * `scale` is the device scale. The cache key is built from the resulting pixel dimensions rather
 * than the element's size, so a 203 DPI render and a 300 DPI render of the same element cannot
 * share an entry — which is what would happen if the key used `el.width` and the scale were only
 * applied afterwards. It carries the rotation too, because with `bakeRotation` the halftone itself
 * depends on the angle.
 *
 * `bakeRotation` applies the element's rotation to the image before it is binarised, into a canvas
 * big enough to hold the result, for the angles where drawing it rotated afterwards would resample.
 * See drawImage().
 */
export function ditherPreview(img: HTMLImageElement, el: ImageElement, scale = 1, bakeRotation = false): HTMLCanvasElement {
  const w = Math.max(1, Math.round(el.width * scale));
  const h = Math.max(1, Math.round(el.height * scale));
  const angle = bakeRotation ? ((el.rotation || 0) * Math.PI) / 180 : 0;
  // The axis-aligned box the rotated image needs. Unrotated this is exactly w x h.
  const cw = angle ? Math.ceil(Math.abs(w * Math.cos(angle)) + Math.abs(h * Math.sin(angle))) : w;
  const ch = angle ? Math.ceil(Math.abs(w * Math.sin(angle)) + Math.abs(h * Math.cos(angle))) : h;
  const key = `${el.id}|${el.imageData.length}|${cw}|${ch}|${el.dither ?? 'auto'}|${el.brightness || 0}|${el.contrast || 0}|${el.rotation || 0}`;
  const hit = ditherCache.get(key);
  if (hit) return hit;

  const cv = document.createElement('canvas');
  cv.width = cw;
  cv.height = ch;
  const c = cv.getContext('2d', { willReadFrequently: true })!;
  const f = imageFilterString(el);
  if (f) c.filter = f;
  if (angle) {
    c.translate(cw / 2, ch / 2);
    c.rotate(angle);
    c.drawImage(img, -w / 2, -h / 2, w, h);
  } else {
    c.drawImage(img, 0, 0, w, h);
  }
  c.filter = 'none';
  const data = c.getImageData(0, 0, cw, ch);
  // Resolved from the canvas that will be binarised, so a rotated image is judged in the orientation
  // it prints in. Worth knowing: the ported heuristic samples on a stride derived from the canvas
  // size, so its verdict for a synthetic gradient can change with the size. A photograph carries
  // enough distinct colour to be dithered at any size, which is the case this decides.
  const mode = resolveImageMode(data.data, cw, ch, el.dither);
  const gray = rgbaToGrayscale(data.data, cw, ch, 1.3);
  const bits = mode === 'none' ? thresholdGray(gray) : mode === 'atkinson' ? atkinson(gray, cw, ch) : mode === 'ordered' ? ordered(gray, cw, ch) : floydSteinberg(gray, cw, ch);
  for (let i = 0; i < bits.length; i++) {
    const v = bits[i] ? 0 : 255;
    data.data[i * 4] = data.data[i * 4 + 1] = data.data[i * 4 + 2] = v;
    data.data[i * 4 + 3] = 255;
  }
  c.putImageData(data, 0, 0);
  ditherCache.set(key, cv);
  if (ditherCache.size > 50) ditherCache.delete(ditherCache.keys().next().value!);
  return cv;
}

function drawImage(ctx: Ctx, el: ImageElement, width: number, height: number, opts: DrawOptions): void {
  if (!el.imageData) return;
  const img = getImage(el.imageData);
  if (!img || !img.naturalWidth) return;
  if (opts.ditherImages) {
    const scale = opts.scale ?? 1;
    const angle = el.rotation || 0;
    // A right-angle turn maps pixels exactly, so the halftone can be made unrotated and turned when
    // it is drawn. Any other angle resamples, and resampling a 1-bit image by nearest neighbour is
    // what turns a halftone into moire: on a photograph rotated 17 degrees the drawn-rotated version
    // showed jagged dot clumps and vertical columnar banding through the midtones, where binarising
    // the rotated image gave clean isotropic dots. So for those angles the rotation is applied to
    // the image first and the draw below cancels the parent rotation.
    const bake = angle % 90 !== 0;
    const halftone = ditherPreview(img, el, scale, bake);
    ctx.save();
    // No smoothing either way. The halftone is already at device resolution, so this draw maps it 1:1
    // onto device pixels; interpolating a 1-bit image spreads each dot over its neighbours' grey and
    // the threshold that follows turns those greys into clumps. See DrawOptions.scale.
    ctx.imageSmoothingEnabled = false;
    if (bake) {
      ctx.rotate(-(angle * Math.PI) / 180);
      ctx.drawImage(halftone, -halftone.width / (2 * scale), -halftone.height / (2 * scale), halftone.width / scale, halftone.height / scale);
    } else {
      ctx.drawImage(halftone, -width / 2, -height / 2, width, height);
    }
    ctx.restore();
    return;
  }
  const f = imageFilterString(el);
  if (f) ctx.filter = f;
  ctx.drawImage(img, -width / 2, -height / 2, width, height);
  if (f) ctx.filter = 'none';
}

// ---- barcode --------------------------------------------------------------------

const RENDER_SCALE = 3;
const barcodeCache = new Map<string, HTMLCanvasElement>();

/** Module pattern for a barcode ('1' = bar), or null when the data is invalid for the format. */
export function encodeBarcode(data: string, format: string): string | null {
  try {
    const target: { encodings?: { data: string }[] } = {};
    JsBarcode(target, data, { format, displayValue: false, margin: 0 } as JsBarcode.Options);
    return (target.encodings ?? []).map((e) => e.data).join('');
  } catch {
    return null;
  }
}

function drawBarcode(ctx: Ctx, el: BarcodeElement, width: number, height: number, opts: DrawOptions): void {
  const data = el.barcodeData;
  if (!data || !data.trim()) return;
  const format = el.barcodeFormat || 'CODE128';
  const showText = el.showText !== false;
  const fontSize = el.textFontSize || 12;
  const bold = el.textBold || false;

  const modules = encodeBarcode(data, format);
  const rw = Math.max(1, Math.round(width * RENDER_SCALE));
  const rh = Math.max(1, Math.round(height * RENDER_SCALE));
  const count = modules?.length ?? 0;
  const pxWidth = Math.max(1, Math.round(width));
  let bar = count > 0 ? Math.floor(pxWidth / count) : 2;
  const tooSmall = count > 0 && bar < 1;
  if (bar < 1) bar = 1;

  if (!modules) {
    ctx.strokeStyle = '#ccc';
    ctx.strokeRect(-width / 2, -height / 2, width, height);
    return;
  }

  const warn = opts.preview && tooSmall;
  const key = `${modules}|${rw}|${rh}|${showText}|${fontSize}|${bold}|${bar}|${warn ? 1 : 0}|${showText ? data : ''}`;
  let cv = barcodeCache.get(key);
  if (!cv) {
    cv = document.createElement('canvas');
    cv.width = rw;
    cv.height = rh;
    const c = cv.getContext('2d')!;
    c.imageSmoothingEnabled = false;
    c.fillStyle = 'white';
    c.fillRect(0, 0, rw, rh);

    const S = RENDER_SCALE;
    const renderFont = fontSize * S;
    const textBlock = showText ? renderFont + 8 * S : 0;
    const barsH = Math.round(Math.max(1, rh - textBlock) * 0.85);
    const availH = Math.max(1, rh - (showText ? renderFont + 6 * S : 0));
    const drawW = count * bar * S;
    const drawH = Math.min(barsH, availH);
    const dx = Math.floor(Math.floor((rw - drawW) / 2) / S) * S;
    const dy = 2 * S;

    c.fillStyle = 'black';
    for (let i = 0; i < count; ) {
      if (modules[i] !== '1') { i++; continue; }
      let j = i;
      while (j < count && modules[j] === '1') j++;
      c.fillRect(dx + i * bar * S, dy, (j - i) * bar * S, drawH);
      i = j;
    }
    if (showText) {
      const ty = dy + drawH + 2 * S;
      if (ty < rh) {
        c.fillStyle = 'black';
        c.font = `${bold ? 'bold ' : ''}${renderFont}px monospace`;
        c.textAlign = 'center';
        c.textBaseline = 'top';
        c.fillText(data, rw / 2, ty);
      }
    }
    if (warn) {
      c.fillStyle = '#ff0000';
      c.fillRect(0, rh - Math.max(1, S), rw, Math.max(1, S));
    }
    barcodeCache.set(key, cv);
    if (barcodeCache.size > 100) barcodeCache.delete(barcodeCache.keys().next().value!);
  }
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(cv, -width / 2, -height / 2, width, height);
}

// ---- QR -------------------------------------------------------------------------

const qrCache = new Map<string, HTMLCanvasElement>();

function drawQR(ctx: Ctx, el: QRElement, width: number, height: number): void {
  const data = el.qrData;
  if (!data || !data.trim()) return;
  const size = Math.min(width, height);
  const key = `${size}|${data}`;
  let cv = qrCache.get(key);
  if (!cv) {
    try {
      const qr = QRCode.create(data, { errorCorrectionLevel: 'M' });
      // Same pixel mapping as the qrcode library's canvas renderer (margin 1 module).
      const n = qr.modules.size;
      const margin = 1;
      const scale = size >= 21 && size >= n + margin * 2 ? size / (n + margin * 2) : 4;
      const symbol = Math.floor((n + margin * 2) * scale);
      const scaledMargin = margin * scale;
      cv = document.createElement('canvas');
      cv.width = cv.height = symbol;
      const c = cv.getContext('2d')!;
      const img = c.createImageData(symbol, symbol);
      for (let i = 0; i < symbol; i++) {
        for (let j = 0; j < symbol; j++) {
          let dark = false;
          if (i >= scaledMargin && j >= scaledMargin && i < symbol - scaledMargin && j < symbol - scaledMargin) {
            dark = !!qr.modules.data[Math.floor((i - scaledMargin) / scale) * n + Math.floor((j - scaledMargin) / scale)];
          }
          const p = (i * symbol + j) * 4;
          img.data[p] = img.data[p + 1] = img.data[p + 2] = dark ? 0 : 255;
          img.data[p + 3] = 255;
        }
      }
      c.putImageData(img, 0, 0);
      qrCache.set(key, cv);
      if (qrCache.size > 100) qrCache.delete(qrCache.keys().next().value!);
    } catch {
      ctx.strokeStyle = '#ccc';
      ctx.strokeRect(-size / 2, -size / 2, size, size);
      return;
    }
  }
  const prev = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(cv, -size / 2, -size / 2, size, size);
  ctx.imageSmoothingEnabled = prev;
}

// ---- shapes ---------------------------------------------------------------------

const DITHER_DENSITY: Record<string, number> = {
  'dither-6': 0.0625, 'dither-12': 0.125, 'dither-25': 0.25, 'dither-light': 0.25, 'dither-37': 0.375,
  'dither-50': 0.5, 'dither-medium': 0.5, 'dither-62': 0.625, 'dither-75': 0.75, 'dither-dark': 0.75,
  'dither-87': 0.875, 'dither-94': 0.9375,
};
export const DITHER_FILLS = ['dither-6', 'dither-12', 'dither-25', 'dither-37', 'dither-50', 'dither-62', 'dither-75', 'dither-87', 'dither-94'];

const BAYER4 = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];

function fillDither(ctx: Ctx, fill: string, width: number, height: number): void {
  const density = DITHER_DENSITY[fill] ?? 0;
  if (density === 0) return;
  const cell = 2;
  const hw = Math.ceil(width / 2 / cell) + 2;
  const hh = Math.ceil(height / 2 / cell) + 2;
  ctx.save();
  ctx.clip();
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = 'white';
  ctx.fillRect(-hw * cell - cell, -hh * cell - cell, (hw * 2 + 2) * cell, (hh * 2 + 2) * cell);
  ctx.fillStyle = 'black';
  for (let cy = -hh; cy <= hh; cy++) {
    for (let cx = -hw; cx <= hw; cx++) {
      if (density > BAYER4[Math.abs(cy) & 3][Math.abs(cx) & 3] / 16) ctx.fillRect(cx * cell, cy * cell, cell, cell);
    }
  }
  ctx.restore();
}

function paint(ctx: Ctx, w: number, h: number, fill: string, stroke: string, strokeWidth: number): void {
  if (fill && fill !== 'none') {
    if (fill.startsWith('dither-')) fillDither(ctx, fill, w, h);
    else { ctx.fillStyle = fill; ctx.fill(); }
  }
  if (stroke && stroke !== 'none') {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = strokeWidth || 2;
    ctx.stroke();
  }
}

/**
 * Colour for the stroke-only shapes ('line', 'check').
 *
 * The obvious `stroke || fill || 'black'` is wrong here: "no colour" in this model is the *string*
 * `'none'`, which is truthy, so the fallback never ran and the code assigned `ctx.strokeStyle =
 * 'none'` — an invalid colour that canvas silently ignores, leaving the previous strokeStyle in
 * place. A default line or tick therefore came out in whatever colour the last draw had set
 * (measured: the label's 28%-alpha outline, i.e. a light grey) instead of black.
 */
function strokeInk(stroke: string, fill: string): string {
  if (stroke && stroke !== 'none') return stroke;
  if (fill && fill !== 'none') return fill;
  return 'black';
}

function drawShape(ctx: Ctx, el: ShapeElement, w: number, h: number): void {
  const { fill, stroke, strokeWidth } = el;
  ctx.beginPath();
  switch (el.shapeType) {
    case 'ellipse':
      ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
      break;
    case 'triangle':
      ctx.moveTo(0, -h / 2);
      ctx.lineTo(w / 2, h / 2);
      ctx.lineTo(-w / 2, h / 2);
      break;
    case 'diamond':
      ctx.moveTo(0, -h / 2);
      ctx.lineTo(w / 2, 0);
      ctx.lineTo(0, h / 2);
      ctx.lineTo(-w / 2, 0);
      break;
    case 'pentagon':
    case 'hexagon': {
      const sides = el.shapeType === 'pentagon' ? 5 : 6;
      for (let i = 0; i < sides; i++) {
        const a = -Math.PI / 2 + (i * 2 * Math.PI) / sides;
        const px = Math.cos(a) * (w / 2), py = Math.sin(a) * (h / 2);
        if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
      }
      break;
    }
    case 'star': {
      // Five-point star: outer and inner radii alternate. The inner radius is cos(72°)/cos(36°)
      // ≈ 0.382 of the outer one, which is what keeps a five-pointer's arms straight instead of
      // bowed; the box's w/h ratio scales it into whatever the user drags out.
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        const k = i % 2 ? 0.382 : 1;
        const px = Math.cos(a) * (w / 2) * k, py = Math.sin(a) * (h / 2) * k;
        if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
      }
      break;
    }
    case 'heart': {
      // A unit-square heart mapped onto the box, so it fills whatever shape the user draws.
      const X = (u: number) => (u - 0.5) * w;
      const Y = (u: number) => (u - 0.5) * h;
      ctx.moveTo(X(0.5), Y(0.95));
      ctx.bezierCurveTo(X(0.02), Y(0.62), X(0.02), Y(0.1), X(0.32), Y(0.05));
      ctx.bezierCurveTo(X(0.43), Y(0.02), X(0.5), Y(0.1), X(0.5), Y(0.2));
      ctx.bezierCurveTo(X(0.5), Y(0.1), X(0.57), Y(0.02), X(0.68), Y(0.05));
      ctx.bezierCurveTo(X(0.98), Y(0.1), X(0.98), Y(0.62), X(0.5), Y(0.95));
      break;
    }
    case 'plus': {
      const t = 0.18;   // half-thickness of the bars, as a fraction of the box
      ctx.moveTo(-w * t, -h / 2);
      ctx.lineTo(w * t, -h / 2);
      ctx.lineTo(w * t, -h * t);
      ctx.lineTo(w / 2, -h * t);
      ctx.lineTo(w / 2, h * t);
      ctx.lineTo(w * t, h * t);
      ctx.lineTo(w * t, h / 2);
      ctx.lineTo(-w * t, h / 2);
      ctx.lineTo(-w * t, h * t);
      ctx.lineTo(-w / 2, h * t);
      ctx.lineTo(-w / 2, -h * t);
      ctx.lineTo(-w * t, -h * t);
      break;
    }
    case 'arrowRight':
    case 'arrowLeft': {
      const s = el.shapeType === 'arrowLeft' ? -1 : 1;
      const shaft = h * 0.22;
      ctx.moveTo(-s * (w / 2), -shaft);
      ctx.lineTo(s * w * 0.1, -shaft);
      ctx.lineTo(s * w * 0.1, -h / 2);
      ctx.lineTo(s * (w / 2), 0);
      ctx.lineTo(s * w * 0.1, h / 2);
      ctx.lineTo(s * w * 0.1, shaft);
      ctx.lineTo(-s * (w / 2), shaft);
      break;
    }
    case 'check': {
      // Like 'line', this one is a stroke rather than a closed region. The floor matters: the
      // default strokeWidth is 2, which on a 203dpi label is a hairline next to the solid shapes,
      // so the tick picks up a thickness proportional to its own box and the user's strokeWidth
      // only ever makes it heavier.
      ctx.moveTo(-w * 0.36, 0);
      ctx.lineTo(-w * 0.08, h * 0.3);
      ctx.lineTo(w * 0.38, -h * 0.32);
      ctx.strokeStyle = strokeInk(stroke, fill);
      ctx.lineWidth = Math.max(strokeWidth || 2, Math.min(w, h) * 0.12);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke();
      return;
    }
    case 'line':
      ctx.moveTo(-w / 2, 0);
      ctx.lineTo(w / 2, 0);
      ctx.strokeStyle = strokeInk(stroke, fill);
      ctx.lineWidth = strokeWidth || 2;
      ctx.lineCap = 'round';
      ctx.stroke();
      return;
    default: {
      const x = -w / 2, y = -h / 2;
      const r = Math.min(el.cornerRadius || 0, w / 2, h / 2);
      if (r > 0) {
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y);
        ctx.quadraticCurveTo(x + w, y, x + w, y + r);
        ctx.lineTo(x + w, y + h - r);
        ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        ctx.lineTo(x + r, y + h);
        ctx.quadraticCurveTo(x, y + h, x, y + h - r);
        ctx.lineTo(x, y + r);
        ctx.quadraticCurveTo(x, y, x + r, y);
      } else ctx.rect(x, y, w, h);
    }
  }
  ctx.closePath();
  paint(ctx, w, h, fill, stroke, strokeWidth);
}

// Re-export so callers only need one import for pixel → raster.
export { pixelsToRaster };
