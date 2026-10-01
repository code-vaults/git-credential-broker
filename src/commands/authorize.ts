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
import { bootstrapProxy } from '../proxy.ts';

bootstrapProxy();

import { dirname, join, resolve as resolvePath } from 'node:path';

import { userTokenPath, loadConfig, resolveConfigPath } from '../config.ts';
import { collectUserToken, startDeviceFlow, type Fetcher } from '../device-flow.ts';
import { fail, insideMountedPath, isInsideContainer, parseArgs, say, writeSecretFile } from './support.ts';

/** Usage text for `authorize`. */
export const AUTHORIZE_USAGE = `Usage: git-credential-broker authorize [options]

Get a user token for this app, by authorizing it once from a browser somewhere else. Run it on the host,
beside the configuration. It stores a refresh token and prints where; nothing else needs running after
that, because the broker renews the token itself.

  --config <path>   The configuration (default: $GIT_BROKER_CONFIG, else ./broker.config.json)
  --host <host>     The host block to authorize for (default: github.com)
  --to <path>       Where to write the refresh token (default: beside the configuration)
  -h, --help        Show this help

The app needs its client id configured (the App ID will not do), and "Enable Device Flow" selected in
its settings. GitHub returns a refresh token only while "Expire user authorization tokens" is selected,
which is its default and what this wants.
`;

/**
 * Where this command writes the refresh token.
 *
 * Beside the configuration, because the configuration is the path this process was *given*: the paths
 * inside it belong to whichever process runs the broker, and for a sidecar those are container paths
 * that do not exist out here. In the usual sidecar layout the configuration and the key sit in one
 * directory, so this lands in the same file the broker reads; where they differ, the difference is
 * printed rather than discovered later.
 *
 * @param configPath - the resolved configuration path.
 * @returns the path to write the refresh token to.
 */
export function refreshTokenPath(configPath: string): string {
  return join(dirname(resolvePath(configPath)), 'user.refresh');
}

/**
 * Where the broker will look for it, which is beside the key — from the key's own point of view.
 *
 * @param privateKeyPath - the path as the configuration records it.
 * @returns the path the broker reads, or `undefined` when the key is not a file.
 */
export function brokerReadsPath(privateKeyPath: string | undefined): string | undefined {
  return privateKeyPath === undefined ? undefined : userTokenPath(privateKeyPath);
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

  const target = args.value('to') ?? refreshTokenPath(configPath);
  // The same two checks init and stage apply, for the same reason: this is a credential of a person, and
  // the container that pushes must not be able to read it. It is written outside every mount or not at all.
  if (isInsideContainer()) {
    fail('run this on the host, not inside the container: the token must not land anywhere the container can read');
  }
  const mounted = insideMountedPath(target);
  if (mounted !== null) {
    fail(
      `${target} is inside ${mounted}, which is mounted into the container; the refresh token must live\n` +
        '  outside every mount — the deployment directory beside the configuration is the usual place',
    );
  }
  writeSecretFile(target, `${token.refreshToken}\n`);
  say(`stored the refresh token in ${target} (mode 600)`);
  const readByBroker = brokerReadsPath(block.privateKeyPath);
  if (readByBroker === undefined) {
    // An inline privateKeyPem deployment: the broker has no directory to derive a path from, so it never
    // looks for this file. Saying otherwise would be a promise the broker does not keep.
    say('note: this host block keeps its key inline, so the broker has nowhere to look for this file:');
    say('      pull requests will stay app-authored until the key is a file (privateKeyPath)');
  } else if (resolvePath(readByBroker) !== resolvePath(target)) {
    say(`note: the broker will look in ${readByBroker} — make sure that is this file, and that it is`);
    say('      writable, because GitHub rotates the token on every exchange');
  } else {
    say('which is where the broker looks for it — keep it writable, since the token is rotated on every use');
  }
  say('the broker will use it for pull requests authored by that person; nothing else needs running');
  return 0;
}
