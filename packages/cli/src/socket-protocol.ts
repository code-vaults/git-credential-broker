/**
 * The broker wire protocol: newline-delimited JSON over a unix stream socket.
 *
 * One request per line in, one response per line out. The bounded message size keeps a
 * misbehaving or hostile peer from making the broker buffer without limit. The socket
 * lives on the local filesystem, so it never leaves the host and is unaffected by the
 * container's `*_proxy` environment.
 */
import type { WireResponse } from './types.ts';

/**
 * Hard ceiling for one inbound request line.
 *
 * A legal pull-request body is 65,536 UTF-16 code units. JSON escaping can cost six bytes per unit
 * (`\u0000`), so the request ceiling must cover that plus the envelope; 512 KiB does. Responses are
 * bounded by the log limit instead.
 */
export const MAX_MESSAGE_BYTES = 512 * 1024;

/**
 * Encode one protocol message.
 *
 * @param message - a JSON-serializable payload.
 * @returns the encoded line, newline-terminated.
 */
export function encodeMessage(message: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(message)}\n`, 'utf8');
}

/**
 * Parse one protocol line.
 *
 * @param line - a single line without its newline.
 * @returns the parsed object, or null when the line is not a JSON object.
 */
export function parseMessage(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Options for {@link createLineReader}. */
export interface LineReaderOptions {
  /** Called once per complete, non-empty line. */
  onLine(line: string): void;
  /** Called once when a line exceeds the ceiling; the reader then stops permanently. */
  onOverflow?(): void;
  /** Ceiling for one line, in bytes. */
  maxBytes?: number;
}

/**
 * Build a stateful splitter that turns a byte stream into protocol lines.
 *
 * @param options - reader options.
 * @returns the chunk sink.
 */
export function createLineReader(options: LineReaderOptions): (chunk: Buffer | string) => void {
  const { onLine, onOverflow, maxBytes = MAX_MESSAGE_BYTES } = options;
  let chunks: Buffer[] = [];
  let pendingBytes = 0;
  let stopped = false;

  const stop = (): void => {
    stopped = true;
    chunks = [];
    pendingBytes = 0;
    onOverflow?.();
  };

  return (chunk: Buffer | string): void => {
    if (stopped) return;
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let start = 0;
    for (;;) {
      const newline = data.indexOf(0x0a, start);
      if (newline < 0) {
        const rest = data.subarray(start);
        if (pendingBytes + rest.length > maxBytes) {
          stop();
          return;
        }
        if (rest.length > 0) {
          chunks.push(rest);
          pendingBytes += rest.length;
        }
        return;
      }

      const piece = data.subarray(start, newline);
      if (pendingBytes + piece.length > maxBytes) {
        stop();
        return;
      }
      const line = pendingBytes === 0 ? piece : Buffer.concat([...chunks, piece], pendingBytes + piece.length);
      chunks = [];
      pendingBytes = 0;
      const text = line.toString('utf8');
      if (text.trim()) onLine(text);
      start = newline + 1;
      if (start >= data.length) return;
    }
  };
}

/**
 * Narrow an untyped wire response, for the helper's benefit.
 *
 * @param value - the parsed message.
 * @returns the same object typed as a response.
 */
export function asWireResponse(value: Record<string, unknown>): WireResponse {
  return value as unknown as WireResponse;
}
