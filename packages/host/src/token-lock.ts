/**
 * Cross-process coordination for the one writable secret: the authorized person's refresh token.
 *
 * The daemon renews it and `gcb authorize` replaces it. Both hold the same lock for the whole read
 * → exchange → write sequence, so a reader never sees a token another process is rewriting. The
 * lock directory is mounted beside the token in the sidecar; it must exist on both sides.
 */
import {
  closeSync,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
  constants as fsConstants,
} from 'node:fs'
import { join } from 'node:path'

const LOCK_TIMEOUT_MS = 120_000
const STALE_LOCK_MS = 90_000

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** The directory holding the token's lock. It persists so a bind mount can provide it. */
export function tokenLockPath(path: string): string {
  return `${path}.lock`
}

function ensureLockDirectory(path: string): string {
  const lock = tokenLockPath(path)
  try {
    const stat = lstatSync(lock)
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`${lock} is not a real directory`)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
    mkdirSync(lock, { recursive: true, mode: 0o700 })
  }
  return lock
}

/**
 * Run `fn` while holding the token's lock.
 *
 * @param path - The token path.
 * @param fn - The work to do under the lock.
 * @returns Whatever `fn` returns.
 */
export async function withTokenLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const lock = ensureLockDirectory(path)
  const held = join(lock, 'held')
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  let fd: number | undefined
  for (;;) {
    try {
      fd = openSync(held, 'wx', 0o600)
      writeFileSync(fd, `${process.pid}\n`)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new Error(`could not lock ${path}: ${(error as Error).message}`, { cause: error })
      }
      try {
        if (Date.now() - statSync(held).mtimeMs > STALE_LOCK_MS) {
          unlinkSync(held)
          continue
        }
      } catch {
        // The holder released it between the failed open and the stat; retry.
      }
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for the lock on ${path}`, { cause: error })
      }
      await sleep(25)
    }
  }
  try {
    return await fn()
  } finally {
    closeSync(fd)
    try {
      if (readFileSync(held, 'utf8').trim() === String(process.pid)) {
        unlinkSync(held)
      }
    } catch {
      // Another process already removed a stale lock; nothing to release.
    }
  }
}

/**
 * Open the token for an in-place write through a validated descriptor.
 *
 * @param path - The token path.
 * @returns An open writable descriptor.
 */
export function openTokenForWrite(path: string): number {
  const fd = openSync(
    path,
    fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0),
  )
  try {
    if (!fstatSync(fd).isFile()) {
      throw new Error(`${path} is not a regular file`)
    }
    fchmodSync(fd, 0o600)
    return fd
  } catch (error) {
    closeSync(fd)
    throw error
  }
}

/**
 * Open, replace and close the token while its caller holds the lock.
 *
 * @param path - The token path.
 * @param token - The new refresh token.
 */
export function writeTokenLocked(path: string, token: string): void {
  const fd = openTokenForWrite(path)
  try {
    writeTokenThrough(fd, token)
  } finally {
    closeSync(fd)
  }
}

/**
 * Replace the token contents through an already-open descriptor.
 *
 * Callers hold the token lock; the descriptor prevents a path swap from redirecting the write.
 *
 * @param fd - An open token descriptor.
 * @param token - The new refresh token.
 */
export function writeTokenThrough(fd: number, token: string): void {
  ftruncateSync(fd, 0)
  writeFileSync(fd, `${token}\n`)
  fchmodSync(fd, 0o600)
}
