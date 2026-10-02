// @vitest-environment jsdom
/**
 * PrintersDialog — the custom printer-definition editor.
 *
 * A definition decides the protocol, head width and DPI a job is encoded with, so a bad edit here
 * prints garbage. The tests cover validation, the id sanitiser, and that built-ins are never
 * silently replaced.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';
import { PrintersDialog } from '../src/ui/Dialogs';
import { useStore } from '../src/state/store';
import { loadCustomPrinters, saveCustomPrinters } from '../src/core/storage/storage';
import { BUILTIN_PRINTERS } from '../src/core/printers/definitions';


/** Field now forwards its id to the control, so labels resolve the normal way. */
const fieldInput = (labelText: string) => screen.getByLabelText(labelText) as HTMLInputElement;

beforeEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  useStore.getState().newDesign();
  useStore.setState({ lang: 'en', dialog: 'printers', past: [], future: [] });
  useStore.getState().setRegistry([]);
});

describe('the printer list', () => {
  it('lists every built-in definition', () => {
    render(<PrintersDialog />);
    const rows = document.querySelectorAll('.list li');
    expect(rows.length).toBe(BUILTIN_PRINTERS.length);
  });

  it('marks built-ins as built-in', () => {
    render(<PrintersDialog />);
    expect(screen.getAllByText(/Built-in/).length).toBe(BUILTIN_PRINTERS.length);
  });

  it('offers an edit button per row but no delete for a built-in', () => {
    render(<PrintersDialog />);
    expect(screen.getAllByLabelText('Edit printer').length).toBe(BUILTIN_PRINTERS.length);
    // Built-ins cannot be deleted — only custom definitions can.
    expect(screen.queryAllByLabelText('Delete').length).toBe(0);
  });

  it('shows a custom definition and marks it as custom', () => {
    saveCustomPrinters([{ id: 'mine', name: 'My printer', protocol: 'm-series', widthBytes: 72, dpi: 203, alignment: 'center', rotated: false, tape: false, tapeWidths: null, defaultTapeWidth: null, namePatterns: ['MINE'] }] as never);
    useStore.getState().setRegistry();
    render(<PrintersDialog />);
    expect(screen.getByText('My printer')).toBeTruthy();
    expect(screen.getByText(/Custom/)).toBeTruthy();
  });

  it('a custom definition can be deleted, and a built-in it overrode reappears', () => {
    saveCustomPrinters([{ id: 'm221', name: 'My M221', protocol: 'm-series', widthBytes: 72, dpi: 203, alignment: 'center', rotated: false, tape: false, tapeWidths: null, defaultTapeWidth: null, namePatterns: ['M221'] }] as never);
    useStore.getState().setRegistry();
    render(<PrintersDialog />);
    // An override is offered as a reset, not a delete.
    fireEvent.click(screen.getByLabelText('Reset to default'));
    expect(loadCustomPrinters()).toEqual([]);
  });
});

describe('adding a printer', () => {
  it('the Add button opens a blank editor', () => {
    render(<PrintersDialog />);
    fireEvent.click(screen.getByText('Add printer'));
    // The editor replaced the list: its title is the modal's aria-label.
    expect(document.querySelector('[aria-label="Add printer"]')).toBeTruthy();
    expect(screen.getByText('ID')).toBeTruthy();
  });

  it('Save is disabled until both an id and a name are given', () => {
    render(<PrintersDialog />);
    fireEvent.click(screen.getByText('Add printer'));
    const save = () => screen.getByText('Save').closest('button') as HTMLButtonElement;
    expect(save().disabled).toBe(true);

    fireEvent.change(fieldInput('ID'), { target: { value: 'myid' } });
    expect(save().disabled).toBe(true); // still no name

    const nameField = fieldInput('Name');
    fireEvent.change(nameField, { target: { value: 'My Printer' } });
    expect(save().disabled).toBe(false);
  });

  it('the id is sanitised to lowercase letters, digits, dash and underscore', () => {
    render(<PrintersDialog />);
    fireEvent.click(screen.getByText('Add printer'));
    const id = fieldInput('ID');
    fireEvent.change(id, { target: { value: 'My Printer!! #1' } });
    expect(id.value).toBe('myprinter1');
  });

  it('saving persists the definition and registers it', () => {
    render(<PrintersDialog />);
    fireEvent.click(screen.getByText('Add printer'));
    fireEvent.change(fieldInput('ID'), { target: { value: 'custom1' } });
    fireEvent.change(fieldInput('Name'), { target: { value: 'Custom One' } });
    fireEvent.click(screen.getByText('Save'));

    expect(loadCustomPrinters().map((d) => d.id)).toEqual(['custom1']);
    expect(useStore.getState().registry.get('custom1')!.name).toBe('Custom One');
    expect(useStore.getState().registry.get('custom1')!.builtin).toBe(false);
  });

  it('a new definition defaults to the m-series protocol and 203 dpi', () => {
    render(<PrintersDialog />);
    fireEvent.click(screen.getByText('Add printer'));
    fireEvent.change(fieldInput('ID'), { target: { value: 'x' } });
    fireEvent.change(fieldInput('Name'), { target: { value: 'X' } });
    fireEvent.click(screen.getByText('Save'));
    const def = loadCustomPrinters()[0];
    expect(def.protocol).toBe('m-series');
    expect(def.dpi).toBe(203);
  });

  it('Cancel discards the edit', () => {
    render(<PrintersDialog />);
    fireEvent.click(screen.getByText('Add printer'));
    fireEvent.change(fieldInput('ID'), { target: { value: 'nope' } });
    fireEvent.click(screen.getByText('Cancel'));
    expect(loadCustomPrinters()).toEqual([]);
  });
});

