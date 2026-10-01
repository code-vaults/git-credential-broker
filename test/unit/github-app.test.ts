/**
 * Tests for the GitHub App provider.
 *
 * These cover exactly the details that make `POST /app/installations/{id}/access_tokens`
 * fail in practice — JWT claims, installation resolution across owners, single-repository
 * scoping, permission narrowing and token reuse — with a stubbed transport, so they run
 * offline and never touch a real credential.
 */
/**
 * The body of a recorded call, as an object when it is JSON.
 *
 * The OAuth endpoints take a form, and a form is not JSON. Swallowing the failure is the point: a stub
 * that throws while recording is a stub that fails the test it was meant to explain.
 *
 * @param body - the raw body, if the call had one.
 * @returns the parsed object, or null.
 */
function recordedBody(body: string | undefined): Record<string, unknown> | null {
  if (!body) return null;
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    return null;
  }
}

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';

import { createGithubAppProvider, nextLink, signAppJwt } from '../../src/providers/github-app.ts';
import type { FetchLike, FetchResponseLike, GithubAppHostConfig } from '../../src/types.ts';
import { ProviderConfigError } from '../../src/errors.ts';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

/**
 * Build a minimal fetch Response stand-in.
 *
 * @param body - JSON body.
 * @param status - HTTP status.
 * @param headers - response headers.
 * @returns a Response-like object.
 */
function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): FetchResponseLike {
  const map = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => map.get(name.toLowerCase()) ?? null },
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

/** One recorded call to the stubbed transport. */
interface RecordedCall {
  /** The body as sent, since the OAuth endpoints take a form rather than JSON. */
  raw?: string;
  readonly url: string;
  readonly method: string;
  readonly body: Record<string, unknown> | null;
  readonly authorization: string | undefined;
}

describe('signAppJwt', () => {
  const nowMs = Date.UTC(2026, 8, 30, 12, 0, 0);

  it('produces a verifiable RS256 JWT with the claims GitHub requires', () => {
    const jwt = signAppJwt({ privateKeyPem: PRIVATE_PEM, iss: 'Iv1.clientid', nowMs });
    const parts = jwt.split('.');
    const header = parts[0];
    const payload = parts[1];
    const signature = parts[2];
    assert.ok(header && payload && signature, 'a JWT has three dot-separated segments');

    assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url').toString('utf8')), {
      typ: 'JWT',
      alg: 'RS256',
    });

    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
    const nowSeconds = Math.floor(nowMs / 1000);
    assert.equal(claims['iat'], nowSeconds - 60, 'iat must be 60s in the past to absorb clock drift');
    assert.equal(claims['exp'], nowSeconds + 600, 'exp must be at most 10 minutes after iat');
    assert.equal((claims['exp'] as number) - (claims['iat'] as number), 660);
    assert.equal(claims['iss'], 'Iv1.clientid');

    const verified = createVerify('RSA-SHA256')
      .update(`${header}.${payload}`)
      .verify(publicKey, Buffer.from(signature, 'base64url'));
    assert.equal(verified, true, 'the signature must verify against the app public key');
  });

  it('refuses a lifetime GitHub would reject', () => {
    assert.throws(
      () => signAppJwt({ privateKeyPem: PRIVATE_PEM, iss: 'x', nowMs, lifetimeSeconds: 601 }),
      /at most 600/,
    );
  });

  it('refuses to sign without a key or an issuer', () => {
    assert.throws(() => signAppJwt({ privateKeyPem: '', iss: 'x', nowMs }), /privateKeyPem is required/);
    assert.throws(() => signAppJwt({ privateKeyPem: PRIVATE_PEM, iss: '', nowMs }), /iss .* is required/);
  });
});

describe('nextLink', () => {
  it('extracts the next page and tolerates absence', () => {
    const header =
      '<https://api.github.com/app/installations?page=2>; rel="next", <https://api.github.com/app/installations?page=5>; rel="last"';
    assert.equal(nextLink(header), 'https://api.github.com/app/installations?page=2');
    assert.equal(nextLink('<https://api.github.com/x>; rel="last"'), null);
    assert.equal(nextLink(null), null);
  });
});

/**
 * Build a recording fetch stub for the GitHub endpoints the provider uses.
 *
 * @param options - stub options.
 * @returns the stub.
 */
