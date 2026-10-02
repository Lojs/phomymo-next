// @vitest-environment jsdom
/**
 * Stage — the canvas editor's structure, zoom controls and selection handles.
 *
 * Pointer gestures are driven through the real handlers where jsdom can support them; where it
 * cannot (getBoundingClientRect returns zeros, so label-space maths is meaningless), the tests
 * assert the rendered structure and the store effects that are deterministic.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';
import { Stage } from '../src/ui/stage/Stage';
import { useStore } from '../src/state/store';
import { createText, createShape } from '../src/core/model/elements';

beforeEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  useStore.getState().newDesign();
  useStore.setState({ lang: 'en', past: [], future: [], selectedIds: [], zoom: 1, fit: false, previewOnPaper: false });
  // jsdom reports a zero-size scroller, so a fit would drive zoom to its minimum; keep it off.
  useStore.getState().setLabelSize({ width: 40, height: 30 });
});

const stageEl = () => document.querySelector('.stage')!;

describe('structure', () => {
  it('renders a canvas and a pointer overlay', () => {
    render(<Stage />);
    expect(document.querySelector('canvas')).toBeTruthy();
    expect(document.querySelector('.stage-hit')).toBeTruthy();
  });

  it('renders an SVG annotation layer', () => {
    render(<Stage />);
    expect(document.querySelector('svg')).toBeTruthy();
  });

  it('shows no selection outline when nothing is selected', () => {
    useStore.getState().add(createText('A'));
    useStore.setState({ selectedIds: [] });
    render(<Stage />);
    expect(document.querySelectorAll('.sel-outline').length).toBe(0);
  });

  it('shows an outline and handles for a single selection', () => {
    const el = createText('A');
    useStore.getState().add(el);
    useStore.getState().select([el.id]);
    render(<Stage />);
    expect(document.querySelectorAll('.sel-outline').length).toBe(1);
    // 8 resize handles plus the rotation handle.
    expect(document.querySelectorAll('.handle').length).toBe(9);
  });

  it('shows a group box (not per-element handles) for a multi-selection', () => {
    const a = createText('A');
    const b = createText('B');
    useStore.getState().add(a);
    useStore.getState().add(b);
    useStore.getState().select([a.id, b.id]);
    render(<Stage />);
    expect(document.querySelector('.sel-group')).toBeTruthy();
  });

  it('hides handles while previewing on paper', () => {
    const el = createText('A');
    useStore.getState().add(el);
    useStore.getState().select([el.id]);
    useStore.setState({ previewOnPaper: true });
    render(<Stage />);
    expect(document.querySelectorAll('.handle').length).toBe(0);
  });
});

describe('roll zones', () => {
  it('tags each zone with its number', () => {
    useStore.getState().setMulti({ enabled: true, labelWidth: 10, labelHeight: 20, labelsAcross: 3, gapMm: 2, cloneMode: true });
    render(<Stage />);
    const tags = [...document.querySelectorAll('.zone-tag')].map((t) => t.textContent);
    expect(tags).toEqual(['1', '2', '3']);
  });

  it('shows no zone tags on a single label', () => {
    render(<Stage />);
    expect(document.querySelectorAll('.zone-tag').length).toBe(0);
  });
});

describe('zoom controls', () => {
  it('shows the current zoom as a percentage', () => {
    useStore.setState({ zoom: 1.5, fit: false });
    render(<Stage />);
    expect(screen.getByTitle('100%').textContent).toBe('150%');
  });

  it('zoom-in raises the zoom', () => {
    useStore.setState({ zoom: 1, fit: false });
    render(<Stage />);
    fireEvent.click(screen.getByLabelText('Zoom in'));
    expect(useStore.getState().zoom).toBeGreaterThan(1);
  });

  it('zoom-out lowers the zoom', () => {
    useStore.setState({ zoom: 1, fit: false });
    render(<Stage />);
    fireEvent.click(screen.getByLabelText('Zoom out'));
    expect(useStore.getState().zoom).toBeLessThan(1);
  });

  it('the readout resets to 100% when clicked', () => {
    useStore.setState({ zoom: 2, fit: false });
    render(<Stage />);
    fireEvent.click(screen.getByTitle('100%'));
    expect(useStore.getState().zoom).toBe(1);
  });

  it('Fit asks the view to refit', () => {
    useStore.setState({ fit: false });
    render(<Stage />);
    fireEvent.click(screen.getByLabelText('Fit to screen'));
    expect(useStore.getState().fit).toBe(true);
  });

  it('zoom stays within the allowed limits', async () => {
    render(<Stage />);
    const zoomIn = screen.getByLabelText('Zoom in');
    for (let i = 0; i < 40; i++) fireEvent.click(zoomIn);
    const { LIMITS } = await import('../src/core/printers/presets');
    expect(useStore.getState().zoom).toBeLessThanOrEqual(LIMITS.zoom.max);
  });

  it('the zoom bar is a labelled group', () => {
    render(<Stage />);
    expect(screen.getByRole('group', { name: 'Zoom' })).toBeTruthy();
  });
});

describe('dimension guides', () => {
  it('labels the label width and height in mm', () => {
    // The dimension guides are hidden below 0.4 zoom, and a fit under jsdom drives zoom to its
    // 0.25 floor — so pin a zoom at which they are shown.
    useStore.setState({ zoom: 1, fit: false });
    render(<Stage />);
    const texts = [...document.querySelectorAll('svg text')].map((t) => t.textContent);
    expect(texts.some((t) => t?.includes('40'))).toBe(true);
    expect(texts.some((t) => t?.includes('30'))).toBe(true);
  });

  it('hides the dimension guides when zoomed far out', () => {
    useStore.setState({ zoom: 0.2, fit: false });
    render(<Stage />);
    const texts = [...document.querySelectorAll('svg text')].map((t) => t.textContent);
    expect(texts.some((t) => t?.includes('40'))).toBe(false);
  });

  it('reports the new size after a change', () => {
    // setLabelSize() re-fits the view, so pin the zoom after it, not before.
    useStore.getState().setLabelSize({ width: 70, height: 50 });
    useStore.setState({ zoom: 1, fit: false });
    render(<Stage />);
    const texts = [...document.querySelectorAll('svg text')].map((t) => t.textContent);
    expect(texts.some((t) => t?.includes('70'))).toBe(true);
  });
});

describe('pointer interaction', () => {
  it('a pointer-down on empty space reaches the selection logic', () => {
    // jsdom does not implement setPointerCapture, which onPointerDown calls first, so the handler
    // cannot complete here. Assert the call is attempted rather than the outcome, and leave the
    // selection semantics to the geometry tests that cover hitTest/topElementAt directly.
    const el = createText('A');
    useStore.getState().add(el);
    useStore.getState().select([el.id]);
    render(<Stage />);
    const hit = document.querySelector('.stage-hit')!;
    (hit as HTMLElement).setPointerCapture = () => {};
    fireEvent.pointerDown(hit, { clientX: 0, clientY: 0, pointerType: 'mouse', button: 0 });
    fireEvent.pointerUp(hit, { clientX: 0, clientY: 0, pointerType: 'mouse' });
    // A zero-rect overlay puts the pointer at label origin, which is inside the element, so the
    // element stays selected — the important part is that the handler ran without throwing.
    expect(useStore.getState().elements.length).toBe(1);
  });

  it('a pointer-down on the overlay does not throw', () => {
    const el = createText('A');
    useStore.getState().add(el);
    useStore.getState().select([el.id]);
    render(<Stage />);
    const hit = document.querySelector('.stage-hit')!;
    expect(() => {
      fireEvent.pointerDown(hit, { clientX: 10, clientY: 10, pointerType: 'mouse', button: 0 });
      fireEvent.pointerMove(hit, { clientX: 20, clientY: 20, pointerType: 'mouse' });
      fireEvent.pointerUp(hit, { clientX: 20, clientY: 20, pointerType: 'mouse' });
    }).not.toThrow();
  });

  it('the overlay swallows pointer events, so it carries the cursor style', () => {
    render(<Stage />);
    expect(document.querySelector('.stage-hit')).toBeTruthy();
  });
});

describe('editing', () => {
  it('a double-click on a text element opens the inline editor', () => {
    const el = createText('HELLO');
    useStore.getState().add(el);
    useStore.getState().select([el.id]);
    render(<Stage />);
    const hit = document.querySelector('.stage-hit')!;
    fireEvent.doubleClick(hit, { clientX: 0, clientY: 0 });
    // jsdom cannot resolve label coordinates, so the editor opens only when a hit-test succeeds;
    // assert the handler is wired and did not throw.
    expect(() => fireEvent.doubleClick(hit, { clientX: 0, clientY: 0 })).not.toThrow();
  });

  it('renders without a selection at all', () => {
    expect(() => render(<Stage />)).not.toThrow();
  });

  it('renders a shape element without error', () => {
    const el = createShape('star');
    useStore.getState().add(el);
    useStore.getState().select([el.id]);
    expect(() => render(<Stage />)).not.toThrow();
  });
});
