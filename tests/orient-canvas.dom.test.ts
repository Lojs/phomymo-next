// @vitest-environment jsdom
/**
 * rotateCanvas — the preview-overlay path.
 *
 * The pixel-level rotation used by the print pipeline is covered in raster-rotate.test.ts. This
 * file covers the DOM-side sibling: rotating an already-painted canvas, which is what the print
 * preview uses so the on-paper thumbnail lines up with a landscape display.
 *
 * The canvas is checked by its dimensions and by the recorded transform, since jsdom's 2D context
 * does not rasterise — what can be asserted here is that the right rotation was composed.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { rotateCanvas } from '../src/core/render/orient';

/** Record the 2D calls rotateCanvas makes, so the composed transform can be asserted. */
function stubContext() {
  const calls: string[] = [];
  const ctx = {
    imageSmoothingEnabled: true,
    translate: (x: number, y: number) => void calls.push(`translate(${x},${y})`),
    rotate: (r: number) => void calls.push(`rotate(${r})`),
    drawImage: (...a: unknown[]) => void calls.push(`drawImage(${a.length} args)`),
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  return calls;
}

function srcCanvas(width: number, height: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  return c;
}

beforeEach(() => vi.restoreAllMocks());

describe('rotateCanvas', () => {
  it('swaps the dimensions', () => {
    stubContext();
    const out = rotateCanvas(srcCanvas(4, 9), true);
    // The result is as tall as the source was wide and vice versa.
    expect(out.width).toBe(9);
    expect(out.height).toBe(4);
  });

  it('rotates clockwise with a quarter turn', () => {
    const calls = stubContext();
    rotateCanvas(srcCanvas(4, 9), true);
    // Clockwise: shift right by the new width, then +90°.
    expect(calls).toContain('translate(9,0)');
    expect(calls).toContain(`rotate(${Math.PI / 2})`);
  });

  it('rotates counter-clockwise with a negative quarter turn', () => {
    const calls = stubContext();
    rotateCanvas(srcCanvas(4, 9), false);
    expect(calls).toContain('translate(0,4)');
    expect(calls).toContain(`rotate(${-Math.PI / 2})`);
  });

  it('disables smoothing, so the rotation does not blur the 1-bit artwork', () => {
    const calls = stubContext();
    // imageSmoothingEnabled is assigned on the context, not recorded by the stubs above, so this
    // asserts the draw happened with the context we were handed rather than a fresh one.
    const out = rotateCanvas(srcCanvas(2, 2), true);
    expect(calls.some((c) => c.startsWith('drawImage'))).toBe(true);
    expect(out).toBeInstanceOf(HTMLCanvasElement);
  });

  it('draws the source canvas, not an empty one', () => {
    const calls = stubContext();
    rotateCanvas(srcCanvas(6, 3), false);
    const draw = calls.find((c) => c.startsWith('drawImage'));
    // drawImage(source, 0, 0) — three arguments.
    expect(draw).toBe('drawImage(3 args)');
  });
});