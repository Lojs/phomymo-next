// @vitest-environment jsdom
/**
 * LabelPanel — label size, orientation and tape width.
 *
 * The size chosen here is the paper actually loaded in the printer, and orientation decides how
 * the design sits on it, so these tests cover the preset/custom distinction and the rotation.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';
import { LabelPanel } from '../src/ui/LabelPanel';
import { useStore } from '../src/state/store';
import { createText } from '../src/core/model/elements';

beforeEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  useStore.getState().newDesign();
  useStore.setState({
    lang: 'en',
    dialog: null,
    conn: { type: null, connected: false, busy: false, deviceName: '', status: 'disconnected', error: null },
    past: [],
    future: [],
  });
  useStore.getState().updateSettings({ printerModel: 'auto', tapeWidth: 12 });
  useStore.getState().setLabelSize({ width: 40, height: 30 });
});

/** The size dropdown is the first combobox in the panel. */
const sizeSelect = () => screen.getAllByRole('combobox')[0] as HTMLSelectElement;

describe('label size dropdown', () => {
  it('offers presets, a custom entry and the roll entry', () => {
    render(<LabelPanel />);
    const values = [...sizeSelect().querySelectorAll('option')].map((o) => o.value);
    expect(values).toContain('custom');
    expect(values).toContain('multi');
  });

  it('shows the current preset as the selected value', () => {
    render(<LabelPanel />);
    expect(sizeSelect().value).not.toBe('custom'); // 40×30 is a real preset
  });

  it('picking a preset applies its dimensions', () => {
    render(<LabelPanel />);
    const select = sizeSelect();
    const other = [...select.querySelectorAll('option')].find((o) => o.value !== select.value && o.value !== 'custom' && o.value !== 'multi')!;
    fireEvent.change(select, { target: { value: other.value } });
    const chosen = useStore.getState().labelSize;
    expect(`${chosen.width}×${chosen.height}`).toBe(other.textContent?.split(' ')[0]);
  });

  it('choosing Custom reveals the editable width and height', () => {
    render(<LabelPanel />);
    fireEvent.change(sizeSelect(), { target: { value: 'custom' } });
    expect(screen.getByText('Width')).toBeTruthy();
    expect(screen.getByText('Height')).toBeTruthy();
  });

  it('choosing Multi-label opens the roll dialog', () => {
    render(<LabelPanel />);
    fireEvent.change(sizeSelect(), { target: { value: 'multi' } });
    expect(useStore.getState().dialog).toBe('multi');
  });
});

describe('custom dimensions', () => {
  beforeEach(() => {
    render(<LabelPanel />);
    fireEvent.change(sizeSelect(), { target: { value: 'custom' } });
  });

  it('editing the width applies it', () => {
    const w = screen.getByLabelText('Width') as HTMLInputElement;
    fireEvent.focus(w);
    fireEvent.change(w, { target: { value: '55' } });
    fireEvent.keyDown(w, { key: 'Enter' });
    expect(useStore.getState().labelSize.width).toBe(55);
  });

  it('a round label forces height to equal width', () => {
    fireEvent.click(screen.getByText('Round'));
    const s = useStore.getState().labelSize;
    expect(s.round).toBe(true);
    expect(s.height).toBe(s.width);
  });

  it('round labels hide the separate height field', () => {
    fireEvent.click(screen.getByText('Round'));
    expect(screen.queryByLabelText('Height')).toBeNull();
  });

  it('un-rounding brings the height field back', () => {
    fireEvent.click(screen.getByText('Round'));
    fireEvent.click(screen.getByText('Round'));
    expect(screen.getByLabelText('Height')).toBeTruthy();
  });

  it('a size edit is undoable', () => {
    const w = screen.getByLabelText('Width') as HTMLInputElement;
    fireEvent.focus(w);
    fireEvent.change(w, { target: { value: '60' } });
    fireEvent.keyDown(w, { key: 'Enter' });
    useStore.getState().undo();
    expect(useStore.getState().labelSize.width).toBe(40);
  });
});

