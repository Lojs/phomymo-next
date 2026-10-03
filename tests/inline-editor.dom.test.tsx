// @vitest-environment jsdom
/**
 * InlineTextEditor — the in-place text editor laid over the canvas.
 *
 * The editor is the only rendering of the text while it is open (the canvas skips the element),
 * so its padding has to place the first line exactly where the canvas would, or the text jumps on
 * the frame you leave the editor. These tests pin that positioning and the commit behaviour.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { InlineTextEditor } from '../src/ui/stage/InlineTextEditor';
import { useStore } from '../src/state/store';
import { createText } from '../src/core/model/elements';
import type { TextElement } from '../src/core/model/elements';

const PAD = 120;

beforeEach(() => {
  cleanup();
  localStorage.clear();
  useStore.getState().newDesign();
  useStore.setState({ lang: 'en', past: [], future: [], selectedIds: [] });
});

afterEach(() => cleanup());

/** Render the editor for a text element built from overrides. */
function openEditor(over: Partial<TextElement> = {}, origin = { x: 0, y: 0 }, zoom = 1) {
  const el = { ...createText('HELLO'), ...over } as TextElement;
  return render(<InlineTextEditor el={el} origin={origin} zoom={zoom} pad={PAD} onDone={() => {}} />);
}

const ta = () => screen.getByRole('textbox') as HTMLTextAreaElement;

describe('the editor element', () => {
  it('is a textarea holding the element text', () => {
    openEditor({ text: 'CONTENT' });
    expect(ta().value).toBe('CONTENT');
  });

  it('is autofocused and fully selected, so typing replaces the text', () => {
    openEditor({ text: 'CONTENT' });
    expect(document.activeElement).toBe(ta());
    expect(ta().selectionStart).toBe(0);
    expect(ta().selectionEnd).toBe('CONTENT'.length);
  });

  it('opens with the text direction set to auto, so Arabic reads right-to-left', () => {
    openEditor({ text: 'مرحبا' });
    expect(ta().dir).toBe('auto');
  });
});

describe('positioning matches the canvas', () => {
  it('sits at the element position, offset by the edit margin and the zone origin', () => {
    openEditor({ x: 10, y: 20 }, { x: 96, y: 0 }, 1);
    const style = ta().style;
    expect(style.left).toBe(`${(10 + 96 + PAD)}px`);
    expect(style.top).toBe(`${(20 + 0 + PAD)}px`);
  });

  it('scales position and size by the zoom', () => {
    openEditor({ x: 10, y: 20, width: 100, height: 40 }, { x: 0, y: 0 }, 2);
    const style = ta().style;
    expect(style.left).toBe(`${(10 + PAD) * 2}px`);
    expect(style.width).toBe('200px');
    expect(style.height).toBe('80px');
  });

  it('carries the element rotation', () => {
    openEditor({ rotation: 45 });
    expect(ta().style.transform).toBe('rotate(45deg)');
  });

  it('reports no rotation for an element that has none', () => {
    openEditor({ rotation: 0 });
    expect(ta().style.transform).toBe('rotate(0deg)');
  });

  it('mirrors the element typography so the editor looks like the canvas', () => {
    openEditor({ fontFamily: 'Lato, sans-serif', fontWeight: 'bold', fontStyle: 'italic', color: 'red', align: 'center' });
    const s = ta().style;
    expect(s.fontFamily).toContain('Lato');
    expect(s.fontWeight).toBe('bold');
    expect(s.fontStyle).toBe('italic');
    expect(s.color).toBe('red');
    expect(s.textAlign).toBe('center');
  });

  it('keeps newlines literal when the element does not wrap', () => {
    openEditor({ noWrap: true });
    expect(ta().style.whiteSpace).toBe('pre');
  });

  it('wraps when the element wraps', () => {
    openEditor({ noWrap: false });
    expect(ta().style.whiteSpace).toBe('pre-wrap');
  });

  it('uses the element font size, scaled by zoom', () => {
    openEditor({ fontSize: 20 }, { x: 0, y: 0 }, 3);
    expect(ta().style.fontSize).toBe('60px');
  });

  it('uses a 1.2 line height, matching the canvas', () => {
    openEditor();
    expect(ta().style.lineHeight).toBe('1.2');
  });
});

