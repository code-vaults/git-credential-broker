import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isPublicRepository } from '../../packages/host/src/public-repo.ts';
import { ProviderConfigError } from '../../packages/core/src/errors.ts';

function response(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  };
}

describe('the unauthenticated public repository check', () => {
  it('uses the configured API base and API version', async () => {
    let requested = '';
    let version = '';
    const fetchImpl = async (url: string, init: { headers?: Record<string, string> }) => {
      requested = url;
      version = init.headers?.['x-github-api-version'] ?? '';
      return response(200, { private: false });
    };
    const result = await isPublicRepository(
      fetchImpl,
      'https://ghe.example/api/v3',
      'acme/widget',
      '2022-11-28',
    );
    assert.equal(result, true);
    assert.equal(requested, 'https://ghe.example/api/v3/repos/acme/widget');
    assert.equal(version, '2022-11-28');
  });

  it('returns false for a private or missing repository', async () => {
    assert.equal(
      await isPublicRepository(async () => response(200, { private: true }), 'https://api.github.com', 'acme/widget'),
      false,
    );
    assert.equal(
      await isPublicRepository(async () => response(404, {}), 'https://api.github.com', 'acme/widget'),
      false,
    );
  });

  it('refuses redirects and bounds the whole check', async () => {
    let redirect = '';
    await isPublicRepository(
      async (_url, init) => {
        redirect = init.redirect ?? '';
        return response(200, { private: false });
      },
      'https://api.github.com',
      'acme/widget',
    );
    assert.equal(redirect, 'error');

    await assert.rejects(
      isPublicRepository(
        async (_url, init) => {
          await new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          });
          return response(200, { private: false });
        },
        'https://api.github.com',
        'acme/widget',
        '2022-11-28',
        5,
      ),
      /timed out/u,
    );
  });

  it('treats an unparseable body as not public', async () => {
    const responseWithHtml = {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => '<html>proxy error</html>',
    };
    assert.equal(
      await isPublicRepository(async () => responseWithHtml, 'https://api.github.com', 'acme/widget'),
      false,
    );
  });

  it('reports an exhausted quota and a plain refusal differently', async () => {
    await assert.rejects(
      isPublicRepository(async () => response(429, {}), 'https://api.github.com', 'acme/widget'),
      /rate-limited/u,
    );
    await assert.rejects(
      isPublicRepository(async () => response(403, {}), 'https://api.github.com', 'acme/widget'),
      (error: unknown) => error instanceof ProviderConfigError && /refused/u.test(error.message),
    );
  });
});
