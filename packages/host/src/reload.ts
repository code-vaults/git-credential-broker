/**
 * Watch the configuration file for a change, with a poll as the safety net.
 *
 * `fs.watch` is the low-latency trigger. Events can be missed (network filesystems and bind mounts
 * have been observed dropping them), so a 5-second digest poll runs alongside it; a digest that has
 * not changed costs one read and no reload.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** What one file read looked like. */
export interface ConfigFingerprint {
  readonly digest: string;
}

/**
 * Read the file and hash it.
 *
 * @param file - the configuration path.
 * @returns the digest, or undefined when the file is momentarily absent (an atomic rename).
 */
export function fingerprintConfig(file: string): ConfigFingerprint | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  return { digest: createHash('sha256').update(text).digest('hex') };
}

/** Options for {@link ConfigWatcher}. */
export interface ConfigWatcherOptions {
  readonly file: string;
  /** Safety poll interval, used alongside the watch and as the fallback when it is unavailable. */
  readonly intervalMs?: number;
  /** How long to coalesce a burst of events. */
  readonly debounceMs?: number;
  /** Reload the file; throws when invalid. Returns the digest of the bytes it loaded. */
  readonly reload: () => string;
  /** Digest already loaded at start-up; avoids a race between load and watcher construction. */
  readonly initialDigest?: string;
  /** Report a failed reload; the last good snapshot stays active. */
  readonly onError?: (error: Error) => void;
}

/** Poll and watch one configuration file. */
export class ConfigWatcher {
  readonly #file: string;
  readonly #intervalMs: number;
  readonly #debounceMs: number;
  readonly #reload: () => string;
  readonly #onError: (error: Error) => void;
  #last: string | undefined;
  #timer: NodeJS.Timeout | undefined;
  #watch: fs.FSWatcher | undefined;
  #debounce: NodeJS.Timeout | undefined;
  #stopped = false;

  constructor(options: ConfigWatcherOptions) {
    this.#file = options.file;
    this.#intervalMs = options.intervalMs ?? 5_000;
    this.#debounceMs = options.debounceMs ?? 300;
    this.#reload = options.reload;
    this.#onError = options.onError ?? (() => {});
    this.#last = options.initialDigest ?? fingerprintConfig(this.#file)?.digest;
  }

  /**
   * Start watching. A failure to establish the fast path is not fatal: polling still runs.
   *
   * @returns this watcher, for chaining.
   */
  start(): this {
    this.#startPolling();
    try {
      this.#watch = fs.watch(path.dirname(this.#file), { persistent: false }, (_event, name) => {
        if (name !== null && name !== path.basename(this.#file)) return;
        if (this.#debounce !== undefined) clearTimeout(this.#debounce);
        this.#debounce = setTimeout(() => this.check(false), this.#debounceMs);
        this.#debounce.unref();
      });
      this.#watch.on('error', () => {
        this.#watch?.close();
        this.#watch = undefined;
      });
    } catch {
      // The safety poll is already running; an unavailable watch must not stop the daemon.
    }
    return this;
  }

  /** Start the safety poll once; the watch is the primary, low-latency trigger. */
  #startPolling(): void {
    if (this.#stopped || this.#timer !== undefined) return;
    this.#timer = setInterval(() => this.check(false), this.#intervalMs);
    this.#timer.unref();
  }

  /**
   * Compare the file with the last accepted digest and reload when it changed.
   *
   * @param force - reload even when the digest is unchanged (SIGHUP).
   */
  check(force: boolean): void {
    if (this.#stopped) return;
    let next: ConfigFingerprint | undefined;
    try {
      next = fingerprintConfig(this.#file);
    } catch (error) {
      this.#onError(error as Error);
      return;
    }
    if (next === undefined || (!force && next.digest === this.#last)) return;
    try {
      this.#last = this.#reload();
    } catch (error) {
      // Keep the last good snapshot. Clear the digest so a transient failure (a half-written file,
      // a permission blip) is retried on the next tick, even when the bytes have not changed.
      this.#last = undefined;
      this.#onError(error as Error);
    }
  }

  /** Stop both triggers. */
  stop(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    if (this.#debounce !== undefined) clearTimeout(this.#debounce);
    this.#watch?.close();
  }
}
