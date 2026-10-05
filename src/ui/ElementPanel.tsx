import { extractFields } from '../core/template/template';
import { useMemo, useRef } from 'react';
import { useStore } from '../state/store';
import { useT, type Key } from '../i18n';
import { Button, Field, MenuButton, NumberInput, Section, Segmented, Select, Slider, Toggle } from './kit';
import { LABEL_FONTS, isLocalFontAccessAvailable, queryLocalFontFamilies } from '../fonts';
import { LIMITS } from '../core/printers/presets';
import { MIN_SIZES, type BarcodeElement, type DitherChoice, type ImageElement, type LabelElement, type QRElement, type ShapeElement, type ShapeType, type TextElement } from '../core/model/elements';
import { SHAPES, STROKED_SHAPES } from './shapes';
import { DITHER_FILLS, encodeBarcode } from '../core/render/draw';
import { replaceImageFile } from '../services/actions';

const EXPRESSIONS = ['date', 'time', 'datetime', 'year', 'month', 'day', 'hour', 'minute'];

export function ElementPanel() {
  const t = useT();
  const s = useStore();
  const sel = s.elements.filter((e) => s.selectedIds.includes(e.id));
  if (!sel.length) return null;
  const one = sel.length === 1 ? sel[0] : null;

  return (
    <div className="panel-stack">
      {one ? <TypeSection el={one} /> : <Section title={t('properties')}><p className="field-hint">{t('multipleSelected', { n: sel.length })}</p></Section>}
      {one && <GeometrySection el={one} />}
      <Section title={t('arrange')}>
        <div className="row row-wrap">
          <Button icon="front" title={t('bringFront')} aria-label={t('bringFront')} onClick={() => s.order('front')} />
          <Button icon="layers" title={t('forward')} aria-label={t('forward')} onClick={() => s.order('up')} />
          <Button icon="layers" style={{ transform: 'scaleY(-1)' }} title={t('backward')} aria-label={t('backward')} onClick={() => s.order('down')} />
          <Button icon="back" title={t('sendBack')} aria-label={t('sendBack')} onClick={() => s.order('back')} />
        </div>
        <div className="row row-wrap">
          {sel.length > 1 && <Button icon="group" onClick={s.group}>{t('group')}</Button>}
          {sel.some((e) => e.groupId) && <Button icon="ungroup" onClick={s.ungroup}>{t('ungroup')}</Button>}
          <Button icon="copy" onClick={s.duplicate}>{t('duplicate')}</Button>
          <Button icon="trash" variant="danger" onClick={s.removeSelected}>{t('remove')}</Button>
        </div>
      </Section>
    </div>
  );
}

function GeometrySection({ el }: { el: LabelElement }) {
  const t = useT();
  const patch = useStore((s) => s.patchSelected);
  const min = MIN_SIZES[el.type];
  return (
    <Section title={t('position')}>
      <div className="grid-2">
        <Field label="X"><NumberInput value={el.x} onChange={(v) => patch({ x: v }, 'x')} /></Field>
        <Field label="Y"><NumberInput value={el.y} onChange={(v) => patch({ y: v }, 'y')} /></Field>
        <Field label={t('width')}><NumberInput value={el.width} min={min.width} onChange={(v) => patch({ width: Math.max(min.width, v) }, 'w')} /></Field>
        <Field label={t('height')}><NumberInput value={el.height} min={min.height} onChange={(v) => patch({ height: Math.max(min.height, v) }, 'h')} /></Field>
      </div>
      <Field label={t('rotation')}><Slider value={Math.round(el.rotation || 0)} min={0} max={359} onChange={(v) => patch({ rotation: v }, 'rot')} /></Field>
    </Section>
  );
}

function TypeSection({ el }: { el: LabelElement }) {
  switch (el.type) {
    case 'text': return <TextSection el={el} />;
    case 'barcode': return <BarcodeSection el={el} />;
    case 'qr': return <QrSection el={el} />;
    case 'shape': return <ShapeSection el={el} />;
    case 'image': return <ImageSection el={el} />;
  }
}

