import { describe, it, expect } from 'vitest';
import { HANDLES, handlePoint, resizeBox, rotationFromPointer, snapBox } from '../src/ui/stage/geometry';

const opposite: Record<string, string> = { nw: 'se', n: 's', ne: 'sw', e: 'w', se: 'nw', s: 'n', sw: 'ne', w: 'e' };

describe('resizeBox', () => {
  for (const rotation of [0, 30, 90, 137, 270]) {
    for (const h of HANDLES) {
      it(`keeps the opposite handle fixed (${h}, rotation ${rotation}°)`, () => {
        const box = { x: 40, y: 30, width: 120, height: 60, rotation };
        const target = handlePoint(box, h);
        const pointer = { x: target.x + 13, y: target.y - 9 };
        const next = resizeBox(box, h, pointer);
        const before = handlePoint(box, opposite[h] as never);
        const after = handlePoint(next, opposite[h] as never);
        expect(after.x).toBeCloseTo(before.x, 6);
        expect(after.y).toBeCloseTo(before.y, 6);
      });
    }
  }

  it('respects minimum size', () => {
    const next = resizeBox({ x: 0, y: 0, width: 100, height: 50, rotation: 0 }, 'e', { x: -500, y: 25 }, { minWidth: 20 });
    expect(next.width).toBe(20);
  });

  it('keeps aspect ratio on corner drags', () => {
    const next = resizeBox({ x: 0, y: 0, width: 100, height: 50, rotation: 0 }, 'se', { x: 300, y: 80 }, { keepAspect: true });
    expect(next.width / next.height).toBeCloseTo(2, 6);
  });
});

describe('rotationFromPointer', () => {
  it('points straight up at 0°', () => expect(rotationFromPointer({ x: 0, y: 0 }, { x: 0, y: -50 }, false)).toBe(0));
  it('snaps to 15° with shift', () => expect(rotationFromPointer({ x: 0, y: 0 }, { x: 50, y: -20 }, true) % 15).toBe(0));
});

describe('snapBox', () => {
  it('snaps to the label centre within the threshold', () => {
    const r = snapBox({ x: 96, y: 10, width: 8, height: 8, cx: 100, cy: 14 }, [], { width: 200, height: 100 }, 5);
    expect(r.dx).toBe(0);
    expect(r.guides.some((g) => g.axis === 'x' && g.pos === 100)).toBe(true);
  });
  it('does nothing outside the threshold', () => {
    const r = snapBox({ x: 20, y: 30, width: 10, height: 10, cx: 25, cy: 35 }, [], { width: 200, height: 100 }, 3);
    expect(r.guides).toHaveLength(0);
  });
});
