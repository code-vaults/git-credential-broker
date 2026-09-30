/**
 * Platform guards, and the reason they are not merely cosmetic.
 *
 * On native Windows this design does not degrade, it lies: the socket becomes a named pipe and the
 * mode bits stop enforcing anything, so a broker that started would look healthy while every local
 * process could ask it for credentials. Inside WSL the trap is narrower but easier to fall into —
 * `/mnt/<drive>` is a Windows-backed mount, and a unix socket cannot live there.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { prepareSocketPath } from '../../src/broker.ts';
import { isNativeWindows, isWindowsBackedPath, isWsl, platformRefusal, socketPathRefusal } from '../../src/platform.ts';

/** Scratch space for the one test that touches the filesystem. */
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gcb-platform-'));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

describe('platform detection', () => {
  it('separates native Windows from WSL, which is Linux with a Windows filesystem beside it', () => {
    assert.equal(isNativeWindows('win32'), true);
    assert.equal(isNativeWindows('linux'), false);
    assert.equal(isNativeWindows('darwin'), false);

    // Either signal is enough: they were added at different times and either can be absent.
    assert.equal(isWsl({ WSL_DISTRO_NAME: 'Ubuntu' }, '5.15.0-generic'), true);
    assert.equal(isWsl({ WSL_INTEROP: '/run/WSL/8_interop' }, '5.15.0-generic'), true);
    assert.equal(isWsl({}, '5.15.90.1-microsoft-standard-WSL2'), true);
    assert.equal(isWsl({}, '6.6.87.1-linuxkit'), false);
  });

  it('recognises the Windows-backed mounts, and only those', () => {
    assert.equal(isWindowsBackedPath('/mnt/c/Users/x/broker.sock'), true);
    assert.equal(isWindowsBackedPath('/mnt/d/'), true);
    // Not a drive letter: WSL's own mounts are on the Linux side and carry sockets fine.
    assert.equal(isWindowsBackedPath('/mnt/wsl/foo.sock'), false);
    assert.equal(isWindowsBackedPath('/home/me/git-broker/broker.sock'), false);
    assert.equal(isWindowsBackedPath('/mnt/cc/x.sock'), false);
  });
});

describe('the refusals', () => {
  it('refuses native Windows for the broker, naming why', () => {
    const refusal = platformRefusal('win32');
    assert.match(refusal as string, /native Windows is not supported/);
    assert.match(refusal as string, /WSL/, 'and says where to run it instead');
    assert.equal(platformRefusal('linux'), null);
    assert.equal(platformRefusal('darwin'), null);
  });

  it('refuses a Windows-backed socket path only in WSL', () => {
    assert.match(socketPathRefusal('/mnt/c/x/broker.sock', 'linux', true) as string, /9p\/drvfs/);
    // The same path on a machine that is not WSL is just a path someone chose; do not guess.
    assert.equal(socketPathRefusal('/mnt/c/x/broker.sock', 'linux', false), null);
    assert.equal(socketPathRefusal('/home/me/broker.sock', 'linux', true), null);
    assert.match(socketPathRefusal('/run/git-broker/broker.sock', 'win32', false) as string, /named pipe/);
  });

  it('stops the broker before it creates anything', () => {
    const previous = process.env['WSL_DISTRO_NAME'];
    process.env['WSL_DISTRO_NAME'] = 'Ubuntu';
    try {
      const target = '/mnt/z/git-broker/broker.sock';
      assert.throws(() => prepareSocketPath(target), /refusing to bind at .*9p\/drvfs/);
      // The whole point of checking first: nothing was created on the way to the refusal.
      assert.equal(fs.existsSync('/mnt/z'), false);
    } finally {
      if (previous === undefined) delete process.env['WSL_DISTRO_NAME'];
      else process.env['WSL_DISTRO_NAME'] = previous;
    }
  });
});
