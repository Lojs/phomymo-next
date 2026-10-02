import { useStore } from '../state/store';
import { useT } from '../i18n';
import { Field, NumberInput, Section, Segmented, Select, Toggle, Button } from './kit';
import { LIMITS, TAPE_WIDTHS, presetKey, presetsFor } from '../core/printers/presets';
import { isDSeries, isTape } from '../core/printers/definitions';
import { orientationApplies, resolveOrientation } from '../core/render/layout';
import { rememberTapeWidth } from '../services/printing';

// Whether the user has explicitly picked "Custom…" from the label-size dropdown, so the
// editable width/height fields stay visible even if the current numbers happen to coincide
// with a real preset (e.g. right after opening the app, or right after typing in exactly a
// preset's dimensions by hand). This intentionally lives outside React state: LabelPanel
// unmounts whenever an element is selected (ElementPanel takes over) and remounts on
// deselection, and a plain module-level flag survives that far more simply than plumbing it
// through the store for what is otherwise a purely transient UI habit — it always changes
// inside the same handler that also touches the store, so the next render picks it up.
let customSizeMode = false;

export function LabelPanel() {
  const t = useT();
  const s = useStore();
  const cfg = s.registry.resolve(s.conn.deviceName, s.settings.printerModel);
  const groups = presetsFor(cfg, s.settings.tapeWidth);
  const tape = isTape(cfg);
  const dSeries = isDSeries(cfg);
  const key = presetKey(s.labelSize);
  const offered = { ...groups.rect, ...groups.round, ...groups.continuous };
  const isPreset = key in offered && !customSizeMode;
  const selectValue = s.multi.enabled ? 'multi' : isPreset ? key : 'custom';
  const lengthEditable = tape || !!s.labelSize.continuous;

  const setSize = (patch: Partial<typeof s.labelSize>) => {
    const next = { ...s.labelSize, ...patch };
    if (next.round) next.height = next.width;
    s.setLabelSize(next);
  };

  const onSizeSelect = (v: string) => {
    if (v === 'multi') { customSizeMode = false; return s.openDialog('multi'); }
    if (v === 'custom') { customSizeMode = true; return s.setLabelSize({ width: s.labelSize.width, height: s.labelSize.height, round: false, continuous: false }); }
    customSizeMode = false;
    const p = offered[v];
    if (p) s.setLabelSize({ ...p });
  };

  return (
    <div className="panel-stack">
      <Section title={t('labelSize')}>
        {/* The section heading above already says "Label size", so this select carries the
            name only for assistive tech — a second visible copy read as visual stutter. */}
        <Select value={selectValue} onChange={onSizeSelect} aria-label={t('labelSize')}>
          {Object.entries(groups.rect).map(([k, v]) => <option key={k} value={k}>{v.width}×{v.height} {t('mm')}</option>)}
          {Object.keys(groups.round).length > 0 && (
            <optgroup label={t('roundLabels')}>{Object.keys(groups.round).map((k) => <option key={k} value={k}>{k}</option>)}</optgroup>
          )}
          {Object.keys(groups.continuous).length > 0 && (
            <optgroup label={t('continuousTape')}>{Object.entries(groups.continuous).map(([k, v]) => <option key={k} value={k}>{v.width}×{v.height} {t('mm')}</option>)}</optgroup>
          )}
          <option value="custom">{t('custom')}</option>
          <option value="multi">{t('multiLabel')}</option>
        </Select>

        {!s.multi.enabled && <p className="field-hint">{t('labelSizeHint')}</p>}

        {!s.multi.enabled && orientationApplies(s.labelSize) && (
          <Field label={t('orientation')}>
            <Segmented
              value={resolveOrientation(s.labelSize)}
              onChange={s.setOrientation}
              options={[
                { value: 'portrait', icon: 'orientPortrait', title: t('portrait') },
                { value: 'landscape', icon: 'orientLandscape', title: t('landscape') },
              ]}
            />
          </Field>
        )}
        {!s.multi.enabled && orientationApplies(s.labelSize) && (
          <p className="field-hint">{t('orientationHint')}</p>
        )}

        {tape && (
          <Field label={t('tapeWidth')}>
            <Segmented
              value={s.settings.tapeWidth}
              options={TAPE_WIDTHS.map((w) => ({ value: w as number, label: `${w} ${t('mm')}` }))}
              onChange={(w) => { s.updateSettings({ tapeWidth: w }); rememberTapeWidth(s.conn.deviceName, w); }}
            />
          </Field>
        )}

        {!s.multi.enabled && !isPreset && (
          <div className="row">
            <Field label={t('width')}><NumberInput value={s.labelSize.width} min={LIMITS.label.minW} max={LIMITS.label.maxW} unit={t('mm')} onChange={(v) => setSize({ width: v })} /></Field>
            {!s.labelSize.round && <Field label={t('height')}><NumberInput value={s.labelSize.height} min={LIMITS.label.minH} max={LIMITS.label.maxH} unit={t('mm')} onChange={(v) => setSize({ height: v })} /></Field>}
          </div>
        )}
        {!s.multi.enabled && !isPreset && (
          <div className="row row-wrap">
            <Toggle checked={!!s.labelSize.round} label={t('round')} onChange={(round) => setSize({ round, continuous: round ? false : s.labelSize.continuous })} />
            {dSeries && !s.labelSize.round && <Toggle checked={!!s.labelSize.continuous} label={t('continuous')} onChange={(continuous) => setSize({ continuous })} />}
          </div>
        )}

        {lengthEditable && !s.multi.enabled && (
          <Field label={t('width')}>
            <span className="row">
              <Button icon="minus" aria-label={t('lengthMinus')} title={t('lengthMinus')} onClick={() => setSize({ width: Math.max(LIMITS.label.minW, s.labelSize.width - 5) })} />
              <NumberInput value={s.labelSize.width} min={LIMITS.label.minW} max={LIMITS.label.maxW} unit={t('mm')} onChange={(v) => setSize({ width: v })} />
              <Button icon="plus" aria-label={t('lengthPlus')} title={t('lengthPlus')} onClick={() => setSize({ width: Math.min(LIMITS.label.maxW, s.labelSize.width + 5) })} />
            </span>
          </Field>
        )}

        {s.multi.enabled && (
          <div className="roll-note">
            <span>{s.multi.labelsAcross} × {s.multi.labelWidth}×{s.multi.labelHeight} {t('mm')}</span>
            <Button variant="ghost" onClick={() => s.openDialog('multi')}>{t('multiLabelRoll')}</Button>
          </div>
        )}
      </Section>

      </div>
  );
}
