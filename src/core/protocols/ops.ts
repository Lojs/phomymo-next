/**
 * A print job is expressed as a flat list of operations. Encoders are pure
 * (bytes in, ops out), so they can be tested byte-for-byte and replayed on any
 * transport (BLE, USB, or a recorder in tests).
 */
export type Op =
  | { t: 'send'; data: Uint8Array }
  | { t: 'delay'; ms: number }
  /** Wait for a printer notification; transports without notifications fall back to a 100 ms delay. */
  | { t: 'wait'; ms: number }
  | { t: 'progress'; pct: number };

export interface Transport {
  send(data: Uint8Array): Promise<void>;
  delay(ms: number): Promise<void>;
  waitForResponse?(timeoutMs: number): Promise<unknown>;
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
        await transport.delay(op.ms);
        break;
      case 'wait':
        if (transport.waitForResponse) await transport.waitForResponse(op.ms);
        else await transport.delay(100);
        break;
      case 'progress':
        opts.onProgress?.(op.pct);
        break;
    }
  }
}
