import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MAX_BODY_CHARS } from '../../packages/cli/src/host-request.ts';
import { MAX_MESSAGE_BYTES, createLineReader } from '../../packages/cli/src/socket-protocol.ts';

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
    assert.deepEqual(lines, []);
    assert.equal(overflow, 1);
  });

  it('accepts a line delivered one byte at a time', () => {
    const line = 'x'.repeat(4096);
    const lines: string[] = [];
    let overflow = 0;
    const write = createLineReader({ maxBytes: line.length, onLine: (value) => lines.push(value), onOverflow: () => overflow++ });
    for (const character of line) write(character);
    write('\n');
    assert.deepEqual(lines, [line]);
    assert.equal(overflow, 0);
  });

  it('reports an oversized unterminated buffer and stops reading', () => {
    const lines: string[] = [];
    let overflow = 0;
    const write = createLineReader({ maxBytes: 4, onLine: (line) => lines.push(line), onOverflow: () => overflow++ });
    write('12345');
    write('ok\n');
    assert.deepEqual(lines, []);
    assert.equal(overflow, 1);
  });
});

describe('protocol message ceiling', () => {
  it('covers the largest legal pull-request body after JSON escaping', () => {
    const body = '\u0000'.repeat(MAX_BODY_CHARS);
    const line = JSON.stringify({ op: 'pull-request', body });
    assert.ok(Buffer.byteLength(line) + 1 <= MAX_MESSAGE_BYTES);
    assert.ok(MAX_MESSAGE_BYTES >= MAX_BODY_CHARS * 6 + 1024);

    const lines: string[] = [];
    let overflow = 0;
    const write = createLineReader({ onLine: (value) => lines.push(value), onOverflow: () => overflow++ });
    write(`${line}\n`);
    assert.equal(lines.length, 1);
    assert.equal(overflow, 0);
  });
});
