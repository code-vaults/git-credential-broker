/**
 * Shared runtime for the two installed entry points.
 *
 * `gcb-client` and `gcb-host` each own a bin, a command set and a backend. This module does the
 * parts that must not drift: version/help dispatch, the "wrong package" error, and the shared
 * wire/types used by both sides. It never imports `yaml` or a host implementation.
 */
export * from './errors.ts';
export * from './fingerprint.ts';
export * from './host-request.ts';
export * from './paths.ts';
export * from './platform.ts';
export * from './socket-protocol.ts';
export * from './support.ts';
export * from './types.ts';
export * from './version.ts';

import { platformRefusal } from './platform.ts';
import { packageVersion } from './version.ts';

/** Commands implemented by the container-side package. */
export const CLIENT_COMMANDS = ['setup', 'probe', 'logs', 'pr', 'remotes'] as const;

/** Commands implemented by the host-side package. */
export const HOST_COMMANDS = [
  'app',
  'host',
  'daemon',
  'init',
  'stage',
  'compose',
  'diagnose',
  'authorize',
  'host-opener',
] as const;

/** The commands a top-level package implements. */
export interface CommandBackend {
  /** Which side this process is. */
  readonly role: 'client' | 'host';
  /** Commands this backend implements, without the leading `gcb`. */
  readonly commands: readonly string[];
  /** Full help text, including the command list for this side. */
  readonly help: string;
  /**
   * Run one command.
   *
   * @param argv - the full argv, starting with the command name.
   * @returns the process exit code.
   */
  run(argv: readonly string[]): Promise<number>;
}

/**
 * Dispatch one command line to the installed backend.
 *
 * @param argv - arguments after the `gcb` bin name.
 * @param backend - the client or host implementation.
 * @returns the process exit code.
 */
export async function runCli(argv: readonly string[], backend: CommandBackend): Promise<number> {
  const [command] = argv;

  if (command === undefined) {
    process.stderr.write(`${backend.help}\n`);
    return 1;
  }
  if (command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(`${backend.help}\n`);
    return 0;
  }
  if (command === 'version' || command === '--version' || command === '-v') {
    process.stdout.write(`${packageVersion()}\n`);
    return 0;
  }

  // Refuse before the backend imports its command modules: the host ones import yaml, and the
  // Windows job removes it on purpose.
  const refusal = platformRefusal();
  if (refusal !== null) {
    process.stderr.write(`gcb: ${refusal}\n`);
    return 1;
  }

  if (backend.commands.includes(command)) return backend.run(argv);

  const otherRole = backend.role === 'client' ? 'host' : 'client';
  const otherCommands = backend.role === 'client' ? HOST_COMMANDS : CLIENT_COMMANDS;
  if ((otherCommands as readonly string[]).includes(command)) {
    process.stderr.write(
      `gcb: \`${command}\` is a ${otherRole} command; install gcb-${otherRole} on the ${otherRole}.\n`,
    );
    return 1;
  }

  process.stderr.write(`gcb: unknown command \`${command}\`.\n\n${backend.help}\n`);
  return 1;
}
