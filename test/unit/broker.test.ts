/**
 * Tests for the broker's request handling and its refusal codes.
 *
 * These are the assertions that back the "default deny" claim: every way a request can be
 * wrong has a named code, and the caller never learns more than it needs to.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { redact, tokenFingerprint } from '../../src/audit.ts';
import { CODES, createRequestHandler, prepareSocketPath } from '../../src/broker.ts';
import { createStaticProvider } from '../../src/providers/static.ts';
import type { AuditSink, BrokerConfig, Provider, StaticHostConfig, WireResponse } from '../../src/types.ts';

const HOST = 'github.com';
const SECRET = 'unit-secret-value';

/** A handler plus the audit events it produced. */
interface Harness {
  handle(message: Record<string, unknown>): Promise<WireResponse>;
  events: Array<Record<string, unknown>>;
}

/**
 * Build a handler backed by a static provider and an in-memory audit sink.
 *
 * @param allow - the allowlist for the configured host.
 * @param providerOverride - a provider to use instead of the static one.
 * @param allowInsecureHttp - whether the host opts into plaintext remotes.
 * @returns the harness.
 */
function makeHarness(
  allow: readonly string[] = ['acme/widget'],
  providerOverride?: Provider,
  allowInsecureHttp?: boolean,
): Harness {
  const block: StaticHostConfig = {
    provider: 'static',
    allow,
    allowInsecureHttp,
    username: 'x-access-token',
    password: SECRET,
  };
  const config: BrokerConfig = {
    socketPath: path.join(os.tmpdir(), 'gcb-unit', 'broker.sock'),
    socketMode: 0o660,
    auditPath: null,
    tokenCacheSkewSeconds: 300,
    hosts: { [HOST]: block },
  };
  const events: Array<Record<string, unknown>> = [];
  const audit: AuditSink = {
    path: null,
    record: (event) => {
      events.push(event);
    },
    close: () => Promise.resolve(),
  };
  const providers = new Map<string, Provider>([
    [HOST, providerOverride ?? createStaticProvider({ host: HOST, cfg: block })],
  ]);
  return { handle: createRequestHandler({ config, audit, providers }), events };
}

/** A well-formed request for the allowlisted repository. */
const REQUEST: Record<string, unknown> = {
  op: 'credential',
  protocol: 'https',
  host: HOST,
  path: 'acme/widget.git',
  session: 'session-d2465e08',
  pid: 4242,
};

describe('broker request handling', () => {
  it('issues a credential for an allowlisted repository and audits it without the secret', async () => {
    const { handle, events } = makeHarness();
    const response = await handle({ ...REQUEST });

    assert.equal(response.ok, true);
    assert.equal(response.username, 'x-access-token');
    assert.equal(response.password, SECRET);

    const allowed = events.filter((event) => event['decision'] === 'allow');
    assert.equal(allowed.length, 1);
    const record = allowed[0];
    assert.ok(record);
    assert.equal(record['repo'], 'acme/widget', 'the audit names the repository, normalized');
    assert.equal(record['session'], 'session-d2465e08', 'the audit carries the DSH session for attribution');
    assert.equal(record['helper_pid'], 4242);
    assert.equal(record['token_fingerprint'], tokenFingerprint(SECRET));
    assert.equal(
      JSON.stringify(events).includes(SECRET),
      false,
      'the credential itself must never reach the audit log',
    );
  });

  it('answers a ping with the version and the configured hosts', async () => {
    const { handle } = makeHarness();
    const response = await handle({ op: 'ping' });
    assert.equal(response.ok, true);
    assert.equal(response.version, '0.1.0');
    assert.deepEqual(response.hosts, [HOST]);
  });

  it('refuses an unknown operation', async () => {
    const { handle } = makeHarness();
    const response = await handle({ op: 'exfiltrate' });
    assert.equal(response.ok, false);
    assert.equal(response.code, CODES.BAD_REQUEST);
  });

  it('refuses a plaintext or unknown protocol unless the host opts in', async () => {
    const { handle } = makeHarness();
    for (const protocol of ['http', 'ftp', undefined]) {
      const response = await handle({ ...REQUEST, protocol });
      assert.equal(response.code, CODES.PROTOCOL_NOT_HTTPS, `expected a refusal for ${String(protocol)}`);
    }
  });

  it('allows a plaintext http remote only when the host explicitly opts in', async () => {
    const strict = makeHarness();
    assert.equal((await strict.handle({ ...REQUEST, protocol: 'http' })).code, CODES.PROTOCOL_NOT_HTTPS);

    const relaxed = makeHarness(['acme/widget'], undefined, true);
    const allowed = await relaxed.handle({ ...REQUEST, protocol: 'http' });
    assert.equal(allowed.ok, true);
    assert.equal(allowed.password, SECRET);
  });

  it('refuses a host that is not configured', async () => {
    const { handle } = makeHarness();
    const response = await handle({ ...REQUEST, host: 'evil.example' });
    assert.equal(response.code, CODES.HOST_NOT_ALLOWED);
  });

  it('refuses a request with no path, and tells the operator which switch is missing', async () => {
    const { handle } = makeHarness();
    // Deliberately built without `path`, which is what git sends unless useHttpPath is on.
    const response = await handle({ op: 'credential', protocol: 'https', host: HOST });
    assert.equal(response.code, CODES.PATH_REQUIRED);
    assert.match(response.reason ?? '', /credential\.useHttpPath true/);
  });

  it('refuses an unparsable or traversal path', async () => {
    const { handle } = makeHarness();
    for (const value of ['acme/..', 'acme', 'acme/widget/extra', '../../etc/passwd']) {
      const response = await handle({ ...REQUEST, path: value });
      assert.equal(response.code, CODES.PATH_REQUIRED, `expected a refusal for ${JSON.stringify(value)}`);
    }
  });

  it('refuses a repository that is not on the allowlist', async () => {
    const { handle } = makeHarness();
    const response = await handle({ ...REQUEST, path: 'acme/other.git' });
    assert.equal(response.code, CODES.REPO_NOT_ALLOWED);
  });

  it('never treats an allowlisted name as a prefix', async () => {
    const { handle } = makeHarness(['acme/widget']);
    const response = await handle({ ...REQUEST, path: 'acme/widget-evil.git' });
    assert.equal(response.code, CODES.REPO_NOT_ALLOWED);
  });

  it('keeps provider failures generic for the caller and detailed in the audit', async () => {
    const exploding: Provider = {
      name: 'exploding',
      getCredential: () => Promise.reject(new Error(`internal detail: token ghs_leak_should_not_surface`)),
    };
    const { handle, events } = makeHarness(['acme/widget'], exploding);
    const response = await handle({ ...REQUEST });

    assert.equal(response.code, CODES.PROVIDER_ERROR);
    assert.doesNotMatch(response.reason ?? '', /ghs_leak_should_not_surface/);
    assert.match(String(events.at(-1)?.['reason']), /internal detail/, 'the audit keeps the real reason');
  });
});

