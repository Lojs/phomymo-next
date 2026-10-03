import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../state/store';
import { useT } from '../i18n';
import { Button, NumberInput, useOutsideClose } from './kit';
import { Icon } from './icons';
import { LIMITS } from '../core/printers/presets';
import { bluetoothAvailable, connectPrinter, disconnectPrinter, printCurrent, usbAvailable } from '../services/printing';

function ConnectMenu() {
  const t = useT();
  const conn = useStore((s) => s.conn);
  const info = useStore((s) => s.printerInfo);
  const battery = info?.battery;
  const [open, setOpen] = useState(false);
  const ref = useOutsideClose(open, () => setOpen(false));
  const pick = (fn: () => Promise<unknown>) => { setOpen(false); void fn(); };

  const label = conn.busy ? t('connecting')
    : conn.connected ? conn.deviceName || t('connected')
    : conn.status === 'failed' ? t('connectFailed')
    : t('connectPrinter');
  // A shorter form for narrow screens (CSS swaps between them — see .conn-label-* rules) so the
  // button doesn't need as much room on a phone-width topbar.
  const shortLabel = conn.busy ? t('connecting')
    : conn.connected ? conn.deviceName || t('connected')
    : conn.status === 'failed' ? t('connectFailed')
    : t('connect');

  return (
    <div className="menu-wrap" ref={ref}>
      <button
        type="button"
        className={`conn${conn.connected ? ' is-on' : ''}${conn.status === 'failed' ? ' is-failed' : ''}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        disabled={conn.busy}
        title={conn.status === 'failed' && conn.error ? conn.error : undefined}
      >
        <span className="led" aria-hidden="true" />
        <Icon name={conn.type === 'usb' ? 'usb' : 'bluetooth'} size={16} />
        <span className="conn-text">
          <span className="conn-label-full">{label}</span>
          <span className="conn-label-short">{shortLabel}</span>
        </span>
        {conn.connected && typeof battery === 'number' && <span className="conn-batt">{battery}%</span>}
      </button>
      {open && (
        <div className="menu" role="menu">
          {conn.status === 'failed' && conn.error && <p className="menu-note menu-note-error">{conn.error}</p>}
          {conn.connected ? (
            <>
              <button role="menuitem" onClick={() => pick(disconnectPrinter)}><Icon name="close" size={16} />{t('disconnect')}</button>
              {/* The printer's own readout lives here, under Disconnect, rather than in the print
                  settings dialog: it is a fact about the connected device, not a setting, and this
                  menu is where you look when you want to know about the device. */}
              {info && (
                <dl className="status-list menu-status">
                  {typeof info.battery === 'number' && <><dt><Icon name="battery" size={14} /> {t('battery')}</dt><dd>{info.battery}%</dd></>}
                  {info.paper && <><dt>{t('paper')}</dt><dd>{info.paper === 'out' ? t('paperOut') : t('paperOk')}</dd></>}
                  {(info.cover === 'open' || info.cover === 'closed') && <><dt>{t('cover')}</dt><dd>{info.cover === 'open' ? t('coverOpen') : t('coverClosed')}</dd></>}
                  {info.firmware && <><dt>{t('firmware')}</dt><dd>{String(info.firmware)}</dd></>}
                  {info.serial && <><dt>{t('serial')}</dt><dd>{String(info.serial)}</dd></>}
                </dl>
              )}
            </>
          ) : (
            <>
              {bluetoothAvailable() && <button role="menuitem" onClick={() => pick(() => connectPrinter('ble'))}><Icon name="bluetooth" size={16} />{t('bluetooth')}</button>}
              {usbAvailable() && <button role="menuitem" onClick={() => pick(() => connectPrinter('usb'))}><Icon name="usb" size={16} />{t('usb')}</button>}
              {bluetoothAvailable() && <button role="menuitem" onClick={() => pick(() => connectPrinter('ble', true))}><Icon name="eye" size={16} />{t('showAllDevices')}</button>}
              {!bluetoothAvailable() && !usbAvailable() && <p className="menu-note">{t('noConnectSupport')}</p>}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function TopBar() {
  const t = useT();
  const { designName, dirty, lang, past, future, print, previewOnPaper, copies } = useStore(useShallow((s) => ({ designName: s.designName, dirty: s.dirty, lang: s.lang, past: s.past.length, future: s.future.length, print: s.print, previewOnPaper: s.previewOnPaper, copies: s.settings.copies })));
  const st = useStore.getState;

  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true" />
        <span className="brand-name">{t('appName')}</span>
      </div>

      <button type="button" className="doc" onClick={() => st().openDialog('designs')} title={t('designs')}>
        <Icon name="folder" size={16} />
        <span className="doc-name">{designName ?? t('untitled')}{dirty ? ' •' : ''}</span>
      </button>

      <div className="topbar-group">
        <Button variant="ghost" icon="undo" aria-label={t('undo')} title={`${t('undo')} (Ctrl+Z)`} disabled={!past} onClick={() => st().undo()} />
        <Button variant="ghost" icon="redo" aria-label={t('redo')} title={`${t('redo')} (Ctrl+Shift+Z)`} disabled={!future} onClick={() => st().redo()} />
      </div>

      <div className="topbar-spacer" />

      <Button variant="ghost" icon="globe" title={t('language')} aria-label={t('language')} onClick={() => st().setLang(lang === 'ar' ? 'en' : 'ar')}>
        <span className="lang-tag">{lang === 'ar' ? 'EN' : 'ع'}</span>
      </Button>
      <Button variant="ghost" icon="info" aria-label={t('aboutTitle')} title={t('aboutTitle')} onClick={() => st().openDialog('about')} />
      <Button variant="ghost" icon="settings" aria-label={t('printSettings')} title={t('printSettings')} onClick={() => st().openDialog('settings')} />
      <Button variant="ghost" icon="eye" active={previewOnPaper} aria-label={t('printPreview')} title={t('printPreviewHint')} onClick={() => st().setPreviewOnPaper(!previewOnPaper)} />
      <ConnectMenu />
      <span className="topbar-copies">
        <span aria-hidden="true">×</span>
        <NumberInput value={copies} min={LIMITS.copies.min} max={LIMITS.copies.max} onChange={(v) => st().updateSettings({ copies: Math.round(v) })} width={46} title={t('copies')} />
      </span>
      <Button variant="primary" icon="print" disabled={!!print?.active} onClick={() => void printCurrent()}>
        <span className="btn-text">{print?.active ? t('printing') : t('print')}</span>
      </Button>
    </header>
  );
}
