// @vitest-environment jsdom
/**
 * App — keyboard shortcuts, language/direction wiring and dialog routing.
 *
 * The shortcuts are the whole reason the Arabic layout was ever broken, so they are tested with
 * the exact events an Arabic keyboard emits (`code` set, `key` carrying an Arabic character).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';
import App from '../src/App';
import { useStore } from '../src/state/store';
import { createText } from '../src/core/model/elements';
import * as printing from '../src/services/printing';
import * as actions from '../src/services/actions';

beforeEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  useStore.getState().newDesign();
  useStore.setState({ lang: 'en', dialog: null, past: [], future: [], selectedIds: [] });
});

/** A keydown the way an Arabic layout produces it: physical `code`, localised `key`. */
const arabicKey = (code: string, key: string, mods: Partial<KeyboardEventInit> = {}) =>
  fireEvent.keyDown(window, { code, key, ...mods });

const ctrl = { ctrlKey: true };

describe('layout and routing', () => {
  it('renders the topbar, toolbox, stage and the label panel by default', () => {
    render(<App />);
    expect(document.querySelector('.topbar')).toBeTruthy();
    expect(document.querySelector('.toolbox')).toBeTruthy();
    expect(document.querySelector('.stage')).toBeTruthy();
    expect(screen.getByText('Label size')).toBeTruthy();
  });

  it('swaps the panel to the element inspector when something is selected', () => {
    const el = createText('A');
    useStore.getState().add(el);
    render(<App />);
    expect(screen.getByText('Position')).toBeTruthy();
    expect(screen.queryByText('Label size')).toBeNull();
  });

  it('renders only the dialog the store asks for', () => {
    useStore.setState({ dialog: 'about' });
    render(<App />);
    expect(screen.getByText('About Phomymo Next')).toBeTruthy();
    expect(screen.queryByText('Designs')).toBeNull();
  });

  it('renders the print overlay when a job is active', () => {
    useStore.setState({ print: { active: true, label: 'Printing…', current: 0, total: 1, sub: '' } });
    render(<App />);
    // "Printing…" appears both in the print button and in the overlay heading.
    expect(screen.getAllByText('Printing…').length).toBeGreaterThan(1);
    expect(document.querySelector('[role="alertdialog"]')).toBeTruthy();
  });

  it('renders the toast stack', () => {
    useStore.setState({ toasts: [{ id: 1, kind: 'success', text: 'Saved' }] });
    render(<App />);
    expect(screen.getByText('Saved')).toBeTruthy();
  });
});

describe('language and direction', () => {
  it('sets lang and dir on the document for English', () => {
    useStore.setState({ lang: 'en' });
    render(<App />);
    expect(document.documentElement.lang).toBe('en');
    expect(document.documentElement.dir).toBe('ltr');
  });

  it('sets dir=rtl for Arabic', () => {
    useStore.setState({ lang: 'ar' });
    render(<App />);
    expect(document.documentElement.dir).toBe('rtl');
  });

  it('updates the document title', () => {
    render(<App />);
    expect(document.title).toBeTruthy();
  });
});

describe('shortcuts — physical key, English layout', () => {
  it('Ctrl+Z undoes', () => {
    useStore.getState().add(createText('A'));
    render(<App />);
    fireEvent.keyDown(window, { code: 'KeyZ', key: 'z', ...ctrl });
    expect(useStore.getState().elements.length).toBe(0);
  });

  it('Ctrl+Shift+Z redoes', () => {
    useStore.getState().add(createText('A'));
    useStore.getState().undo();
    render(<App />);
    fireEvent.keyDown(window, { code: 'KeyZ', key: 'Z', ctrlKey: true, shiftKey: true });
    expect(useStore.getState().elements.length).toBe(1);
  });

  it('Ctrl+Y redoes as well', () => {
    useStore.getState().add(createText('A'));
    useStore.getState().undo();
    render(<App />);
    fireEvent.keyDown(window, { code: 'KeyY', key: 'y', ...ctrl });
    expect(useStore.getState().elements.length).toBe(1);
  });

  it('Ctrl+D duplicates the selection', () => {
    const el = createText('A');
    useStore.getState().add(el);
    useStore.getState().select([el.id]);
    render(<App />);
    fireEvent.keyDown(window, { code: 'KeyD', key: 'd', ...ctrl });
    expect(useStore.getState().elements.length).toBe(2);
  });

  it('Ctrl+A selects everything', () => {
    useStore.getState().add(createText('A'));
    useStore.getState().add(createText('B'));
    render(<App />);
    fireEvent.keyDown(window, { code: 'KeyA', key: 'a', ...ctrl });
    expect(useStore.getState().selectedIds.length).toBe(2);
  });

  it('Ctrl+G groups and Ctrl+Shift+G ungroups', () => {
    const a = createText('A');
    const b = createText('B');
    useStore.getState().add(a);
    useStore.getState().add(b);
    useStore.getState().select([a.id, b.id]);
    render(<App />);
    fireEvent.keyDown(window, { code: 'KeyG', key: 'g', ...ctrl });
    expect(useStore.getState().elements[0].groupId).toBeTruthy();

    fireEvent.keyDown(window, { code: 'KeyG', key: 'G', ctrlKey: true, shiftKey: true });
    expect(useStore.getState().elements.every((e) => !e.groupId)).toBe(true);
  });

  it('Ctrl+P prints', () => {
    const spy = vi.spyOn(printing, 'printCurrent').mockResolvedValue(true);
    render(<App />);
    fireEvent.keyDown(window, { code: 'KeyP', key: 'p', ...ctrl });
    expect(spy).toHaveBeenCalled();
  });

  it('Delete removes the selection', () => {
    const el = createText('A');
    useStore.getState().add(el);
    useStore.getState().select([el.id]);
    render(<App />);
    fireEvent.keyDown(window, { code: 'Delete', key: 'Delete' });
    expect(useStore.getState().elements.length).toBe(0);
  });

  it('Escape clears the selection', () => {
    const el = createText('A');
    useStore.getState().add(el);
    useStore.getState().select([el.id]);
    render(<App />);
    fireEvent.keyDown(window, { code: 'Escape', key: 'Escape' });
    expect(useStore.getState().selectedIds).toEqual([]);
  });

  it('arrow keys nudge by 1, and by 10 with Shift', () => {
    const el = createText('A', { x: 50, y: 50 });
    useStore.getState().add(el);
    useStore.getState().select([el.id]);
    render(<App />);

    fireEvent.keyDown(window, { code: 'ArrowRight', key: 'ArrowRight' });
    expect(useStore.getState().elements[0].x).toBe(51);

    fireEvent.keyDown(window, { code: 'ArrowDown', key: 'ArrowDown', shiftKey: true });
    expect(useStore.getState().elements[0].y).toBe(60);
  });
});

