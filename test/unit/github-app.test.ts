/**
 * Tests for the GitHub App provider.
 *
 * These cover exactly the details that make `POST /app/installations/{id}/access_tokens`
 * fail in practice — JWT claims, installation resolution across owners, single-repository
 * scoping, permission narrowing and token reuse — with a stubbed transport, so they run
 * offline and never touch a real credential.
 */
import assert from 'node:assert/strict';
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
function createStubFetch(options: {
  installations: unknown;
  nowMs: number;
  token?: string;
  tokenStatus?: number;
  appPermissions?: Record<string, string>;
  installationPermissions?: Record<string, string>;
}): { calls: RecordedCall[]; fetchImpl: FetchLike } {
  const {
    installations,
    nowMs,
    token = 'ghs_stub_token_value',
    tokenStatus = 201,
    appPermissions = { contents: 'write', pull_requests: 'write' },
    installationPermissions = appPermissions,
  } = options;
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchLike = (url, init) => {
    calls.push({
      url,
      method: init.method,
      body: init.body ? (JSON.parse(init.body) as Record<string, unknown>) : null,
      authorization: init.headers['authorization'],
    });
    if (url.endsWith('/app')) return Promise.resolve(jsonResponse({ permissions: appPermissions }));
    if (url.includes('/app/installations?')) return Promise.resolve(jsonResponse(installations));
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
        body: init.body ? (JSON.parse(init.body) as Record<string, unknown>) : null,
        authorization: init.headers['authorization'],
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
});
