// @vitest-environment jsdom
/**
 * TopBar — connection menu, history buttons, language toggle and the print action.
 *
 * The topbar is where state becomes visible: whether Undo is reachable, what the connect button
 * says, and whether Print is blocked. These tests drive those states through the real store.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';
import { TopBar } from '../src/ui/TopBar';
import { useStore } from '../src/state/store';
import * as printing from '../src/services/printing';
import { createText } from '../src/core/model/elements';

beforeEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useStore.getState().newDesign();
  useStore.setState({
    lang: 'en',
    dialog: null,
    print: null,
    previewOnPaper: false,
    conn: { type: null, connected: false, busy: false, deviceName: '', status: 'disconnected', error: null },
    printerInfo: null,
  });
});

describe('document name', () => {
  it('shows "Untitled" for a new design', () => {
    render(<TopBar />);
    expect(screen.getByText('Untitled')).toBeTruthy();
  });

  it('shows the saved name', () => {
    useStore.setState({ designName: 'Shipping labels' });
    render(<TopBar />);
    expect(screen.getByText(/Shipping labels/)).toBeTruthy();
  });

  it('marks an unsaved change with a dot', () => {
    useStore.setState({ designName: 'Draft', dirty: true });
    render(<TopBar />);
    expect(screen.getByText(/•/)).toBeTruthy();
  });

  it('the name button opens the designs dialog', () => {
    render(<TopBar />);
    fireEvent.click(screen.getByTitle('Designs'));
    expect(useStore.getState().dialog).toBe('designs');
  });
});

describe('undo / redo buttons', () => {
  it('are disabled on a genuinely fresh store', () => {
    // newDesign() deliberately checkpoints first, so that clearing the canvas is itself undoable.
    // To see the no-history state, clear the stacks directly.
    useStore.setState({ past: [], future: [] });
    render(<TopBar />);
    expect((screen.getByLabelText('Undo') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText('Redo') as HTMLButtonElement).disabled).toBe(true);
  });

  it('new design is undoable: the button stays enabled after clearing', () => {
    useStore.getState().add(createText('A'));
    useStore.getState().newDesign();
    render(<TopBar />);
    const undo = screen.getByLabelText('Undo') as HTMLButtonElement;
    expect(undo.disabled).toBe(false);
    fireEvent.click(undo);
    expect(useStore.getState().elements.length).toBe(1); // the cleared element comes back
  });

  it('undo becomes enabled once there is history, and actually undoes', () => {
    useStore.getState().add(createText('A'));
    render(<TopBar />);
    const undo = screen.getByLabelText('Undo') as HTMLButtonElement;
    expect(undo.disabled).toBe(false);
    fireEvent.click(undo);
    expect(useStore.getState().elements.length).toBe(0);
  });

  it('redo becomes enabled after an undo, and re-applies', () => {
    useStore.getState().add(createText('A'));
    useStore.getState().undo();
    render(<TopBar />);
    const redo = screen.getByLabelText('Redo') as HTMLButtonElement;
    expect(redo.disabled).toBe(false);
    fireEvent.click(redo);
    expect(useStore.getState().elements.length).toBe(1);
  });
});

describe('language toggle', () => {
  it('shows "ع" while the UI is English', () => {
    useStore.setState({ lang: 'en' });
    render(<TopBar />);
    expect(screen.getByText('ع')).toBeTruthy();
  });

  it('shows "EN" while the UI is Arabic', () => {
    useStore.setState({ lang: 'ar' });
    render(<TopBar />);
    expect(screen.getByText('EN')).toBeTruthy();
  });

  it('switches the language when clicked', () => {
    useStore.setState({ lang: 'en' });
    render(<TopBar />);
    fireEvent.click(screen.getByLabelText('Language'));
    expect(useStore.getState().lang).toBe('ar');
  });

  it('renders Arabic labels when the language is Arabic', () => {
    useStore.setState({ lang: 'ar' });
    render(<TopBar />);
    expect(screen.getByText('طباعة')).toBeTruthy();
  });
});

describe('dialogs', () => {
  it('the info button opens About', () => {
    render(<TopBar />);
    fireEvent.click(screen.getByLabelText('About Phomymo Next'));
    expect(useStore.getState().dialog).toBe('about');
  });

  it('the settings button opens print settings', () => {
    render(<TopBar />);
    fireEvent.click(screen.getByLabelText('Print settings'));
    expect(useStore.getState().dialog).toBe('settings');
  });
});

describe('print preview toggle', () => {
  it('is off by default and turns on when clicked', () => {
    render(<TopBar />);
    const btn = screen.getByLabelText('Print preview') as HTMLButtonElement;
    expect(btn.className).not.toContain('is-active');
    fireEvent.click(btn);
    expect(useStore.getState().previewOnPaper).toBe(true);
  });

  it('reflects an already-on state', () => {
    useStore.setState({ previewOnPaper: true });
    render(<TopBar />);
    expect((screen.getByLabelText('Print preview') as HTMLButtonElement).className).toContain('is-active');
  });
});

describe('copies', () => {
  it('shows the current copy count', () => {
    useStore.getState().updateSettings({ copies: 3 });
    render(<TopBar />);
    expect((screen.getByTitle('Copies') as HTMLInputElement).value).toBe('3');
  });

  it('committing a new value updates the setting', () => {
    render(<TopBar />);
    const input = screen.getByTitle('Copies') as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '5' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(useStore.getState().settings.copies).toBe(5);
  });

  it('clamps a value above the maximum', () => {
    render(<TopBar />);
    const input = screen.getByTitle('Copies') as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '9999' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(useStore.getState().settings.copies).toBeLessThanOrEqual(99);
  });
});

describe('print button', () => {
  it('is enabled when idle', () => {
    render(<TopBar />);
    const btn = screen.getByText('Print').closest('button') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });

  it('is disabled and reads "Printing…" while a job is active', () => {
    useStore.setState({ print: { active: true, label: 'x', current: 0, total: 1, sub: '' } });
    render(<TopBar />);
    const btn = screen.getByText('Printing…').closest('button') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('clicking it calls the print path', () => {
    const spy = vi.spyOn(printing, 'printCurrent').mockResolvedValue(true);
    render(<TopBar />);
    fireEvent.click(screen.getByText('Print').closest('button')!);
    expect(spy).toHaveBeenCalled();
  });
});

describe('connection menu', () => {
  it('prompts to connect when disconnected', () => {
    render(<TopBar />);
    expect(screen.getAllByText('Connect Printer').length).toBeGreaterThan(0);
  });

  it('shows the device name when connected, with the battery', () => {
    useStore.setState({
      conn: { type: 'ble', connected: true, busy: false, deviceName: 'M221', status: 'connected', error: null },
      printerInfo: { battery: 80, paper: 'ok', firmware: null, serial: null, cover: 'closed' },
    });
    render(<TopBar />);
    expect(screen.getAllByText('M221').length).toBeGreaterThan(0);
    expect(screen.getByText('80%')).toBeTruthy();
  });

  it('shows a connecting state and disables the button while busy', () => {
    useStore.setState({ conn: { type: null, connected: false, busy: true, deviceName: '', status: 'connecting', error: null } });
    render(<TopBar />);
    const btn = screen.getAllByText('Connecting…')[0].closest('button') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('reports a failure and surfaces the reason as a tooltip', () => {
    useStore.setState({ conn: { type: null, connected: false, busy: false, deviceName: '', status: 'failed', error: 'GATT operation failed' } });
    render(<TopBar />);
    const btn = screen.getAllByText('Couldn’t connect')[0].closest('button') as HTMLButtonElement;
    expect(btn.title).toBe('GATT operation failed');
    expect(btn.className).toContain('is-failed');
  });

  it('offers Disconnect when connected, and calls it', () => {
    useStore.setState({ conn: { type: 'ble', connected: true, busy: false, deviceName: 'M221', status: 'connected', error: null } });
    const spy = vi.spyOn(printing, 'disconnectPrinter').mockResolvedValue(undefined);
    render(<TopBar />);
    fireEvent.click(screen.getAllByText('M221')[0].closest('button')!);
    fireEvent.click(screen.getByText('Disconnect'));
    expect(spy).toHaveBeenCalled();
  });

  it('shows the failure reason inside the open menu too', () => {
    useStore.setState({ conn: { type: null, connected: false, busy: false, deviceName: '', status: 'failed', error: 'Bluetooth is blocked' } });
    render(<TopBar />);
    fireEvent.click(screen.getAllByText('Couldn’t connect')[0].closest('button')!);
    expect(screen.getByText('Bluetooth is blocked')).toBeTruthy();
  });
});
