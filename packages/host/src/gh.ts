/**
 * Run one catalogued `gh` action as the App, with the action's short-lived token.
 *
 * The caller has already validated the action, repository and values. This module owns the process
 * boundary: a temp HOME/GH_CONFIG_DIR, a minimal environment, no shell, a hard timeout and an output
 * ceiling. The host user's gh configuration and token are never read.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import path from 'node:path';

import { buildGhArgv, getGhAction, type ActionValues } from 'gcb-cli';

/** The default stdout/stderr ceiling, in bytes per stream. */
export const DEFAULT_GH_OUTPUT_BYTES = 200_000;

/** What one gh invocation produced. */
export interface GhRunResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
  readonly timedOut: boolean;
  /** Set only when the process could not be started at all. */
  readonly error?: string;
}

/** Options for {@link runGhAction}. */
export interface GhRunOptions {
  readonly action: string;
  readonly values: ActionValues;
  readonly repo: string;
  readonly token: string;
  readonly host?: string;
  readonly ghPath?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  /** Environment to copy only the proxy and PATH values from. */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Run one allowed action.
 *
 * @param options - action, values, repository and token.
 * @returns the bounded process result.
 */
export async function runGhAction(options: GhRunOptions): Promise<GhRunResult> {
  const argv = buildGhArgv(options.action, options.values, options.repo);
  const home = mkdtempSync(path.join(tmpdir(), 'gcb-gh-'));
  const configDir = path.join(home, 'gh');
  mkdirSync(configDir, { recursive: true });
  const source = options.env ?? process.env;
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    GH_CONFIG_DIR: configDir,
    GH_TOKEN: options.token,
    GH_HOST: options.host ?? 'github.com',
    NO_COLOR: '1',
    GH_PROMPT_DISABLED: '1',
    GH_NO_UPDATE_NOTIFIER: '1',
    GIT_TERMINAL_PROMPT: '0',
    PATH: source['PATH'] ?? '',
  };
  for (const key of [
    'http_proxy',
    'https_proxy',
    'all_proxy',
    'no_proxy',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'NO_PROXY',
    'NODE_USE_ENV_PROXY',
  ]) {
    const value = source[key];
    if (value !== undefined && value !== '') env[key] = value;
  }

  const timeoutMs = options.timeoutMs ?? getGhAction(options.action).timeoutSeconds * 1000;
  const maxBytes = options.maxOutputBytes ?? DEFAULT_GH_OUTPUT_BYTES;

  try {
    return await new Promise<GhRunResult>((resolve) => {
      let stdout = '';
      let stderr = '';
      let stdoutBytes = 0;
      let stderrBytes = 0;
      const stdoutDecoder = new StringDecoder('utf8');
      const stderrDecoder = new StringDecoder('utf8');
      let truncated = false;
      let timedOut = false;
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      let killTimer: NodeJS.Timeout | undefined;

      const child = spawn(options.ghPath ?? 'gh', argv, {
        cwd: home,
        env,
        shell: false,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const finish = (result: Omit<GhRunResult, 'stdout' | 'stderr' | 'truncated' | 'timedOut'>): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        if (killTimer !== undefined) clearInterval(killTimer);
        const fullStdout = stdout + stdoutDecoder.end();
        const fullStderr = stderr + stderrDecoder.end();
        stdout = clampUtf8(fullStdout, maxBytes);
        stderr = clampUtf8(fullStderr, maxBytes);
        if (stdout !== fullStdout || stderr !== fullStderr) truncated = true;
        resolve({ ...result, stdout, stderr, truncated, timedOut });
      };

      const signalGroup = (): void => {
        if (child.pid === undefined) return;
        try {
          // The child is its own process-group leader; kill the group so a gh-spawned helper does
          // not keep the pipe open after timeout or output overflow.
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      };

      const kill = (): void => {
        signalGroup();
        // A child forked between the signal and the process-group scan can retain the pipe. Keep
        // signalling until close, then finish clears this interval.
        if (killTimer === undefined && !settled) killTimer = setInterval(signalGroup, 100);
      };

      const take = (stream: 'stdout' | 'stderr', chunk: Buffer): void => {
        if (truncated || timedOut) return;
        const used = stream === 'stdout' ? stdoutBytes : stderrBytes;
        if (used >= maxBytes) {
          truncated = true;
          kill();
          return;
        }
        const room = maxBytes - used;
        const piece = chunk.subarray(0, room);
        if (stream === 'stdout') {
          stdout += stdoutDecoder.write(piece);
          stdoutBytes += piece.length;
        } else {
          stderr += stderrDecoder.write(piece);
          stderrBytes += piece.length;
        }
        if (chunk.length > room) {
          truncated = true;
          kill();
        }
      };

      timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, timeoutMs);

      child.stdout?.on('data', (chunk: Buffer) => take('stdout', chunk));
      child.stderr?.on('data', (chunk: Buffer) => take('stderr', chunk));
      child.on('error', (error: Error) => finish({ code: null, signal: null, error: error.message }));
      child.on('close', (code, signal) => finish({ code, signal }));
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/**
 * Keep a decoded string within a UTF-8 byte budget without splitting a code point.
 *
 * @param text - the decoded text.
 * @param maxBytes - the byte budget.
 * @returns the prefix that fits.
 */
function clampUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  let used = 0;
  let kept = '';
  for (const character of text) {
    const size = Buffer.byteLength(character);
    if (used + size > maxBytes) break;
    kept += character;
    used += size;
  }
  return kept;
}
