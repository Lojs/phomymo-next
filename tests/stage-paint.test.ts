/**
 * Stage painting — zone placement, the faded overhang region, and the active-zone accent.
 *
 * paintStage draws to a canvas, so these tests drive it through a recording 2D context and assert
 * on the operations that actually determine what the user sees: where the clip regions land, what
 * alpha is in force for each pass, and which zone is accented.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { placed, paintStage, zoneOrigin, PAD } from '../src/ui/stage/paint';
import { multiLayout, singleLayout } from '../src/core/render/layout';
import { createText } from '../src/core/model/elements';

/** A 2D context stub that records every call and tracks save/restore of alpha. */
function recordingCtx() {
  const ops: { op: string; args: number[] }[] = [];
  let alpha = 1;
  const stack: number[] = [];
  const ctx: any = {
    globalAlpha: 1,
    lineWidth: 1,
    strokeStyle: '',
    fillStyle: '',
    shadowColor: '',
    shadowBlur: 0,
    shadowOffsetY: 0,
    imageSmoothingEnabled: true,
    setTransform: (...a: number[]) => ops.push({ op: 'setTransform', args: a }),
    clearRect: (...a: number[]) => ops.push({ op: 'clearRect', args: a }),
    save: () => { stack.push(ctx.globalAlpha); ops.push({ op: 'save', args: [] }); },
    restore: () => { ctx.globalAlpha = stack.pop() ?? 1; ops.push({ op: 'restore', args: [] }); },
    beginPath: () => ops.push({ op: 'beginPath', args: [] }),
    rect: (...a: number[]) => ops.push({ op: 'rect', args: a }),
    arc: (...a: number[]) => ops.push({ op: 'arc', args: a }),
    clip: (...a: any[]) => ops.push({ op: 'clip', args: a as number[] }),
    fill: () => ops.push({ op: 'fill', args: [] }),
    stroke: () => ops.push({ op: 'stroke', args: [] }),
    strokeRect: (...a: number[]) => ops.push({ op: 'strokeRect', args: a }),
    fillRect: (...a: number[]) => ops.push({ op: 'fillRect', args: a }),
    drawImage: () => ops.push({ op: 'drawImage', args: [] }),
    measureText: () => ({ width: 10 }),
    fillText: () => ops.push({ op: 'fillText', args: [] }),
    translate: () => {},
    rotate: () => {},
    scale: () => {},
    createImageData: () => ({ data: new Uint8ClampedArray(4) }),
    putImageData: () => {},
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    // record alpha at the moment of each clip so the faded pass can be identified
    _alphaAtClip: () => ops.filter((o) => o.op === 'clip').length,
  };
  Object.defineProperty(ctx, 'globalAlpha', {
    get: () => alpha,
    set: (v: number) => { alpha = v; ops.push({ op: 'alpha', args: [v] }); },
  });
  return { ctx, ops };
}

function fakeCanvas(ctx: any) {
  return { width: 800, height: 600, getContext: () => ctx } as unknown as HTMLCanvasElement;
}

const text = (over: Record<string, unknown> = {}) => ({ ...createText('A', { x: 10, y: 10, width: 50, height: 20 }), ...over });

describe('zoneOrigin', () => {
  it('returns the zone offset on a roll', () => {
    const layout = multiLayout({ labelWidth: 10, labelHeight: 20, labelsAcross: 3, gapMm: 2 });
    // The whole zone is returned, so callers get its size too; only the offset matters here.
    expect(zoneOrigin(layout, 1)).toMatchObject({ x: 10 * 8 + 2 * 8, y: 0 });
    expect(layout.zones![1].width).toBe(10 * 8);
  });

  it('falls back to the origin for a single label and for an out-of-range zone', () => {
    const single = singleLayout({ width: 40, height: 30 });
    expect(zoneOrigin(single, 0)).toEqual({ x: 0, y: 0 });
    const roll = multiLayout({ labelWidth: 10, labelHeight: 20, labelsAcross: 2, gapMm: 2 });
    expect(zoneOrigin(roll, 99)).toEqual({ x: 0, y: 0 });
  });
});

