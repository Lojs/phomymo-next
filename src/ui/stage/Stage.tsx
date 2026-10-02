import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../state/store';
import { useT } from '../../i18n';
import {
  MIN_SIZES, boundsOf, boundsOfMany, hitTest, rotateElements, scaleElements, type LabelElement, type Point, type Bounds,
} from '../../core/model/elements';
import { PX_PER_MM } from '../../core/render/layout';
import { onImageLoaded } from '../../core/render/images';
import { PAD, paintStage, placed, zoneOrigin } from './paint';
import { HANDLES, groupResize, handlePoint, resizeBox, rotationFromPointer, snapBox, type Guide, type HandleId } from './geometry';
import { InlineTextEditor } from './InlineTextEditor';
import { Icon } from '../icons';

type Gesture =
  | { kind: 'move'; start: Point; origins: Map<string, Point>; moved: boolean; zone: number }
  | { kind: 'resize'; handle: HandleId; start: LabelElement; moved: boolean; zone: number }
  | { kind: 'rotate'; center: Point; moved: boolean; zone: number }
  | { kind: 'gresize'; handle: HandleId; bounds: Bounds; startEls: LabelElement[]; moved: boolean; zone: number }
  | { kind: 'grotate'; center: Point; startAngle: number; startEls: LabelElement[]; moved: boolean; zone: number }
  | { kind: 'pan'; sx: number; sy: number; left: number; top: number; moved: boolean }
  | { kind: 'tapEmpty'; sx: number; sy: number };

