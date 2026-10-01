/** Decoded-image cache so element rendering can stay synchronous. */
const cache = new Map<string, HTMLImageElement>();
const pending = new Map<string, Promise<HTMLImageElement | null>>();
const listeners = new Set<() => void>();

export const onImageLoaded = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};

export function loadImage(src: string): Promise<HTMLImageElement | null> {
  const hit = cache.get(src);
  if (hit) return Promise.resolve(hit);
  let p = pending.get(src);
  if (!p) {
    p = new Promise<HTMLImageElement | null>((resolve) => {
      const img = new Image();
      img.onload = () => {
        cache.set(src, img);
        pending.delete(src);
        listeners.forEach((l) => l());
        resolve(img);
      };
      img.onerror = () => {
        pending.delete(src);
        resolve(null);
      };
      img.src = src;
    });
    pending.set(src, p);
  }
  return p;
}

/** Returns the image if decoded, otherwise starts loading and returns null. */
export function getImage(src: string): HTMLImageElement | null {
  const hit = cache.get(src);
  if (hit) return hit;
  void loadImage(src);
  return null;
}

export const preloadImages = (sources: string[]) => Promise.all(sources.map(loadImage));
