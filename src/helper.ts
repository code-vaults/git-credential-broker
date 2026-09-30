/**
 * The container side: a git credential helper.
 *
 * git invokes this as `git-credential-broker <get|store|erase>` with a small `key=value`
 * description on stdin, and reads `key=value` pairs back from stdout.
 *
 * What it deliberately does:
 *  - `store` and `erase` do nothing, ever, so no credential is written to
 *    `~/.git-credentials` or anywhere else;
 *  - it refuses a request without a `path`, because a path-less request can only be
 *    authorized at host granularity — exactly the over-grant this design exists to prevent;
 *  - on any refusal it emits `quit=1` and exits 0. That is the git credential protocol's way
 *    of saying "stop asking helpers": an exit code alone would let git fall through to
 *    another helper and silently authenticate as someone else;
 *  - it never prints the credential to stderr, and never prints diagnostics to stdout, where
 *    they would corrupt the protocol;
 *  - it forwards the protocol and lets the *broker* decide whether plaintext is acceptable
 *    for that host. That decision is therefore host-side and cannot be widened from inside the
 *    container; the helper only rejects a protocol it cannot reason about at all.
 *
 * One exception to fail-closed, and it matters because the workspace is a bind mount shared
 * with the host: when no broker is configured at all (`GIT_BROKER_SOCKET` unset), the helper
 * behaves as if it were not installed — no output, exit 0 — so the human's own git keeps its
 * own credential chain for https remotes. It refuses with `quit=1` only when it *is*
 * configured (socket set, or `GIT_BROKER_REQUIRE=1`), because that means we are meant to be
 * the authority. Set `GIT_BROKER_REQUIRE=1` in the container so a missing socket variable
 * can never degrade into "silently rely on something else".
 *
 * The helper is stateless: it holds no secret and knows no allowlist. The broker decides.
 */
import { readFileSync } from 'node:fs';
import net from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';

import { asWireResponse, encodeMessage, parseMessage } from './socket-protocol.ts';
import type { WireResponse } from './types.ts';

/** Ceiling for the description git sends us. */
const MAX_INPUT_BYTES = 8 * 1024;

/** How long to wait for the broker before giving up (fail closed, fast). */
const SOCKET_TIMEOUT_MS = 10_000;

/**
 * Where to look for the socket path when no environment variable is set.
 *
 * A file rather than only an environment variable, because git is often spawned from a
 * non-login shell that never sources a profile: relying on the environment alone means pushes
 * mysteriously stop working in a fresh session. Override with `GIT_BROKER_SOCKET_FILE`.
 */
const DEFAULT_SOCKET_FILE = ['.config', 'git-credential-broker', 'socket'];

/** Injectable streams and environment, for tests. */
export interface HelperIO {
  readonly stdin?: Readable;
  readonly stdout?: Writable;
  readonly stderr?: Writable;
  readonly env?: NodeJS.ProcessEnv;
}

/** The helper's parsed command line. */
export interface HelperArgs {
  readonly operation: string;
  readonly socketPath: string | undefined;
  readonly strict: boolean;
}

/**
 * Parse git's credential description.
 *
 * @param text - the raw stdin contents.
 * @returns the key/value pairs.
 */
export function parseCredentialInput(text: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of String(text).split('\n')) {
    if (!line) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    fields[line.slice(0, separator).trim()] = line.slice(separator + 1);
  }
  return fields;
}

/**
 * Read a stream to the end, with a size ceiling.
 *
 * Chunks are normalized to `Buffer` rather than assumed: `process.stdin` yields buffers, but
 * any stream in string or object mode yields strings, and `Buffer.concat` rejects those.
 *
 * @param stream - the stream to drain.
 * @param maxBytes - ceiling; exceeding it rejects.
 * @returns the decoded contents.
 */
export function readAll(stream: Readable, maxBytes: number = MAX_INPUT_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    stream.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > maxBytes) {
        reject(new Error('credential description is implausibly large'));
        stream.destroy();
        return;
      }
      chunks.push(buffer);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', reject);
  });
}

/**
 * Send one request to the broker over its unix socket and await one response.
 *
 * @param socketPath - the broker socket path.
 * @param request - the request payload.
 * @param timeoutMs - how long to wait for an answer.
 * @returns the parsed response.
 */
export function requestOverSocket(
  socketPath: string,
  request: Record<string, unknown>,
  timeoutMs: number = SOCKET_TIMEOUT_MS,
): Promise<WireResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ path: socketPath });
    let buffer = '';
    let settled = false;

    const settle = (callback: (value: never) => void, argument: unknown): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      callback(argument as never);
    };

    socket.setTimeout(timeoutMs, () => {
      settle(reject as (value: never) => void, new Error(`the broker did not answer within ${timeoutMs}ms`));
    });
    socket.on('connect', () => socket.write(encodeMessage(request)));
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const message = parseMessage(buffer.slice(0, newline));
      if (message) settle(resolve as (value: never) => void, asWireResponse(message));
      else settle(reject as (value: never) => void, new Error('the broker sent a malformed response'));
    });
    socket.on('error', (error: NodeJS.ErrnoException) => {
      settle(
        reject as (value: never) => void,
        new Error(`cannot reach the broker at ${socketPath}: ${error.code ?? error.message}`),
      );
    });
    socket.on('close', () => {
      settle(reject as (value: never) => void, new Error('the broker closed the connection without answering'));
    });
  });
}

