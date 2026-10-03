// @vitest-environment jsdom
/**
 * SettingsDialog, ModelDialog and AboutDialog.
 *
 * Settings is where the print parameters live; ModelDialog decides which printer protocol a job
 * uses, so a wrong choice there means a wrong print. Both are driven through the real store.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { SettingsDialog, ModelDialog, AboutDialog } from '../src/ui/Dialogs';
import { useStore } from '../src/state/store';
import { DEFAULT_SETTINGS, getDeviceModel } from '../src/core/storage/storage';
import * as printing from '../src/services/printing';

const connected = (name = 'M221') =>
  useStore.setState({
    conn: { type: 'ble', connected: true, busy: false, deviceName: name, status: 'connected', error: null },
  });

beforeEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  useStore.getState().newDesign();
  useStore.setState({
    lang: 'en',
    dialog: 'settings',
    conn: { type: null, connected: false, busy: false, deviceName: '', status: 'disconnected', error: null },
    printerInfo: null,
  });
  useStore.getState().updateSettings({ ...DEFAULT_SETTINGS });
});

describe('SettingsDialog — printer state', () => {
  it('reports "Not connected" when nothing is attached', () => {
    render(<SettingsDialog />);
    expect(screen.getByText('Not connected')).toBeTruthy();
  });

  it('shows the device name and marks it on when connected', () => {
    connected('M221');
    render(<SettingsDialog />);
    // The name also appears in the model dropdown, so target the pill by its class.
    const pill = document.querySelector('.pill') as HTMLElement;
    expect(pill.textContent).toBe('M221');
    expect(pill.className).toContain('pill-on');
  });

  it('the density test is disabled until a printer is connected', () => {
    render(<SettingsDialog />);
    expect((screen.getByText('Density test').closest('button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('the density test is enabled once connected, and calls the print path', () => {
    connected();
    const spy = vi.spyOn(printing, 'printDensityTest').mockResolvedValue(undefined);
    render(<SettingsDialog />);
    const btn = screen.getByText('Density test').closest('button') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(spy).toHaveBeenCalled();
  });
});

describe('SettingsDialog — printer status readout', () => {
  // The readout moved to the connect menu (see topbar.dom.test.tsx). These assertions pin that it
  // is gone from here, so it cannot quietly come back in two places.
  it('shows nothing but the controls while disconnected', () => {
    render(<SettingsDialog />);
    expect(screen.queryByText('Battery')).toBeNull();
    expect(screen.queryByText('Paper')).toBeNull();
  });

  it('no longer shows the printer readout even while connected', () => {
    connected();
    useStore.setState({
      printerInfo: { battery: 74, paper: 'ok', cover: 'closed', firmware: '1.1.3', serial: 'Q059E35I0030870' },
    });
    render(<SettingsDialog />);
    expect(screen.queryByText('74%')).toBeNull();
    expect(screen.queryByText('Q059E35I0030870')).toBeNull();
    expect(screen.queryByText('1.1.3')).toBeNull();
  });
});

describe('SettingsDialog — parameters', () => {
  it('changing the model updates the setting', () => {
    render(<SettingsDialog />);
    const select = screen.getAllByRole('combobox')[0] as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'm221' } });
    expect(useStore.getState().settings.printerModel).toBe('m221');
  });

  it('choosing a model while connected remembers it for that device', () => {
    connected('M221');
    render(<SettingsDialog />);
    const select = screen.getAllByRole('combobox')[0] as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'm221' } });
    expect(getDeviceModel('M221')).toBe('m221');
  });

  it('changing density updates the setting', () => {
    render(<SettingsDialog />);
    const range = document.querySelector('input[type="range"]') as HTMLInputElement;
    fireEvent.input(range, { target: { value: '8' } });
    expect(useStore.getState().settings.density).toBe(8);
  });

  it('changing feed updates the setting and rounds it', () => {
    render(<SettingsDialog />);
    const feed = screen.getByDisplayValue(String(DEFAULT_SETTINGS.feed));
    fireEvent.focus(feed);
    fireEvent.change(feed, { target: { value: '48' } });
    fireEvent.keyDown(feed, { key: 'Enter' });
    expect(useStore.getState().settings.feed).toBe(48);
  });

  it('Reset restores the default parameters', () => {
    useStore.getState().updateSettings({ density: 2, feed: 96, printerModel: 'm221' });
    render(<SettingsDialog />);
    fireEvent.click(screen.getByText('Reset'));
    const s = useStore.getState().settings;
    expect(s.density).toBe(DEFAULT_SETTINGS.density);
    expect(s.feed).toBe(DEFAULT_SETTINGS.feed);
    expect(s.printerModel).toBe(DEFAULT_SETTINGS.printerModel);
  });

  it('Done closes the dialog', () => {
    render(<SettingsDialog />);
    fireEvent.click(screen.getByText('Done'));
    expect(useStore.getState().dialog).toBeNull();
  });

  it('Manage printers opens the printer-list dialog', () => {
    render(<SettingsDialog />);
    fireEvent.click(screen.getByText('Manage printers…'));
    expect(useStore.getState().dialog).toBe('printers');
  });
});

describe('ModelDialog', () => {
  it('names the unrecognised device in the prompt', () => {
    useStore.setState({ conn: { type: 'ble', connected: true, busy: false, deviceName: 'Mystery-9000', status: 'connected', error: null } });
    render(<ModelDialog />);
    expect(screen.getByText(/Mystery-9000/)).toBeTruthy();
  });

  it('defaults to a known model rather than an empty selection', () => {
    render(<ModelDialog />);
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    expect(select.value).toBeTruthy();
    expect(useStore.getState().registry.get(select.value)).toBeTruthy();
  });

  it('lists every registered printer plus the auto option', () => {
    render(<ModelDialog />);
    const options = (screen.getByRole('combobox') as HTMLSelectElement).querySelectorAll('option');
    expect(options.length).toBe(useStore.getState().registry.all.length);
  });

  it('confirming applies the chosen model and closes', () => {
    render(<ModelDialog />);
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'm221' } });
    fireEvent.click(screen.getByText('Use this model'));
    expect(useStore.getState().settings.printerModel).toBe('m221');
    expect(useStore.getState().dialog).toBeNull();
  });

  it('remembers the choice for the device when "remember" is on', () => {
    useStore.setState({ conn: { type: 'ble', connected: true, busy: false, deviceName: 'Mystery-9000', status: 'connected', error: null } });
    render(<ModelDialog />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'm221' } });
    fireEvent.click(screen.getByText('Use this model'));
    expect(getDeviceModel('Mystery-9000')).toBe('m221');
  });

  it('does not remember when "remember" is turned off', () => {
    useStore.setState({ conn: { type: 'ble', connected: true, busy: false, deviceName: 'Mystery-9000', status: 'connected', error: null } });
    render(<ModelDialog />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'm221' } });
    fireEvent.click(screen.getByText('Remember for this device'));
    fireEvent.click(screen.getByText('Use this model'));
    expect(getDeviceModel('Mystery-9000')).toBeNull();
    expect(useStore.getState().settings.printerModel).toBe('m221'); // still applied for this session
  });

  it('cancelling leaves the model untouched', () => {
    const before = useStore.getState().settings.printerModel;
    render(<ModelDialog />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'm221' } });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(useStore.getState().settings.printerModel).toBe(before);
  });
});

describe('AboutDialog', () => {
  it('shows the running version', () => {
    render(<AboutDialog />);
    expect(screen.getByText(/^v\d+\.\d+\.\d+/)).toBeTruthy();
  });

  it('credits the upstream project with a link', () => {
    render(<AboutDialog />);
    const link = screen.getByText('transcriptionstream/phomymo') as HTMLAnchorElement;
    expect(link.href).toContain('github.com/transcriptionstream/phomymo');
    expect(link.rel).toContain('noreferrer');
  });

  it('lists keyboard shortcuts', () => {
    render(<AboutDialog />);
    expect(screen.getByText(/Ctrl\/⌘ \+ Z/)).toBeTruthy();
    expect(screen.getByText(/Ctrl\/⌘ \+ P/)).toBeTruthy();
  });

  it('pins the version block to LTR so RTL cannot reorder it', () => {
    useStore.setState({ lang: 'ar' });
    const { container } = render(<AboutDialog />);
    expect(container.querySelector('.about-meta')!.getAttribute('dir')).toBe('ltr');
  });
});
