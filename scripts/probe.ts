#!/usr/bin/env node
/**
 * Ask the broker what it would do for one repository — without doing a push, and without
 * printing the credential.
 *
 * This is the tool to reach for after creating a GitHub App or changing its permissions: it
 * exercises the real path (JWT -> installation lookup -> permission pre-flight -> token mint)
 * and reports the broker's decision, so a missing installation or an ungranted permission is
 * diagnosed here rather than halfway through a push.
 *
 * The credential itself is deliberately reduced to a fingerprint, so the output is safe to
 * paste into an issue or a chat.
 *
 * Usage:
 *   node scripts/probe.ts --socket /run/git-cred-broker/broker.sock \
 *     --host github.com --repo code-vaults/example-repo
 *
 *   # Plaintext host that has opted in:
 *   node scripts/probe.ts --socket ... --host git.example.internal:8443 \
 *     --repo infra/tools --protocol http
 */
import { createHash } from 'node:crypto';
import net from 'node:net';

import { asWireResponse, encodeMessage, parseMessage } from '../src/socket-protocol.ts';

/** Parsed command line. */
interface ProbeArgs {
  socketPath: string | undefined;
  host: string | undefined;
  repo: string | undefined;
  protocol: string;
}

/**
 * Parse the probe's arguments.
 *
 * @param argv - arguments after the script name.
 * @returns the parsed arguments.
 */
function parseArgs(argv: readonly string[]): ProbeArgs {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined || !argument.startsWith('--')) continue;
    const [name, inline] = argument.slice(2).split('=', 2);
    if (name === undefined) continue;
    if (inline !== undefined) values.set(name, inline);
    else {
      const next = argv[index + 1];
      if (next !== undefined) {
        values.set(name, next);
        index += 1;
      }
    }
  }
  return {
    socketPath: values.get('socket') ?? process.env['GIT_BROKER_SOCKET'],
    host: values.get('host'),
    repo: values.get('repo'),
    protocol: values.get('protocol') ?? 'https',
  };
}

/**
 * Fingerprint a credential so the probe can prove one was returned without revealing it.
 *
 * @param secret - the credential.
 * @returns the first 12 hex characters of its SHA-256 digest.
 */
function fingerprint(secret: string): string {
  return createHash('sha256').update(secret).digest('hex').slice(0, 12);
}

const { socketPath, host, repo, protocol } = parseArgs(process.argv.slice(2));
if (!socketPath || !host || !repo) {
  process.stderr.write(
    'usage: node scripts/probe.ts --socket <path> --host <host> --repo <owner/name> [--protocol https]\n',
  );
  process.exit(2);
}

const EXIT: Record<string, number> = { ok: 0, denied: 1, unreachable: 3 };

const socket = net.connect({ path: socketPath });
let buffer = '';
let settled = false;

/**
 * Print the outcome and exit.
 *
 * @param code - the exit code.
 * @param message - what to print.
 * @param stream - where to print it.
 */
function finish(code: number, message: string, stream: NodeJS.WritableStream = process.stdout): void {
  if (settled) return;
  settled = true;
  stream.write(`${message}\n`);
  socket.destroy();
  process.exitCode = code;
}

socket.setTimeout(30_000, () => finish(EXIT['unreachable'] ?? 3, `unreachable: no answer from ${socketPath}`, process.stderr));
socket.on('error', (error: NodeJS.ErrnoException) =>
  finish(EXIT['unreachable'] ?? 3, `unreachable: ${error.code ?? error.message} (${socketPath})`, process.stderr),
);
socket.on('connect', () =>
  socket.write(
    encodeMessage({
      v: 1,
      op: 'credential',
      protocol,
      host,
      path: repo,
      session: 'probe',
      pid: process.pid,
    }),
  ),
);
socket.on('data', (chunk: Buffer) => {
  buffer += chunk.toString('utf8');
  const newline = buffer.indexOf('\n');
  if (newline < 0) return;
  const message = parseMessage(buffer.slice(0, newline));
  if (!message) {
    finish(EXIT['unreachable'] ?? 3, 'unreachable: malformed response', process.stderr);
    return;
  }
  const response = asWireResponse(message);
  if (!response.ok) {
    finish(EXIT['denied'] ?? 1, `denied [${response.code ?? 'unknown'}]: ${response.reason ?? 'no reason given'}`, process.stderr);
    return;
  }
  const password = response.password ?? '';
  finish(
    0,
    [
      `allowed: ${host}/${repo} over ${protocol}`,
      `  username      : ${response.username ?? '(none)'}`,
      `  expires_at    : ${response.expires_at ?? '(unknown)'}`,
      `  credential    : ${password ? `present, fingerprint ${fingerprint(password)} (value not printed)` : 'MISSING'}`,
    ].join('\n'),
  );
});