/** A plain-text response, which is what the job log endpoint returns. */
function textResponse(body: string, status = 200) {
  return {
    ok: status < 400,
    status,
    headers: { get: (): string | null => null },
    text: () => Promise.resolve(body),
  };
}

function createStubFetch(options: {
  installations: unknown;
  nowMs: number;
  token?: string;
  tokenStatus?: number;
  appPermissions?: Record<string, string>;
  installationPermissions?: Record<string, string>;
  logText?: string;
  jobMissing?: boolean;
}): { calls: RecordedCall[]; fetchImpl: FetchLike } {
  const {
    installations,
    nowMs,
    token = 'ghs_stub_token_value',
    tokenStatus = 201,
    appPermissions = { contents: 'write', pull_requests: 'write' },
    installationPermissions = appPermissions,
    logText = 'stub log\n',
    jobMissing = false,
  } = options;
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchLike = (url, init) => {
    calls.push({
      url,
      method: init.method,
      body: recordedBody(init.body),
      authorization: init.headers['authorization'],
        raw: init.body ?? '',
    });
    if (url.includes('/login/oauth/access_token')) {
      return Promise.resolve(
        jsonResponse({ access_token: 'person-token', refresh_token: 'rotated', expires_in: 28800 }),
      );
    }
    if (url.endsWith('/app')) return Promise.resolve(jsonResponse({ permissions: appPermissions }));
    if (url.includes('/app/installations?')) return Promise.resolve(jsonResponse(installations));
    if (url.endsWith('/merge')) {
      return Promise.resolve(jsonResponse({ merged: true, message: 'Pull Request successfully merged' }));
    }
    if (url.includes('/actions/runs?head_sha=')) {
      return Promise.resolve(
        jsonResponse({
          workflow_runs: [{ name: 'CI', status: 'completed', conclusion: 'success' }],
        }),
      );
    }
    if (/\/pulls\/\d+$/.test(url)) {
      return Promise.resolve(
        jsonResponse({
          number: 42,
          html_url: 'https://github.com/acme/widget/pull/42',
          state: 'closed',
          merged: true,
          mergeable_state: 'blocked',
          head: { sha: 'cafebabe' },
        }),
      );
    }
    if (url.endsWith('/pulls')) {
      return Promise.resolve(
        jsonResponse({ number: 42, html_url: 'https://github.com/acme/widget/pull/42' }, 201),
      );
    }
    if (url.includes('/actions/jobs/') && url.endsWith('/logs')) {
      return jobMissing
        ? Promise.resolve(jsonResponse({ message: 'Not Found' }, 404))
        : Promise.resolve(textResponse(logText));
    }
    if (url.includes('/actions/jobs/')) {
      return jobMissing
        ? Promise.resolve(jsonResponse({ message: 'Not Found' }, 404))
        : Promise.resolve(jsonResponse({ id: 7 }));
    }
    if (/\/app\/installations\/\d+$/.test(url)) {
      return Promise.resolve(jsonResponse({ permissions: installationPermissions }));
    }
    if (url.includes('/access_tokens')) {
      if (tokenStatus !== 201) return Promise.resolve(jsonResponse({ message: 'Bad credentials' }, tokenStatus));
      return Promise.resolve(
        jsonResponse({ token, expires_at: new Date(nowMs + 3_600_000).toISOString() }, tokenStatus),
      );
    }
    return Promise.resolve(jsonResponse({ message: 'unexpected url' }, 404));
  };
  return { calls, fetchImpl };
}

