/**
 * The broker wire protocol: newline-delimited JSON over a unix stream socket.
 *
 * One request per line in, one response per line out. The bounded message size keeps a
 * misbehaving or hostile peer from making the broker buffer without limit. The socket
 * lives on the local filesystem, so it never leaves the host and is unaffected by the
 * container's `*_proxy` environment.
 */
import type { WireResponse } from './types.ts';

/** Hard ceiling for one protocol line. */
export const MAX_MESSAGE_BYTES = 16 * 1024;

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
  /** Called when a single line exceeds the ceiling. */
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
  let buffer = Buffer.alloc(0);

  return (chunk: Buffer | string): void => {
    buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    let newline = buffer.indexOf(0x0a);
    if (newline < 0 && buffer.length > maxBytes) {
      buffer = Buffer.alloc(0);
      onOverflow?.();
      return;
    }
    while (newline >= 0) {
      const line = buffer.subarray(0, newline).toString('utf8');
      buffer = buffer.subarray(newline + 1);
      if (line.trim()) onLine(line);
      newline = buffer.indexOf(0x0a);
    }
    if (buffer.length > maxBytes) {
      buffer = Buffer.alloc(0);
      onOverflow?.();
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
