/**
 * A print job is expressed as a flat list of operations. Encoders are pure
 * (bytes in, ops out), so they can be tested byte-for-byte and replayed on any
 * transport (BLE, USB, or a recorder in tests).
 */
export type Op =
  | { t: 'send'; data: Uint8Array }
  | { t: 'delay'; ms: number }
  /**
   * Wait for a printer notification; transports without notifications fall back to a 100 ms delay.
   *
   * This resolves on the FIRST notification of any kind, including the frames the printer pushes
   * unprompted (cover 1a 05 99, paper-out 1a 06 88, print-status 1a 0b ..). A `wait` used to accept
   * an `expect` predicate so a caller could wait for one specific frame instead; no caller ever
   * passed one, so the P12 handshake concern it was written for is unchanged either way, and the
   * unused plumbing was dead weight on a security-relevant path (an unfiltered waiter also resolves
   * on anything the printer volunteers). Kept as a plain timeout until a caller has a frame to wait for.
   */
  | { t: 'wait'; ms: number }
  | { t: 'progress'; pct: number };

export interface Transport {
  send(data: Uint8Array): Promise<void>;
  /** An optional signal lets an implementation abandon the wait early instead of running it out. */
  delay(ms: number, signal?: AbortSignal): Promise<void>;
  waitForResponse?(timeoutMs: number, signal?: AbortSignal): Promise<unknown>;
}

/**
 * Run `p`, but stop waiting for it as soon as the signal aborts.
 *
 * The transport's delay is always invoked — it may be doing real work (a pacing delay the printer
 * needs) — but a cancel does not have to wait it out. Racing rather than replacing keeps a
 * transport that predates the signal parameter working unchanged.
 */
function race<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(new DOMException('Print cancelled', 'AbortError'));
  // The listener is removed once the race settles. `{ once: true }` only removes it if the signal
  // actually fires, so a long job that never cancels kept one listener per delay op — hundreds on
  // a big batch — attached to a signal that outlives the whole job.
  let onAbort: (() => void) | undefined;
  const armed = new Promise<never>((_r, reject) => {
    onAbort = () => reject(new DOMException('Print cancelled', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([p, armed]).finally(() => {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  });
}

/**
 * An interruptible sleep, for the case where there is no transport delay to delegate to.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return race(new Promise<void>((resolve) => setTimeout(resolve, ms)), signal);
}

export async function runOps(
  transport: Transport,
  ops: Op[],
  opts: { onProgress?: (pct: number) => void; signal?: AbortSignal } = {},
): Promise<void> {
  for (const op of ops) {
    if (opts.signal?.aborted) throw new DOMException('Print cancelled', 'AbortError');
    switch (op.t) {
      case 'send':
        await transport.send(op.data);
        break;
      case 'delay':
        // The transport's delay may be a bare setTimeout (the mSeries post-feed is 800 ms), so a
        // cancel landing inside one had to wait it out. Racing the signal makes Stop immediate.
        await race(transport.delay(op.ms), opts.signal);
        break;
      case 'wait':
        if (transport.waitForResponse) {
          await transport.waitForResponse(op.ms, opts.signal);
        } else {
          await sleep(100, opts.signal);
        }
        break;
      case 'progress':
        opts.onProgress?.(op.pct);
        break;
    }
  }
}
