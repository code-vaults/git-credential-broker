/**
 * Append-only audit log for credential decisions.
 *
 * The log records *that* a credential was issued and for which repository, never the
 * credential itself: callers pass only a short SHA-256 fingerprint. A defensive redaction
 * pass drops any secret-looking key a future caller might add by accident, and the file is
 * created 0600 so it stays broker-owned.
 */
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, createWriteStream, mkdirSync, openSync } from 'node:fs';
import type { WriteStream } from 'node:fs';
import { dirname } from 'node:path';

import type { AuditSink } from './types.ts';

/**
 * Keys whose values must never reach the audit log.
 *
 * `token_fingerprint` is deliberately exempt: it is a hash, not a credential, and it is the
 * whole point of the allow records. Without the negative lookahead the `^token` branch would
 * swallow it, and the operator would lose the ability to correlate a grant with a later
 * event — a real bug this pattern previously had.
 */
const FORBIDDEN_KEY_RE = /pass(word)?|secret|^token(?!_fingerprint)|token$|credential/i;

/** Options for {@link createAudit}. */
export interface AuditOptions {
  /** Log path; omitted or null means "log nothing to disk". */
  path?: string | null;
  /** Clock, injectable for tests. */
  now?: () => number;
  /** Where write failures are reported. */
  stderr?: NodeJS.WritableStream;
}

/**
 * A stable, non-reversible fingerprint for correlating an issued credential with later
 * events, without storing the credential.
 *
 * @param secret - the credential value.
 * @returns the first 12 hex characters of its SHA-256 digest.
 */
export function tokenFingerprint(secret: unknown): string {
  return createHash('sha256').update(String(secret)).digest('hex').slice(0, 12);
}

/**
 * Remove secret-looking fields from one audit record.
 *
 * @param event - the record a caller wants to log.
 * @returns the record with secret-bearing keys replaced by `<redacted>`.
 */
export function redact(event: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) {
    out[key] = FORBIDDEN_KEY_RE.test(key) ? '<redacted>' : value;
  }
  return out;
}

/**
 * Create the audit sink.
 *
 * @param options - sink options.
 * @returns the sink; a null path yields a sink that writes nothing.
 */
export function createAudit(options: AuditOptions = {}): AuditSink {
  const { path = null, now = () => Date.now(), stderr = process.stderr } = options;

  let stream: WriteStream | null = null;
  if (path) {
    mkdirSync(dirname(path), { recursive: true });
    // Create, restrict, then append through the stream. The mode passed to a create call is
    // advisory on an ACL-based share, which would leave the audit trail writable by other local
    // users — and an audit trail someone else can append to is not an audit trail.
    closeSync(openSync(path, 'a', 0o600));
    chmodSync(path, 0o600);
    stream = createWriteStream(path, { flags: 'a', mode: 0o600 });
    stream.on('error', (error: Error) => {
      stderr.write(`git-credential-brokerd: audit write failed: ${error.message}\n`);
    });
  }

  return {
    path,
    record(event: Record<string, unknown>): void {
      if (!stream) return;
      stream.write(`${JSON.stringify({ ts: new Date(now()).toISOString(), ...redact(event) })}\n`);
    },
    close(): Promise<void> {
      const target = stream;
      return new Promise((resolve) => {
        if (!target) {
          resolve();
          return;
        }
        target.end(resolve);
      });
    },
  };
}
