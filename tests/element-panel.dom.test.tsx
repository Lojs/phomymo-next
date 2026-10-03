// @vitest-environment jsdom
/**
 * ElementPanel — the inspector for the current selection.
 *
 * This is where an element is actually configured: geometry, z-order, grouping, and the
 * per-type controls. The tests drive it through the real store and assert on the resulting state,
 * since that is what ends up on the label.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ElementPanel } from '../src/ui/ElementPanel';
import { useStore } from '../src/state/store';
import { createText, createBarcode, createQR, createShape, createImage } from '../src/core/model/elements';

beforeEach(() => {
  cleanup();
  useStore.getState().newDesign();
  useStore.setState({ lang: 'en', past: [], future: [], selectedIds: [] });
});

/** Put one element in the store and select it. */
function withElement(el: ReturnType<typeof createText> | ReturnType<typeof createBarcode> | ReturnType<typeof createQR> | ReturnType<typeof createShape> | ReturnType<typeof createImage>) {
  useStore.getState().add(el);
  useStore.getState().select([el.id]);
  return el;
}

const sel = () => useStore.getState().selected()[0];

describe('visibility', () => {
  it('renders nothing with no selection', () => {
    const { container } = render(<ElementPanel />);
    expect(container.firstChild).toBeNull();
  });

  it('renders sections once an element is selected', () => {
    withElement(createText('A'));
    render(<ElementPanel />);
    expect(screen.getByText('Position')).toBeTruthy();
    expect(screen.getByText('Arrange')).toBeTruthy();
  });

  it('shows a multi-selection note and hides the single-element controls', () => {
    const a = createText('A');
    const b = createText('B');
    useStore.getState().add(a);
    useStore.getState().add(b);
    useStore.getState().select([a.id, b.id]);
    render(<ElementPanel />);
    expect(screen.getByText(/2/)).toBeTruthy();
    expect(screen.queryByText('Position')).toBeNull(); // geometry is per-element
    expect(screen.getByText('Group')).toBeTruthy();   // but grouping is offered
  });
});

describe('geometry', () => {
  it('committing X moves the element', () => {
    withElement(createText('A', { x: 10, y: 20 }));
    render(<ElementPanel />);
    const x = screen.getByDisplayValue('10');
    fireEvent.focus(x);
    fireEvent.change(x, { target: { value: '55' } });
    fireEvent.keyDown(x, { key: 'Enter' });
    expect(sel().x).toBe(55);
  });

  it('clamps width to the element type minimum', () => {
    withElement(createText('A', { width: 100 }));
    render(<ElementPanel />);
    const w = screen.getByDisplayValue('100');
    fireEvent.focus(w);
    fireEvent.change(w, { target: { value: '1' } }); // below the text minimum of 50
    fireEvent.keyDown(w, { key: 'Enter' });
    expect(sel().width).toBeGreaterThanOrEqual(50);
  });

  it('rotation is applied', () => {
    const el = withElement(createText('A'));
    render(<ElementPanel />);
    // A text element renders TWO sliders (font size, then rotation), so pick the rotation one by
    // its 0–359 range rather than by position. Type into its paired number input, which is the
    // deterministic path in jsdom.
    const rotRange = [...document.querySelectorAll('input[type="range"]')]
      .find((r) => (r as HTMLInputElement).max === '359') as HTMLInputElement;
    const rot = rotRange.parentElement!.querySelector('input[type="text"]') as HTMLInputElement;
    fireEvent.focus(rot);
    fireEvent.change(rot, { target: { value: '45' } });
    fireEvent.keyDown(rot, { key: 'Enter' });
    expect(Math.round(useStore.getState().elements.find((e) => e.id === el.id)!.rotation)).toBe(45);
  });

  it('a geometry edit is undoable', () => {
    const el = withElement(createText('A', { x: 10 }));
    render(<ElementPanel />);
    const x = screen.getByDisplayValue('10');
    fireEvent.focus(x);
    fireEvent.change(x, { target: { value: '90' } });
    fireEvent.keyDown(x, { key: 'Enter' });
    expect(useStore.getState().elements.find((e) => e.id === el.id)!.x).toBe(90);

    // undo() clears the selection by design, so look the element up by id afterwards.
    useStore.getState().undo();
    expect(useStore.getState().elements.find((e) => e.id === el.id)!.x).toBe(10);
  });
});

