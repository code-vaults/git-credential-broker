import { createHash } from 'node:crypto';

/**
 * A stable, non-reversible fingerprint for audit and probe output.
 *
 * @param secret - the credential or token.
 * @returns the first 12 hex characters of its SHA-256.
 */
export function tokenFingerprint(secret: unknown): string {
  return createHash('sha256').update(String(secret)).digest('hex').slice(0, 12);
}
