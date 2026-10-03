/**
 * Debug logging for the transports.
 *
 * The BLE and USB transports are chatty: they narrate the connection sequence, dump every byte the
 * printer sends, and log the GATT service UUIDs they try. That is genuinely useful when a printer does
 * something unexpected — the byte dump in particular is how the protocol here was reverse-engineered
 * — but it is noise in normal use, and the byte dump is large.
 *
 * So it is kept rather than deleted, and off by default: `import.meta.env.DEV` enables it in a dev
 * build, and `?trace=1` in the URL enables it in a deployed build, because the alternative is
 * rebuilding the image to investigate a printer.
 */
const fromQuery =
  typeof location !== 'undefined' && typeof location.search === 'string'
    ? new URLSearchParams(location.search).get('trace') === '1'
    : false;

export const TRACE = import.meta.env.DEV || fromQuery;

/** Log a connection-lifecycle step. */
export const trace = (...args: unknown[]): void => {
  if (TRACE) console.log(...args);
};

/**
 * Log raw bytes received from the printer. Verbose by nature, so it stays off even in a dev build
 * unless explicitly asked for — this is the one that floods the console.
 */
export const traceBytes = (label: string, data: ArrayLike<number>): void => {
  if (TRACE && fromQuery) {
    const hex = Array.from({ length: data.length }, (_, i) => (data[i] & 0xff).toString(16).padStart(2, '0'));
    console.log(label, hex.join(' '));
  }
};

/** A warning worth showing even with tracing off: something failed and there is a fallback. */
export const warn = (...args: unknown[]): void => console.warn(...args);
