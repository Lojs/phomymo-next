/**
 * Shared setup for the jsdom component tests.
 *
 * jsdom gives us a DOM but not the canvas API, and the app renders to a <canvas> everywhere. The
 * stub below satisfies the calls the renderer makes without pretending to rasterise anything —
 * component tests assert on structure and behaviour, not on pixels.
 *
 * This file is loaded for every test, including the node-environment logic tests, so everything
 * is guarded on `document` existing.
 */
import { vi } from 'vitest';

const hasDom = typeof document !== 'undefined' && typeof HTMLCanvasElement !== 'undefined';

/** A no-op 2D context: every drawing call is accepted and discarded. */
function stubContext(): CanvasRenderingContext2D {
  const noop = () => {};
  return {
    canvas: {} as HTMLCanvasElement,
    font: '',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    globalAlpha: 1,
    imageSmoothingEnabled: true,
    imageSmoothingQuality: 'low',
    shadowColor: '',
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    filter: 'none',
    measureText: (t: string) => ({ width: t.length * 8 }) as TextMetrics,
    save: noop, restore: noop, scale: noop, rotate: noop, translate: noop,
    transform: noop, setTransform: noop, resetTransform: noop,
    beginPath: noop, closePath: noop, moveTo: noop, lineTo: noop,
    bezierCurveTo: noop, quadraticCurveTo: noop, arc: noop, arcTo: noop, ellipse: noop, rect: noop,
    fill: noop, stroke: noop, clip: noop,
    fillRect: noop, strokeRect: noop, clearRect: noop,
    fillText: noop, strokeText: noop,
    drawImage: noop, putImageData: noop,
    createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }) as ImageData,
    getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }) as ImageData,
    setLineDash: noop, getLineDash: () => [],
  } as unknown as CanvasRenderingContext2D;
}

if (hasDom) {
  // jsdom defines getContext but throws "not implemented"; override it globally.
  HTMLCanvasElement.prototype.getContext = function getContext(this: HTMLCanvasElement) {
    return stubContext();
  } as unknown as HTMLCanvasElement['getContext'];

  // toDataURL / toBlob are likewise unimplemented; the export paths call them.
  HTMLCanvasElement.prototype.toDataURL = function toDataURL() {
    return 'data:image/png;base64,';
  };
  HTMLCanvasElement.prototype.toBlob = function toBlob(cb: BlobCallback) {
    cb(new Blob([], { type: 'image/png' }));
  };

  // The app reads document.fonts before rasterising.
  if (!('fonts' in document)) {
    Object.defineProperty(document, 'fonts', {
      value: { load: () => Promise.resolve([]), ready: Promise.resolve(), addEventListener: () => {}, removeEventListener: () => {} },
      configurable: true,
    });
  }

  if (!window.matchMedia) {
    Object.defineProperty(window, 'matchMedia', {
      value: (q: string) => ({ matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, onchange: null, dispatchEvent: () => false }),
      configurable: true,
    });
  }

  // jsdom has no ResizeObserver, and the stage uses one to track its size.
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as any).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }

  // URL.createObjectURL is used by the download helper.
  if (!URL.createObjectURL) {
    Object.defineProperty(URL, 'createObjectURL', { value: () => 'blob:test', configurable: true, writable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: () => {}, configurable: true, writable: true });
  }

  // React 19 needs this flag to allow act() outside a test-runner integration.
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
}

// The app is chatty; keep test output readable unless a test opts back in.
vi.spyOn(console, 'log').mockImplementation(() => {});
