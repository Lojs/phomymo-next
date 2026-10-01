import type { Key } from '../i18n';
import type { ShapeType } from '../core/model/elements';
import type { IconName } from './icons';

/**
 * The shape palette, ordered roughly by how often a label needs it.
 *
 * It lives in its own module because two places render the identical list — the toolbox's "Shapes"
 * menu and the shape-type chooser in the inspector — and two hand-kept copies would drift the first
 * time someone adds a shape to only one of them.
 */
export const SHAPES: { type: ShapeType; icon: IconName; label: Key }[] = [
  { type: 'rectangle', icon: 'rect', label: 'rectangle' },
  { type: 'ellipse', icon: 'ellipse', label: 'ellipse' },
  { type: 'triangle', icon: 'triangle', label: 'triangle' },
  { type: 'line', icon: 'line', label: 'line' },
  { type: 'diamond', icon: 'diamond', label: 'diamond' },
  { type: 'star', icon: 'star', label: 'star' },
  { type: 'heart', icon: 'heart', label: 'heart' },
  { type: 'pentagon', icon: 'pentagon', label: 'pentagon' },
  { type: 'hexagon', icon: 'hexagon', label: 'hexagon' },
  { type: 'arrowRight', icon: 'arrowRight', label: 'arrowRight' },
  { type: 'arrowLeft', icon: 'arrowLeft', label: 'arrowLeft' },
  { type: 'plus', icon: 'plus', label: 'plus' },
  { type: 'check', icon: 'check', label: 'check' },
];

/**
 * Shapes drawn as a stroke rather than a filled region. Their `fill` is never painted, so the
 * inspector hides that field rather than offering a control that does nothing.
 */
export const STROKED_SHAPES: ShapeType[] = ['line', 'check'];