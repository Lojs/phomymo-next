// Bundled fonts (no CDN): UI faces + the families offered for label text.
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-700.css';
import '@fontsource/ibm-plex-sans-arabic/arabic-400.css';
import '@fontsource/ibm-plex-sans-arabic/arabic-700.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-700.css';
import '@fontsource/roboto/latin-400.css';
import '@fontsource/roboto/latin-700.css';
import '@fontsource/open-sans/latin-400.css';
import '@fontsource/open-sans/latin-700.css';
import '@fontsource/lato/latin-400.css';
import '@fontsource/lato/latin-700.css';
import '@fontsource/montserrat/latin-400.css';
import '@fontsource/montserrat/latin-700.css';
import '@fontsource/oswald/latin-400.css';
import '@fontsource/oswald/latin-700.css';
import '@fontsource/playfair-display/latin-400.css';
import '@fontsource/playfair-display/latin-700.css';
import '@fontsource/merriweather/latin-400.css';
import '@fontsource/merriweather/latin-700.css';
import '@fontsource/roboto-mono/latin-400.css';
import '@fontsource/roboto-mono/latin-700.css';
import '@fontsource/source-code-pro/latin-400.css';
import '@fontsource/source-code-pro/latin-700.css';
import '@fontsource/cairo/arabic-400.css';
import '@fontsource/cairo/arabic-700.css';
import '@fontsource/cairo/latin-400.css';
import '@fontsource/cairo/latin-700.css';
import '@fontsource/tajawal/arabic-400.css';
import '@fontsource/tajawal/arabic-700.css';
import '@fontsource/amiri/arabic-400.css';
import '@fontsource/amiri/arabic-700.css';
import '@fontsource/noto-naskh-arabic/arabic-400.css';
import '@fontsource/noto-naskh-arabic/arabic-700.css';

export interface FontChoice { value: string; label: string; group: 'sans' | 'serif' | 'mono' | 'display' | 'arabic' }

export const LABEL_FONTS: FontChoice[] = [
  { value: 'Inter, sans-serif', label: 'Inter', group: 'sans' },
  { value: 'Roboto, sans-serif', label: 'Roboto', group: 'sans' },
  { value: 'Open Sans, sans-serif', label: 'Open Sans', group: 'sans' },
  { value: 'Lato, sans-serif', label: 'Lato', group: 'sans' },
  { value: 'Montserrat, sans-serif', label: 'Montserrat', group: 'sans' },
  { value: 'Oswald, sans-serif', label: 'Oswald', group: 'sans' },
  { value: 'Arial, sans-serif', label: 'Arial', group: 'sans' },
  { value: 'Helvetica, sans-serif', label: 'Helvetica', group: 'sans' },
  { value: 'Playfair Display, serif', label: 'Playfair Display', group: 'serif' },
  { value: 'Merriweather, serif', label: 'Merriweather', group: 'serif' },
  { value: 'Georgia, serif', label: 'Georgia', group: 'serif' },
  { value: 'Times New Roman, serif', label: 'Times New Roman', group: 'serif' },
  { value: 'Roboto Mono, monospace', label: 'Roboto Mono', group: 'mono' },
  { value: 'Source Code Pro, monospace', label: 'Source Code Pro', group: 'mono' },
  { value: 'Courier New, monospace', label: 'Courier New', group: 'mono' },
  { value: 'Impact, sans-serif', label: 'Impact', group: 'display' },
  { value: 'Comic Sans MS, cursive', label: 'Comic Sans', group: 'display' },
  { value: 'Cairo, sans-serif', label: 'Cairo', group: 'arabic' },
  { value: 'Tajawal, sans-serif', label: 'Tajawal', group: 'arabic' },
  { value: 'IBM Plex Sans Arabic, sans-serif', label: 'IBM Plex Sans Arabic', group: 'arabic' },
  { value: 'Noto Naskh Arabic, serif', label: 'Noto Naskh Arabic', group: 'arabic' },
  { value: 'Amiri, serif', label: 'Amiri', group: 'arabic' },
];

export const isLocalFontAccessAvailable = () => 'queryLocalFonts' in window;

/** Ask the browser for the user's installed system fonts (Chrome/Edge, permission required). */
export async function queryLocalFontFamilies(): Promise<string[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fonts: { family: string }[] = await (window as any).queryLocalFonts();
  return [...new Set(fonts.map((f) => f.family))].sort((a, b) => a.localeCompare(b));
}