/** Textarea with "insert field" / "insert date" helpers that drop tokens at the cursor. */
function TokenInput({ value, onChange, rows = 3, label }: { value: string; onChange: (v: string) => void; rows?: number; label: string }) {
  const t = useT();
  const ref = useRef<HTMLTextAreaElement>(null);
  const elements = useStore((s) => s.elements);
  const fields = useMemo(() => extractFields(elements), [elements]);

  const insert = (token: string) => {
    const ta = ref.current;
    const at = ta ? [ta.selectionStart, ta.selectionEnd] : [value.length, value.length];
    onChange(value.slice(0, at[0]) + token + value.slice(at[1]));
    requestAnimationFrame(() => { ta?.focus(); ta?.setSelectionRange(at[0] + token.length, at[0] + token.length); });
  };
  const newField = () => {
    const name = window.prompt(t('fieldName'))?.trim();
    if (name) insert(`{{${name}}}`);
  };

  return (
    <>
      <Field label={label}>
        <textarea ref={ref} rows={rows} value={value} dir="auto" onChange={(e) => onChange(e.target.value)} />
      </Field>
      <div className="row row-wrap">
        {/* A menu, not a <select>: with a native select the "Insert field" label had to be a
            placeholder <option> to appear on the closed control, and Chrome re-listed it as the
            first row of the popup. The label now lives on the trigger only. */}
        <MenuButton
          label={t('insertField')}
          items={[...fields.map((f) => ({ value: f, label: f })), { value: '__new', label: t('newField') }]}
          onPick={(v) => (v === '__new' ? newField() : insert(`{{${v}}}`))}
        />
        <MenuButton
          label={t('insertExpression')}
          items={EXPRESSIONS.map((x) => ({ value: x, label: x }))}
          onPick={(v) => insert(`[[${v}]]`)}
        />
      </div>
    </>
  );
}