describe('arrange', () => {
  it('bring to front reorders the element to the end of the list', () => {
    const a = createText('A');
    const b = createText('B');
    useStore.getState().add(a);
    useStore.getState().add(b);
    useStore.getState().select([a.id]);
    render(<ElementPanel />);
    fireEvent.click(screen.getByLabelText('Bring to front'));
    expect(useStore.getState().elements.at(-1)!.id).toBe(a.id);
  });

  it('send to back moves it to the start', () => {
    const a = createText('A');
    const b = createText('B');
    useStore.getState().add(a);
    useStore.getState().add(b);
    useStore.getState().select([b.id]);
    render(<ElementPanel />);
    fireEvent.click(screen.getByLabelText('Send to back'));
    expect(useStore.getState().elements[0].id).toBe(b.id);
  });

  it('duplicate adds a copy and selects it', () => {
    const el = withElement(createText('A'));
    render(<ElementPanel />);
    fireEvent.click(screen.getByText('Duplicate'));
    expect(useStore.getState().elements.length).toBe(2);
    expect(sel().id).not.toBe(el.id);
  });

  it('remove deletes the selection', () => {
    withElement(createText('A'));
    render(<ElementPanel />);
    fireEvent.click(screen.getByText('Delete'));
    expect(useStore.getState().elements.length).toBe(0);
  });

  it('group appears only for a multi-selection, and groups', () => {
    const a = createText('A');
    const b = createText('B');
    useStore.getState().add(a);
    useStore.getState().add(b);
    useStore.getState().select([a.id]);
    render(<ElementPanel />);
    expect(screen.queryByText('Group')).toBeNull();
    cleanup();

    useStore.getState().select([a.id, b.id]);
    render(<ElementPanel />);
    fireEvent.click(screen.getByText('Group'));
    expect(useStore.getState().elements[0].groupId).toBeTruthy();
  });

  it('ungroup appears for a grouped selection and ungroups', () => {
    const a = createText('A');
    const b = createText('B');
    useStore.getState().add(a);
    useStore.getState().add(b);
    useStore.getState().select([a.id, b.id]);
    useStore.getState().group();
    render(<ElementPanel />);
    fireEvent.click(screen.getByText('Ungroup'));
    expect(useStore.getState().elements.every((e) => !e.groupId)).toBe(true);
  });
});

describe('per-type controls', () => {
  it('a text element exposes its content', () => {
    withElement(createText('HELLO'));
    render(<ElementPanel />);
    expect(screen.getByDisplayValue('HELLO')).toBeTruthy();
  });

  it('editing the text updates the element', () => {
    withElement(createText('HELLO'));
    render(<ElementPanel />);
    const ta = screen.getByDisplayValue('HELLO');
    fireEvent.change(ta, { target: { value: 'CHANGED' } });
    expect((sel() as { text: string }).text).toBe('CHANGED');
  });

  it('a barcode element exposes its data and format', () => {
    withElement(createBarcode('123456789012'));
    render(<ElementPanel />);
    expect(screen.getByDisplayValue('123456789012')).toBeTruthy();
  });

  it('a QR element exposes its data', () => {
    withElement(createQR('https://example.com'));
    render(<ElementPanel />);
    expect(screen.getByDisplayValue('https://example.com')).toBeTruthy();
  });

  it('a shape element exposes its shape type', () => {
    withElement(createShape('star'));
    render(<ElementPanel />);
    // The closed chooser shows the current shape.
    expect(screen.getAllByText('Star').length).toBeGreaterThan(0);
  });

  it('switching shape type updates the element', () => {
    withElement(createShape('rectangle'));
    render(<ElementPanel />);
    // The chooser is a dropdown: open it, then click the option.
    fireEvent.click(screen.getByText('Rectangle').closest('button')!);
    fireEvent.click(screen.getAllByText('Heart')[0].closest('button')!);
    expect((sel() as { shapeType: string }).shapeType).toBe('heart');
  });

  it('a stroked shape hides the fill control, since fill is never painted', () => {
    withElement(createShape('line'));
    render(<ElementPanel />);
    expect(screen.queryByText('Fill')).toBeNull();
  });

  it('a filled shape does expose the fill control', () => {
    withElement(createShape('rectangle'));
    render(<ElementPanel />);
    expect(screen.getByText('Fill')).toBeTruthy();
  });
});
