import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
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

  it('reaches a local target directly even with a dead proxy in the environment', async () => {
    const previous = process.env['http_proxy'];
    process.env['http_proxy'] = 'http://127.0.0.1:1';
    const server = http.createServer((_request, response) => {
      response.writeHead(200);
      response.end('direct');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address !== null && typeof address !== 'string');
    try {
      const response = await fetcherFor(null)(`http://127.0.0.1:${address.port}/`, {
        method: 'GET',
        headers: {},
      });
      assert.equal(response.status, 200);
      assert.equal(await response.text(), 'direct');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (previous === undefined) delete process.env['http_proxy'];
      else process.env['http_proxy'] = previous;
    }
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

describe('startup proxy environment', () => {
  it('does not let a startup env proxy capture the direct path', async () => {
    const server = http.createServer((_request, response) => {
      response.writeHead(200);
      response.end('direct');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address !== null && typeof address !== 'string');
    const script = `
      import { fetcherFor } from ${JSON.stringify(new URL('../../packages/host/src/http.ts', import.meta.url).href)};
      const response = await fetcherFor(null)('http://127.0.0.1:${address.port}/', { method: 'GET', headers: {} });
      console.log(response.status, await response.text());
    `;
    const child = spawn(process.execPath, ['--conditions=development', '--input-type=module', '-e', script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_USE_ENV_PROXY: '1',
        http_proxy: 'http://127.0.0.1:1',
        https_proxy: 'http://127.0.0.1:1',
      },
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += String(chunk); });
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    assert.equal(code, 0);
    assert.equal(output.trim(), '200 direct');
  });
});
