// @vitest-environment jsdom
/**
 * Dialogs — the designs library and the toast stack.
 *
 * The designs dialog is the only place the user can save, load, rename and delete their work, so
 * these tests cover the confirmations and the storage round-trip, not just the markup.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';
import { DesignsDialog, Toasts } from '../src/ui/Dialogs';
import { useStore } from '../src/state/store';
import { createText } from '../src/core/model/elements';
import * as storage from '../src/core/storage/storage';

beforeEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  useStore.getState().newDesign();
  useStore.setState({ lang: 'en', dialog: 'designs', designName: null, past: [], future: [] });
});

/** Seed a saved design straight into storage. */
function seed(name: string, elementCount = 1) {
  const els = Array.from({ length: elementCount }, (_, i) => createText(`E${i}`));
  storage.saveDesign(name, { elements: els, labelSize: { width: 40, height: 30 } } as never);
}

describe('empty library', () => {
  it('says there are no designs yet', () => {
    render(<DesignsDialog />);
    expect(screen.getByText(/No saved designs yet/)).toBeTruthy();
  });

  it('the Save button is disabled until a name is typed', () => {
    render(<DesignsDialog />);
    const btn = screen.getByText('Save').closest('button') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Design name'), { target: { value: 'My label' } });
    expect(btn.disabled).toBe(false);
  });

  it('a whitespace-only name does not enable Save', () => {
    render(<DesignsDialog />);
    fireEvent.change(screen.getByLabelText('Design name'), { target: { value: '   ' } });
    expect((screen.getByText('Save').closest('button') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('saving', () => {
  it('saves the current design under the typed name', () => {
    useStore.getState().add(createText('A'));
    render(<DesignsDialog />);
    fireEvent.change(screen.getByLabelText('Design name'), { target: { value: 'Shipping' } });
    fireEvent.click(screen.getByText('Save'));
    expect(storage.listDesigns().map((d) => d.name)).toEqual(['Shipping']);
    expect(useStore.getState().designName).toBe('Shipping');
  });

  it('saved designs appear in the list with their element count', () => {
    seed('Existing', 3);
    render(<DesignsDialog />);
    expect(screen.getByText('Existing')).toBeTruthy();
    expect(screen.getByText(/3/)).toBeTruthy();
  });

  it('pressing Enter in the name field saves', () => {
    useStore.getState().add(createText('A'));
    render(<DesignsDialog />);
    const input = screen.getByLabelText('Design name');
    fireEvent.change(input, { target: { value: 'ViaEnter' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(storage.listDesigns().map((d) => d.name)).toEqual(['ViaEnter']);
  });

  it('overwriting a different existing design asks first, and respects a cancel', () => {
    seed('Taken');
    useStore.getState().add(createText('NEW'));
    render(<DesignsDialog />);
    fireEvent.change(screen.getByLabelText('Design name'), { target: { value: 'Taken' } });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.click(screen.getByText('Save'));
    expect(confirm).toHaveBeenCalled();
    // Cancelled: the stored design keeps its original single element.
    expect(storage.loadDesign('Taken')!.elements.length).toBe(1);
  });

  it('overwriting proceeds when confirmed', () => {
    seed('Taken');
    useStore.getState().add(createText('A'));
    useStore.getState().add(createText('B'));
    render(<DesignsDialog />);
    fireEvent.change(screen.getByLabelText('Design name'), { target: { value: 'Taken' } });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(screen.getByText('Save'));
    expect(storage.loadDesign('Taken')!.elements.length).toBe(2);
  });

  it('re-saving the current design does not ask for confirmation', () => {
    seed('Mine');
    useStore.setState({ designName: 'Mine' });
    render(<DesignsDialog />);
    const confirm = vi.spyOn(window, 'confirm');
    fireEvent.click(screen.getByText('Save'));
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe('loading', () => {
  it('loading a design replaces the document and closes the dialog', () => {
    seed('Loaded', 2);
    render(<DesignsDialog />);
    fireEvent.click(screen.getByText('Loaded'));
    expect(useStore.getState().elements.length).toBe(2);
    expect(useStore.getState().designName).toBe('Loaded');
    expect(useStore.getState().dialog).toBeNull();
  });

  it('the current design is marked in the list', () => {
    seed('Mine');
    useStore.setState({ designName: 'Mine' });
    render(<DesignsDialog />);
    expect(document.querySelector('li.is-current')).toBeTruthy();
  });
});

describe('new design', () => {
  it('clears the canvas immediately when it is already empty', () => {
    render(<DesignsDialog />);
    const confirm = vi.spyOn(window, 'confirm');
    fireEvent.click(screen.getByText('New design'));
    expect(confirm).not.toHaveBeenCalled(); // nothing to lose
    expect(useStore.getState().dialog).toBeNull();
  });

  it('asks before discarding work, and respects a cancel', () => {
    useStore.getState().add(createText('A'));
    render(<DesignsDialog />);
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.click(screen.getByText('New design'));
    expect(useStore.getState().elements.length).toBe(1); // kept
  });

  it('discards when confirmed', () => {
    useStore.getState().add(createText('A'));
    render(<DesignsDialog />);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(screen.getByText('New design'));
    expect(useStore.getState().elements.length).toBe(0);
  });
});

describe('renaming', () => {
  it('renames via the prompt', () => {
    seed('Old');
    render(<DesignsDialog />);
    vi.spyOn(window, 'prompt').mockReturnValue('New');
    fireEvent.click(screen.getByLabelText('Rename'));
    expect(storage.listDesigns().map((d) => d.name)).toEqual(['New']);
  });

  it('updates the current design name when the active one is renamed', () => {
    seed('Old');
    useStore.setState({ designName: 'Old' });
    render(<DesignsDialog />);
    vi.spyOn(window, 'prompt').mockReturnValue('New');
    fireEvent.click(screen.getByLabelText('Rename'));
    expect(useStore.getState().designName).toBe('New');
  });

  it('a cancelled prompt leaves the name alone', () => {
    seed('Old');
    render(<DesignsDialog />);
    vi.spyOn(window, 'prompt').mockReturnValue(null);
    fireEvent.click(screen.getByLabelText('Rename'));
    expect(storage.listDesigns().map((d) => d.name)).toEqual(['Old']);
  });

  it('renaming onto an existing name surfaces the error instead of losing data', () => {
    seed('A');
    seed('B');
    render(<DesignsDialog />);
    vi.spyOn(window, 'prompt').mockReturnValue('B');
    fireEvent.click(screen.getAllByLabelText('Rename')[0]);
    expect(useStore.getState().toasts.at(-1)!.kind).toBe('error');
    expect(storage.listDesigns().length).toBe(2);
  });
});

describe('deleting', () => {
  it('deletes after confirmation', () => {
    seed('Doomed');
    render(<DesignsDialog />);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(screen.getByLabelText('Delete'));
    expect(storage.listDesigns()).toEqual([]);
  });

  it('a cancelled confirmation keeps the design', () => {
    seed('Kept');
    render(<DesignsDialog />);
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.click(screen.getByLabelText('Delete'));
    expect(storage.listDesigns().map((d) => d.name)).toEqual(['Kept']);
  });
});

describe('export buttons', () => {
  it('offers JSON, PNG and PDF export plus JSON import', () => {
    render(<DesignsDialog />);
    for (const label of ['Import JSON', 'Export JSON', 'Export PNG', 'Export PDF']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  it('the import button opens the hidden file picker', () => {
    render(<DesignsDialog />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const click = vi.spyOn(input, 'click');
    fireEvent.click(screen.getByText('Import JSON'));
    expect(click).toHaveBeenCalled();
  });
});

describe('Toasts', () => {
  it('renders nothing when there are none', () => {
    useStore.setState({ toasts: [] });
    const { container } = render(<Toasts />);
    expect(container.querySelectorAll('.toast').length).toBe(0);
  });

  it('renders each toast with its kind as a class', () => {
    useStore.setState({
      toasts: [
        { id: 1, kind: 'success', text: 'Saved' },
        { id: 2, kind: 'error', text: 'Failed' },
      ],
    });
    render(<Toasts />);
    expect(screen.getByText('Saved').className).toContain('toast-success');
    expect(screen.getByText('Failed').className).toContain('toast-error');
  });

  it('is an aria-live region so screen readers announce it', () => {
    const { container } = render(<Toasts />);
    expect(container.querySelector('[aria-live="polite"]')).toBeTruthy();
  });

  it('an error toast lingers longer than an info one', () => {
    vi.useFakeTimers();
    useStore.setState({ toasts: [] });
    useStore.getState().toast('note', 'info');
    useStore.getState().toast('bad', 'error');
    expect(useStore.getState().toasts.length).toBe(2);

    vi.advanceTimersByTime(3000); // past the info timeout, before the error one
    const left = useStore.getState().toasts.map((x) => x.text);
    expect(left).toContain('bad');
    expect(left).not.toContain('note');

    vi.advanceTimersByTime(2500);
    expect(useStore.getState().toasts.length).toBe(0);
    vi.useRealTimers();
  });
});