describe('prepareSocketPath', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gcb-sock-'));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('creates the parent directory and tolerates a missing socket', () => {
    const target = path.join(dir, 'nested', 'deep', 'broker.sock');
    prepareSocketPath(target);
    assert.equal(fs.existsSync(path.dirname(target)), true);
  });

  it('unlinks an existing socket so a crashed broker\u2019s leftovers do not block startup', async () => {
    const target = path.join(dir, 'existing.sock');
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(target, () => resolve()));
    assert.equal(fs.lstatSync(target).isSocket(), true);

    prepareSocketPath(target);
    assert.equal(fs.existsSync(target), false, 'the old socket must be gone so listen() can rebind');

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('refuses a regular file instead of overwriting it', () => {
    const target = path.join(dir, 'not-a-socket');
    fs.writeFileSync(target, 'important');
    assert.throws(() => prepareSocketPath(target), /non-socket/);
    assert.equal(fs.readFileSync(target, 'utf8'), 'important', 'the file must be left alone');
  });

  it('refuses to bind inside a symlinked directory', () => {
    // The recommended socket path sits in a directory the agent can write to, so a symlinked
    // directory would let the container choose where the broker binds.
    const real = path.join(dir, 'real-dir');
    const link = path.join(dir, 'link-dir');
    fs.mkdirSync(real, { recursive: true });
    fs.symlinkSync(real, link);
    assert.throws(() => prepareSocketPath(path.join(link, 'broker.sock')), /symlinked directory/);
  });

  it('refuses a symlink instead of following it', () => {
    const real = path.join(dir, 'real.sock');
    const link = path.join(dir, 'link.sock');
    fs.writeFileSync(real, '');
    fs.symlinkSync(real, link);
    assert.throws(() => prepareSocketPath(link), /symlink/);
  });
});

describe('audit redaction', () => {
  it('drops secret-looking keys whatever a future caller passes', () => {
    const record = redact({ password: 'p', token: 't', secret: 's', apiKey: 'k', provider: 'static', repo: 'a/b' });
    assert.equal(record['password'], '<redacted>');
    assert.equal(record['token'], '<redacted>');
    assert.equal(record['secret'], '<redacted>');
    assert.equal(record['provider'], 'static');
    assert.equal(record['repo'], 'a/b');
  });

  it('keeps the fingerprint, which is a hash rather than a credential', () => {
    const record = redact({ token_fingerprint: 'abcdef012345', access_token: 'a', client_secret: 'c' });
    assert.equal(record['token_fingerprint'], 'abcdef012345');
    assert.equal(record['access_token'], '<redacted>');
    assert.equal(record['client_secret'], '<redacted>');
  });

  it('fingerprints deterministically and reversibly for the operator', () => {
    assert.equal(tokenFingerprint('abc'), tokenFingerprint('abc'));
    assert.notEqual(tokenFingerprint('abc'), tokenFingerprint('abd'));
    assert.match(tokenFingerprint('abc'), /^[0-9a-f]{12}$/);
  });
});
