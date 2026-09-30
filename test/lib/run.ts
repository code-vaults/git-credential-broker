/**
 * Small process helpers shared by the tests.
 *
 * The async variants matter more than they look: the end-to-end test runs an HTTP server in
 * this very process, so any `spawnSync` would block the event loop and deadlock the git
 * client that is waiting for that server to answer.
 */
import { spawn, spawnSync } from 'node:child_process';
import type { SpawnSyncOptions } from 'node:child_process';

/** One command result, with output coerced to strings. */
export interface RunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error: Error | null;
}

/** Options for the async runners. */
export interface AsyncRunOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Text written to stdin; stdin is always closed, so a command can never block on it. */
  readonly input?: string;
  /** Kill the command after this long. */
  readonly timeoutMs?: number;
}

/**
 * Sleep.
 *
 * @param ms - milliseconds.
 * @returns resolves after the delay.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run a command without blocking the event loop, returning its result without throwing.
 *
 * @param command - the program.
 * @param args - its arguments.
 * @param options - run options.
 * @returns the result.
 */
export function tryRunAsync(
  command: string,
  args: readonly string[],
  options: AsyncRunOptions = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer =
      options.timeoutMs === undefined
        ? null
        : setTimeout(() => {
            child.kill('SIGKILL');
          }, options.timeoutMs);

    const finish = (result: RunResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (error: Error) => finish({ status: null, stdout, stderr, error }));
    child.on('close', (status) => finish({ status, stdout, stderr, error: null }));

    // Always close stdin: git can otherwise wait on a pipe that nobody will ever write to.
    // A command that exits before reading (a fast failure, a usage error) closes the pipe
    // first, and writing to a closed pipe raises EPIPE asynchronously. Without a handler that
    // is an unhandled stream error, which takes down the entire test file and hides the real
    // assertion — this was a genuine intermittent failure of this suite.
    child.stdin?.on('error', () => {});
    child.stdin?.end(options.input ?? '');
  });
}

/**
 * Run a command without blocking the event loop, throwing with full output when it fails.
 *
 * @param command - the program.
 * @param args - its arguments.
 * @param options - run options.
 * @returns the result.
 * @throws {Error} when the command cannot start or exits non-zero.
 */
export async function runAsync(
  command: string,
  args: readonly string[],
  options: AsyncRunOptions = {},
): Promise<RunResult> {
  const result = await tryRunAsync(command, args, options);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} exited ${String(result.status)}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
    );
  }
  return result;
}

/**
 * Run a command and return its result without throwing.
 *
 * @param command - the program.
 * @param args - its arguments.
 * @param options - spawn options.
 * @returns the result.
 */
export function tryRun(
  command: string,
  args: readonly string[],
  options: SpawnSyncOptions = {},
): RunResult {
  const result = spawnSync(command, [...args], { encoding: 'utf8', ...options });
  return {
    status: result.status,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
    error: result.error ?? null,
  };
}

/**
 * Run a command, throwing with full output when it fails.
 *
 * @param command - the program.
 * @param args - its arguments.
 * @param options - spawn options.
 * @returns the result.
 * @throws {Error} when the command cannot start or exits non-zero.
 */
export function run(command: string, args: readonly string[], options: SpawnSyncOptions = {}): RunResult {
  const result = tryRun(command, args, options);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} exited ${String(result.status)}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
    );
  }
  return result;
}

/**
 * Poll until a predicate holds.
 *
 * The return type is narrowed to `NonNullable<T>` because the promise only ever resolves on
 * a truthy value, which lets callers use the result without re-checking for null.
 *
 * @param predicate - checked repeatedly; any truthy value ends the wait.
 * @param options - wait options.
 * @returns the first truthy value.
 * @throws {Error} when the timeout elapses first.
 */
export async function waitFor<T>(
  predicate: () => T | Promise<T>,
  options: { timeoutMs?: number; intervalMs?: number; what?: string } = {},
): Promise<NonNullable<T>> {
  const { timeoutMs = 5000, intervalMs = 25, what = 'condition' } = options;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await sleep(intervalMs);
  }
}
