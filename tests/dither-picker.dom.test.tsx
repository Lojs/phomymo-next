// @vitest-environment jsdom
/**
 * The dithering picker on an image element.
 *
 * Choosing how a photograph is turned into 1-bit dots used to mean reading four algorithm names
 * ("Ordered (Bayer)", "Floyd–Steinberg") and guessing which one suited a photo. The picker now
 * names each choice for what it does and keeps the algorithm name as a hint beside it.
 *
 * It is deliberately **text only**: an earlier version put a dithered thumbnail of the image on
 * every row, and the user asked for that to be removed. The test that pins this is "is text only".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { ElementPanel } from '../src/ui/ElementPanel';
import { MenuButton } from '../src/ui/kit';
import { useStore } from '../src/state/store';
import { createImage } from '../src/core/model/elements';

beforeEach(() => {
  cleanup();
  useStore.getState().newDesign();
  useStore.setState({ lang: 'en', past: [], future: [], selectedIds: [] });
});

afterEach(() => vi.restoreAllMocks());

/** Put one image in the store and select it. */
function withImage(dither?: 'none' | 'ordered' | 'atkinson' | 'floyd-steinberg') {
  const el = createImage('data:image/png;base64,AAAA', dither ? { dither } : {});
  useStore.getState().add(el);
  useStore.getState().select([el.id]);
  return el;
}

const pickerButton = () =>
  screen.getByRole('button', { name: /Grayscale 256|Standard|Light dots|Black & white|تدرّج|قياسي|نقاط|أبيض/ });
const openPicker = () => fireEvent.click(pickerButton());

describe('the picker offers plain-language choices', () => {
  it('lists all four, each with the algorithm name beside it', () => {
    withImage();
    render(<ElementPanel />);
    openPicker();
    expect(screen.getByRole('menuitem', { name: /Grayscale 256/ })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: /Standard/ })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: /Light dots/ })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: /Black & white/ })).toBeTruthy();
  });

  it('keeps the algorithm name so nothing is lost by renaming', () => {
    withImage();
    render(<ElementPanel />);
    openPicker();
    // the hints are algorithm names, so they stay in Latin script in both languages
    expect(screen.getByRole('menuitem', { name: /Floyd–Steinberg/ })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: /Bayer/ })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: /Atkinson/ })).toBeTruthy();
  });

  it('puts the one meant for a photograph first', () => {
    withImage();
    render(<ElementPanel />);
    openPicker();
    expect(screen.getAllByRole('menuitem')[0].textContent).toContain('Grayscale 256');
  });

  it('is text only — no picture on any row', () => {
    // The user asked for the previews to go, so the menu must carry text and nothing else.
    withImage();
    const { container } = render(<ElementPanel />);
    openPicker();
    expect(container.querySelectorAll('.menu [role="menuitem"] img')).toHaveLength(0);
    expect(container.querySelectorAll('.menu-thumb, .menu-thumb-blank')).toHaveLength(0);
  });
});

describe('the trigger reports what will print', () => {
  it('names the tonal choice when the element has not chosen', () => {
    // The element carries no dither, and 'auto' resolves to Floyd–Steinberg for a photo, so the
    // button must say Grayscale 256 — showing "None" here would be a lie about the output.
    withImage();
    render(<ElementPanel />);
    expect(pickerButton().textContent).toContain('Grayscale 256');
  });

  it('follows the element once it has chosen', () => {
    withImage('ordered');
    render(<ElementPanel />);
    expect(pickerButton().textContent).toContain('Standard');
  });
});

describe('picking a choice reaches the element', () => {
  it('writes the mode the user picked', () => {
    const el = withImage();
    render(<ElementPanel />);
    openPicker();
    fireEvent.click(screen.getByRole('menuitem', { name: /Black & white/ }));
    const saved = useStore.getState().elements.find((e) => e.id === el.id) as { dither?: string };
    expect(saved.dither).toBe('none');
  });

  it('writes the tonal mode too', () => {
    const el = withImage('none');
    render(<ElementPanel />);
    openPicker();
    fireEvent.click(screen.getByRole('menuitem', { name: /Grayscale 256/ }));
    const saved = useStore.getState().elements.find((e) => e.id === el.id) as { dither?: string };
    expect(saved.dither).toBe('floyd-steinberg');
  });
});

describe('the menu stays reachable in a short window', () => {
  /** Drive the geometry by hand: jsdom reports every rect as zero, so nothing would ever flip. */
  function stubRects(triggerTop: number) {
    // jsdom's window is 768px tall; the trigger position alone decides whether the menu fits.
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const isMenu = this.classList?.contains('menu') ?? false;
      const top = isMenu ? triggerTop + 36 : triggerTop;
      const height = isMenu ? 210 : 30;
      return { top, bottom: top + height, height, left: 0, right: 200, width: 200, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
    });
  }

  it('opens upward when it would fall off the bottom', async () => {
    // Measured for real: with the trigger at y=403 in a 577px window the menu ended at 613 and its
    // last option could not be clicked at all. A native <select> is repositioned by the browser;
    // this popup has to reposition itself.
    stubRects(700);          // 700 + 36 + 210 = 946, past the 768px window
    withImage();
    const { container } = render(<ElementPanel />);
    openPicker();
    await waitFor(() => expect(container.querySelector('.menu')?.classList.contains('menu-up')).toBe(true));
  });

  it('opens downward when there is room', async () => {
    stubRects(40);           // 40 + 36 + 210 = 286, comfortably inside
    withImage();
    const { container } = render(<ElementPanel />);
    openPicker();
    await waitFor(() => expect(container.querySelector('.menu')).toBeTruthy());
    expect(container.querySelector('.menu')?.classList.contains('menu-up')).toBe(false);
  });
});

describe('the shared menu still works for its other callers', () => {
  it('renders an icon and a plain label when there is no hint', () => {
    const { container } = render(
      <MenuButton label="Shapes" items={[{ value: 'circle', label: 'Circle', icon: 'image' }]} onPick={() => {}} />,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByRole('menuitem', { name: /Circle/ })).toBeTruthy();
  });

  it('renders the hint under the label when one is given', () => {
    const { container } = render(
      <MenuButton label="Dithering" items={[{ value: 'none', label: 'Black & white', hint: 'threshold' }]} onPick={() => {}} />,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(container.querySelector('.menu-hint')?.textContent).toBe('threshold');
  });
});

describe('the Arabic interface names the choices too', () => {
  it('translates the plain names but keeps the algorithm hints', () => {
    useStore.setState({ lang: 'ar' });
    withImage();
    render(<ElementPanel />);
    openPicker();
    expect(screen.getByRole('menuitem', { name: /تدرّج رمادي 256/ })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: /Floyd–Steinberg/ })).toBeTruthy();
  });
});