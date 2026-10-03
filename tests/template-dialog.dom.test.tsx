// @vitest-environment jsdom
/**
 * TemplateDialog — the CSV / data table that drives batch printing.
 *
 * The selection here decides which labels actually print, so the tests cover selection semantics
 * (individual, select-all, delete-shifts-indices) as carefully as the rendering.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { TemplateDialog } from '../src/ui/Dialogs';
import { useStore } from '../src/state/store';
import { createText } from '../src/core/model/elements';
import * as printing from '../src/services/printing';

/** A design with one {{SKU}} field plus two data rows. */
function withTemplate() {
  useStore.getState().add(createText('{{SKU}}'));
  useStore.getState().setTemplateData([{ SKU: 'A1' }, { SKU: 'A2' }]);
}

beforeEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  useStore.getState().newDesign();
  useStore.setState({ lang: 'en', dialog: 'template', past: [], future: [], selectedRecords: [] });
});

describe('empty state', () => {
  it('explains how to create a field when there is none', () => {
    render(<TemplateDialog />);
    expect(screen.getByText(/No fields yet/)).toBeTruthy();
  });

  it('disables the actions that need fields or rows', () => {
    render(<TemplateDialog />);
    expect((screen.getByText('Add record').closest('button') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText('Fill sample data').closest('button') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText('Export CSV').closest('button') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText('Clear data').closest('button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('disables both print buttons with nothing to print', () => {
    render(<TemplateDialog />);
    expect((screen.getByText('Print selected').closest('button') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText('Print all').closest('button') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('table rendering', () => {
  it('lists the detected field as a column', () => {
    withTemplate();
    render(<TemplateDialog />);
    expect(screen.getByText('SKU')).toBeTruthy();
  });

  it('renders one row per record with its values', () => {
    withTemplate();
    render(<TemplateDialog />);
    expect(screen.getByDisplayValue('A1')).toBeTruthy();
    expect(screen.getByDisplayValue('A2')).toBeTruthy();
  });

  it('editing a cell updates that record only', () => {
    withTemplate();
    render(<TemplateDialog />);
    const cell = screen.getByDisplayValue('A1');
    fireEvent.change(cell, { target: { value: 'ZZ' } });
    expect(useStore.getState().templateData[0].SKU).toBe('ZZ');
    expect(useStore.getState().templateData[1].SKU).toBe('A2');
  });

  it('falls back to the columns of the first record when no field is in the design', () => {
    useStore.getState().add(createText('plain'));
    useStore.getState().setTemplateData([{ CODE: 'x' }]);
    render(<TemplateDialog />);
    expect(screen.getByText('CODE')).toBeTruthy();
  });
});

describe('selection', () => {
  it('ticking a row selects it', () => {
    withTemplate();
    render(<TemplateDialog />);
    fireEvent.click(screen.getByLabelText('Record 1'));
    expect(useStore.getState().selectedRecords).toEqual([0]);
  });

  it('ticking twice deselects', () => {
    withTemplate();
    render(<TemplateDialog />);
    fireEvent.click(screen.getByLabelText('Record 1'));
    fireEvent.click(screen.getByLabelText('Record 1'));
    expect(useStore.getState().selectedRecords).toEqual([]);
  });

  it('selections stay sorted by row order regardless of click order', () => {
    withTemplate();
    render(<TemplateDialog />);
    fireEvent.click(screen.getByLabelText('Record 2'));
    fireEvent.click(screen.getByLabelText('Record 1'));
    expect(useStore.getState().selectedRecords).toEqual([0, 1]);
  });

  it('the header checkbox selects every row', () => {
    withTemplate();
    render(<TemplateDialog />);
    fireEvent.click(screen.getByLabelText('Select all'));
    expect(useStore.getState().selectedRecords).toEqual([0, 1]);
  });

  it('the header checkbox unselects every row', () => {
    withTemplate();
    render(<TemplateDialog />);
    fireEvent.click(screen.getByLabelText('Select all'));
    fireEvent.click(screen.getByLabelText('Select all'));
    expect(useStore.getState().selectedRecords).toEqual([]);
  });

  it('the header checkbox reads as checked only when every row is selected', () => {
    withTemplate();
    render(<TemplateDialog />);
    const head = screen.getByLabelText('Select all') as HTMLInputElement;
    expect(head.checked).toBe(false);
    fireEvent.click(screen.getByLabelText('Record 1'));
    expect(head.checked).toBe(false);
    fireEvent.click(screen.getByLabelText('Record 2'));
    expect(head.checked).toBe(true);
  });

  it('Print selected is enabled only once something is chosen', () => {
    withTemplate();
    render(<TemplateDialog />);
    const btn = screen.getByText('Print selected').closest('button') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText('Record 1'));
    expect(btn.disabled).toBe(false);
  });
});

describe('row operations', () => {
  it('Add record appends a blank row with the known columns', () => {
    withTemplate();
    render(<TemplateDialog />);
    fireEvent.click(screen.getByText('Add record'));
    const rows = useStore.getState().templateData;
    expect(rows.length).toBe(3);
    expect(rows[2]).toEqual({ SKU: '' });
  });

  it('deleting a row removes exactly that row', () => {
    withTemplate();
    render(<TemplateDialog />);
    fireEvent.click(screen.getAllByLabelText('Delete')[0]);
    expect(useStore.getState().templateData.map((r) => r.SKU)).toEqual(['A2']);
  });

  it('Clear data empties the records', () => {
    withTemplate();
    render(<TemplateDialog />);
    fireEvent.click(screen.getByText('Clear data'));
    expect(useStore.getState().templateData).toEqual([]);
  });

  it('Fill sample data generates three rows from the design fields', () => {
    useStore.getState().add(createText('{{SKU}}'));
    render(<TemplateDialog />);
    fireEvent.click(screen.getByText('Fill sample data'));
    const rows = useStore.getState().templateData;
    expect(rows.length).toBe(3);
    expect(Object.keys(rows[0])).toEqual(['SKU']);
  });

  it('the CSV import button opens the file picker, which accepts CSV', () => {
    render(<TemplateDialog />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const click = vi.spyOn(input, 'click');
    fireEvent.click(screen.getByText('Import CSV'));
    expect(click).toHaveBeenCalled();
    expect(input.accept).toContain('.csv');
  });
});

describe('grid preview', () => {
  it('is disabled with no rows', () => {
    render(<TemplateDialog />);
    expect((screen.getByText('Preview').closest('button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('switching to the grid replaces the table with selectable thumbnails', () => {
    withTemplate();
    render(<TemplateDialog />);
    expect(document.querySelector('table.data')).toBeTruthy();
    fireEvent.click(screen.getByText('Preview'));
    expect(document.querySelector('table.data')).toBeNull();
    expect(document.querySelectorAll('.thumb').length).toBe(2);
  });

  it('clicking a thumbnail toggles that record', () => {
    withTemplate();
    render(<TemplateDialog />);
    fireEvent.click(screen.getByText('Preview'));
    fireEvent.click(document.querySelectorAll('.thumb')[1]);
    expect(useStore.getState().selectedRecords).toEqual([1]);
    expect(document.querySelectorAll('.thumb')[1].className).toContain('is-on');
  });
});

describe('printing', () => {
  it('Print all closes the dialog and starts a batch over every record', () => {
    withTemplate();
    const spy = vi.spyOn(printing, 'runBatch').mockResolvedValue(true);
    render(<TemplateDialog />);
    fireEvent.click(screen.getByText('Print all'));
    expect(spy).toHaveBeenCalledWith([0, 1]);
    expect(useStore.getState().dialog).toBeNull();
  });

  it('Print selected sends only the chosen indexes', () => {
    withTemplate();
    const spy = vi.spyOn(printing, 'runBatch').mockResolvedValue(true);
    render(<TemplateDialog />);
    fireEvent.click(screen.getByLabelText('Record 2'));
    fireEvent.click(screen.getByText('Print selected'));
    expect(spy).toHaveBeenCalledWith([1]);
  });

  it('Print all is enabled whenever rows exist, even with nothing selected', () => {
    withTemplate();
    render(<TemplateDialog />);
    expect((screen.getByText('Print all').closest('button') as HTMLButtonElement).disabled).toBe(false);
  });
});
