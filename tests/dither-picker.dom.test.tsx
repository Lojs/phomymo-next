// @vitest-environment jsdom
/**
 * The dithering picker on an image element.
 *
 * Choosing how a photograph is turned into 1-bit dots used to mean reading four algorithm names
 * ("Ordered (Bayer)", "Floyd–Steinberg") and guessing which one suited a photo. The picker now
 * names each choice for what it does, keeps the algorithm name beside it, and shows a picture of
 * the result.
 *
 * jsdom's canvas stub discards every drawing call and never loads an image, so the *content* of a
 * thumbnail cannot be asserted here — it would be blank regardless of the mode. What is asserted
 * is the part that decides behaviour: that the four choices exist and are named, that the trigger
 * reports what will actually print, that picking one reaches the store, and that a menu item with a
 * thumbnail is laid out as one. The thumbnail's own pixels come from `pixelsToRaster`, which
 * `tests/golden-raster-templates.test.ts` pins bit-for-bit against the original implementation.
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

/** Put one image in the store and select it. */
function withImage(dither?: 'none' | 'ordered' | 'atkinson' | 'floyd-steinberg') {
  const el = createImage('data:image/png;base64,AAAA', dither ? { dither } : {});
  useStore.getState().add(el);
  useStore.getState().select([el.id]);
  return el;
}

const openPicker = () => fireEvent.click(screen.getByRole('button', { name: /Grayscale 256|Standard|Light dots|Black & white|قياسي|تدرّج|نقاط|أبيض/ }));

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
    const items = screen.getAllByRole('menuitem');
    expect(items[0].textContent).toContain('Grayscale 256');
  });
});

describe('the trigger reports what will print', () => {
  it('names the tonal choice when the element has not chosen', () => {
    // The element carries no dither, and 'auto' resolves to Floyd–Steinberg for a photo, so the
    // button must say Grayscale 256 — showing "None" here would be a lie about the output.
    withImage();
    render(<ElementPanel />);
    expect(screen.getByRole('button', { name: /Grayscale 256/ })).toBeTruthy();
  });

  it('follows the element once it has chosen', () => {
    withImage('ordered');
    render(<ElementPanel />);
    expect(screen.getByRole('button', { name: /Standard/ })).toBeTruthy();
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

describe('a picker item is laid out as a thumbnail item', () => {
  it('reserves the image slot even before the picture is ready', () => {
    // jsdom never fires the image's onload, so this is the pre-load state: the row must still be
    // sized for a thumbnail rather than rendering an icon and reflowing when the picture arrives.
    withImage();
    const { container } = render(<ElementPanel />);
    openPicker();
    expect(container.querySelectorAll('.menu-thumb-blank')).toHaveLength(4);
  });

  it('renders the picture, not the icon, when a thumbnail is supplied', () => {
    const { container } = render(
      <MenuButton
        label="Dithering"
        items={[{ value: 'none', label: 'Black & white', icon: 'image', thumb: 'data:image/png;base64,AA', hint: 'threshold' }]}
        onPick={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(container.querySelector('img.menu-thumb')).toBeTruthy();
    expect(container.querySelector('.menu-hint')?.textContent).toBe('threshold');
  });

  it('still renders an icon and a plain label for the menus that have no thumbnails', () => {
    // The connect and shapes menus share this component; the thumbnail must stay optional.
    const { container } = render(
      <MenuButton label="Shapes" items={[{ value: 'circle', label: 'Circle', icon: 'image' }]} onPick={() => {}} />,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(container.querySelector('img.menu-thumb')).toBeNull();
    expect(container.querySelector('.menu-thumb-blank')).toBeNull();
    expect(screen.getByRole('menuitem', { name: /Circle/ })).toBeTruthy();
  });
});


describe('the thumbnails are generated from the image itself', () => {
  /** jsdom never loads an image, so the load is driven by hand; the canvas stub then returns blank
   *  pixels, which is fine here — this asserts the wiring, and the pixels are pinned elsewhere. */
  class FakeImage {
    naturalWidth = 100;
    naturalHeight = 80;
    onload: (() => void) | null = null;
    set src(_v: string) { queueMicrotask(() => this.onload?.()); }
  }
  const RealImage = globalThis.Image;

  afterEach(() => { (globalThis as { Image: unknown }).Image = RealImage; vi.restoreAllMocks(); });

  it('swaps the placeholder for a picture once the image has loaded', async () => {
    (globalThis as { Image: unknown }).Image = FakeImage;
    withImage();
    const { container } = render(<ElementPanel />);
    openPicker();
    await waitFor(() => expect(container.querySelectorAll('img.menu-thumb')).toHaveLength(4));
    expect(container.querySelectorAll('.menu-thumb-blank')).toHaveLength(0);
  });

  it('keeps the picker usable when a thumbnail cannot be exported', async () => {
    // A canvas that has drawn cross-origin content throws from toDataURL. The menu must still open,
    // still list the choices, and still write the choice — the picture is an aid, not the control.
    (globalThis as { Image: unknown }).Image = FakeImage;
    const realCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = realCreate(tag);
      if (tag === 'canvas') (el as HTMLCanvasElement).toDataURL = () => { throw new Error('tainted'); };
      return el;
    });
    const el = withImage();
    const { container } = render(<ElementPanel />);
    openPicker();
    await waitFor(() => expect(container.querySelectorAll('.menu-thumb-blank')).toHaveLength(4));
    fireEvent.click(screen.getByRole('menuitem', { name: /Standard/ }));
    const saved = useStore.getState().elements.find((e) => e.id === el.id) as { dither?: string };
    expect(saved.dither).toBe('ordered');
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
    // Measured for real: with the trigger at y=403 in a 577px window the 210px menu ended at 613
    // and the fourth option could not be clicked at all. A native <select> is repositioned by the
    // browser; this popup has to reposition itself.
    stubRects(700);          // 700 + 36 + 210 = 946, past the 768px window
    withImage();
    const { container } = render(<ElementPanel />);
    openPicker();
    await waitFor(() => expect(container.querySelector('.menu-picker')?.classList.contains('menu-up')).toBe(true));
  });

  it('opens downward when there is room', async () => {
    stubRects(40);           // 40 + 36 + 210 = 286, comfortably inside
    withImage();
    const { container } = render(<ElementPanel />);
    openPicker();
    await waitFor(() => expect(container.querySelector('.menu-picker')).toBeTruthy());
    expect(container.querySelector('.menu-picker')?.classList.contains('menu-up')).toBe(false);
  });
});

describe('the Arabic interface names the choices too', () => {
  it('translates the plain names but keeps the algorithm hints', () => {
    useStore.setState({ lang: 'ar' });
    withImage();
    render(<ElementPanel />);
    fireEvent.click(screen.getByRole('button', { name: /تدرّج|قياسي|نقاط|أبيض/ }));
    expect(screen.getByRole('menuitem', { name: /تدرّج رمادي 256/ })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: /Floyd–Steinberg/ })).toBeTruthy();
  });
});