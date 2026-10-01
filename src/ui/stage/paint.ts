import type { LabelElement } from '../../core/model/elements';
import { drawElement } from '../../core/render/draw';
import type { LabelLayout } from '../../core/render/layout';

/** Extra room around the label (label px) so elements can hang over the edge while editing. */
export const PAD = 120;

export const zoneOrigin = (layout: LabelLayout, zone: number) => layout.zones?.[zone] ?? { x: 0, y: 0 };

/** Elements moved into canvas space (zone offset applied). Elements pointing at a missing zone are dropped. */
export function placed(elements: LabelElement[], layout: LabelLayout): LabelElement[] {
  if (!layout.zones) return elements;
  const out: LabelElement[] = [];
  for (const el of elements) {
    const z = layout.zones[el.zone ?? 0];
    if (z) out.push({ ...el, x: el.x + z.x, y: el.y + z.y });
  }
  return out;
}

function labelPath(ctx: CanvasRenderingContext2D, layout: LabelLayout) {
  ctx.beginPath();
  if (layout.round) ctx.arc(layout.width / 2, layout.height / 2, Math.min(layout.width, layout.height) / 2, 0, Math.PI * 2);
  else for (const z of layout.zones ?? [{ x: 0, y: 0, width: layout.width, height: layout.height }]) ctx.rect(z.x, z.y, z.width, z.height);
}

export interface PaintArgs {
  canvas: HTMLCanvasElement;
  layout: LabelLayout;
  elements: LabelElement[];
  zoom: number;
  dpr: number;
  activeZone: number;
  ditherImages: boolean;
  /** When set, draw this 1-bpp preview instead of live elements. */
  paper: HTMLCanvasElement | null;
  accent: string;
  /**
   * Element currently open in the in-place text editor. It is skipped here because the editor
   * already renders the same text in a transparent textarea laid over the canvas: painting it
   * too showed the text twice, offset by the difference between the canvas's vertically
   * centred baseline and the textarea's own line box.
   */
  skipId?: string | null;
}

export function paintStage(a: PaintArgs): void {
  const { canvas, layout, zoom, dpr } = a;
  const ctx = canvas.getContext('2d')!;
  const k = dpr * zoom;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(k, 0, 0, k, PAD * k, PAD * k);

  // paper with a soft lift
  ctx.save();
  ctx.shadowColor = 'rgba(20, 32, 43, 0.22)';
  ctx.shadowBlur = 14 * dpr;
  ctx.shadowOffsetY = 3 * dpr;
  ctx.fillStyle = '#fff';
  labelPath(ctx, layout);
  ctx.fill();
  ctx.restore();

  if (a.paper) {
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(a.paper, 0, 0, layout.width, layout.height);
  } else {
    const els = placed(a.elements, layout).filter((el) => el.id !== a.skipId);
    const opts = { preview: true, ditherImages: a.ditherImages };

    // parts hanging outside the label are shown faded
    ctx.save();
    ctx.beginPath();
    ctx.rect(-PAD, -PAD, layout.width + PAD * 2, layout.height + PAD * 2);
    if (layout.round) ctx.arc(layout.width / 2, layout.height / 2, Math.min(layout.width, layout.height) / 2, 0, Math.PI * 2);
    else for (const z of layout.zones ?? [{ x: 0, y: 0, width: layout.width, height: layout.height }]) ctx.rect(z.x, z.y, z.width, z.height);
    ctx.clip('evenodd');
    ctx.globalAlpha = 0.3;
    for (const el of els) drawElement(ctx, el, opts);
    ctx.restore();

    ctx.save();
    labelPath(ctx, layout);
    ctx.clip();
    for (const el of els) drawElement(ctx, el, opts);
    ctx.restore();
  }

  // label outline(s); the active zone of a roll is accented
  ctx.lineWidth = 1 / k;
  ctx.strokeStyle = 'rgba(20, 32, 43, 0.28)';
  labelPath(ctx, layout);
  ctx.stroke();
  if (layout.zones && layout.zones.length > 1) {
    const z = layout.zones[Math.min(a.activeZone, layout.zones.length - 1)];
    ctx.strokeStyle = a.accent;
    ctx.lineWidth = 2 / k;
    ctx.strokeRect(z.x, z.y, z.width, z.height);
  }
}