export function Stage() {
  const t = useT();
  const elements = useStore((s) => s.elements);
  const selectedIds = useStore((s) => s.selectedIds);
  const multi = useStore((s) => s.multi);
  const labelSize = useStore((s) => s.labelSize);
  const zoom = useStore((s) => s.zoom);
  const fit = useStore((s) => s.fit);
  const activeZone = useStore((s) => s.activeZone);
  const previewOnPaper = useStore((s) => s.previewOnPaper);
  const dirty = useStore((s) => s.dirty);
  const lang = useStore((s) => s.lang);
  const layout = useMemo(() => useStore.getState().layout(), [multi, labelSize]); // eslint-disable-line react-hooks/exhaustive-deps

  const scroller = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const pointers = useRef(new Map<number, Point>());
  const pinch = useRef<{ dist: number; zoom: number } | null>(null);
  const lastTap = useRef({ t: 0, id: '' });
  const [guides, setGuides] = useState<Guide[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  // The cursor shown over the design surface, driven by hit-testing the selection handles.
  const [cursor, setCursor] = useState('default');
  const [imgVersion, setImgVersion] = useState(0);
  const [touch, setTouch] = useState(false);

  useEffect(() => onImageLoaded(() => setImgVersion((v) => v + 1)), []);

  const cssW = (layout.width + PAD * 2) * zoom;
  const cssH = (layout.height + PAD * 2) * zoom;

  // ---- fit to screen ------------------------------------------------------------------
  // The canvas is (layout + 2*PAD) * zoom, so PAD has to be in the divisor: fitting against
  // layout.width alone overshoots by 2*PAD/width (measured on a 40x30mm label in a 414x524
  // stage: it chose 1.10 where 0.60 fits, leaving a 616px canvas in a 414px box — a 202px
  // horizontal scrollbar at the moment you asked it to fit). The 56/96 are the breathing room
  // around the canvas, so they stay outside the division.
  //
  // PAD_FIT is much smaller than PAD: the 120px editing margin exists so elements can hang
  // over the label edge while editing, but at fit time it ate 41% of the viewport on a phone
  // (a 320px-wide label became a 560px canvas). A 40px margin still keeps edge elements
  // reachable while letting the label fill the screen.
  const PAD_FIT = 40;
  const doFit = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const z = Math.min(
      (el.clientWidth - 56) / (layout.width + PAD_FIT * 2),
      (el.clientHeight - 96) / (layout.height + PAD_FIT * 2),
    );
    useStore.getState().setZoom(Math.max(0.25, Math.min(3, Math.floor(z * 20) / 20)), true);
  }, [layout.width, layout.height]);

  useLayoutEffect(() => {
    if (fit) doFit();
  }, [fit, doFit]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => { if (useStore.getState().fit) doFit(); });
    ro.observe(el);
    return () => ro.disconnect();
  }, [doFit]);

  // keep the label centred when zoom changes
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    el.scrollLeft = Math.max(0, (el.scrollWidth - el.clientWidth) / 2);
    el.scrollTop = Math.max(0, (el.scrollHeight - el.clientHeight) / 2);
  }, [zoom, layout.width, layout.height]);

  // ---- painting -----------------------------------------------------------------------------
  // Print preview dithers the *images* only; text and barcodes stay crisp. Replacing the whole
  // label with the 1-bit printer raster (what this used to do) is literally the exact output, but
  // it turned every glyph into dots as soon as you zoomed in — unreadable at the very moment you
  // are inspecting the design. Dithering is the part that can genuinely surprise you on paper
  // (a photo turning to mush), so that is what the toggle shows.

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    c.width = Math.round(cssW * dpr);
    c.height = Math.round(cssH * dpr);
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#60a5fa';
    paintStage({ canvas: c, layout, elements, zoom, dpr, activeZone, ditherImages: previewOnPaper, paper: null, accent, skipId: editingId });
    // fonts may finish loading after first paint
    let cancelled = false;
    void document.fonts.ready.then(() => {
      if (!cancelled) paintStage({ canvas: c, layout, elements, zoom, dpr, activeZone, ditherImages: previewOnPaper, paper: null, accent, skipId: editingId });
    });
    return () => { cancelled = true; };
  }, [layout, elements, zoom, activeZone, cssW, cssH, previewOnPaper, imgVersion, lang, editingId]);

  // ---- selection geometry (canvas space) ----------------------------------------------------------
  const selected = useMemo(() => elements.filter((e) => selectedIds.includes(e.id)), [elements, selectedIds]);
  const selZone = selected[0]?.zone ?? 0;
  const origin = zoneOrigin(layout, selZone);
  const single = selected.length === 1 ? selected[0] : null;
  const groupBounds = selected.length > 1 ? boundsOfMany(selected) : null;

  const toLabel = useCallback((e: { clientX: number; clientY: number }): Point => {
    const r = overlay.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / zoom - PAD, y: (e.clientY - r.top) / zoom - PAD };
  }, [zoom]);

  const handleRadius = (touchLike: boolean) => (touchLike ? 20 : 9) / zoom;

  /** Handle positions in *zone-local* coordinates for the current selection. */
  const handlePoints = useCallback((): { id: HandleId | 'rot'; p: Point }[] => {
    const out: { id: HandleId | 'rot'; p: Point }[] = [];
    if (single) {
      const box = { x: single.x, y: single.y, width: single.width, height: single.height, rotation: single.rotation || 0 };
      for (const h of HANDLES) out.push({ id: h, p: handlePoint(box, h) });
      const c = { x: single.x + single.width / 2, y: single.y + single.height / 2 };
      const off = single.height / 2 + 30 / zoom;
      const a = ((single.rotation || 0) * Math.PI) / 180;
      out.push({ id: 'rot', p: { x: c.x + Math.sin(a) * off, y: c.y - Math.cos(a) * off } });
    } else if (groupBounds) {
      const b = groupBounds;
      const box = { x: b.x, y: b.y, width: b.width, height: b.height, rotation: 0 };
      for (const h of HANDLES) out.push({ id: h, p: handlePoint(box, h) });
      out.push({ id: 'rot', p: { x: b.x + b.width / 2, y: b.y - 30 / zoom } });
    }
    return out;
  }, [single, groupBounds, zoom]);

  // ---- cursor feedback -----------------------------------------------------------------------------
  // The overlay div sits above the SVG annotation layer and swallows every pointer event, so the
  // handle shapes themselves can never be hovered — the overlay has to decide the cursor by
  // hit-testing the very same points the pointerdown handler uses. The angle comes from the box,
  // not the screen axes, so a rotated element still shows the arrow matching the direction the
  // handle will actually travel.
  const cursorRef = useRef('default');
  const setCursorNow = (c: string) => { if (cursorRef.current !== c) { cursorRef.current = c; setCursor(c); } };

  const resizeCursor = (h: HandleId, rotation: number) => {
    const base: Record<HandleId, number> = { e: 0, se: 45, s: 90, sw: 135, w: 180, nw: 225, n: 270, ne: 315 };
    const bucket = Math.round(((((base[h] + rotation) % 360) + 360) % 360) / 45) % 8;
    return ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'][bucket % 4];
  };

  /** Cursor for the handle under this pointer, or 'default' when there is none. */
  const cursorAt = (e: React.PointerEvent): string => {
    if (e.pointerType === 'touch') return 'default';
    const p = toLabel(e);
    for (const h of handlePoints()) {
      if (Math.hypot(h.p.x + origin.x - p.x, h.p.y + origin.y - p.y) > handleRadius(false)) continue;
      return h.id === 'rot' ? 'grab' : resizeCursor(h.id, single ? single.rotation || 0 : 0);
    }
    return 'default';
  };

  // ---- pointer handling ----------------------------------------------------------------------------
  const onPointerDown = (e: React.PointerEvent) => {
    if (editingId) return;
    const isTouch = e.pointerType === 'touch';
    setTouch(isTouch);
    overlay.current!.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const st = useStore.getState();

    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { dist: Math.hypot(a.x - b.x, a.y - b.y), zoom: st.zoom };
      gesture.current = null;
      return;
    }

    const p = toLabel(e);

    // 1. handles of the current selection
    for (const h of handlePoints()) {
      const world = { x: h.p.x + origin.x, y: h.p.y + origin.y };
      if (Math.hypot(world.x - p.x, world.y - p.y) > handleRadius(isTouch)) continue;
      const local = { x: p.x - origin.x, y: p.y - origin.y };
      if (single) {
        gesture.current = h.id === 'rot'
          ? { kind: 'rotate', center: { x: single.x + single.width / 2, y: single.y + single.height / 2 }, moved: false, zone: selZone }
          : { kind: 'resize', handle: h.id, start: { ...single }, moved: false, zone: selZone };
      } else if (groupBounds) {
        gesture.current = h.id === 'rot'
          ? { kind: 'grotate', center: { x: groupBounds.cx, y: groupBounds.cy }, startAngle: Math.atan2(local.y - groupBounds.cy, local.x - groupBounds.cx), startEls: selected.map((s) => ({ ...s })), moved: false, zone: selZone }
          : { kind: 'gresize', handle: h.id, bounds: groupBounds, startEls: selected.map((s) => ({ ...s })), moved: false, zone: selZone };
      }
      return;
    }

    // 2. element under the pointer (topmost first)
    const all = st.elements;
    for (let i = all.length - 1; i >= 0; i--) {
      const el = all[i];
      const o = zoneOrigin(layout, el.zone ?? 0);
      if (!layout.zones?.[el.zone ?? 0] && layout.zones) continue;
      if (!hitTest(p.x - o.x, p.y - o.y, el)) continue;

      if (el.type === 'text' && lastTap.current.id === el.id && Date.now() - lastTap.current.t < 320) {
        // Suppress this pointerdown's default action. A double-click is two mousedowns, and the
        // browser moves focus to the element under the cursor as the *default action* of the
        // second one — which runs after React has already mounted the editor and focused its
        // textarea, stealing focus straight back out and firing the editor's blur. The editor
        // unmounted one millisecond after appearing, so double-click looked like it did nothing.
        // Preventing the pointerdown default stops the compatibility mousedown entirely.
        e.preventDefault();
        setEditingId(el.id);
        lastTap.current = { t: 0, id: '' };
        return;
      }
      lastTap.current = { t: Date.now(), id: el.id };

      if (multi.enabled && (el.zone ?? 0) !== st.activeZone) st.setActiveZone(el.zone ?? 0);
      const already = st.selectedIds.includes(el.id);
      if (e.shiftKey) st.select([el.id], true);
      else if (!already) st.select([el.id]);
      const ids = useStore.getState().selectedIds;
      gesture.current = {
        kind: 'move', start: p, moved: false, zone: el.zone ?? 0,
        origins: new Map(useStore.getState().elements.filter((x) => ids.includes(x.id)).map((x) => [x.id, { x: x.x, y: x.y }])),
      };
      return;
    }

    // 3. empty space
    if (multi.enabled) {
      for (let z = 0; z < (layout.zones?.length ?? 0); z++) {
        const zn = layout.zones![z];
        if (p.x >= zn.x && p.x < zn.x + zn.width && p.y >= zn.y && p.y < zn.y + zn.height && z !== st.activeZone) st.setActiveZone(z);
      }
    }
    gesture.current = isTouch
      ? { kind: 'pan', sx: e.clientX, sy: e.clientY, left: scroller.current!.scrollLeft, top: scroller.current!.scrollTop, moved: false }
      : { kind: 'tapEmpty', sx: e.clientX, sy: e.clientY };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pinch.current && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      useStore.getState().setZoom(Math.round((pinch.current.zoom * d) / pinch.current.dist * 20) / 20);
      return;
    }
    const g = gesture.current;
    if (!g) { setCursorNow(cursorAt(e)); return; }
    const st = useStore.getState();
    const p = toLabel(e);

    if (g.kind === 'pan') {
      setCursorNow('grabbing');
      const dx = e.clientX - g.sx, dy = e.clientY - g.sy;
      if (Math.abs(dx) + Math.abs(dy) > 4) g.moved = true;
      scroller.current!.scrollLeft = g.left - dx;
      scroller.current!.scrollTop = g.top - dy;
      return;
    }
    if (g.kind === 'tapEmpty') return;

    const o = zoneOrigin(layout, g.zone);
    const local = { x: p.x - o.x, y: p.y - o.y };
    const begin = () => { if (!g.moved) { st.checkpoint(); g.moved = true; } };

    if (g.kind === 'move') {
      setCursorNow('grabbing');
      let dx = p.x - g.start.x, dy = p.y - g.start.y;
      if (!g.moved && Math.abs(dx) + Math.abs(dy) < 2) return;
      begin();
      const ids = [...g.origins.keys()];
      const moving = st.elements.filter((x) => ids.includes(x.id)).map((x) => ({ ...x, x: g.origins.get(x.id)!.x + dx, y: g.origins.get(x.id)!.y + dy }));
      const mb = boundsOfMany(moving);
      if (mb && !e.altKey) {
        const targets = st.elements.filter((x) => !ids.includes(x.id) && (x.zone ?? 0) === g.zone).map(boundsOf);
        const snap = snapBox(mb, targets, { width: layout.labelWidth, height: layout.labelHeight }, 5 / Math.max(zoom, 0.5));
        dx += snap.dx; dy += snap.dy;
        setGuides(snap.guides);
      } else setGuides([]);
      st.patch(ids, (el) => ({ x: g.origins.get(el.id)!.x + dx, y: g.origins.get(el.id)!.y + dy }));
      return;
    }

    if (g.kind === 'resize') {
      begin();
      const s = g.start;
      const world = resizeBox(
        { x: s.x, y: s.y, width: s.width, height: s.height, rotation: s.rotation || 0 },
        g.handle, local,
        {
          keepAspect: s.type === 'qr' || (s.type === 'image' && s.lockAspectRatio) || e.shiftKey,
          minWidth: MIN_SIZES[s.type].width, minHeight: MIN_SIZES[s.type].height,
        },
      );
      st.patch([s.id], { x: world.x, y: world.y, width: world.width, height: world.height });
      return;
    }

    if (g.kind === 'rotate' && single) {
      begin();
      st.patch([single.id], { rotation: Math.round(rotationFromPointer(g.center, local, e.shiftKey)) % 360 });
      return;
    }

    if (g.kind === 'gresize') {
      begin();
      const { sx, sy, anchor } = groupResize(g.bounds, g.handle, local, e.shiftKey);
      const ids = g.startEls.map((x) => x.id);
      const scaled = scaleElements(g.startEls, ids, sx, sy, anchor);
      st.patch(ids, (el) => { const n = scaled.find((x) => x.id === el.id)!; return { x: n.x, y: n.y, width: n.width, height: n.height }; });
      return;
    }

    if (g.kind === 'grotate') {
      begin();
      let delta = ((Math.atan2(local.y - g.center.y, local.x - g.center.x) - g.startAngle) * 180) / Math.PI;
      if (e.shiftKey) delta = Math.round(delta / 15) * 15;
      const ids = g.startEls.map((x) => x.id);
      const rotated = rotateElements(g.startEls, ids, delta, g.center);
      st.patch(ids, (el) => { const n = rotated.find((x) => x.id === el.id)!; return { x: n.x, y: n.y, rotation: n.rotation }; });
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    setCursorNow(cursorAt(e));
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    const g = gesture.current;
    if (g?.kind === 'tapEmpty' && Math.hypot(e.clientX - g.sx, e.clientY - g.sy) < 5) useStore.getState().select([]);
    if (g?.kind === 'pan' && !g.moved) useStore.getState().select([]);
    gesture.current = null;
    setGuides([]);
  };

  // ctrl/⌘ + wheel zooms
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const st = useStore.getState();
      st.setZoom(Math.round((st.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1)) * 20) / 20);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // ---- overlay drawing (screen space) ------------------------------------------------------------------
  const S = (v: number) => (v + PAD) * zoom;
  const editing = editingId ? elements.find((x) => x.id === editingId) : null;
  const placedSel = placed(selected, layout);
  const mmW = Math.round((layout.width / PX_PER_MM) * 10) / 10;
  const mmH = Math.round((layout.height / PX_PER_MM) * 10) / 10;
  const annotate = zoom >= 0.4;

  const outline = (el: LabelElement) => {
    const pts = boundsAndCorners(el);
    return pts.map((p) => `${S(p.x)},${S(p.y)}`).join(' ');
  };

  return (
    <>
      <div className="stage" ref={scroller} dir="ltr">
        <div className="stage-canvas" style={{ width: cssW, height: cssH }}>
          <canvas ref={canvas} style={{ width: cssW, height: cssH }} aria-label={t('label')} />

          <svg className="stage-annot" width={cssW} height={cssH} aria-hidden="true">
            {annotate && (
              <g className="dim">
                <line x1={S(0)} x2={S(layout.width)} y1={S(-18 / zoom * 1.0)} y2={S(-18 / zoom * 1.0)} />
                <line x1={S(0)} x2={S(0)} y1={S(-24 / zoom)} y2={S(-12 / zoom)} />
                <line x1={S(layout.width)} x2={S(layout.width)} y1={S(-24 / zoom)} y2={S(-12 / zoom)} />
                <text x={S(layout.width / 2)} y={S(-24 / zoom) - 5} textAnchor="middle">{mmW} {t('mm')}</text>
                <line x1={S(-18 / zoom)} x2={S(-18 / zoom)} y1={S(0)} y2={S(layout.height)} />
                <line x1={S(-24 / zoom)} x2={S(-12 / zoom)} y1={S(0)} y2={S(0)} />
                <line x1={S(-24 / zoom)} x2={S(-12 / zoom)} y1={S(layout.height)} y2={S(layout.height)} />
                <text transform={`translate(${S(-24 / zoom) - 5} ${S(layout.height / 2)}) rotate(-90)`} textAnchor="middle">{mmH} {t('mm')}</text>
              </g>
            )}

            {layout.zones && layout.zones.map((z, i) => (
              <text key={i} className="zone-tag" x={S(z.x + z.width / 2)} y={S(layout.height) + 18} textAnchor="middle">{i + 1}</text>
            ))}

            {guides.map((g, i) => g.axis === 'x'
              ? <line key={i} className="guide" x1={S(g.pos + origin.x)} x2={S(g.pos + origin.x)} y1={S(-PAD / 2)} y2={S(layout.height + PAD / 2)} />
              : <line key={i} className="guide" y1={S(g.pos + origin.y)} y2={S(g.pos + origin.y)} x1={S(-PAD / 2)} x2={S(layout.width + PAD / 2)} />)}

            {!previewOnPaper && placedSel.map((el) => <polygon key={el.id} className="sel-outline" points={outline(el)} />)}
            {!previewOnPaper && groupBounds && (
              <rect className="sel-outline sel-group" x={S(groupBounds.x + origin.x)} y={S(groupBounds.y + origin.y)} width={groupBounds.width * zoom} height={groupBounds.height * zoom} />
            )}

            {!previewOnPaper && !editing && handlePoints().map((h) => {
              const x = S(h.p.x + origin.x), y = S(h.p.y + origin.y);
              if (h.id === 'rot') {
                const top = single ? handlePoint({ x: single.x, y: single.y, width: single.width, height: single.height, rotation: single.rotation || 0 }, 'n') : { x: groupBounds!.x + groupBounds!.width / 2, y: groupBounds!.y };
                return (
                  <g key="rot">
                    <line className="rot-stem" x1={S(top.x + origin.x)} y1={S(top.y + origin.y)} x2={x} y2={y} />
                    <circle className="handle handle-rot" cx={x} cy={y} r={touch ? 10 : 6.5} />
                  </g>
                );
              }
              const r = touch ? 8 : 5;
              return <rect key={h.id} className="handle" x={x - r} y={y - r} width={r * 2} height={r * 2} rx={2} />;
            })}
          </svg>

          <div className="stage-hit" ref={overlay} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} onPointerLeave={() => setCursorNow('default')} style={{ width: cssW, height: cssH, cursor }} />

          {editing && editing.type === 'text' && (
            <InlineTextEditor el={editing} origin={origin} zoom={zoom} pad={PAD} onDone={() => setEditingId(null)} />
          )}
        </div>
      </div>

      {/* A sibling of the scroller, not a child of it. `.stage` scrolls, so an absolutely
          positioned child of it is placed against its scrollable content and slides upward out
          of the corner as soon as you scroll the canvas — which is how the pill ended up parked
          over the middle of the label. Anchored to .app-stage, which never scrolls, it stays in
          the visible corner at every scroll position. */}
      <div className="zoom-bar" role="group" aria-label="Zoom">
        {/* The stepped +/- buttons are hidden by CSS on touch-sized viewports: they are the
            controls that end up parked over the label while you design, and pinch-to-zoom
            already covers the gesture. The readout (tap = 100%) and Fit stay. */}
        <button type="button" className="zoom-step" onClick={() => useStore.getState().setZoom(zoom - 0.25)} aria-label={t('zoomOut')} title={t('zoomOut')}><Icon name="minus" size={16} /></button>
        <button type="button" className="zoom-val" onClick={() => useStore.getState().setZoom(1)} title="100%">{Math.round(zoom * 100)}%</button>
        <button type="button" className="zoom-step" onClick={() => useStore.getState().setZoom(zoom + 0.25)} aria-label={t('zoomIn')} title={t('zoomIn')}><Icon name="plus" size={16} /></button>
        <button type="button" onClick={() => useStore.getState().setZoom(zoom, true)} aria-label={t('zoomFit')} title={t('zoomFit')}><Icon name="fit" size={16} /></button>
      </div>
      <span hidden>{dirty ? '' : ''}</span>
    </>
  );
}

function boundsAndCorners(el: LabelElement): Point[] {
  const c = { x: el.x + el.width / 2, y: el.y + el.height / 2 };
  const a = ((el.rotation || 0) * Math.PI) / 180;
  const cos = Math.cos(a), sin = Math.sin(a);
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => {
    const dx = (sx * el.width) / 2, dy = (sy * el.height) / 2;
    return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos };
  });
}
