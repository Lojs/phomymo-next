/** Deterministic pseudo-random data for golden tests. */
export function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

export function randomBytes(n: number, seed: number): Uint8Array {
  const r = rng(seed);
  return Uint8Array.from({ length: n }, () => Math.floor(r() * 256));
}

export type Flavor = 'bw' | 'gray' | 'color' | 'alpha';

export function randomRGBA(w: number, h: number, seed: number, flavor: Flavor): Uint8ClampedArray {
  const r = rng(seed);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const p = i * 4;
    const x = i % w;
    if (flavor === 'bw') {
      const v = r() < 0.4 ? 0 : 255;
      out[p] = out[p + 1] = out[p + 2] = v;
      out[p + 3] = 255;
    } else if (flavor === 'gray') {
      const v = Math.floor(((x / w) * 0.7 + r() * 0.3) * 255);
      out[p] = out[p + 1] = out[p + 2] = v;
      out[p + 3] = 255;
    } else if (flavor === 'color') {
      out[p] = Math.floor(r() * 256);
      out[p + 1] = Math.floor(r() * 256);
      out[p + 2] = Math.floor(r() * 256);
      out[p + 3] = 255;
    } else {
      out[p] = out[p + 1] = out[p + 2] = Math.floor(r() * 256);
      out[p + 3] = Math.floor(r() * 256);
    }
  }
  return out;
}
