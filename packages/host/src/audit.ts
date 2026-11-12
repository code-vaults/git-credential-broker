/**
 * Append-only audit log for credential decisions.
 *
 * The log records _that_ a credential was issued and for which repository, never the credential
 * itself: callers pass only a short SHA-256 fingerprint. A defensive redaction pass drops any
 * secret-looking key a future caller might add by accident, and the file is created 0600 so it
 * stays broker-owned.
 *
 * The file rotates before a write would exceed the configured size; older files are kept up to the
 * configured count. Rotation is deliberately synchronous: a request that is being audited should
 * not race a rotate that is moving its own log file.
 */
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs'
import { dirname } from 'node:path'

import type { AuditSink } from 'gcb-core'

/** The default audit segment size: 10 MiB. */
export const AUDIT_MAX_BYTES = 10 * 1024 * 1024

/** The default number of rotated audit segments to keep. */
export const AUDIT_KEEP = 5

/**
 * Keys whose values must never reach the audit log.
 *
 * `token_fingerprint` is deliberately exempt: it is a hash, not a credential, and it is the whole
 * point of the allow records. Without the negative lookahead the `^token` branch would swallow it,
 * and the operator would lose the ability to correlate a grant with a later event — a real bug this
 * pattern previously had.
 */
const FORBIDDEN_KEY_RE = /pass(word)?|secret|^token(?!_fingerprint)|token$|credential/i

/** Options for {@link createAudit}. */
export interface AuditOptions {
  /** Log path; omitted or null means "log nothing to disk". */
  path?: string | null
  /** Rotate before a write would make the active file larger than this. */
  maxBytes?: number
  /** How many rotated files to retain, excluding the active file. */
  keep?: number
  /** Clock, injectable for tests. */
  now?: () => number
  /** Where write failures are reported. */
  stderr?: NodeJS.WritableStream
}

/**
 * Remove secret-looking fields from one audit record.
 *
 * @param event - The record a caller wants to log.
 * @returns The record with secret-bearing keys replaced by `<redacted>`.
 */
export function redact(event: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(event)) {
    out[key] = FORBIDDEN_KEY_RE.test(key) ? '<redacted>' : value
  }
  return out
}

/** Create the active audit file 0600, even when the directory already existed. */
function ensureAuditFile(path: string): void {
  mkdirSync(dirname(path), { recursive: true })
  // The mode passed to create is advisory on ACL shares; chmod is the actual boundary.
  closeSync(openSync(path, 'a', 0o600))
  chmodSync(path, 0o600)
}

/** Shift the current file to `.1`, keeping at most `keep` numbered segments. */
function rotateAuditFile(path: string, keep: number): void {
  for (let index = keep - 1; index >= 1; index -= 1) {
    const from = `${path}.${index}`
    if (!existsSync(from)) {
      continue
    }
    const to = `${path}.${index + 1}`
    rmSync(to, { force: true })
    renameSync(from, to)
  }
  rmSync(`${path}.1`, { force: true })
  renameSync(path, `${path}.1`)
}

/**
 * Create the audit sink.
 *
 * @param options - Sink options.
 * @returns The sink; a null path yields a sink that writes nothing.
 */
export function createAudit(options: AuditOptions = {}): AuditSink {
  const {
    path = null,
    maxBytes = AUDIT_MAX_BYTES,
    keep = AUDIT_KEEP,
    now = () => Date.now(),
    stderr = process.stderr,
  } = options

  let secured = false
  if (path) {
    ensureAuditFile(path)
    secured = true
  }

  return {
    path,
    record(event: Record<string, unknown>): void {
      if (path === null) {
        return
      }
      if (!secured || !existsSync(path)) {
        try {
          ensureAuditFile(path)
          secured = true
        } catch (error) {
          stderr.write(`gcb daemon: audit recreate failed: ${(error as Error).message}\n`)
          return
        }
      }
      const line = `${JSON.stringify({ ts: new Date(now()).toISOString(), ...redact(event) })}\n`
      try {
        const size = statSync(path).size
        if (size > 0 && size + Buffer.byteLength(line) > maxBytes) {
          try {
            rotateAuditFile(path, keep)
          } catch (error) {
            stderr.write(`gcb daemon: audit rotation failed: ${(error as Error).message}\n`)
          }
          try {
            ensureAuditFile(path)
            secured = true
          } catch (error) {
            secured = false
            stderr.write(`gcb daemon: audit recreate failed: ${(error as Error).message}\n`)
            return
          }
        }
        appendFileSync(path, line, { mode: 0o600 })
      } catch (error) {
        stderr.write(`gcb daemon: audit write failed: ${(error as Error).message}\n`)
      }
    },
    close(): Promise<void> {
      return Promise.resolve()
    },
  }
}