describe('createGithubAppProvider', () => {
  const nowMs = Date.UTC(2026, 8, 30, 12, 0, 0);

  /**
   * Build a provider wired to a stub transport.
   *
   * @param stub - the stub from createStubFetch.
   * @param overrides - configuration overrides.
   * @returns the provider.
   */
  function providerFor(
    stub: { calls: RecordedCall[]; fetchImpl: FetchLike },
    overrides: Partial<GithubAppHostConfig> = {},
  ) {
    const cfg: GithubAppHostConfig = {
      provider: 'github-app',
      allow: ['acme/widget'],
      clientId: 'Iv1.clientid',
      privateKeyPem: PRIVATE_PEM,
      permissions: { contents: 'write', pull_requests: 'write' },
      ...overrides,
    };
    return createGithubAppProvider({ host: 'github.com', cfg, fetchImpl: stub.fetchImpl, now: () => nowMs });
  }

  it('resolves the installation by account login and scopes the token to one named repository', async () => {
    const stub = createStubFetch({ installations: [{ id: 42, account: { login: 'Acme' } }], nowMs });
    const provider = providerFor(stub);

    const credential = await provider.getCredential({ host: 'github.com', owner: 'acme', repo: 'widget', full: 'acme/widget' });

    assert.equal(credential.username, 'x-access-token');
    assert.equal(credential.password, 'ghs_stub_token_value');

    const appCall = stub.calls.find((call) => call.url.endsWith('/app'));
    const lookup = stub.calls.find((call) => call.url.includes('/app/installations?'));
    const mint = stub.calls.find((call) => call.method === 'POST');
    assert.ok(appCall && lookup && mint, 'the pre-flight, the lookup and the mint must all happen');
    assert.match(lookup.url, /\/app\/installations\?per_page=100$/);
    assert.match(lookup.authorization ?? '', /^Bearer eyJ/, 'the app JWT authenticates the lookup');

    assert.match(mint.url, /\/app\/installations\/42\/access_tokens$/);
    assert.deepEqual(
      mint.body,
      { repositories: ['widget'], permissions: { contents: 'write', pull_requests: 'write' } },
      'the token must be scoped to one repository *name* with narrowed permissions',
    );
  });

  it('reuses a cached token instead of minting one per helper invocation', async () => {
    const stub = createStubFetch({ installations: [{ id: 42, account: { login: 'acme' } }], nowMs });
    const provider = providerFor(stub);

    await provider.getCredential({ host: 'github.com', owner: 'acme', repo: 'widget', full: 'acme/widget' });
    const callsAfterFirst = stub.calls.length;
    const second = await provider.getCredential({ host: 'github.com', owner: 'acme', repo: 'widget', full: 'acme/widget' });

    assert.equal(second.cached, true);
    assert.equal(stub.calls.length, callsAfterFirst, 'a second call must not hit the network at all');
  });

  it('re-mints before expiry rather than handing out a token that is about to die', async () => {
    const stub = createStubFetch({ installations: [{ id: 42, account: { login: 'acme' } }], nowMs });
    let clock = nowMs;
    const provider = createGithubAppProvider({
      host: 'github.com',
      cfg: { provider: 'github-app', allow: ['acme/widget'], clientId: 'Iv1.clientid', privateKeyPem: PRIVATE_PEM },
      fetchImpl: stub.fetchImpl,
      now: () => clock,
      skewSeconds: 300,
    });

    await provider.getCredential({ host: 'github.com', owner: 'acme', repo: 'widget', full: 'acme/widget' });
    clock = nowMs + 3_600_000 - 299_000; // inside the skew window
    await provider.getCredential({ host: 'github.com', owner: 'acme', repo: 'widget', full: 'acme/widget' });

    assert.equal(
      stub.calls.filter((call) => call.method === 'POST').length,
      2,
      'a token inside the skew window must be replaced',
    );
    assert.equal(
      stub.calls.filter((call) => call.url.endsWith('/app')).length,
      1,
      'the permission pre-flight must run once per process, not per mint',
    );
  });

  it('supports multiple owners by resolving a different installation per account', async () => {
    const stub = createStubFetch({
      installations: [
        { id: 42, account: { login: 'Acme' } },
        { id: 43, account: { login: 'Other' } },
      ],
      nowMs,
    });
    const provider = providerFor(stub);

    await provider.getCredential({ host: 'github.com', owner: 'acme', repo: 'widget', full: 'acme/widget' });
    await provider.getCredential({ host: 'github.com', owner: 'other', repo: 'thing', full: 'other/thing' });

    const posts = stub.calls.filter((call) => call.method === 'POST').map((call) => call.url);
    assert.deepEqual(posts, [
      'https://api.github.com/app/installations/42/access_tokens',
      'https://api.github.com/app/installations/43/access_tokens',
    ]);
  });

  it('fails loudly when the app is not installed for the owner', async () => {
    const stub = createStubFetch({ installations: [{ id: 42, account: { login: 'someone-else' } }], nowMs });
    const provider = providerFor(stub);
    await assert.rejects(
      () => provider.getCredential({ host: 'github.com', owner: 'acme', repo: 'widget', full: 'acme/widget' }),
      /no installation.*acme/,
    );
  });

  it('fails before minting when the app is not granted a configured permission, and names it', async () => {
    const stub = createStubFetch({
      installations: [{ id: 42, account: { login: 'acme' } }],
      nowMs,
      appPermissions: { contents: 'write', metadata: 'read' },
    });
    const provider = providerFor(stub);
    const error = await provider
      .getCredential({ host: 'github.com', owner: 'acme', repo: 'widget', full: 'acme/widget' })
      .then(() => null)
      .catch((caught: unknown) => caught as Error);

    assert.ok(error, 'the call must fail');
    assert.match(error.message, /pull_requests/, 'the message must name the missing permission');
    assert.match(error.message, /not granted/);
    assert.equal(
      stub.calls.some((call) => call.method === 'POST'),
      false,
      'it must fail before asking GitHub for a token that could never be granted',
    );
  });

  it('re-checks after a failure, so fixing the app settings needs no broker restart', async () => {
    let appPermissions: Record<string, string> = { contents: 'write' };
    const calls: RecordedCall[] = [];
    const fetchImpl: FetchLike = (url, init) => {
      calls.push({
        url,
        method: init.method,
        body: recordedBody(init.body),
        authorization: init.headers['authorization'],
        raw: init.body ?? '',
      });
      if (url.endsWith('/app')) return Promise.resolve(jsonResponse({ permissions: appPermissions }));
      if (url.includes('/app/installations?')) {
        return Promise.resolve(jsonResponse([{ id: 42, account: { login: 'acme' } }]));
      }
      if (/\/app\/installations\/\d+$/.test(url)) {
        return Promise.resolve(jsonResponse({ permissions: appPermissions }));
      }
      if (url.includes('/access_tokens')) {
        return Promise.resolve(
          jsonResponse({ token: 'ghs_after_fix', expires_at: new Date(nowMs + 3_600_000).toISOString() }, 201),
        );
      }
      return Promise.resolve(jsonResponse({}, 404));
    };
    const provider = createGithubAppProvider({
      host: 'github.com',
      cfg: {
        provider: 'github-app',
        allow: ['acme/widget'],
        clientId: 'Iv1.clientid',
        privateKeyPem: PRIVATE_PEM,
        permissions: { pull_requests: 'write' },
      },
      fetchImpl,
      now: () => nowMs,
    });

    await assert.rejects(
      () => provider.getCredential({ host: 'github.com', owner: 'acme', repo: 'widget', full: 'acme/widget' }),
      /pull_requests/,
    );

    appPermissions = { contents: 'write', pull_requests: 'write' };
    const credential = await provider.getCredential({
      host: 'github.com',
      owner: 'acme',
      repo: 'widget',
      full: 'acme/widget',
    });
    assert.equal(credential.password, 'ghs_after_fix');
  });

  it('fails when the app has a permission but the installation has not approved it', async () => {
    // /app is the app's ceiling; the installation is the actual grant. Checking only the former passes
    // here and then fails at the token request, where the message is GitHub's and cannot be handed to
    // the container — so the operator gets "see the broker log" instead of a permission name.
    const stub = createStubFetch({
      installations: [{ id: 42, account: { login: 'acme' } }],
      nowMs,
      appPermissions: { contents: 'write', pull_requests: 'write', workflows: 'write' },
      installationPermissions: { contents: 'write', pull_requests: 'write' },
    });
    const provider = providerFor(stub, { permissions: { contents: 'write', workflows: 'write' } });
    const error = await provider
      .getCredential({ host: 'github.com', owner: 'acme', repo: 'widget', full: 'acme/widget' })
      .then(() => null)
      .catch((caught: unknown) => caught as Error);

    assert.ok(error, 'the call must fail');
    assert.ok(error instanceof ProviderConfigError, 'and be marked as ours, so it can be shown');
    assert.match(error.message, /workflows/, 'naming the permission');
    assert.match(error.message, /installation/, 'and which grant is short of it');
    assert.equal(stub.calls.some((call) => call.method === 'POST'), false, 'still before a token');
  });

  it('reads a job log with a token narrowed to actions: read', async () => {
    const stub = createStubFetch({
      installations: [{ id: 42, account: { login: 'acme' } }],
      nowMs,
      appPermissions: { contents: 'write', actions: 'read' },
      installationPermissions: { contents: 'write', actions: 'read' },
      logText: 'line one\nline two\n',
    });
    const log = await providerFor(stub).getJobLog!({
      host: 'github.com',
      owner: 'acme',
      repo: 'widget',
      jobId: 7,
    });

    assert.equal(log.text, 'line one\nline two\n');
    assert.equal(log.truncated, false);
    const mint = stub.calls.find((call) => call.url.includes('/access_tokens'));
    assert.deepEqual(
      mint?.body?.['permissions'],
      { actions: 'read' },
      'the log token must ask for nothing but the log',
    );
    assert.ok(
      stub.calls.some((call) => call.url.endsWith('/repos/acme/widget/actions/jobs/7/logs')),
      'the log is read through the repository route, which is what binds it to the allowlist',
    );
  });

  it('refuses a job the allowlisted repository does not have', async () => {
    const stub = createStubFetch({
      installations: [{ id: 42, account: { login: 'acme' } }],
      nowMs,
      appPermissions: { actions: 'read' },
      installationPermissions: { actions: 'read' },
      jobMissing: true,
    });
    const error = await providerFor(stub)
      .getJobLog!({ host: 'github.com', owner: 'acme', repo: 'widget', jobId: 7 })
      .then(() => null)
      .catch((caught: unknown) => caught as Error);

    assert.ok(error, 'it must fail');
    assert.match(error.message, /actions\/jobs\/7/);
    assert.match(error.message, /has no log yet/, 'and say why a 404 there is ordinary');
    assert.equal(
      stub.calls.some(
        (call) => call.url.endsWith('/logs') && !call.url.includes('/repos/acme/widget/'),
      ),
      false,
      'a log must never be requested without the repository in the path',
    );
  });

  it('opens a pull request with a token narrowed to pull_requests: write', async () => {
    const stub = createStubFetch({
  installations: [{ id: 42, account: { login: 'acme' } }],
  nowMs,
  appPermissions: { pull_requests: 'write', contents: 'read' },
  installationPermissions: { pull_requests: 'write', contents: 'read' },
    });
    const pr = await providerFor(stub).pullRequest!({
    action: 'open',
  host: 'github.com',
  owner: 'acme',
  repo: 'widget',
  head: 'feature',
  base: 'main',
  title: 'a title',
  body: 'a body',
    });

    assert.equal(pr.number, 42);
    assert.equal(pr.url, 'https://github.com/acme/widget/pull/42');
    const mint = stub.calls.find((call) => call.url.includes('/access_tokens'));
    assert.deepEqual(
  mint?.body?.['permissions'],
  { pull_requests: 'write', contents: 'read' },
  'the token must ask for what the pull request needs',
    );
    const posted = stub.calls.find((call) => call.url.endsWith('/pulls'));
    assert.equal(posted?.method, 'POST');
    assert.equal(posted?.url, 'https://api.github.com/repos/acme/widget/pulls', 'through the repository route');
    assert.equal(posted?.body?.['head'], 'feature');
    assert.equal(posted?.body?.['draft'], false);
  });

  it('merges a pull request with the method it was told to use', async () => {
    const stub = createStubFetch({
      installations: [{ id: 42, account: { login: 'acme' } }],
      nowMs,
      appPermissions: { pull_requests: 'write', contents: 'read' },
      installationPermissions: { pull_requests: 'write', contents: 'read' },
    });
    const pr = await providerFor(stub).pullRequest!({
      action: 'merge',
      host: 'github.com',
      owner: 'acme',
      repo: 'widget',
      number: 42,
      method: 'rebase',
    });

    const put = stub.calls.find((call) => call.method === 'PUT');
    assert.equal(put?.url, 'https://api.github.com/repos/acme/widget/pulls/42/merge');
    assert.deepEqual(put?.body, { merge_method: 'rebase' });
    assert.equal(pr.url, 'https://github.com/acme/widget/pull/42');
    assert.equal(pr.merged, true, 'and the state comes from reading the pull request back');
  });

  it('reports a pull request, and how its commit is doing', async () => {
    const stub = createStubFetch({
  installations: [{ id: 42, account: { login: 'acme' } }],
  nowMs,
  appPermissions: { actions: 'read', pull_requests: 'write', contents: 'read' },
  installationPermissions: { actions: 'read', pull_requests: 'write', contents: 'read' },
    });
    const pr = await providerFor(stub).pullRequest!({
  action: 'status',
  host: 'github.com',
  owner: 'acme',
  repo: 'widget',
  number: 42,
    });

    assert.equal(pr.state, 'closed');
    assert.match(pr.status ?? '', /mergeable: blocked/);
    assert.match(pr.status ?? '', /run CI: success/, 'and the runs for that exact commit');
    assert.ok(
  stub.calls.some((call) => call.url.includes('/actions/runs?head_sha=cafebabe')),
  'read through the repository route, pinned to the head commit',
    );
  });

  it('skips the pre-flight when the operator turns it off', async () => {
    const stub = createStubFetch({
      installations: [{ id: 42, account: { login: 'acme' } }],
      nowMs,
      appPermissions: {},
    });
    const provider = providerFor(stub, { verifyAppPermissions: false });
    const credential = await provider.getCredential({
      host: 'github.com',
      owner: 'acme',
      repo: 'widget',
      full: 'acme/widget',
    });
    assert.equal(credential.password, 'ghs_stub_token_value');
    assert.equal(stub.calls.some((call) => call.url.endsWith('/app')), false);
  });

  it('surfaces an API failure without leaking the private key or the client ID', async () => {
    const stub = createStubFetch({ installations: [{ id: 42, account: { login: 'acme' } }], nowMs, tokenStatus: 403 });
    const provider = providerFor(stub);
    const error = await provider
      .getCredential({ host: 'github.com', owner: 'acme', repo: 'widget', full: 'acme/widget' })
      .then(() => null)
      .catch((caught: unknown) => caught as Error);
    assert.ok(error, 'the call must fail');
    assert.match(error.message, /403/);
    assert.doesNotMatch(error.message, /PRIVATE KEY/);
    assert.doesNotMatch(error.message, /clientid/);
  });

  describe("the authorized person's token", () => {
    it('is renewed from beside the key, used for the pull request, and rotated back to disk', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'personal-token-'));
      const refreshPath = join(dir, 'user.refresh');
      writeFileSync(refreshPath, 'refresh-from-authorize\n', 'utf8');

      const stub = createStubFetch({
        installations: [{ id: 42, account: { login: 'acme' } }],
        nowMs,
        appPermissions: { pull_requests: 'write', contents: 'read' },
        installationPermissions: { pull_requests: 'write', contents: 'read' },
      });

      const pr = await providerFor(stub, { privateKeyPath: join(dir, 'app.pem') }).pullRequest!({
        action: 'open',
        host: 'github.com',
        owner: 'acme',
        repo: 'widget',
        head: 'feat/thing',
        base: 'main',
        title: 'a title',
        body: 'a body',
      });

      assert.equal(pr.number, 42);

      const exchange = stub.calls.find((call) => call.url.includes('/login/oauth/access_token'));
      assert.ok(exchange, 'the refresh token was exchanged');
      assert.match(String(exchange?.raw), /grant_type=refresh_token/);
      assert.match(String(exchange?.raw), /refresh_token=refresh-from-authorize/);

      const created = stub.calls.find((call) => call.url.endsWith('/pulls'));
      assert.equal(created?.authorization, 'Bearer person-token', 'and it was created as them');

      assert.equal(
        readFileSync(refreshPath, 'utf8').trim(),
        'rotated',
        'the rotated refresh token is written back: keeping the old one would work exactly once',
      );

      rmSync(dir, { recursive: true, force: true });
    });
  });


  it("creates the pull request without an installation when a person has authorized one", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'no-installation-'));
    writeFileSync(join(dir, 'user.refresh'), 'refresh-from-authorize\n', 'utf8');

    // An upstream the app was never installed on: the installation lookup finds nothing at all.
    const stub = createStubFetch({ installations: [], nowMs });

    const pr = await providerFor(stub, { privateKeyPath: join(dir, 'app.pem') }).pullRequest!({
      action: 'open', host: 'github.com', owner: 'upstream', repo: 'upstream',
      head: 'feat/thing', base: 'main', title: 'a title', body: 'a body',
    });

    assert.equal(pr.number, 42);
    assert.ok(
      !stub.calls.some((call) => call.url.includes('/access_tokens')),
      'and never mints an installation token it does not have',
    );

    rmSync(dir, { recursive: true, force: true });
  });

});
