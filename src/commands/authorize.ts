/**
 * `authorize` — get a user token for this app, once, from whoever runs it.
 *
 * Run on the host, beside the configuration. It prints a code, waits for that person to type it at
 * GitHub on whatever device has a browser, and stores the refresh token next to the configuration and
 * its key — outside every mount, never in the repository. From then on the broker renews the token by
 * itself and nothing here has to be run again.
 *
 * The token is what makes a pull request authored by a person rather than by the app. Only a person
 * can be the author of one that reviewers will not skip, and only the device flow reaches a person
 * whose host has no browser and no callback server.
 *
 * Exit codes: 0 stored, 1 refused.
 */
import { dirname, join, resolve as resolvePath } from 'node:path';

import { loadConfig, resolveConfigPath } from '../config.ts';
import { collectUserToken, startDeviceFlow, type Fetcher } from '../device-flow.ts';
import { fail, parseArgs, say, writeSecretFile } from './support.ts';

/** Usage text for `authorize`. */
export const AUTHORIZE_USAGE = `Usage: git-credential-broker authorize [options]

Get a user token for this app, by authorizing it once from a browser somewhere else. Run it on the host,
beside the configuration. It stores a refresh token and prints where; nothing else needs running after
that, because the broker renews the token itself.

  --config <path>   The configuration (default: $GIT_BROKER_CONFIG, else ./broker.config.json)
  --host <host>     The host block to authorize for (default: github.com)
  -h, --help        Show this help

The app needs its client id configured (the App ID will not do), and "Enable Device Flow" selected in
its settings. GitHub returns a refresh token only while "Expire user authorization tokens" is selected,
which is its default and what this wants.
`;

/**
 * Where the refresh token is kept.
 *
 * Beside the private key, because that is where the broker will look for it: one rule, so a
 * deployment that keeps its key and its configuration together needs to configure nothing. Falling
 * back to the configuration directory covers the deployment that keeps its key inline as a PEM
 * rather than as a file.
 *
 * @param privateKeyPath - where the key is, when it is a file.
 * @param configPath - the resolved configuration path.
 * @returns the path to write the refresh token to.
 */
export function refreshTokenPath(privateKeyPath: string | undefined, configPath: string): string {
  const beside = privateKeyPath === undefined ? dirname(resolvePath(configPath)) : dirname(resolvePath(privateKeyPath));
  return join(beside, 'user.refresh');
}

/**
 * Run the `authorize` command.
 *
 * @param argv - arguments after the command name.
 * @returns the process exit code: 0 stored, 1 refused.
 */
export async function runAuthorize(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, { booleans: ['help'] });
  if (args.has('help') || args.has('h')) {
    say(AUTHORIZE_USAGE);
    return 0;
  }

  const configPath = resolveConfigPath(args.value('config'));
  const host = args.value('host') ?? 'github.com';
  const config = loadConfig(configPath);
  const block = config.hosts[host];
  if (block === undefined) fail(`no host ${host} in ${configPath}`);
  if (block.provider !== 'github-app') fail(`${host} is not a github-app host`);
  if (block.clientId === undefined) {
    fail(`${host} has no clientId — a device flow needs the app's client id, and the App ID will not do`);
  }

  const fetcher: Fetcher = (url, init) => fetch(url, init);
  const code = await startDeviceFlow(block.clientId, fetcher);
  say(`Open ${code.verificationUri} and enter: ${code.userCode}`);
  say(`Waiting up to ${Math.round(code.expiresIn / 60)} minutes for that to be authorized…`);

  const token = await collectUserToken(
    block.clientId,
    code,
    fetcher,
    (ms) => new Promise((done) => setTimeout(done, ms)),
  );
  if (token.refreshToken === undefined) {
    fail(
      'GitHub returned no refresh token, so the token would expire in eight hours with no way to renew.\n' +
        '  Select "Expire user authorization tokens" in the app settings and authorize again.',
    );
  }

  const target = refreshTokenPath(block.privateKeyPath, configPath);
  writeSecretFile(target, `${token.refreshToken}\n`);
  say(`stored the refresh token in ${target} (mode 600)`);
  say(`that is beside the private key${block.privateKeyPath === undefined ? " (or the configuration)" : ""}, which is where the broker looks for it`);
  say('the broker will use it for pull requests authored by that person; nothing else needs running');
  return 0;
}
