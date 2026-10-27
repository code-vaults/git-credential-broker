import assert from 'node:assert/strict';
import http from 'node:http';
import { describe, it } from 'node:test';

import { fetcherFor, proxyCacheKey } from '../../packages/host/src/http.ts';

describe('proxy fetch cache', () => {
  it('keys the environment snapshot separately from explicit choices', () => {
    const previous = process.env['https_proxy'];
    process.env['https_proxy'] = 'http://one.example:1';
    const one = proxyCacheKey(undefined);
    process.env['https_proxy'] = 'http://two.example:2';
    const two = proxyCacheKey(undefined);
    if (previous === undefined) delete process.env['https_proxy'];
    else process.env['https_proxy'] = previous;
    assert.notEqual(one, two);
    assert.equal(proxyCacheKey(null), 'direct');
    assert.equal(proxyCacheKey('http://p.example:1'), 'proxy:http://p.example:1');
    assert.equal(fetcherFor('http://p.example:1'), fetcherFor('http://p.example:1'));
  });

  it('returns a response for a non-2xx even though x-fetch throws', async () => {
    const server = http.createServer((_request, response) => {
      response.writeHead(404);
      response.end('missing');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address !== null && typeof address !== 'string');
    try {
      const response = await fetcherFor(null)(`http://127.0.0.1:${address.port}/`, {
        method: 'GET',
        headers: {},
      });
      assert.equal(response.status, 404);
      assert.equal(await response.text(), 'missing');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
