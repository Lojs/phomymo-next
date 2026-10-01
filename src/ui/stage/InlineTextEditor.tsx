import { useEffect, useMemo, useRef, type CSSProperties } from 'react';
import type { TextElement, Point } from '../../core/model/elements';
import { useStore } from '../../state/store';
import { autoScaleFontSize, wrapText } from '../../core/render/draw';

/**
 * A measuring context, kept at module scope. Both the font size and the wrapped line count come
 * from the very functions the canvas uses (autoScaleFontSize / wrapText) — duplicating that
 * logic here would let the two drift apart, and any drift shows up as the text jumping the
 * moment you click away.
 */
let measureCtx: CanvasRenderingContext2D | null = null;
const getMeasureCtx = (): CanvasRenderingContext2D => {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d')!;
  return measureCtx;
};

/** Edit a text element in place: a textarea laid over the element with matching typography. */
export function InlineTextEditor({ el, origin, zoom, pad, onDone }: { el: TextElement; origin: Point; zoom: number; pad: number; onDone: () => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
    useStore.getState().checkpoint();
  }, []);

  /**
   * The canvas does not draw this element while the editor is open (paintStage's skipId), so
   * this textarea is the only rendering of the text on screen. Its padding therefore has to put
   * the first line exactly where the canvas would have — same font size, same line box, same
   * vertical alignment — or the text would jump on the frame you finish editing. Mirrors the
   * layout rules in drawText().
   */
  const padTop = useMemo(() => {
    const ctx = getMeasureCtx();
    const size = el.autoScale ? autoScaleFontSize(ctx, el, el.width, el.height) : el.fontSize;
    const lines = el.noWrap
      ? el.text.split('\n')
      : wrapText(ctx, el.text, el.width - 8, size, el.fontFamily, el.fontWeight, el.fontStyle);
    const lineHeight = size * 1.2;
    const totalHeight = lines.length * lineHeight;

    const v = el.verticalAlign || 'middle';
    let centreY: number;
    if (v === 'top') centreY = lineHeight / 2 + 2;
    else if (v === 'bottom') centreY = el.height - totalHeight + lineHeight / 2 - 2;
    else centreY = (el.height - totalHeight) / 2 + lineHeight / 2;

    if (el.autoScale) {
      const unused = el.height - totalHeight;
      if (unused / el.height > 0.4) centreY -= unused * 0.08;
      else if (v === 'bottom') centreY += 1;
      else if (v === 'middle') centreY += 0.5;
    }
    // Baseline-model correction. The canvas places textBaseline:'middle' on the em box, whereas
    // a textarea centres the font's content area inside the line box; the two disagree by a fixed
    // fraction of the font size (all font metrics scale with it), which showed up as the text
    // shifting 3.4 CSS px on the frame you leave the editor. The factor was measured off the
    // rendered pixels, not guessed. drawText() is unchanged — the editor is aligned to the
    // canvas, never the other way round, so nothing here can affect what gets printed.
    const BASELINE_MODEL_OFFSET = 0.091;
    return (centreY - lineHeight / 2 - size * BASELINE_MODEL_OFFSET) * zoom;
  }, [el, zoom]);

  const style: CSSProperties = {
    left: (el.x + origin.x + pad) * zoom,
    top: (el.y + origin.y + pad) * zoom,
    width: el.width * zoom,
    height: el.height * zoom,
    transform: `rotate(${el.rotation || 0}deg)`,
    fontFamily: el.fontFamily,
    fontSize: el.fontSize * zoom,
    fontWeight: el.fontWeight,
    fontStyle: el.fontStyle,
    textAlign: el.align,
    lineHeight: 1.2,
    color: el.color,
    // Replaces the old uniform `padding: 2px 4px`: the top inset now depends on the element's
    // vertical alignment, and 2px was never a match for any of the three cases.
    paddingTop: padTop,
    paddingRight: 4 * zoom,
    paddingBottom: 0,
    paddingLeft: 4 * zoom,
    whiteSpace: el.noWrap ? 'pre' : 'pre-wrap',
  };
  return (
    <textarea
      ref={ref}
      className="inline-editor"
      style={style}
      value={el.text}
      dir="auto"
      onChange={(e) => useStore.getState().patch([el.id], { text: e.target.value })}
      onBlur={onDone}
      onKeyDown={(e) => {
        if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) { e.preventDefault(); onDone(); }
        e.stopPropagation();
      }}
    />
  );
}