import type { SVGProps } from 'react';

const P: Record<string, string> = {
  text: 'M5 6V4h14v2M12 4v16M9 20h6',
  image: 'M4 5h16v14H4zM4 16l4.5-4.5 3.5 3.5 3-3 5 5M15.5 9.5h.01',
  barcode: 'M4 5v14M7 5v14M11 5v14M14 5v14M17 5v14M20 5v14',
  qr: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 14h2v2h-2zM14 18h2v2h-2zM18 18h2v2h-2z',
  // Kept inside the 0 0 24 24 viewBox on purpose. The previous circle was centred at y=4 with
  // r=5, so its top arc sat at y=-1 and the viewBox sliced it flat — the "Shape" icon read as a
  // broken circle. A stroked path also bleeds half the stroke width (0.875px) past the path, so
  // leave that much clearance on every side.
  shape: 'M20 7.5a4.5 4.5 0 0 1-9 0a4.5 4.5 0 0 1 9 0zM3 13h10v8H3z',
  data: 'M4 5h16v14H4zM4 10h16M4 15h16M10 5v14',
  undo: 'M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3',
  redo: 'M15 14l5-5-5-5M20 9H10a6 6 0 0 0 0 12h3',
  print: 'M7 9V3h10v6M7 17H4v-7h16v7h-3M7 14h10v7H7z',
  bluetooth: 'M7 7l10 10-5 4V3l5 4L7 17',
  usb: 'M12 3v13M12 16a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM12 11l-4-2v-3M12 8l4-2v3M6 6h2M15 9h2',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  fit: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  trash: 'M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13M10 11v6M14 11v6',
  copy: 'M8 8h11v12H8zM5 16V4h11',
  layers: 'M12 4l9 5-9 5-9-5zM3 14l9 5 9-5',
  group: 'M4 4h8v8H4zM12 12h8v8h-8z',
  ungroup: 'M4 4h6v6H4zM14 14h6v6h-6zM10 10l4 4',
  folder: 'M3 6h6l2 2h10v11H3z',
  // Tray sits at the bottom of both icons. An arrow coming DOWN into the tray is data arriving
  // (Import); an arrow rising UP out of it is data leaving (Export). Getting these two the wrong
  // way round reads as "the arrows are reversed" — match the arrow to where the file is going.
  download: 'M12 4v11M7 11l5 5 5-5M5 20h14',
  upload: 'M12 16V5M7 9l5-5 5 5M5 20h14',
  settings: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM19 12l2-1-2-4-2 .5-1.5-1L15 4h-4l-.5 2.5-1.5 1L7 7l-2 4 2 1v1l-2 1 2 4 2-.5 1.5 1L11 20h4l.5-2.5 1.5-1 2 .5 2-4-2-1z',
  globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18',
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v6M12 7.5v.01',
  close: 'M6 6l12 12M18 6L6 18',
  chevron: 'M6 9l6 6 6-6',
  check: 'M5 12l5 5 9-10',
  lock: 'M6 11h12v9H6zM8 11V8a4 4 0 0 1 8 0v3',
  bold: 'M7 4h6a4 4 0 0 1 0 8H7zM7 12h7a4 4 0 0 1 0 8H7z',
  italic: 'M10 4h8M6 20h8M14 4l-4 16',
  underline: 'M7 4v7a5 5 0 0 0 10 0V4M5 20h14',
  alignL: 'M4 6h16M4 10h10M4 14h16M4 18h10',
  alignC: 'M4 6h16M7 10h10M4 14h16M7 18h10',
  alignR: 'M4 6h16M10 10h10M4 14h16M10 18h10',
  alignT: 'M4 4h16M8 8v12M16 8v7',
  alignM: 'M4 12h16M8 5v14M16 8v8',
  alignB: 'M4 20h16M8 4v12M16 9v7',
  rotate: 'M20 12a8 8 0 1 1-3-6.2M20 4v4h-4',
  front: 'M9 9h11v11H9zM4 4h11v3M4 4v11h3',
  back: 'M4 4h11v11H4zM9 20h11V9h-3',
  menu: 'M4 7h16M4 12h16M4 17h16',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  battery: 'M3 8h15v8H3zM21 11v2M6 11v2',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  sliders: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4',
  stop: 'M6 6h12v12H6z',
  line: 'M4 20L20 4',
  rect: 'M4 6h16v12H4z',
  ellipse: 'M12 5c5 0 9 3 9 7s-4 7-9 7-9-3-9-7 4-7 9-7z',
  triangle: 'M12 4l9 16H3z',
  diamond: 'M12 3l9 9-9 9-9-9z',
  star: 'M12 3.5l2.7 5.4 6 .9-4.3 4.2 1 6-5.4-2.8-5.4 2.8 1-6L3.3 9.8l6-.9z',
  heart: 'M12 20.3S4.5 15.6 4.5 10.4A4 4 0 0 1 12 8.3a4 4 0 0 1 7.5 2.1c0 5.2-7.5 9.9-7.5 9.9z',
  pentagon: 'M12 3l8.6 6.2-3.3 10.4H6.7L3.4 9.2z',
  hexagon: 'M12 3l7.8 4.6v8.8L12 21l-7.8-4.6V7.6z',
  arrowRight: 'M4 9.5h9V5.5l7 6.5-7 6.5v-4H4z',
  arrowLeft: 'M20 9.5h-9V5.5l-7 6.5 7 6.5v-4h9z',
  orientPortrait: 'M7 3h10v18H7z',
  orientLandscape: 'M3 7h18v10H3z',
};

export type IconName = keyof typeof P;

export function Icon({ name, size = 18, ...rest }: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
      <path d={P[name]} />
    </svg>
  );
}