describe('editing a printer', () => {
  it('editing a custom definition updates it in place rather than duplicating', () => {
    saveCustomPrinters([{ id: 'mine', name: 'Old name', protocol: 'm-series', widthBytes: 72, dpi: 203, alignment: 'center', rotated: false, tape: false, tapeWidths: null, defaultTapeWidth: null, namePatterns: [] }] as never);
    useStore.getState().setRegistry();
    render(<PrintersDialog />);
    // Find the row for the custom definition, then its edit button.
    const row = [...document.querySelectorAll('.list li')].find((li) => li.textContent?.includes('Old name'))!;
    fireEvent.click(row.querySelector('[aria-label="Edit printer"]')!);
    const name = fieldInput('Name');
    fireEvent.change(name, { target: { value: 'New name' } });
    fireEvent.click(screen.getByText('Save'));
    expect(loadCustomPrinters().length).toBe(1);
    expect(loadCustomPrinters()[0].name).toBe('New name');
  });

  it('the id is read-only when editing an existing definition', () => {
    render(<PrintersDialog />);
    fireEvent.click(screen.getAllByLabelText('Edit printer')[0]);
    const id = fieldInput('ID');
    expect(id.disabled).toBe(true);
  });

  it('editing a built-in stores an override without touching the built-in list', () => {
    render(<PrintersDialog />);
    fireEvent.click(screen.getAllByLabelText('Edit printer')[0]);
    fireEvent.click(screen.getByText('Save'));
    expect(loadCustomPrinters().length).toBe(1);
    expect(loadCustomPrinters()[0].builtin).toBe(false);
    expect(BUILTIN_PRINTERS.some((b) => b.id === loadCustomPrinters()[0].id)).toBe(true);
  });
});

describe('definition fields', () => {
  it('turning on "tape printer" seeds sensible tape widths', () => {
    render(<PrintersDialog />);
    fireEvent.click(screen.getByText('Add printer'));
    fireEvent.click(screen.getByText('Tape printer'));
    fireEvent.change(fieldInput('ID'), { target: { value: 't' } });
    fireEvent.change(fieldInput('Name'), { target: { value: 'T' } });
    fireEvent.click(screen.getByText('Save'));
    expect(loadCustomPrinters()[0].tape).toBe(true);
    expect(loadCustomPrinters()[0].tapeWidths).toEqual([12, 14, 15]);
  });

  it('turning it off clears the tape widths', () => {
    render(<PrintersDialog />);
    fireEvent.click(screen.getByText('Add printer'));
    fireEvent.click(screen.getByText('Tape printer'));
    fireEvent.click(screen.getByText('Tape printer'));
    fireEvent.change(fieldInput('ID'), { target: { value: 't' } });
    fireEvent.change(fieldInput('Name'), { target: { value: 'T' } });
    fireEvent.click(screen.getByText('Save'));
    expect(loadCustomPrinters()[0].tapeWidths).toBeNull();
  });

  it('name patterns are parsed from a comma-separated list', () => {
    render(<PrintersDialog />);
    fireEvent.click(screen.getByText('Add printer'));
    fireEvent.change(fieldInput('ID'), { target: { value: 'p' } });
    fireEvent.change(fieldInput('Name'), { target: { value: 'P' } });
    const patterns = fieldInput('Bluetooth name prefixes (comma separated)') as HTMLInputElement;
    fireEvent.change(patterns, { target: { value: 'AB, CD ,,EF' } });
    fireEvent.click(screen.getByText('Save'));
    expect(loadCustomPrinters()[0].namePatterns).toEqual(['AB', 'CD', 'EF']);
  });

  it('the protocol is chosen from the known set', () => {
    render(<PrintersDialog />);
    fireEvent.click(screen.getByText('Add printer'));
    const select = screen.getAllByRole('combobox')[0] as HTMLSelectElement;
    const values = [...select.querySelectorAll('option')].map((o) => o.value);
    expect(values).toContain('m-series');
    expect(values).toContain('tspl');
    expect(values).toContain('d-series');
  });
});
