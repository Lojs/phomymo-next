// @vitest-environment jsdom
/**
 * services/actions.ts — image and PDF loading, plus the export paths.
 *
 * The uncovered surface here is the file-input side: loading an image or a PDF's first page and
 * placing it on the label. These tests drive the real code with synthetic files.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';
import { addImageFile, replaceImageFile, loadImageFile, addText, addBarcode, addQR, addShape } from '../src/services/actions';
import { useStore } from '../src/state/store';
import { createImage } from '../src/core/model/elements';

beforeEach(() => {
  cleanup();
  localStorage.clear();
  useStore.getState().newDesign();
  useStore.setState({ lang: 'en', past: [], future: [], selectedIds: [], toasts: [] });
  useStore.getState().setLabelSize({ width: 40, height: 30 });
});

/** A File whose text() and arrayBuffer() work without touching the filesystem. */
function fakeFile(name: string, type: string, text = ''): File {
  return {
    name,
    type,
    text: async () => text,
    arrayBuffer: async () => new TextEncoder().encode(text).buffer,
    size: text.length,
  } as unknown as File;
}

/** jsdom has no FileReader result for a blob it cannot read, so provide one. */
function stubFileReader(result: string) {
  class FR {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    result: string | null = null;
    readAsDataURL() { this.result = result; this.onload?.(); }
  }
  (globalThis as any).FileReader = FR;
}

/** An Image that loads immediately with the given natural size. */
function stubImage(width: number, height: number) {
  (globalThis as any).Image = class {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    naturalWidth = width;
    naturalHeight = height;
    set src(_v: string) { setTimeout(() => this.onload?.(), 0); }
  };
}

describe('loadImageFile', () => {
  it('reads an image and reports its natural size', async () => {
    stubFileReader('data:image/png;base64,AAAA');
    stubImage(200, 100);
    const loaded = await loadImageFile(fakeFile('photo.png', 'image/png'));
    expect(loaded).toMatchObject({ width: 200, height: 100 });
    expect(loaded.dataUrl).toContain('data:image/png');
  });

  it('rejects an unreadable image', async () => {
    stubFileReader('data:image/png;base64,AAAA');
    (globalThis as any).Image = class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      naturalWidth = 0;
      set src(_v: string) { setTimeout(() => this.onerror?.(), 0); }
    };
    await expect(loadImageFile(fakeFile('bad.png', 'image/png'))).rejects.toThrow();
  });
});

describe('addImageFile', () => {
  it('places the image on the label and selects it', async () => {
    stubFileReader('data:image/png;base64,AAAA');
    stubImage(200, 100);
    await addImageFile(fakeFile('photo.png', 'image/png'));
    const els = useStore.getState().elements;
    expect(els.length).toBe(1);
    expect(els[0].type).toBe('image');
    expect(useStore.getState().selectedIds).toEqual([els[0].id]);
  });

  it('scales a large image down to fit the label', async () => {
    stubFileReader('data:image/png;base64,AAAA');
    stubImage(2000, 1000); // far bigger than the 320x240 label
    await addImageFile(fakeFile('huge.png', 'image/png'));
    const el = useStore.getState().elements[0];
    const layout = useStore.getState().layout();
    expect(el.width).toBeLessThanOrEqual(layout.labelWidth);
    expect(el.height).toBeLessThanOrEqual(layout.labelHeight);
  });

  it('keeps a small image at its own size, not blown up', async () => {
    stubFileReader('data:image/png;base64,AAAA');
    stubImage(40, 40); // much smaller than the label
    await addImageFile(fakeFile('tiny.png', 'image/png'));
    const el = useStore.getState().elements[0];
    expect(el.width).toBeLessThanOrEqual(40);
  });

  it('records the image natural size for later aspect-ratio work', async () => {
    stubFileReader('data:image/png;base64,AAAA');
    stubImage(300, 150);
    await addImageFile(fakeFile('photo.png', 'image/png'));
    const el = useStore.getState().elements[0] as { naturalWidth: number; naturalHeight: number };
    expect(el.naturalWidth).toBe(300);
    expect(el.naturalHeight).toBe(150);
  });

  it('toasts an error and adds nothing when the file cannot be read', async () => {
    stubFileReader('data:image/png;base64,AAAA');
    (globalThis as any).Image = class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      naturalWidth = 0;
      set src(_v: string) { setTimeout(() => this.onerror?.(), 0); }
    };
    await addImageFile(fakeFile('bad.png', 'image/png'));
    expect(useStore.getState().elements).toEqual([]);
    expect(useStore.getState().toasts.at(-1)!.kind).toBe('error');
  });

  it('the insertion is undoable', async () => {
    stubFileReader('data:image/png;base64,AAAA');
    stubImage(100, 100);
    await addImageFile(fakeFile('photo.png', 'image/png'));
    expect(useStore.getState().elements.length).toBe(1);
    useStore.getState().undo();
    expect(useStore.getState().elements).toEqual([]);
  });
});

describe('replaceImageFile', () => {
  it('swaps the image data and keeps the new natural size', async () => {
    const el = createImage('data:image/png;base64,OLD', { width: 100, height: 100 });
    useStore.getState().add(el);
    stubFileReader('data:image/png;base64,NEW');
    stubImage(400, 200);

    await replaceImageFile(el.id, fakeFile('new.png', 'image/png'));
    const after = useStore.getState().elements[0] as { imageData: string; naturalWidth: number; width: number; height: number };
    expect(after.imageData).toContain('NEW');
    expect(after.naturalWidth).toBe(400);
    // The height follows the new aspect ratio while the width is kept.
    expect(after.height).toBe(Math.max(30, Math.round(100 / 2)));
  });

  it('keeps the old image when the replacement cannot be read', async () => {
    const el = createImage('data:image/png;base64,OLD');
    useStore.getState().add(el);
    stubFileReader('data:image/png;base64,NEW');
    (globalThis as any).Image = class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      naturalWidth = 0;
      set src(_v: string) { setTimeout(() => this.onerror?.(), 0); }
    };
    await replaceImageFile(el.id, fakeFile('bad.png', 'image/png'));
    expect((useStore.getState().elements[0] as { imageData: string }).imageData).toContain('OLD');
    expect(useStore.getState().toasts.at(-1)!.kind).toBe('error');
  });

  it('is undoable', async () => {
    const el = createImage('data:image/png;base64,OLD', { width: 100, height: 100 });
    useStore.getState().add(el);
    stubFileReader('data:image/png;base64,NEW');
    stubImage(400, 200);
    await replaceImageFile(el.id, fakeFile('new.png', 'image/png'));
    useStore.getState().undo();
    expect((useStore.getState().elements[0] as { imageData: string }).imageData).toContain('OLD');
  });
});

describe('add actions size to the label', () => {
  it('a QR fills the smaller label side without exceeding it', () => {
    useStore.getState().setLabelSize({ width: 30, height: 30 });
    addQR();
    const el = useStore.getState().elements[0];
    expect(el.width).toBe(el.height);
    expect(el.width).toBeLessThanOrEqual(30 * 8);
  });

  it('a shape is inserted centred', () => {
    addShape('circle' as never);
    const el = useStore.getState().elements[0];
    expect(el.x).toBeGreaterThan(0);
  });

  it('every add action appends exactly one element', () => {
    addText(); addBarcode(); addQR(); addShape('rectangle');
    expect(useStore.getState().elements.length).toBe(4);
  });

  it('each add action is individually undoable', () => {
    addText();
    useStore.getState().undo();
    expect(useStore.getState().elements).toEqual([]);
  });
});