describe('placed', () => {
  it('leaves elements untouched on a single label', () => {
    const layout = singleLayout({ width: 40, height: 30 });
    const els = [text()];
    expect(placed(els, layout)).toBe(els); // same reference: no needless copy
  });

  it('offsets each element by its own zone', () => {
    const layout = multiLayout({ labelWidth: 10, labelHeight: 20, labelsAcross: 3, gapMm: 2 });
    const a = text({ zone: 0, x: 5, y: 7 });
    const b = text({ zone: 2, x: 5, y: 7 });
    const out = placed([a, b], layout);
    const stride = 10 * 8 + 2 * 8;
    expect(out[0]).toMatchObject({ x: 5, y: 7 });
    expect(out[1]).toMatchObject({ x: 5 + 2 * stride, y: 7 });
  });

  it('drops elements pointing at a zone that no longer exists', () => {
    const layout = multiLayout({ labelWidth: 10, labelHeight: 20, labelsAcross: 2, gapMm: 2 });
    const orphan = text({ zone: 7 });
    expect(placed([orphan], layout)).toEqual([]);
  });

  it('does not mutate the input elements', () => {
    const layout = multiLayout({ labelWidth: 10, labelHeight: 20, labelsAcross: 3, gapMm: 2 });
    const a = text({ zone: 1, x: 5, y: 7 });
    placed([a], layout);
    expect(a.x).toBe(5);
    expect(a.y).toBe(7);
  });
});

describe('paintStage', () => {
  let rec: ReturnType<typeof recordingCtx>;

  beforeEach(() => {
    rec = recordingCtx();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  const args = (over: Record<string, unknown> = {}) => ({
    canvas: fakeCanvas(rec.ctx),
    layout: singleLayout({ width: 40, height: 30 }),
    elements: [text()],
    zoom: 1,
    dpr: 1,
    activeZone: 0,
    ditherImages: false,
    paper: null,
    accent: '#f00',
    ...over,
  });

  it('applies zoom and dpr to the transform, offset by the editing pad', () => {
    paintStage(args({ zoom: 2, dpr: 3 }) as never);
    const k = 6;
    const t = rec.ops.find((o) => o.op === 'setTransform' && o.args[0] === k)!;
    expect(t.args).toEqual([k, 0, 0, k, PAD * k, PAD * k]);
  });

  it('clears the whole canvas before drawing', () => {
    paintStage(args() as never);
    const clear = rec.ops.find((o) => o.op === 'clearRect')!;
    expect(clear.args).toEqual([0, 0, 800, 600]);
  });

  it('draws the overhang pass faded and the on-label pass fully opaque', () => {
    paintStage(args() as never);
    // Two clip passes happen for elements: the evenodd overhang, then the label clip.
    const alphas = rec.ops.filter((o) => o.op === 'alpha').map((o) => o.args[0]);
    expect(alphas).toContain(0.3); // the faded overhang
    expect(alphas).toContain(1);   // restored before the on-label pass
  });

  it('clips the overhang region with the evenodd rule', () => {
    paintStage(args() as never);
    const clip = rec.ops.find((o) => o.op === 'clip')!;
    expect(clip.args).toEqual(['evenodd']);
  });

  it('skips the element that is open in the in-place editor', () => {
    const el = text();
    paintStage(args({ elements: [el], skipId: el.id }) as never);
    // Nothing to paint, but the frame still renders: the label outline is stroked.
    expect(rec.ops.some((o) => o.op === 'stroke')).toBe(true);
  });

  it('draws the supplied 1-bpp paper preview instead of live elements', () => {
    const paper = fakeCanvas(recordingCtx().ctx);
    paintStage(args({ paper }) as never);
    expect(rec.ops.some((o) => o.op === 'drawImage')).toBe(true);
  });

  it('accentuates the active zone only on a multi-zone roll', () => {
    const roll = multiLayout({ labelWidth: 10, labelHeight: 20, labelsAcross: 3, gapMm: 2 });
    paintStage(args({ layout: roll, activeZone: 1 }) as never);
    const accentStroke = rec.ops.filter((o) => o.op === 'strokeRect');
    expect(accentStroke.length).toBe(1);
    const stride = 10 * 8 + 2 * 8;
    expect(accentStroke[0].args).toEqual([stride, 0, 10 * 8, 20 * 8]);
  });

  it('clamps the accented zone when activeZone is out of range', () => {
    const roll = multiLayout({ labelWidth: 10, labelHeight: 20, labelsAcross: 3, gapMm: 2 });
    expect(() => paintStage(args({ layout: roll, activeZone: 99 }) as never)).not.toThrow();
    const accentStroke = rec.ops.filter((o) => o.op === 'strokeRect');
    expect(accentStroke.length).toBe(1);
  });

  it('does not accent any zone on a single label', () => {
    paintStage(args() as never);
    expect(rec.ops.filter((o) => o.op === 'strokeRect').length).toBe(0);
  });

  it('renders a round label with an arc, not a rect', () => {
    paintStage(args({ layout: singleLayout({ width: 40, height: 40, round: true }) }) as never);
    expect(rec.ops.some((o) => o.op === 'arc')).toBe(true);
  });
});