function TextSection({ el }: { el: TextElement }) {
  const t = useT();
  const p = useStore((s) => s.patchSelected);
  const groups = ['sans', 'serif', 'mono', 'display', 'arabic'] as const;
  const known = LABEL_FONTS.some((f) => f.value === el.fontFamily);
  const localFonts = useStore((s) => s.localFonts);
  const loadSystemFonts = async () => {
    if (!isLocalFontAccessAvailable()) { useStore.getState().toast(t('systemFontsUnsupported'), 'error'); return; }
    try { useStore.getState().setLocalFonts(await queryLocalFontFamilies()); } catch { /* permission denied or cancelled */ }
  };
  return (
    <Section title={t('text')}>
      <TokenInput value={el.text} label={t('text')} onChange={(v) => p({ text: v }, 'text')} />
      <Field label={t('font')}>
        <Select value={el.fontFamily} onChange={(v) => p({ fontFamily: v })}>
          {!known && <option value={el.fontFamily}>{el.fontFamily.split(',')[0]}</option>}
          {groups.map((g) => (
            <optgroup key={g} label={g}>
              {LABEL_FONTS.filter((f) => f.group === g).map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
            </optgroup>
          ))}
          {localFonts.length > 0 && (
            <optgroup label="System">
              {localFonts.map((f) => <option key={f} value={`${f}, sans-serif`}>{f}</option>)}
            </optgroup>
          )}
        </Select>
      </Field>
      {localFonts.length === 0 && <Button variant="ghost" onClick={loadSystemFonts}>{t('systemFonts')}</Button>}
      <Field label={t('fontSize')}>
        <Slider value={el.fontSize} min={LIMITS.font.min} max={LIMITS.font.max} disabled={el.autoScale} onChange={(v) => p({ fontSize: v }, 'fs')} />
      </Field>
      {el.autoScale && <p className="field-hint">{t('fontSizeAuto')}</p>}
      <div className="row row-wrap">
        {/* `Segmented` always emits the clicked option's own value, and these groups hold a single
            `true` option — so the value arriving here is always `true` and reading it can never
            turn the style back off. Toggle against the element's current state instead. */}
        <Segmented value={el.fontWeight === 'bold'} options={[{ value: true, icon: 'bold', title: t('bold') }]} onChange={() => p({ fontWeight: el.fontWeight === 'bold' ? 'normal' : 'bold' })} />
        <Segmented value={el.fontStyle === 'italic'} options={[{ value: true, icon: 'italic', title: t('italic') }]} onChange={() => p({ fontStyle: el.fontStyle === 'italic' ? 'normal' : 'italic' })} />
        <Segmented value={el.textDecoration === 'underline'} options={[{ value: true, icon: 'underline', title: t('underline') }]} onChange={() => p({ textDecoration: el.textDecoration === 'underline' ? 'none' : 'underline' })} />
      </div>
      <div className="row row-wrap">
        <Segmented value={el.align} onChange={(v) => p({ align: v })} options={[{ value: 'left', icon: 'alignL', title: t('alignLeft') }, { value: 'center', icon: 'alignC', title: t('alignCenter') }, { value: 'right', icon: 'alignR', title: t('alignRight') }]} />
        <Segmented value={el.verticalAlign} onChange={(v) => p({ verticalAlign: v })} options={[{ value: 'top', icon: 'alignT', title: t('alignTop') }, { value: 'middle', icon: 'alignM', title: t('alignMiddle') }, { value: 'bottom', icon: 'alignB', title: t('alignBottom') }]} />
      </div>
      <div className="grid-2">
        <Field label={t('textColor')}><Segmented value={el.color} onChange={(v) => p({ color: v })} options={[{ value: 'black', label: t('black') }, { value: 'white', label: t('white') }]} /></Field>
        <Field label={t('background')}><Segmented value={el.background} onChange={(v) => p({ background: v })} options={[{ value: 'transparent', label: t('none') }, { value: 'white', label: t('white') }, { value: 'black', label: t('black') }]} /></Field>
      </div>
      <Toggle checked={el.autoScale} onChange={(v) => p({ autoScale: v })} label={t('autoScale')} />
      <Toggle checked={el.noWrap} onChange={(v) => p({ noWrap: v })} label={t('noWrap')} />
      <Toggle checked={el.clipOverflow} onChange={(v) => p({ clipOverflow: v })} label={t('clipOverflow')} />
    </Section>
  );
}

function BarcodeSection({ el }: { el: BarcodeElement }) {
  const t = useT();
  const p = useStore((s) => s.patchSelected);
  const resolved = el.barcodeData.includes('{{') || el.barcodeData.includes('[[') ? null : encodeBarcode(el.barcodeData, el.barcodeFormat);
  const invalid = el.barcodeData.trim() !== '' && resolved === null && !el.barcodeData.includes('{{') && !el.barcodeData.includes('[[');
  const tooWide = resolved && Math.floor(el.width / resolved.length) < 1;
  return (
    <Section title={t('addBarcode')}>
      <TokenInput value={el.barcodeData} rows={2} label={t('barcodeData')} onChange={(v) => p({ barcodeData: v }, 'bc')} />
      {invalid && <p className="field-error">{t('barcodeInvalid', { format: el.barcodeFormat })}</p>}
      {tooWide && <p className="field-error">{t('barcodeTooWide')}</p>}
      <Field label={t('barcodeFormat')}>
        <Select value={el.barcodeFormat} onChange={(v) => p({ barcodeFormat: v as BarcodeElement['barcodeFormat'] })}>
          <option value="CODE128">Code 128</option><option value="EAN13">EAN-13</option><option value="CODE39">Code 39</option><option value="UPC">UPC-A</option>
        </Select>
      </Field>
      <Toggle checked={el.showText !== false} onChange={(v) => p({ showText: v })} label={t('showText')} />
      {el.showText !== false && (
        <>
          <Field label={t('textSize')}><Slider value={el.textFontSize ?? 12} min={6} max={40} onChange={(v) => p({ textFontSize: v }, 'tfs')} /></Field>
          <Toggle checked={!!el.textBold} onChange={(v) => p({ textBold: v })} label={t('bold')} />
        </>
      )}
    </Section>
  );
}

function QrSection({ el }: { el: QRElement }) {
  const t = useT();
  const p = useStore((s) => s.patchSelected);
  return (
    <Section title={t('addQR')}>
      <TokenInput value={el.qrData} rows={4} label={t('qrData')} onChange={(v) => p({ qrData: v }, 'qr')} />
    </Section>
  );
}

const DITHER_LABEL: Record<string, string> = { 'dither-6': '6%', 'dither-12': '12%', 'dither-25': '25%', 'dither-37': '37%', 'dither-50': '50%', 'dither-62': '62%', 'dither-75': '75%', 'dither-87': '87%', 'dither-94': '94%' };
const FILLS: [string, Key | string][] = [['none', 'none'], ['black', 'black'], ['white', 'white']];

function ShapeSection({ el }: { el: ShapeElement }) {
  const t = useT();
  const p = useStore((s) => s.patchSelected);
  const normalizedFill = ({ 'dither-light': 'dither-25', 'dither-medium': 'dither-50', 'dither-dark': 'dither-75' } as Record<string, string>)[el.fill] ?? el.fill;
  const current = SHAPES.find((s) => s.type === el.shapeType) ?? SHAPES[0];
  return (
    <Section title={t('addShape')}>
      <Field label={t('shapeType')}>
        {/* A dropdown rather than the segmented row it used to be: thirteen shapes do not fit across
            a 257px inspector, and a row that silently clips is worse than an opened list. */}
        <MenuButton
          layout="grid"
          icon={current.icon}
          label={t(current.label)}
          items={SHAPES.map((s) => ({ value: s.type, label: t(s.label), icon: s.icon }))}
          onPick={(v) => p({ shapeType: v as ShapeType })}
        />
      </Field>
      {!STROKED_SHAPES.includes(el.shapeType) && (
        <Field label={t('fill')}>
          <Select value={normalizedFill} onChange={(v) => p({ fill: v })}>
            {FILLS.map(([v, k]) => <option key={v} value={v}>{t(k as Key)}</option>)}
            {DITHER_FILLS.map((d) => <option key={d} value={d}>{DITHER_LABEL[d]}</option>)}
          </Select>
        </Field>
      )}
      <Field label={t('stroke')}>
        <Segmented value={el.stroke} onChange={(v) => p({ stroke: v })} options={[{ value: 'none', label: t('none') }, { value: 'black', label: t('black') }, { value: 'white', label: t('white') }]} />
      </Field>
      <Field label={t('strokeWidth')}><Slider value={el.strokeWidth} min={1} max={20} onChange={(v) => p({ strokeWidth: v }, 'sw')} /></Field>
      {el.shapeType === 'rectangle' && <Field label={t('cornerRadius')}><Slider value={el.cornerRadius} min={0} max={50} onChange={(v) => p({ cornerRadius: v }, 'cr')} /></Field>}
    </Section>
  );
}

/**
 * The dot patterns an image can be printed with, best for a photograph first.
 *
 * The plain names are what someone actually chooses between, and the hint keeps the algorithm's
 * real name beside it — the previous labels were the algorithm names alone ("Ordered (Bayer)",
 * "Floyd–Steinberg"), which told a user nothing about which one was right for a photo.
 */
const DITHER_CHOICES: { value: DitherChoice; label: Key; hint: string }[] = [
  { value: 'floyd-steinberg', label: 'ditherGray', hint: 'Floyd–Steinberg' },
  { value: 'ordered', label: 'ditherStandard', hint: 'Bayer' },
  { value: 'atkinson', label: 'ditherLight', hint: 'Atkinson' },
  { value: 'none', label: 'ditherBW', hint: 'threshold' },
];

function ImageSection({ el }: { el: ImageElement }) {
  const t = useT();
  const p = useStore((s) => s.patchSelected);
  const input = useRef<HTMLInputElement>(null);
  // An image with no explicit choice prints as 'auto', which resolves to Floyd–Steinberg for a
  // photograph, so the trigger must name the thing the printer will actually do.
  const current = el.dither ?? 'floyd-steinberg';
  return (
    <Section title={t('addImage')}>
      <div className="row">
        <Button icon="image" onClick={() => input.current?.click()}>{t('addImage')}</Button>
        <input ref={input} type="file" accept="image/*,.pdf" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void replaceImageFile(el.id, f); e.target.value = ''; }} />
      </div>
      <Field label={t('brightness')}><Slider value={el.brightness ?? 0} min={-100} max={100} onChange={(v) => p({ brightness: v }, 'br')} /></Field>
      <Field label={t('contrast')}><Slider value={el.contrast ?? 0} min={-100} max={100} onChange={(v) => p({ contrast: v }, 'ct')} /></Field>
      <Field label={t('dither')}>
        <MenuButton
          label={t((DITHER_CHOICES.find((d) => d.value === current) ?? DITHER_CHOICES[0]).label)}
          items={DITHER_CHOICES.map((d) => ({ value: d.value, label: t(d.label), hint: d.hint }))}
          onPick={(v) => p({ dither: v as DitherChoice })}
        />
      </Field>
      <Toggle checked={el.lockAspectRatio} onChange={(v) => p({ lockAspectRatio: v })} label={t('lockAspect')} />
    </Section>
  );
}
