/**
 * Generate the maskable icon and the 180 px apple-touch icon from icon-512.png.
 *
 * Both were wrong in the manifest/index.html: the maskable entry pointed at the ordinary "any"
 * icon, so Android's adaptive launcher cropped the artwork to its own mask and cut into the logo;
 * and the apple-touch-icon was 192 px while iOS asks for 180.
 *
 * A maskable icon needs the artwork inside the safe zone — the centre 80% of the canvas — because
 * the launcher may crop up to 10% from every edge. So this composites the existing icon at 80%
 * onto a solid background matching the manifest's background_color, rather than reusing it as-is.
 *
 * Run with: node scripts/make-icons.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const SRC = 'public/icons/icon-512.png';
const BACKGROUND = [0xe7, 0xe4, 0xdd];   // manifest background_color, #e7e4dd
/** Fraction of the canvas the artwork occupies. 0.8 leaves the 10%-per-edge safe zone intact. */
const SCALE = 0.8;

const src = PNG.sync.read(readFileSync(SRC));

/** Draw `src` centred on a background canvas at `size` px, scaled to `scale` of it. */
function compose(size, scale) {
  const out = new PNG({ width: size, height: size });
  for (let i = 0; i < size * size; i++) {
    out.data[i * 4] = BACKGROUND[0];
    out.data[i * 4 + 1] = BACKGROUND[1];
    out.data[i * 4 + 2] = BACKGROUND[2];
    out.data[i * 4 + 3] = 0xff;
  }

  const draw = Math.round(size * scale);
  const offset = Math.round((size - draw) / 2);
  for (let y = 0; y < draw; y++) {
    // Nearest-neighbour: this is a logo with flat colour, so a resample filter would only blur it.
    const sy = Math.min(src.height - 1, Math.floor((y / draw) * src.height));
    for (let x = 0; x < draw; x++) {
      const sx = Math.min(src.width - 1, Math.floor((x / draw) * src.width));
      const si = (sy * src.width + sx) * 4;
      const alpha = src.data[si + 3] / 255;
      if (alpha === 0) continue;                       // keep the background showing through
      const di = ((y + offset) * size + (x + offset)) * 4;
      for (let c = 0; c < 3; c++) {
        out.data[di + c] = Math.round(src.data[si + c] * alpha + BACKGROUND[c] * (1 - alpha));
      }
      out.data[di + 3] = 0xff;
    }
  }
  return out;
}

const targets = [
  { file: 'public/icons/icon-maskable-512.png', size: 512, scale: SCALE },
  { file: 'public/icons/apple-touch-icon.png', size: 180, scale: 1 },
];

for (const { file, size, scale } of targets) {
  const png = compose(size, scale);
  writeFileSync(file, PNG.sync.write(png));
  console.log(`wrote ${file} (${size}x${size})`);
}