describe('orientation', () => {
  it('is offered for a non-square label', () => {
    render(<LabelPanel />);
    expect(screen.getByText('Orientation')).toBeTruthy();
  });

  it('is hidden for a square label, where it means nothing', () => {
    useStore.getState().setLabelSize({ width: 40, height: 40 });
    render(<LabelPanel />);
    expect(screen.queryByText('Orientation')).toBeNull();
  });

  it('is hidden for a round label', () => {
    useStore.getState().setLabelSize({ width: 40, height: 30, round: true });
    render(<LabelPanel />);
    expect(screen.queryByText('Orientation')).toBeNull();
  });

  it('switching to landscape rotates the composition with the canvas', () => {
    // A tall label: 30x40 resolves to portrait, so switching is a real change. (A 40x30 label is
    // already wide and resolves to landscape, making the switch a deliberate no-op.)
    useStore.getState().setLabelSize({ width: 30, height: 40 });
    useStore.getState().add(createText('A', { x: 0, y: 0, width: 20, height: 10 }));
    render(<LabelPanel />);
    const before = useStore.getState().elements[0];
    fireEvent.click(screen.getByTitle('Landscape'));
    const after = useStore.getState().elements[0];
    expect(useStore.getState().labelSize.orientation).toBe('landscape');
    expect(after.id).toBe(before.id);
    expect(after.rotation).toBe(90); // the element turned with the label
  });

  it('switching back to portrait is lossless', () => {
    useStore.getState().setLabelSize({ width: 30, height: 40 });
    useStore.getState().add(createText('A', { x: 5, y: 7, width: 20, height: 10 }));
    render(<LabelPanel />);
    const before = { ...useStore.getState().elements[0] };
    fireEvent.click(screen.getByTitle('Landscape'));
    fireEvent.click(screen.getByTitle('Portrait'));
    const after = useStore.getState().elements[0];
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
    expect(after.rotation).toBe(before.rotation);
  });

  it('choosing the orientation the label already has is a no-op', () => {
    // 40x30 is wide, so it already resolves to landscape; the button should be a no-op.
    useStore.getState().add(createText('A', { x: 5, y: 7, width: 20, height: 10 }));
    render(<LabelPanel />);
    const before = { ...useStore.getState().elements[0] };
    fireEvent.click(screen.getByTitle('Landscape'));
    expect(useStore.getState().labelSize.orientation).toBeUndefined();
    expect(useStore.getState().elements[0].x).toBe(before.x);
  });

  it('the physical label size is never rewritten by orientation', () => {
    useStore.getState().setLabelSize({ width: 30, height: 40 });
    render(<LabelPanel />);
    fireEvent.click(screen.getByTitle('Landscape'));
    const s = useStore.getState().labelSize;
    expect(s.width).toBe(30);
    expect(s.height).toBe(40);
  });
});

describe('multi-label roll', () => {
  it('shows the roll summary and hides the single-label controls', () => {
    useStore.getState().setMulti({ enabled: true, labelWidth: 10, labelHeight: 20, labelsAcross: 3, gapMm: 2, cloneMode: true });
    render(<LabelPanel />);
    expect(screen.getByText(/3 × 10×20/)).toBeTruthy();
    expect(screen.queryByText('Orientation')).toBeNull();
  });

  it('the roll summary opens the roll dialog', () => {
    useStore.getState().setMulti({ enabled: true, labelWidth: 10, labelHeight: 20, labelsAcross: 3, gapMm: 2, cloneMode: true });
    render(<LabelPanel />);
    fireEvent.click(screen.getByText('Multi-label roll'));
    expect(useStore.getState().dialog).toBe('multi');
  });

  it('the dropdown reads as "multi" while a roll is active', () => {
    useStore.getState().setMulti({ enabled: true, labelWidth: 10, labelHeight: 20, labelsAcross: 3, gapMm: 2, cloneMode: true });
    render(<LabelPanel />);
    expect(sizeSelect().value).toBe('multi');
  });
});

describe('tape printers', () => {
  it('offers tape widths only for a tape printer', () => {
    render(<LabelPanel />);
    expect(screen.queryByText('Tape width')).toBeNull();
  });

  it('shows tape widths for the A30, which is a tape printer', () => {
    useStore.getState().updateSettings({ printerModel: 'a30' });
    render(<LabelPanel />);
    expect(screen.getByText('Tape width')).toBeTruthy();
  });

  it('changing the tape width updates the setting', () => {
    useStore.getState().updateSettings({ printerModel: 'a30', tapeWidth: 12 });
    render(<LabelPanel />);
    fireEvent.click(screen.getByText('15 mm'));
    expect(useStore.getState().settings.tapeWidth).toBe(15);
  });
});

describe('continuous tape', () => {
  it('offers a continuous toggle for a D-series printer', () => {
    useStore.getState().updateSettings({ printerModel: 'd-series' });
    render(<LabelPanel />);
    expect(screen.getByText('Continuous')).toBeTruthy();
  });

  it('does not offer it for a non-D-series printer', () => {
    useStore.getState().updateSettings({ printerModel: 'm221' });
    render(<LabelPanel />);
    expect(screen.queryByText('Continuous')).toBeNull();
  });
});
