import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { CODES, startBroker } from '../../packages/host/src/broker.ts';
import { MAX_MESSAGE_BYTES } from '../../packages/cli/src/socket-protocol.ts';
import { createStaticProvider } from '../../packages/host/src/providers/static.ts';
import type { AuditSink, BrokerConfig, Provider, StaticHostConfig, WireResponse } from '../../packages/cli/src/types.ts';

const HOST = 'github.com';

describe('startBroker oversized request', () => {
  it('answers with a named bad-request instead of dropping the socket', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gcb-broker-lifecycle-'));
    const socketPath = path.join(root, 'broker.sock');
    const block: StaticHostConfig = {
      provider: 'static',
      allow: ['acme/widget'],
      username: 'x-access-token',
      password: 'unit-secret',
    };
    const config: BrokerConfig = {
      socketPath,
      socketMode: 0o600,
      auditPath: null,
      tokenCacheSkewSeconds: 300,
      hosts: { [HOST]: block },
    };
    const audit: AuditSink = { path: null, record: () => {}, close: () => Promise.resolve() };
    const broker = await startBroker({
      config,
      audit,
      providers: new Map<string, Provider>([[HOST, createStaticProvider({ host: HOST, cfg: block })]]),
      log: () => {},
    });
    try {
      const socket = net.connect(socketPath);
      const response = await new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        socket.on('data', (chunk: Buffer) => chunks.push(chunk));
        socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        socket.on('error', reject);
        socket.write('x'.repeat(MAX_MESSAGE_BYTES + 1) + '\n');
      });
      socket.destroy();
      const parsed = JSON.parse(response.trim()) as WireResponse;
      assert.equal(parsed.ok, false);
      assert.equal(parsed.code, CODES.BAD_REQUEST);
      assert.equal(parsed.reason, `request exceeds ${MAX_MESSAGE_BYTES} bytes`);
    } finally {
      await broker.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
