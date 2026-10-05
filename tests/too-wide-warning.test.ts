/**
 * The too-wide warning and the print job latch, from a review of v1.0.12.
 *
 *  widthBytes counts 8-dot bytes, so its length in millimetres depends on the head's DPI. The
 *  warning compared the label's 203 DPI pixels against `widthBytes * 8` and quoted that byte
 *  count with an "mm" suffix. On a 300 DPI printer — four of the built-in ones — a label wider
 *  than the real head was clipped with no warning, and the warning that did appear named a width
 *  roughly 25 mm too wide.
 *
 *  rasterFor() runs once per label in a batch, so the warning fired once per record: a hundred
 *  records queued a hundred identical toasts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { warnIfWiderThanPrinter, beginPrintJob } from '../src/services/printing';
import { useStore } from '../src/state/store';

const toasts = () => useStore.getState().toasts;
/** Toasts expire on a timer, so clear them between assertions rather than sleeping. */
const clearToasts = () => useStore.setState({ toasts: [] });

describe('the too-wide warning converts through the printer DPI', () => {
  beforeEach(() => { clearToasts(); beginPrintJob(); });

  it('warns for a label wider than a 203 DPI head', () => {
    // A 203 DPI head: 40 bytes is 40 mm.
    warnIfWiderThanPrinter({ width: 45 * 8 }, { widthBytes: 40, dpi: 203 });
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0]).toMatchObject({ kind: 'info' });
  });

  it('warns for a label wider than a 300 DPI head, which the old check missed', () => {
    // An M02 Pro: 78 bytes at 300 DPI is 52.8 mm, not 78 mm. A 54 mm label is clipped, and the
    // old check compared 54 mm against 78 mm and stayed silent.
    warnIfWiderThanPrinter({ width: 54 * 8 }, { widthBytes: 78, dpi: 300 });
    expect(toasts()).toHaveLength(1);
  });

  it('stays silent for a label that fits a 300 DPI head', () => {
    // 50 mm fits inside 52.8 mm of head.
    warnIfWiderThanPrinter({ width: 50 * 8 }, { widthBytes: 78, dpi: 300 });
    expect(toasts()).toHaveLength(0);
  });

  it('the number it quotes is the real head width, not the byte count', () => {
    // Quoted to one decimal (52.8), not rounded to 53: rounding it to the label's own width made
    // the warning report the printer as able to print the width the warning exists to report as
    // clipped. Never the byte count.
    warnIfWiderThanPrinter({ width: 60 * 8 }, { widthBytes: 78, dpi: 300 });
    const body = JSON.stringify(toasts()[0]);
    expect(body).not.toContain('78');
    expect(body).toContain('52.8');
  });

  it('a whole-millimetre head is still quoted as a whole number', () => {
    warnIfWiderThanPrinter({ width: 45 * 8 }, { widthBytes: 40, dpi: 203 });
    expect(JSON.stringify(toasts()[0])).toContain('40mm');
  });
});

describe('the warning fires once per print job', () => {
  beforeEach(clearToasts);

  it('a batch of too-wide labels queues one toast, not one per label', () => {
    beginPrintJob();
    for (let i = 0; i < 100; i++) warnIfWiderThanPrinter({ width: 60 * 8 }, { widthBytes: 40, dpi: 203 });
    expect(toasts()).toHaveLength(1);
  });

  it('a second job warns again', () => {
    beginPrintJob();
    warnIfWiderThanPrinter({ width: 60 * 8 }, { widthBytes: 40, dpi: 203 });
    beginPrintJob();
    warnIfWiderThanPrinter({ width: 60 * 8 }, { widthBytes: 40, dpi: 203 });
    expect(toasts()).toHaveLength(2);
  });
});
