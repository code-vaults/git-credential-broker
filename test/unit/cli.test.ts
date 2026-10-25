import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runCli } from '../../packages/cli/src/index.ts';

/** Capture stdout and stderr for one runCli call. */
async function captureRole(role: 'client' | 'host'): Promise<{ code: number; stdout: string }> {
  let stdout = '';
  const original = process.stdout.write;
  process.stdout.write = ((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    const code = await runCli(['role'], {
      role,
      commands: [],
      help: 'help',
      run: async () => 99,
    });
    return { code, stdout };
  } finally {
    process.stdout.write = original;
  }
}

describe('gcb role', () => {
  it('reports the installed side without dispatching a command', async () => {
    assert.deepEqual(await captureRole('client'), { code: 0, stdout: 'client\n' });
    assert.deepEqual(await captureRole('host'), { code: 0, stdout: 'host\n' });
  });
});
