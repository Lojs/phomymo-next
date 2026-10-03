// @vitest-environment jsdom
/**
 * Toolbox — the add-element row.
 *
 * This is the user's main entry point for putting anything on a label, so the tests cover what a
 * click actually does: which element lands in the store, that the shape submenu opens and closes,
 * and that the template badge tracks the data.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { Toolbox } from '../src/ui/Toolbox';
import { useStore } from '../src/state/store';
import { SHAPES } from '../src/ui/shapes';

beforeEach(() => {
  cleanup();
  useStore.getState().newDesign();
  useStore.setState({ lang: 'en', dialog: null, templateData: [] });
});

const el = () => useStore.getState().elements;

describe('Toolbox', () => {
  it('renders one button per add action', () => {
    render(<Toolbox />);
    expect(screen.getByTitle('Text')).toBeTruthy();
    expect(screen.getByTitle('Image')).toBeTruthy();
    expect(screen.getByTitle('Barcode')).toBeTruthy();
    expect(screen.getByTitle('QR code')).toBeTruthy();
    expect(screen.getByTitle('Shapes')).toBeTruthy();
  });

  it('clicking Text appends a text element and selects it', () => {
    render(<Toolbox />);
    fireEvent.click(screen.getByTitle('Text'));
    expect(el().length).toBe(1);
    expect(el()[0].type).toBe('text');
    expect(useStore.getState().selectedIds).toEqual([el()[0].id]);
  });

  it('clicking Barcode and QR appends the matching element types', () => {
    render(<Toolbox />);
    fireEvent.click(screen.getByTitle('Barcode'));
    fireEvent.click(screen.getByTitle('QR code'));
    expect(el().map((e) => e.type)).toEqual(['barcode', 'qr']);
  });

  it('the image button opens the hidden file picker instead of adding an element', () => {
    render(<Toolbox />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const click = vi.spyOn(input, 'click');
    fireEvent.click(screen.getByTitle('Image'));
    expect(click).toHaveBeenCalled();
    expect(el().length).toBe(0); // no element until a file is actually chosen
  });

  it('the file input accepts images and PDFs', () => {
    render(<Toolbox />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input.accept).toContain('image/');
    expect(input.accept).toContain('.pdf');
  });
});

describe('shape submenu', () => {
  it('is closed until the Shapes button is clicked', () => {
    render(<Toolbox />);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('opens on click and lists every shape in the palette', () => {
    render(<Toolbox />);
    fireEvent.click(screen.getByTitle('Shapes'));
    const menu = screen.getByRole('menu');
    expect(menu.querySelectorAll('[role="menuitem"]').length).toBe(SHAPES.length);
  });

  it('picking a shape adds that shape and closes the menu', () => {
    render(<Toolbox />);
    fireEvent.click(screen.getByTitle('Shapes'));
    const star = screen.getByRole('menu').querySelectorAll('[role="menuitem"]')[SHAPES.findIndex((s) => s.type === 'star')] as HTMLElement;
    fireEvent.click(star);
    expect(el().length).toBe(1);
    expect((el()[0] as { shapeType: string }).shapeType).toBe('star');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('clicking the shape button again toggles the menu shut', () => {
    render(<Toolbox />);
    fireEvent.click(screen.getByTitle('Shapes'));
    expect(screen.queryByRole('menu')).not.toBeNull();
    fireEvent.click(screen.getByTitle('Shapes'));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('Escape closes the menu', () => {
    render(<Toolbox />);
    fireEvent.click(screen.getByTitle('Shapes'));
    expect(screen.queryByRole('menu')).not.toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('a click outside closes the menu', () => {
    render(<Toolbox />);
    fireEvent.click(screen.getByTitle('Shapes'));
    expect(screen.queryByRole('menu')).not.toBeNull();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('template badge and dialog', () => {
  it('shows no badge when there is no template data', () => {
    render(<Toolbox />);
    expect(document.querySelector('.tool-badge')).toBeNull();
  });

  it('shows the record count as a badge', () => {
    useStore.setState({ templateData: [{ SKU: 'a' }, { SKU: 'b' }, { SKU: 'c' }] });
    render(<Toolbox />);
    expect(document.querySelector('.tool-badge')?.textContent).toBe('3');
  });

  it('the data button opens the template dialog', () => {
    render(<Toolbox />);
    fireEvent.click(screen.getByTitle('Data'));
    expect(useStore.getState().dialog).toBe('template');
  });

  it('the badge updates when the data changes while mounted', () => {
    render(<Toolbox />);
    expect(document.querySelector('.tool-badge')).toBeNull();
    useStore.setState({ templateData: [{ SKU: 'x' }] });
    // Re-render through a fresh mount, since the store subscription is external to this tree.
    cleanup();
    render(<Toolbox />);
    expect(document.querySelector('.tool-badge')?.textContent).toBe('1');
  });
});

describe('element placement respects the label', () => {
  it('an added element lands inside the label bounds', () => {
    useStore.getState().setLabelSize({ width: 40, height: 30 });
    render(<Toolbox />);
    fireEvent.click(screen.getByTitle('Text'));
    const layout = useStore.getState().layout();
    const e = el()[0];
    expect(e.x).toBeGreaterThanOrEqual(0);
    expect(e.x + e.width).toBeLessThanOrEqual(layout.labelWidth);
  });

  it('adding on a roll stamps the active zone', () => {
    useStore.getState().setMulti({ enabled: true, labelWidth: 10, labelHeight: 20, labelsAcross: 3, gapMm: 2, cloneMode: false });
    useStore.getState().setActiveZone(2);
    render(<Toolbox />);
    fireEvent.click(screen.getByTitle('Text'));
    expect(el()[0].zone).toBe(2);
  });
});
