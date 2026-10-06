// @vitest-environment jsdom
/**
 * N2, from the v1.0.24 review: mutating the composite mode in rasterFor() from 'threshold' to
 * 'auto' left the entire suite green.
 *
 * That one argument is the core of the work in 1.0.22 and 1.0.24. Text, barcodes and shapes are
 * line art, and error-diffusing their antialiased edges is what made printed labels look speckled
 * and hollow — measured at 453 isolated single dots on a text-only label, against none under a
 * threshold. The mode that produced that was a `modeFor()` which went wrong twice and was deleted;
 * nothing took over its test, so the rule was one careless edit from returning.
 *
 * jsdom's canvas discards drawing, so the consequence cannot be asserted here. The decision can:
 * the mode rasterFor() hands to the rasteriser. The pixel consequence is measured in a browser.
 */
import { describe, it, expect, vi } from 'vitest';

/** Every mode the rasteriser is asked for, in order. */
const modes: (string | undefined)[] = [];

// buildRaster is wrapped, not replaced: the real raster path still runs underneath.
vi.mock('../src/core/render/label', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/core/render/label')>();
  return {
    ...real,
    buildRaster: (...args: Parameters<typeof real.buildRaster>) => {
      modes.push(args[3]);
      return real.buildRaster(...args);
    },
  };
});

// prepareForRender awaits image decoding, and jsdom never fires onload for a data URL — without
// this the image case would hang rather than fail.
vi.mock('../src/core/render/images', () => ({
  loadImage: async () => null,
  getImage: () => null,
  onImageLoaded: () => () => {},
}));

import { rasterFor } from '../src/services/printing';
import { createImage, createText } from '../src/core/model/elements';

describe('N2: the composite is thresholded, never dithered', () => {
  it('asks for a threshold on a text label', async () => {
    modes.length = 0;
    await rasterFor([createText('A')]);
    expect(modes).toEqual(['threshold']);
  });

  it('still asks for a threshold when the label contains an image', async () => {
    // The image carries its own rule and is binarised while it is drawn. Putting the composite back
    // on the photo path is exactly what speckled the text beside a logo.
    modes.length = 0;
    await rasterFor([createText('A'), createImage('data:image/png;base64,AAAA', { width: 40, height: 40 })]);
    expect(modes).toEqual(['threshold']);
  });

  it('never asks for auto, which is the mode the heuristic answers for a whole label', async () => {
    modes.length = 0;
    await rasterFor([createText('A'), createImage('data:image/png;base64,AAAA', { width: 40, height: 40 })]);
    expect(modes).not.toContain('auto');
  });
});