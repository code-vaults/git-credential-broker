import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createLineReader } from '../../packages/cli/src/socket-protocol.ts';

describe('createLineReader', () => {
  it('splits lines across chunks and ignores blank lines', () => {
    const lines: string[] = [];
    const write = createLineReader({ onLine: (line) => lines.push(line) });
    write('one\ntw');
    write('o\n\n');
    assert.deepEqual(lines, ['one', 'two']);
  });

  it('reports an oversized complete line before onLine can parse it', () => {
    const lines: string[] = [];
    let overflow = 0;
    const write = createLineReader({ maxBytes: 8, onLine: (line) => lines.push(line), onOverflow: () => overflow++ });
    write('123456789\nok\n');
    assert.deepEqual(lines, ['ok']);
    assert.equal(overflow, 1);
  });

  it('reports an oversized unterminated buffer and resets it', () => {
    const lines: string[] = [];
    let overflow = 0;
    const write = createLineReader({ maxBytes: 4, onLine: (line) => lines.push(line), onOverflow: () => overflow++ });
    write('12345');
    write('ok\n');
    assert.deepEqual(lines, ['ok']);
    assert.equal(overflow, 1);
  });
});