/**
 * Decide where the broker lives, in precedence order:
 *
 *   1. `--socket <path>` on the command line;
 *   2. `GIT_BROKER_SOCKET`;
 *   3. the contents of `GIT_BROKER_SOCKET_FILE`, defaulting to
 *      `$HOME/.config/git-credential-broker/socket`.
 *
 * An empty or missing result means "not configured in this environment", which the caller
 * treats as "behave as if not installed".
 *
 * @param explicitSocket - the `--socket` argument, if any.
 * @param env - the environment to read.
 * @returns the resolved socket path, or undefined when nothing is configured.
 */
export function resolveSocketPath(
  explicitSocket: string | undefined,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (explicitSocket) return explicitSocket;
  const fromEnv = env['GIT_BROKER_SOCKET'];
  if (fromEnv) return fromEnv;

  const file =
    env['GIT_BROKER_SOCKET_FILE'] ?? path.join(env['HOME'] ?? homedir(), ...DEFAULT_SOCKET_FILE);
  try {
    const fromFile = readFileSync(file, 'utf8').trim();
    if (fromFile) return fromFile;
  } catch {
    // No socket file: this environment is not configured for the broker.
  }
  return undefined;
}

/**
 * Parse the helper's own command line.
 *
 * @param argv - arguments after the script name.
 * @returns the parsed arguments.
 */
export function parseArgs(argv: readonly string[]): HelperArgs {
  let operation = 'get';
  let socketPath: string | undefined;
  let strict = false;
  const rest: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;
    if (argument === '--socket') {
      socketPath = argv[index + 1];
      index += 1;
    } else if (argument.startsWith('--socket=')) {
      socketPath = argument.slice('--socket='.length);
    } else if (argument === '--strict') {
      strict = true;
    } else {
      rest.push(argument);
    }
  }
  if (rest.length > 0) operation = rest[0] as string;
  return { operation, socketPath, strict };
}

/**
 * Run the helper.
 *
 * Always resolves with an exit code; refusals still exit 0 on purpose (see the module
 * comment) so that git stops instead of falling through to another helper.
 *
 * @param argv - arguments after the script name.
 * @param io - injectable streams and environment.
 * @returns the process exit code.
 */
export async function runHelper(argv: readonly string[], io: HelperIO = {}): Promise<number> {
  const {
    stdin = process.stdin,
    stdout = process.stdout,
    stderr = process.stderr,
    env = process.env,
  } = io;

  const { operation, socketPath: socketArgument, strict: strictArgument } = parseArgs(argv);

  // git calls `store` after a successful authentication and `erase` after a rejected one.
  // Both are intentionally no-ops: nothing about a credential is ever persisted.
  if (operation !== 'get') return 0;

  const socketPath = resolveSocketPath(socketArgument, env);
  const strict = strictArgument || env['GIT_BROKER_REQUIRE'] === '1';

  const refuse = (message: string): number => {
    stdout.write('quit=1\n');
    stderr.write(`git-credential-broker: ${message}\n`);
    return 0;
  };

  // Drain the description before deciding anything: git closes the pipe once it has
  // written, and walking away without reading can surface as EPIPE on git's side.
  let input: Record<string, string>;
  try {
    input = parseCredentialInput(await readAll(stdin));
  } catch (error) {
    return refuse(`could not read the credential request: ${(error as Error).message}`);
  }

  // Only a configured environment is ours to police. Repository configuration lives in the
  // bind-mounted workspace and is therefore shared with the host, so the human's own git may
  // invoke this helper too. When we are not configured, act as if we were never installed:
  // silence and exit 0 lets git move on to the next helper. Emitting `quit=1` here would stop
  // that chain and break the host's own https credentials.
  if (!socketPath && !strict) return 0;

  const protocol = input['protocol'];
  if (protocol !== 'https' && protocol !== 'http') {
    return refuse(`refusing protocol ${JSON.stringify(protocol ?? '')}: only http and https are understood`);
  }
  if (!input['host']) {
    return refuse('the credential request names no host');
  }
  if (!input['path']) {
    return refuse(
      'the credential request carries no repository path, so only a host-wide credential could be issued; ' +
        'run `git config --global credential.useHttpPath true` to let the broker authorize a single repository',
    );
  }

  if (!socketPath) {
    return refuse('GIT_BROKER_SOCKET is not set while GIT_BROKER_REQUIRE=1, so the broker cannot be reached');
  }

  let response: WireResponse;
  try {
    response = await requestOverSocket(socketPath, {
      v: 1,
      op: 'credential',
      protocol: input['protocol'],
      host: input['host'],
      path: input['path'],
      session: env['DSH_SESSION_ID'] ?? null,
      pid: process.pid,
    });
  } catch (error) {
    return refuse((error as Error).message);
  }

  if (!response.ok) {
    const detail = response.reason ? `: ${response.reason}` : '';
    return refuse(`the broker refused this request (${response.code ?? 'unknown'})${detail}`);
  }
  if (typeof response.username !== 'string' || typeof response.password !== 'string' || !response.password) {
    return refuse('the broker returned an incomplete credential');
  }

  stdout.write(`username=${response.username}\npassword=${response.password}\n`);
  return 0;
}
