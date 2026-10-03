// @vitest-environment jsdom
/**
 * MultiDialog (multi-label rolls) and PrintOverlay (progress + cancel).
 *
 * The roll dialog does real geometry — labels across, gaps, total width — and the overlay is the
 * only feedback the user gets while a job runs, including the Stop button.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MultiDialog, PrintOverlay } from '../src/ui/Dialogs';
import { useStore } from '../src/state/store';
import { createText } from '../src/core/model/elements';
import { loadMultiPresets } from '../src/core/storage/storage';
import * as printing from '../src/services/printing';

beforeEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  useStore.getState().newDesign();
  useStore.setState({ lang: 'en', dialog: 'multi', print: null, past: [], future: [] });
  // exitMulti() keeps the geometry and only clears `enabled`, and the dialog seeds from the store
  // — so reset the geometry explicitly to get a known starting point.
  useStore.getState().setMulti({ enabled: false, labelWidth: 10, labelHeight: 20, labelsAcross: 4, gapMm: 2, cloneMode: true });
  useStore.setState({ past: [], future: [] });
});

describe('MultiDialog — layout', () => {
  it('previews one cell per label across', () => {
    render(<MultiDialog />);
    const svg = document.querySelector('.roll-preview')!;
    expect(svg.querySelectorAll('rect').length).toBe(4); // the default is 4 across
  });

  it('numbers the preview cells', () => {
    render(<MultiDialog />);
    const texts = [...document.querySelectorAll('.roll-preview text')].map((t) => t.textContent);
    expect(texts).toEqual(['1', '2', '3', '4']);
  });

  it('changing labels-across redraws the preview', () => {
    render(<MultiDialog />);
    const across = screen.getByDisplayValue('4');
    fireEvent.focus(across);
    fireEvent.change(across, { target: { value: '3' } });
    fireEvent.keyDown(across, { key: 'Enter' });
    expect(document.querySelectorAll('.roll-preview rect').length).toBe(3);
  });

  it('reports the total roll width including the gaps', () => {
    render(<MultiDialog />);
    // Defaults: 10mm labels, 4 across, 2mm gaps -> 4*10 + 3*2 = 46mm.
    expect(screen.getByText(/46/)).toBeTruthy();
  });

  it('warns when the roll would be wider than the printable head', () => {
    render(<MultiDialog />);
    const width = screen.getByDisplayValue('10');
    fireEvent.focus(width);
    fireEvent.change(width, { target: { value: '40' } });
    fireEvent.keyDown(width, { key: 'Enter' });
    // 4 * 40 + 3 * 2 = 166mm — past the 100mm warning threshold.
    expect(screen.getByText(/⚠/)).toBeTruthy();
  });

  it('does not warn for a sensible roll width', () => {
    render(<MultiDialog />);
    expect(screen.queryByText(/⚠/)).toBeNull();
  });
});

describe('MultiDialog — applying', () => {
  it('Apply enables roll mode with the chosen geometry', () => {
    render(<MultiDialog />);
    fireEvent.click(screen.getByText('Apply'));
    const m = useStore.getState().multi;
    expect(m.enabled).toBe(true);
    expect(m.labelsAcross).toBe(4);
    expect(useStore.getState().dialog).toBeNull();
  });

  it('clone mode replicates the current label across every zone', () => {
    useStore.getState().add(createText('A'));
    render(<MultiDialog />);
    fireEvent.click(screen.getByText('Apply'));
    // cloneMode defaults on, so the single element is cloned into all four zones.
    expect(useStore.getState().elements.length).toBe(4);
  });

  it('with clone mode off only the first zone keeps the element', () => {
    useStore.getState().add(createText('A'));
    render(<MultiDialog />);
    fireEvent.click(screen.getByText('Same design on every label'));
    fireEvent.click(screen.getByText('Apply'));
    expect(useStore.getState().elements.length).toBe(1);
  });

  it('Exit roll is offered only while a roll is already active', () => {
    render(<MultiDialog />);
    expect(screen.queryByText('Exit roll')).toBeNull();
    cleanup();

    useStore.getState().setMulti({ enabled: true, labelWidth: 10, labelHeight: 20, labelsAcross: 3, gapMm: 2, cloneMode: true });
    render(<MultiDialog />);
    fireEvent.click(screen.getByText('Back to single label'));
    expect(useStore.getState().multi.enabled).toBe(false);
  });

  it('Clone now is offered only while a roll is active, and clones the active zone', () => {
    useStore.getState().setMulti({ enabled: true, labelWidth: 10, labelHeight: 20, labelsAcross: 3, gapMm: 2, cloneMode: false });
    useStore.getState().setActiveZone(0);
    useStore.getState().add(createText('A'));
    render(<MultiDialog />);
    fireEvent.click(screen.getByText('Copy this label to all'));
    expect(useStore.getState().elements.length).toBe(3);
  });
});

describe('MultiDialog — presets', () => {
  it('saving a preset stores it under the prompted name', () => {
    render(<MultiDialog />);
    vi.spyOn(window, 'prompt').mockReturnValue('My roll');
    fireEvent.click(screen.getByLabelText('Save preset'));
    const saved = loadMultiPresets()['My roll'];
    expect(saved).toBeTruthy();
    expect(saved.labelsAcross).toBe(4);
    expect(saved.labelWidth).toBe(10);
  });

  it('a saved preset becomes selectable and applies its geometry', () => {
    render(<MultiDialog />);
    vi.spyOn(window, 'prompt').mockReturnValue('Wide');
    fireEvent.click(screen.getByLabelText('Save preset'));
    cleanup();

    render(<MultiDialog />);
    const select = document.querySelector('select') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'Wide' } });
    // The preset is applied to the dialog's working copy, so the across field reflects it.
    expect(screen.getByDisplayValue('4')).toBeTruthy();
  });

  it('a cancelled prompt saves nothing', () => {
    render(<MultiDialog />);
    vi.spyOn(window, 'prompt').mockReturnValue(null);
    fireEvent.click(screen.getByLabelText('Save preset'));
    expect(loadMultiPresets()).toEqual({});
  });

  it('the delete button is disabled until a preset is selected', () => {
    render(<MultiDialog />);
    const del = screen.getByLabelText('Delete') as HTMLButtonElement;
    expect(del.disabled).toBe(true);
  });

  it('deleting removes the selected preset', () => {
    render(<MultiDialog />);
    vi.spyOn(window, 'prompt').mockReturnValue('Doomed');
    fireEvent.click(screen.getByLabelText('Save preset'));
    cleanup();

    render(<MultiDialog />);
    fireEvent.change(document.querySelector('select')!, { target: { value: 'Doomed' } });
    fireEvent.click(screen.getByLabelText('Delete'));
    expect(loadMultiPresets()).toEqual({});
  });
});

describe('PrintOverlay', () => {
  it('renders nothing when no job is active', () => {
    useStore.setState({ print: null });
    const { container } = render(<PrintOverlay />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when a job exists but is not active', () => {
    useStore.setState({ print: { active: false, label: 'x', current: 0, total: 1, sub: '' } });
    const { container } = render(<PrintOverlay />);
    expect(container.firstChild).toBeNull();
  });

  it('shows the job label and a progress bar while active', () => {
    useStore.setState({ print: { active: true, label: 'Printing…', current: 0, total: 4, sub: '' } });
    render(<PrintOverlay />);
    expect(screen.getByText('Printing…')).toBeTruthy();
    expect(document.querySelector('[role="progressbar"]')).toBeTruthy();
  });

  it('reports progress as a percentage of the total', () => {
    useStore.setState({ print: { active: true, label: 'x', current: 2, total: 4, sub: '' } });
    render(<PrintOverlay />);
    const bar = document.querySelector('[role="progressbar"]')!;
    expect(bar.getAttribute('aria-valuenow')).toBe('50');
  });

  it('never exceeds 100%', () => {
    useStore.setState({ print: { active: true, label: 'x', current: 9, total: 4, sub: '' } });
    render(<PrintOverlay />);
    expect(document.querySelector('[role="progressbar"]')!.getAttribute('aria-valuenow')).toBe('100');
  });

  it('shows a copy counter only for a multi-copy job', () => {
    useStore.setState({ print: { active: true, label: 'x', current: 0, total: 3, sub: '' } });
    render(<PrintOverlay />);
    expect(screen.getByText(/1\/3/)).toBeTruthy();
    cleanup();

    useStore.setState({ print: { active: true, label: 'x', current: 0, total: 1, sub: '' } });
    render(<PrintOverlay />);
    expect(screen.queryByText(/\d\/\d/)).toBeNull();
  });

  it('shows the sub-status text (e.g. bytes sent)', () => {
    useStore.setState({ print: { active: true, label: 'x', current: 0, total: 1, sub: 'Sending 42%' } });
    render(<PrintOverlay />);
    expect(screen.getByText(/Sending 42%/)).toBeTruthy();
  });

  it('announces itself to assistive tech', () => {
    useStore.setState({ print: { active: true, label: 'Printing…', current: 0, total: 1, sub: '' } });
    render(<PrintOverlay />);
    const el = document.querySelector('[role="alertdialog"]')!;
    expect(el.getAttribute('aria-live')).toBe('polite');
    expect(el.getAttribute('aria-label')).toBe('Printing…');
  });

  it('offers Stop only while a batch is running, and cancels it', () => {
    useStore.setState({ print: { active: true, label: 'x', current: 0, total: 2, sub: '' } });
    render(<PrintOverlay />);
    expect(screen.queryByText('Stop')).toBeNull(); // a single print is not cancellable
    cleanup();

    const spy = vi.spyOn(printing, 'isBatchRunning').mockReturnValue(true);
    const cancel = vi.spyOn(printing, 'cancelBatch').mockImplementation(() => {});
    useStore.setState({ print: { active: true, label: 'x', current: 0, total: 2, sub: '' } });
    render(<PrintOverlay />);
    fireEvent.click(screen.getByText('Stop'));
    expect(spy).toHaveBeenCalled();
    expect(cancel).toHaveBeenCalled();
  });
});