describe('shortcuts — Arabic layout', () => {
  // On an Arabic layout the physical Z key reports key='س'. Matching on e.key made every
  // Ctrl shortcut dead; matching on e.code fixes it. These are the exact events.
  it('Ctrl+Z undoes when the layout reports an Arabic character', () => {
    useStore.getState().add(createText('A'));
    render(<App />);
    arabicKey('KeyZ', 'ئ', ctrl);
    expect(useStore.getState().elements.length).toBe(0);
  });

  it('Ctrl+A selects all on an Arabic layout', () => {
    useStore.getState().add(createText('A'));
    useStore.getState().add(createText('B'));
    render(<App />);
    arabicKey('KeyA', 'ش', ctrl);
    expect(useStore.getState().selectedIds.length).toBe(2);
  });

  it('Ctrl+D duplicates on an Arabic layout', () => {
    const el = createText('A');
    useStore.getState().add(el);
    useStore.getState().select([el.id]);
    render(<App />);
    arabicKey('KeyD', 'ي', ctrl);
    expect(useStore.getState().elements.length).toBe(2);
  });

  it('Ctrl+P prints on an Arabic layout', () => {
    const spy = vi.spyOn(printing, 'printCurrent').mockResolvedValue(true);
    render(<App />);
    arabicKey('KeyP', 'ح', ctrl);
    expect(spy).toHaveBeenCalled();
  });

  it('non-letter keys keep matching on e.key, which never changes', () => {
    const el = createText('A');
    useStore.getState().add(el);
    useStore.getState().select([el.id]);
    render(<App />);
    fireEvent.keyDown(window, { code: 'Delete', key: 'Delete' });
    expect(useStore.getState().elements.length).toBe(0);
  });
});

describe('shortcuts — typing must not be hijacked', () => {
  it('ignores shortcuts while an input is focused', () => {
    useStore.getState().add(createText('A'));
    render(<App />);
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    fireEvent.keyDown(input, { code: 'KeyZ', key: 'z', bubbles: true, ...ctrl });
    expect(useStore.getState().elements.length).toBe(1); // not undone
    input.remove();
  });

  it('ignores shortcuts while a textarea is focused', () => {
    useStore.getState().add(createText('A'));
    useStore.getState().add(createText('B'));
    // add() selects the element it adds, so exactly one is selected to begin with.
    expect(useStore.getState().selectedIds.length).toBe(1);
    render(<App />);

    const ta = document.createElement('textarea');
    document.body.appendChild(ta);
    ta.focus();
    // fireEvent.keyDown(target) dispatches on the target and lets it bubble to the window
    // listener, so e.target is the textarea — which is what isEditable() inspects.
    fireEvent.keyDown(ta, { code: 'KeyA', key: 'a', bubbles: true, ...ctrl });

    // Ctrl+A was not applied: still one selected, not two.
    expect(useStore.getState().selectedIds.length).toBe(1);
    ta.remove();
  });

  it('ignores shortcuts while a select is focused', () => {
    const el = createText('A');
    useStore.getState().add(el);
    useStore.getState().select([el.id]);
    render(<App />);
    const sel = document.createElement('select');
    document.body.appendChild(sel);
    sel.focus();
    fireEvent.keyDown(sel, { code: 'Delete', key: 'Delete' });
    expect(useStore.getState().elements.length).toBe(1);
    sel.remove();
  });
});

describe('Ctrl+S save', () => {
  it('saves under the current name without prompting', () => {
    useStore.setState({ designName: 'Mine' });
    const spy = vi.spyOn(actions, 'saveCurrentDesign').mockReturnValue(true);
    render(<App />);
    fireEvent.keyDown(window, { code: 'KeyS', key: 's', ...ctrl });
    expect(spy).toHaveBeenCalledWith('Mine');
  });

  it('prompts for a name when the design is untitled', () => {
    useStore.setState({ designName: null });
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue('Fresh');
    const spy = vi.spyOn(actions, 'saveCurrentDesign').mockReturnValue(true);
    render(<App />);
    fireEvent.keyDown(window, { code: 'KeyS', key: 's', ...ctrl });
    expect(prompt).toHaveBeenCalled();
    expect(spy).toHaveBeenCalledWith('Fresh');
  });

  it('a cancelled prompt saves nothing', () => {
    useStore.setState({ designName: null });
    vi.spyOn(window, 'prompt').mockReturnValue(null);
    const spy = vi.spyOn(actions, 'saveCurrentDesign').mockReturnValue(true);
    render(<App />);
    fireEvent.keyDown(window, { code: 'KeyS', key: 's', ...ctrl });
    expect(spy).not.toHaveBeenCalled();
  });
});
