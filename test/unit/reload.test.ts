import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { ConfigWatcher, fingerprintConfig } from '../../packages/host/src/reload.ts';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gcb-reload-'));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

describe('config watcher', () => {
  it('reloads only after the digest changes, and SIGHUP forces a retry', () => {
    const file = path.join(scratch, 'broker.config.yml');
    fs.writeFileSync(file, 'one\n');
    let loads = 0;
    const watcher = new ConfigWatcher({ file, intervalMs: 60_000, reload: () => { loads += 1; return fingerprintConfig(file)?.digest ?? ''; } });
    try {
      watcher.check(false);
      assert.equal(loads, 0);
      fs.writeFileSync(file, 'two\n');
      watcher.check(false);
      assert.equal(loads, 1);
      watcher.check(false);
      assert.equal(loads, 1);
      watcher.check(true);
      assert.equal(loads, 2);
    } finally {
      watcher.stop();
    }
  });

  it('keeps the last good snapshot after a failed reload and reports the error', () => {
    const file = path.join(scratch, 'broken.config.yml');
    fs.writeFileSync(file, 'one\n');
    const errors: string[] = [];
    let loads = 0;
    const watcher = new ConfigWatcher({
      file,
      intervalMs: 60_000,
      reload: () => {
        loads += 1;
        throw new Error('bad config');
      },
      onError: (error) => errors.push(error.message),
    });
    try {
      fs.writeFileSync(file, 'two\n');
      watcher.check(false);
      assert.equal(loads, 1);
      assert.deepEqual(errors, ['bad config']);
      watcher.check(false);
      assert.equal(loads, 1, 'the bad digest is not retried on every poll');
      watcher.check(true);
      assert.equal(loads, 2, 'SIGHUP forces a retry');
    } finally {
      watcher.stop();
    }
  });

  it('reloads from a real file write through a started watcher', async () => {
    const dir = fs.mkdtempSync(path.join(scratch, 'watched-'));
    const file = path.join(dir, 'config.yml');
    fs.writeFileSync(file, 'one\n');
    let loads = 0;
    const watcher = new ConfigWatcher({
      file,
      intervalMs: 50,
      debounceMs: 20,
      reload: () => {
        loads += 1;
        return fingerprintConfig(file)?.digest ?? '';
      },
    });
    watcher.start();
    try {
      fs.writeFileSync(file, 'two\n');
      const deadline = Date.now() + 2_000;
      while (loads === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(loads, 1);
    } finally {
      watcher.stop();
    }
  });

  it('treats a missing file as no change', () => {
    assert.equal(fingerprintConfig(path.join(scratch, 'missing.yml')), undefined);
  });
});
