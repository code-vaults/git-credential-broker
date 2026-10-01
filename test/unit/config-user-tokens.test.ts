/**
 * The two halves of `userTokens`: a path that is there is fine, and one that is not is refused with a
 * remedy.
 *
 * Worth its own file because the check once threw before it looked: any configuration with a token in it
 * made the daemon refuse to start, whatever the file said. A test that only tried the happy path would
 * have caught that, so both are here.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { refreshTokenPath } from '../../src/commands/authorize.ts';
import { assertUserTokensReadable, loadConfig, userTokenPath } from '../../src/config.ts';

/**
 * A configuration with one host and one token for an owner.
 *
 * @param tokenPath - where that token is supposed to be.
 * @param dir - the directory the configuration lives in.
 * @returns the parsed configuration.
 */
function configWith(dir: string, tokenPath: string): ReturnType<typeof loadConfig> {
  const path = join(dir, 'broker.config.json');
  writeFileSync(
    path,
    JSON.stringify({
      socketPath: join(dir, 'broker.sock'),
      auditPath: join(dir, 'audit.jsonl'),
      hosts: {
        'github.com': {
          provider: 'github-app',
          appId: 1,
          clientId: 'Iv1.clientid',
          privateKeyPath: join(dir, 'app.pem'),
          allow: ['acme/widget'],
          userTokens: { acme: tokenPath },
        },
      },
    }),
    'utf8',
  );
  return loadConfig(path);
}

describe('the configured user tokens', () => {
  it('writes the token where the broker will read it, in the layout the deployment uses', () => {
    // The sidecar keeps the configuration and the key in one directory, which is why the writer (beside the
    // configuration) and the reader (beside the key) have to land on the same file.
    const dir = '/etc/git-cred-broker';
    assert.equal(refreshTokenPath(`${dir}/broker.config.json`), userTokenPath(`${dir}/app.pem`));
  });

  it('accepts one whose file is there', () => {
    const dir = mkdtempSync(join(tmpdir(), 'user-tokens-'));
    const token = join(dir, 'acme.token');
    writeFileSync(token, 'github_pat_x\n', 'utf8');
    assert.doesNotThrow(() => assertUserTokensReadable(configWith(dir, token)));
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses one whose file is missing, and names the configuration that asked for it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'user-tokens-'));
    const missing = join(dir, 'not-there.token');
    assert.throws(
      () => assertUserTokensReadable(configWith(dir, missing)),
      (error: unknown) => {
        const message = String((error as Error).message);
        assert.match(message, /github\.com\/acme/, 'the block and the owner are named');
        assert.match(message, /not-there\.token/, 'and the path that could not be read');
        return true;
      },
    );
    rmSync(dir, { recursive: true, force: true });
  });

  it('blames the field it is checking, not permissions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'user-tokens-'));
    const path = join(dir, 'broker.config.json');
    writeFileSync(
      path,
      JSON.stringify({
        socketPath: join(dir, 'broker.sock'),
        auditPath: join(dir, 'audit.jsonl'),
        hosts: {
          'github.com': {
            provider: 'github-app',
            appId: 1,
            clientId: 'Iv1.clientid',
            privateKeyPath: join(dir, 'app.pem'),
            allow: ['acme/widget'],
            userTokens: { acme: 7 },
          },
        },
      }),
      'utf8',
    );
    assert.throws(
      () => loadConfig(path),
      (error: unknown) => {
        const message = String((error as Error).message);
        assert.match(message, /userTokens/, 'the field the operator wrote is the field named');
        assert.doesNotMatch(message, /permissions/, 'not a field they did not');
        return true;
      },
    );
    rmSync(dir, { recursive: true, force: true });
  });

  it('says nothing about a host that has no tokens at all, which is the common case', () => {
    const dir = mkdtempSync(join(tmpdir(), 'user-tokens-'));
    const path = join(dir, 'broker.config.json');
    writeFileSync(
      path,
      JSON.stringify({
        socketPath: join(dir, 'broker.sock'),
        auditPath: join(dir, 'audit.jsonl'),
        hosts: {
          'github.com': {
            provider: 'github-app',
            appId: 1,
            clientId: 'Iv1.clientid',
            privateKeyPath: join(dir, 'app.pem'),
            allow: ['acme/widget'],
          },
        },
      }),
      'utf8',
    );
    assert.doesNotThrow(() => assertUserTokensReadable(loadConfig(path)));
    rmSync(dir, { recursive: true, force: true });
  });
});

// Not covered anywhere yet, and worth knowing: a deployment whose key is `privateKeyPem` rather than a
// file has no directory for the provider to derive `user.refresh` from, so the broker silently finds no
// authorized token and falls back to the app. `authorize` writes beside the configuration in that case,
// which is a different place. Until the provider is told where to look, such a deployment must use
// `userTokens` or the host opener.