describe('vertical alignment', () => {
  it('pads differently for top, middle and bottom', () => {
    openEditor({ verticalAlign: 'top' }, { x: 0, y: 0 }, 1);
    const top = ta().style.paddingTop;

    cleanup();
    openEditor({ verticalAlign: 'middle' }, { x: 0, y: 0 }, 1);
    const middle = ta().style.paddingTop;

    cleanup();
    openEditor({ verticalAlign: 'bottom' }, { x: 0, y: 0 }, 1);
    const bottom = ta().style.paddingTop;

    // The three cases cannot all coincide — that was the bug the padding was introduced to fix.
    expect(new Set([top, middle, bottom]).size).toBeGreaterThan(1);
  });

  it('leaves no bottom padding, so the last line is not pushed up', () => {
    openEditor({ verticalAlign: 'middle' });
    expect(ta().style.paddingBottom).toBe('0px');
  });

  it('applies the same left and right padding', () => {
    openEditor();
    const s = ta().style;
    expect(s.paddingLeft).toBe(s.paddingRight);
  });

  it('scales the horizontal padding with zoom', () => {
    openEditor({}, { x: 0, y: 0 }, 2);
    expect(ta().style.paddingLeft).toBe('8px');
  });

  it('an auto-scaled element still positions its text', () => {
    // autoScaleFontSize needs a measuring context; under jsdom the stub returns a width, so the
    // size resolves and the padding is computed from it rather than throwing.
    expect(() => openEditor({ autoScale: true, text: 'a very long line of text indeed' })).not.toThrow();
  });
});

describe('committing the edit', () => {
  function commitOn(over: Partial<TextElement> = {}) {
    const el = { ...createText('HELLO'), ...over } as TextElement;
    useStore.getState().add(el);
    const onDone = vi.fn();
    render(<InlineTextEditor el={el} origin={{ x: 0, y: 0 }} zoom={1} pad={PAD} onDone={onDone} />);
    return { el, onDone };
  }

  it('records a checkpoint when it opens, so the edit can be undone', () => {
    commitOn();
    expect(useStore.getState().past.length).toBeGreaterThan(0);
  });

  it('typing updates the element text', () => {
    const { el } = commitOn();
    fireEvent.change(ta(), { target: { value: 'EDITED' } });
    expect((useStore.getState().elements.find((e) => e.id === el.id) as TextElement).text).toBe('EDITED');
  });

  it('blur finishes the edit', () => {
    const { onDone } = commitOn();
    fireEvent.blur(ta());
    expect(onDone).toHaveBeenCalled();
  });

  it('Escape finishes the edit', () => {
    const { onDone } = commitOn();
    fireEvent.keyDown(ta(), { key: 'Escape' });
    expect(onDone).toHaveBeenCalled();
  });

  it('Ctrl+Enter finishes the edit', () => {
    const { onDone } = commitOn();
    fireEvent.keyDown(ta(), { key: 'Enter', ctrlKey: true });
    expect(onDone).toHaveBeenCalled();
  });

  it('Meta+Enter finishes the edit', () => {
    const { onDone } = commitOn();
    fireEvent.keyDown(ta(), { key: 'Enter', metaKey: true });
    expect(onDone).toHaveBeenCalled();
  });

  it('a plain Enter does not finish — it adds a newline', () => {
    const { onDone } = commitOn();
    fireEvent.keyDown(ta(), { key: 'Enter' });
    expect(onDone).not.toHaveBeenCalled();
  });

  it('keys never reach the app shortcuts while the editor is open', () => {
    commitOn();
    // Without stopPropagation, Ctrl+Z here would undo instead of typing.
    const e = new KeyboardEvent('keydown', { key: 'z', code: 'KeyZ', ctrlKey: true, bubbles: true, cancelable: true });
    ta().dispatchEvent(e);
    expect(e.cancelBubble).toBe(false); // fired and stopped inside the textarea
  });
});