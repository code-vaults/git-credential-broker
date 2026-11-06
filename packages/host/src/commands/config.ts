/**
 * `config` — inspect, edit and validate the broker configuration.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { parseDocument, isMap, isScalar, isSeq } from 'yaml';

import { inferMode, loadConfig, loadConfigText, readConfigText, resolveConfigPath } from '../config.ts';
import { fail, parseArgs, say } from 'gcb-core';

export const CONFIG_USAGE = `Usage: gcb config check|edit|allow add|remove [options]

Validate or edit the broker configuration, or change one allowlist entry.

  check                       Validate the file without changing it
  edit                        Open it in $VISUAL/$EDITOR and validate the saved file
  allow add <host> <repo>     Append one exact owner/name entry
  allow remove <host> <repo>  Remove one exact owner/name entry
  --config <path>             Config file (default: $GIT_BROKER_CONFIG, else ./broker.config.yml)
  -h, --help                  Show this help
`;

export function runConfig(argv: readonly string[]): number {
  const args = parseArgs(argv, { booleans: ['help'] });
  if (args.has('help') || args.has('h')) {
    say(CONFIG_USAGE);
    return 0;
  }
  const configValues = args.values('config');
  if (args.has('config') || configValues.length > 1) fail('--config may only be given once and needs a value');
  const configArg = configValues[0];
  if (configArg === '') fail('--config needs a value');
  for (const name of args.names) {
    if (name !== 'config' && name !== 'help' && name !== 'h') fail(`unknown option --${name}`);
  }
  const command = args.positionals[0];
  if (command !== 'check' && command !== 'edit' && command !== 'allow') {
    fail('usage: gcb config check|edit|allow add|remove [--config <path>]');
  }
  if (command !== 'allow' && args.positionals.length !== 1) {
    fail(`usage: gcb config ${command} [--config <path>]`);
  }

  const path = resolveConfigPath(configArg);
  if (command === 'edit') {
    if (!existsSync(path)) fail(`cannot edit missing config ${path}`);
    const editor = process.env['VISUAL'] ?? process.env['EDITOR'];
    if (editor === undefined || editor.trim() === '') fail('config edit needs $VISUAL or $EDITOR');
    // `$VISUAL`/`$EDITOR` is a shell command in git's own semantics; `$@` keeps the path intact.
    const result = spawnSync('/bin/sh', ['-c', `${editor} "$@"`, editor, path], { stdio: 'inherit' });
    if (result.error !== undefined) fail(`cannot run editor ${JSON.stringify(editor)}: ${result.error.message}`);
    if (result.status !== 0) {
      const how = result.status === null ? `signal ${String(result.signal)}` : `status ${String(result.status)}`;
      fail(`editor exited with ${how}`);
    }
  }

  if (command === 'allow') {
    try {
      changeAllow(path, args.positionals);
    } catch (error) {
      fail((error as Error).message);
    }
    return 0;
  }

  try {
    const config = loadConfig(path);
    const hosts = Object.keys(config.hosts);
    say(`ok: ${path} (${inferMode(config)})`);
    say(`hosts: ${hosts.join(', ')}`);
    return 0;
  } catch (error) {
    fail((error as Error).message);
  }
}

/** One exact repository entry: no URL, glob or extra segment. */
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;

/**
 * Apply one allowlist add or remove, validate the result, then replace the file atomically.
 *
 * @param path - the configuration file.
 * @param positionals - `allow`, `add|remove`, host, `owner/name`.
 */
function changeAllow(path: string, positionals: readonly string[]): void {
  const action = positionals[1];
  const host = positionals[2];
  const repository = positionals[3];
  if ((action !== 'add' && action !== 'remove') || host === undefined || repository === undefined) {
    fail('usage: gcb config allow add|remove <host> <owner/name> [--config <path>]');
  }
  if (positionals.length !== 4) {
    fail('usage: gcb config allow add|remove <host> <owner/name> [--config <path>]');
  }
  if (!REPOSITORY.test(repository)) {
    fail(`repository must be one exact owner/name, got ${JSON.stringify(repository)}`);
  }

  const before = readConfigText(path);
  const document = parseDocument(before, { schema: 'core', uniqueKeys: true, prettyErrors: true });
  if (document.errors.length > 0) {
    fail(`config ${path} is not valid YAML: ${document.errors.map((error) => error.message).join('; ')}`);
  }
  const hostNode = document.getIn(['hosts', host], true);
  if (!isMap(hostNode)) fail(`no host ${JSON.stringify(host)} in ${path}`);
  const allowNode = hostNode.get('allow', true);
  if (allowNode !== undefined && !isSeq(allowNode)) {
    fail(`hosts.${host}.allow must be a list`);
  }
  const entries = isSeq(allowNode)
    ? allowNode.items.map((item) => (isScalar(item) ? String(item.value) : undefined))
    : [];
  const index = entries.findIndex((entry) => entry?.toLowerCase() === repository.toLowerCase());

  if (action === 'add') {
    if (index !== -1) fail(`${repository} is already in ${host}.allow`);
    if (isSeq(allowNode)) {
      allowNode.add(repository);
    } else {
      hostNode.set('allow', document.createNode([repository]));
    }
  } else {
    if (index === -1 || !isSeq(allowNode)) fail(`${repository} is not in ${host}.allow`);
    allowNode.items.splice(index, 1);
  }

  const after = document.toString();
  loadConfigText(after, path);
  const mode = statSync(path).mode;
  const temporary = `${path}.${String(process.pid)}.${String(Date.now())}.tmp`;
  try {
    writeFileSync(temporary, after, { mode });
    chmodSync(temporary, mode & 0o777);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
  say(`allow ${action} ${host} ${repository}: written; reload: config watcher (or send SIGHUP)`);
}
