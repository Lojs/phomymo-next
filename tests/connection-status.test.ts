/**
 * Regression tests for the Connect Printer status/error tracking added in this pass.
 * store.ts touches localStorage/navigator at module-init time (loading settings, custom
 * printers, autosave, and the initial UI language), so those are polyfilled first, same
 * pattern as tests/golden-protocols.test.ts uses for the legacy import.
 */
import { describe, it, expect, beforeAll } from 'vitest';

beforeAll(() => {
  (globalThis as any).localStorage = { getItem: () => null, setItem() {}, removeItem() {} }; // eslint-disable-line @typescript-eslint/no-explicit-any
  if (!('navigator' in globalThis)) (globalThis as any).navigator = { language: 'en-US' }; // eslint-disable-line @typescript-eslint/no-explicit-any
});

describe('connection status', () => {
  it('starts disconnected with no error', async () => {
    const { useStore } = await import('../src/state/store');
    const conn = useStore.getState().conn;
    expect(conn.status).toBe('disconnected');
    expect(conn.connected).toBe(false);
    expect(conn.error).toBeNull();
  });

  it('setConn merges into the existing connection state rather than replacing it', async () => {
    const { useStore } = await import('../src/state/store');
    useStore.getState().setConn({ status: 'connecting', busy: true });
    let conn = useStore.getState().conn;
    expect(conn.status).toBe('connecting');
    expect(conn.busy).toBe(true);
    expect(conn.type).toBeNull(); // untouched fields survive the partial update

    useStore.getState().setConn({ status: 'connected', connected: true, busy: false, type: 'ble', deviceName: 'M221', error: null });
    conn = useStore.getState().conn;
    expect(conn).toMatchObject({ status: 'connected', connected: true, busy: false, type: 'ble', deviceName: 'M221', error: null });

    useStore.getState().setConn({ status: 'failed', connected: false, type: null, error: 'Something went wrong' });
    conn = useStore.getState().conn;
    expect(conn.status).toBe('failed');
    expect(conn.error).toBe('Something went wrong');
  });
});

describe('friendlyConnectError', () => {
  it('maps known WebBluetooth/WebUSB error names to a readable message', async () => {
    const { friendlyConnectError } = await import('../src/services/printing');
    expect(friendlyConnectError({ name: 'SecurityError' })).toMatch(/permission/i);
    expect(friendlyConnectError({ name: 'NetworkError' })).toMatch(/busy|range/i);
    expect(friendlyConnectError({ name: 'NotSupportedError' })).toMatch(/bluetooth/i);
  });

  it('falls back to the raw message, then a generic one, for anything else', async () => {
    const { friendlyConnectError } = await import('../src/services/printing');
    expect(friendlyConnectError({ message: 'GATT operation failed' })).toBe('GATT operation failed');
    expect(friendlyConnectError({})).toMatch(/connect/i);
    expect(friendlyConnectError(null)).toMatch(/connect/i);
  });
});
