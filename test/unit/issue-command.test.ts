/**
 * The client half of the person-authored issue route: flag refusals, the opener capability gate,
 * and one successful submission answered by a fake opener.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  channelDir,
  listRequests,
  readRequest,
  writeOpener,
  writeResult,
} from '../../packages/core/src/host-request.ts';
import { sleep, tryRunAsync, type RunResult } from '../common/run.ts';

const CLIENT_BIN = fileURLToPath(new URL('../../packages/client/bin/gcb.js', import.meta.url));

function runClient(
  args: readonly string[],
  cwd: string,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<RunResult> {
  return tryRunAsync(process.execPath, ['--conditions=development', CLIENT_BIN, ...args], {
    cwd,
    env: { ...process.env, ...extraEnv },
    timeoutMs: 5_000,
  });
}

function fixture(): { root: string; dir: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gcb-issue-client-'));
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
  const dir = channelDir(path.join(root, '.git'));
  fs.mkdirSync(dir, { recursive: true });
  return { root, dir, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** Give a git setup and the client their own HOME and config, so insteadOf rules cannot rewrite origin. */
function isolatedGitEnv(root: string): NodeJS.ProcessEnv {
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  return {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'),
    // An inherited GIT_DIR/GIT_WORK_TREE or index would point git at this checkout instead.
    GIT_DIR: undefined,
    GIT_WORK_TREE: undefined,
    GIT_COMMON_DIR: undefined,
    GIT_INDEX_FILE: undefined,
  };
}

function requests(dir: string): string[] {
  return listRequests(dir);
}

/** Serve one broker request and answer it as the app would. */
function broker(
  socketPath: string,
  onRequest: (request: Record<string, unknown>) => void,
): Promise<net.Server> {
  const server = net.createServer((socket) => {
    socket.once('data', (chunk) => {
      onRequest(JSON.parse(chunk.toString().split('\n')[0] ?? '{}') as Record<string, unknown>);
      socket.end(JSON.stringify({ ok: true, exitCode: 0 }) + '\n');
    });
  });
  return new Promise((resolve) => server.listen(socketPath, () => resolve(server)));
}

describe('gcb issue edit and comment --as-user', () => {
  it('sends the broker user identity and the catalogued action', async () => {
    const host = fixture();
    const socketPath = path.join(host.root, 'broker.sock');
    try {
      const cases: readonly { args: string[]; action: string; values: Record<string, unknown> }[] = [
        { args: ['edit', '7', '--title', 'fixed'], action: 'issue:edit', values: { number: '7', title: 'fixed' } },
        { args: ['comment', '7', '--body', 'a note'], action: 'issue:comment', values: { number: '7', body: 'a note' } },
      ];
      for (const entry of cases) {
        let seen: Record<string, unknown> = {};
        const server = await broker(socketPath, (request) => {
          seen = request;
        });
        const result = await runClient(
          ['issue', ...entry.args, '--as-user', '--repo', 'acme/widget', '--socket', socketPath],
          host.root,
        );
        await new Promise<void>((resolve) => server.close(() => resolve()));
        assert.equal(result.status, 0, entry.args.join(' '));
        assert.equal(seen['identity'], 'user', entry.args.join(' '));
        assert.equal(seen['ghAction'], entry.action, entry.args.join(' '));
        assert.deepEqual(seen['values'], entry.values, entry.args.join(' '));
      }
    } finally {
      host.cleanup();
    }
  });
});

describe('gcb issue create --as-user', () => {
  it('refuses when no opener is present', async () => {
    const host = fixture();
    try {
      const result = await runClient(['issue', 'create', '--as-user', 'alice', '--title', 't'], host.root);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /no host broker is watching/);
    } finally {
      host.cleanup();
    }
  });

  it('refuses every capability shape that is not an issue array', async () => {
    const variants: unknown[] = [undefined, 5, 'issue', ['pull-request'], null];
    for (const kinds of variants) {
      const host = fixture();
      try {
        writeOpener(host.dir, { pid: process.pid, ...(kinds === undefined ? {} : { kinds: kinds as string[] }) });
        const result = await runClient(['issue', 'create', '--as-user', 'alice', '--title', 't'], host.root);
        assert.equal(result.status, 1, JSON.stringify(kinds));
        assert.match(result.stderr, /does not advertise issue support/u);
        assert.deepEqual(requests(host.dir), [], 'no request is written before the gate');
      } finally {
        host.cleanup();
      }
    }
  });

  it('submits to an opener that advertises issue support', async () => {
    const host = fixture();
    try {
      writeOpener(host.dir, { pid: process.pid, kinds: ['issue'] });
      const pending = runClient(
        [
          'issue',
          'create',
          '--as-user',
          'alice',
          '--title',
          'a title',
          '--body',
          'a body',
          '--repo',
          'acme/widget',
          '--proxy',
          'http://p:1',
        ],
        host.root,
      );
      let id: string | undefined;
      for (let attempt = 0; attempt < 100 && id === undefined; attempt += 1) {
        id = requests(host.dir)[0];
        if (id === undefined) await sleep(10);
      }
      assert.ok(id !== undefined, 'the client wrote the request');
      const request = readRequest(host.dir, id);
      assert.equal(request?.kind, 'issue');
      assert.equal(request?.title, 'a title');
      assert.equal(request?.body, 'a body');
      assert.equal(request?.repo, 'acme/widget');
      assert.equal(request?.account, 'alice');
      assert.equal(request?.proxy, 'http://p:1');
      writeResult(host.dir, id, { number: 42, url: 'https://github.com/acme/widget/issues/42' });
      const result = await pending;
      assert.equal(result.status, 0);
      assert.match(result.stdout, /opened issue #42 as alice: https:\/\/github\.com\/acme\/widget\/issues\/42/u);
    } finally {
      host.cleanup();
    }
  });

  it('consumes a result that lands during the timeout grace', async () => {
    const host = fixture();
    try {
      writeOpener(host.dir, { pid: process.pid, kinds: ['issue'] });
      const pending = runClient(
        ['issue', 'create', '--as-user', 'alice', '--title', 't'],
        host.root,
        { GCB_OPENER_TIMEOUT_MS: '50' },
      );
      let id: string | undefined;
      for (let attempt = 0; attempt < 100 && id === undefined; attempt += 1) {
        id = requests(host.dir)[0];
        if (id === undefined) await sleep(10);
      }
      assert.ok(id !== undefined, 'the client wrote the request');
      await sleep(150);
      writeResult(host.dir, id, { number: 42, url: 'https://github.com/acme/widget/issues/42' });
      const result = await pending;
      assert.equal(result.status, 0);
      assert.match(result.stdout, /opened issue #42 as alice/u);
    } finally {
      host.cleanup();
    }
  });

  it('reports a request the opener took and dropped', async () => {
    const host = fixture();
    try {
      writeOpener(host.dir, { pid: process.pid, kinds: ['issue'] });
      const pending = runClient(
        ['issue', 'create', '--as-user', 'alice', '--title', 't'],
        host.root,
        { GCB_OPENER_TIMEOUT_MS: '3000' },
      );
      let id: string | undefined;
      for (let attempt = 0; attempt < 100 && id === undefined; attempt += 1) {
        id = requests(host.dir)[0];
        if (id === undefined) await sleep(10);
      }
      assert.ok(id !== undefined, 'the client wrote the request');
      fs.rmSync(path.join(host.dir, id + '.json'), { force: true });
      const result = await pending;
      assert.equal(result.status, 1);
      assert.match(result.stderr, /took .* and dropped it without answering/u);
      assert.match(result.stderr, /does not understand issue requests/u);
    } finally {
      host.cleanup();
    }
  });

  it('keeps the in-flight wording when the request is still present', async () => {
    const host = fixture();
    try {
      writeOpener(host.dir, { pid: process.pid, kinds: ['issue'] });
      const pending = runClient(
        ['issue', 'create', '--as-user', 'alice', '--title', 't'],
        host.root,
        { GCB_OPENER_TIMEOUT_MS: '3000' },
      );
      let id: string | undefined;
      for (let attempt = 0; attempt < 100 && id === undefined; attempt += 1) {
        id = requests(host.dir)[0];
        if (id === undefined) await sleep(10);
      }
      assert.ok(id !== undefined, 'the client wrote the request');
      const result = await pending;
      assert.equal(result.status, 1);
      assert.match(result.stderr, /within 3s/u);
      assert.match(result.stderr, /may still be working/u);
    } finally {
      host.cleanup();
    }
  });

  it('sends bare --as-user as a user issue action', async () => {
    const host = fixture();
    const socketPath = path.join(host.root, 'broker.sock');
    try {
      let seen: Record<string, unknown> = {};
      const bodyFile = path.join(host.root, 'body.md');
      fs.writeFileSync(bodyFile, 'from a file\n');
      const server = await broker(socketPath, (request) => {
        seen = request;
      });
      const result = await runClient(
        [
          'issue',
          'create',
          '--as-user',
          '--repo',
          'acme/widget',
          '--title',
          't',
          '--body-file',
          bodyFile,
          '--socket',
          socketPath,
        ],
        host.root,
      );
      await new Promise<void>((resolve) => server.close(() => resolve()));
      assert.equal(result.status, 0);
      assert.equal(seen['identity'], 'user');
      assert.equal(seen['ghAction'], 'issue:create');
      assert.equal((seen['values'] as Record<string, unknown>)['body'], 'from a file\n');
    } finally {
      host.cleanup();
    }
  });

  it('translates body-file without as-user', async () => {
    const host = fixture();
    const socketPath = path.join(host.root, 'broker.sock');
    try {
      const bodyFile = path.join(host.root, 'body.md');
      fs.writeFileSync(bodyFile, 'app body\n');
      let seen: Record<string, unknown> = {};
      const server = await broker(socketPath, (request) => {
        seen = request;
      });
      const result = await runClient(
        ['issue', 'create', '--repo', 'acme/widget', '--title', 't', '--body-file', bodyFile, '--socket', socketPath],
        host.root,
      );
      await new Promise<void>((resolve) => server.close(() => resolve()));
      assert.equal(result.status, 0);
      assert.equal((seen['values'] as Record<string, unknown>)['body'], 'app body\n');
      assert.equal(seen['identity'], undefined);
    } finally {
      host.cleanup();
    }
  });

  it('keeps the catalogue help and refuses --as-user outside create', async () => {
    const host = fixture();
    try {
      const catalogue = await runClient(['issue', '--help'], host.root);
      assert.equal(catalogue.status, 0);
      assert.match(catalogue.stdout, /Usage: gcb issue/u);

      const view = await runClient(['issue', 'view', '--help'], host.root);
      assert.equal(view.status, 0);
      assert.match(view.stdout, /Usage: gcb gh/u);

      const bareHelp = await runClient(['issue', '--as-user', '--help'], host.root);
      assert.equal(bareHelp.status, 0);
      assert.match(bareHelp.stdout, /Usage: gcb issue/u);

      const edit = await runClient(['issue', 'edit', '--help'], host.root);
      assert.equal(edit.status, 0);
      assert.match(edit.stdout, /Usage: gcb gh/u);

      const create = await runClient(['issue', 'create', '--help'], host.root);
      assert.equal(create.status, 0);
      assert.match(create.stdout, /Usage: gcb issue create/u);

      const top = await runClient(['issue', '--as-user'], host.root);
      assert.equal(top.status, 1);
      assert.match(top.stderr, /--as-user without a login only creates, edits or comments/u);

      const other = await runClient(['issue', 'view', '1', '--as-user', 'alice'], host.root);
      assert.equal(other.status, 1);
      assert.match(other.stderr, /--as-user <login> only creates, edits or comments/u);
    } finally {
      host.cleanup();
    }
  });

  it('resolves the issue repository and host from origin', async () => {
    const host = fixture();
    try {
      const env = isolatedGitEnv(host.root);
      execFileSync('git', ['init', '-q'], { cwd: host.root, env });
      execFileSync('git', ['remote', 'add', 'origin', 'git@ghe.example:acme/widget.git'], { cwd: host.root, env });
      writeOpener(host.dir, { pid: process.pid, kinds: ['issue-edit'] });
      const pending = runClient(['issue', 'edit', '7', '--title', 'fixed', '--as-user', 'alice'], host.root, env);
      let id: string | undefined;
      let request;
      for (let attempt = 0; attempt < 100 && request === undefined; attempt += 1) {
        id = requests(host.dir).find((candidate) => readRequest(host.dir, candidate)?.kind === 'issue-edit');
        request = id === undefined ? undefined : readRequest(host.dir, id);
        if (request === undefined) await sleep(10);
      }
      assert.ok(request, 'the edit reached the host broker');
      if (request?.kind !== 'issue-edit') throw new Error('expected an issue-edit request');
      assert.equal(request.repo, 'acme/widget');
      assert.equal(request.host, 'ghe.example');
      writeResult(host.dir, id as string, { number: 7, url: 'https://ghe.example/acme/widget/issues/7' });
      const result = await pending;
      assert.equal(result.status, 0);
    } finally {
      host.cleanup();
    }
  });

  it('refuses an explicit host that does not match origin', async () => {
    const host = fixture();
    try {
      const env = isolatedGitEnv(host.root);
      execFileSync('git', ['init', '-q'], { cwd: host.root, env });
      execFileSync('git', ['remote', 'add', 'origin', 'git@ghe.example:acme/widget.git'], { cwd: host.root, env });
      writeOpener(host.dir, { pid: process.pid, kinds: ['issue-edit'] });
      const result = await runClient(
        ['issue', 'edit', '7', '--title', 'fixed', '--as-user', 'alice', '--host', 'github.com'],
        host.root,
        env,
      );
      assert.equal(result.status, 1);
      assert.match(result.stderr, /remote is on ghe\.example, but --host is github\.com/u);
      assert.deepEqual(requests(host.dir), [], 'no request is written');
    } finally {
      host.cleanup();
    }
  });

  it('sends issue edit and comment through the host broker', async () => {
    const host = fixture();
    try {
      writeOpener(host.dir, { pid: process.pid, kinds: ['issue-edit', 'issue-comment'] });
      for (const entry of [
        { kind: 'issue-edit', args: ['edit', '7', '--title', 'fixed'] },
        { kind: 'issue-comment', args: ['comment', '7', '--body', 'a note'] },
      ]) {
        const pending = runClient(
          ['issue', ...entry.args, '--as-user', 'alice', '--repo', 'acme/widget'],
          host.root,
        );
        let id: string | undefined;
        let request;
        for (let attempt = 0; attempt < 100 && request === undefined; attempt += 1) {
          id = requests(host.dir).find((candidate) => readRequest(host.dir, candidate)?.kind === entry.kind);
          request = id === undefined ? undefined : readRequest(host.dir, id);
          if (request === undefined) await sleep(10);
        }
        assert.ok(request, entry.kind + ' reached the host broker');
        assert.equal(request?.kind, entry.kind);
        writeResult(host.dir, id as string, {
          number: 7,
          url: 'https://github.com/acme/widget/issues/7',
        });
        const result = await pending;
        assert.equal(result.status, 0, entry.kind);
        assert.match(result.stdout, new RegExp(entry.kind === 'issue-edit' ? 'edited issue #7' : 'commented on issue #7'));
      }
    } finally {
      host.cleanup();
    }
  });

  it('takes the issue number positionally and refuses --number/value-drift flags', async () => {
    const host = fixture();
    try {
      const wrong = await runClient(
        ['issue', 'edit', '--number', '7', '--title', 'fixed', '--as-user', 'alice', '--repo', 'acme/widget'],
        host.root,
      );
      assert.equal(wrong.status, 1);
      assert.match(wrong.stderr, /unknown option --number for gcb issue edit --as-user/u);

      const proxy = await runClient(
        ['issue', 'edit', '7', '--title', 'fixed', '--as-user', 'alice', '--repo', 'acme/widget', '--proxy'],
        host.root,
      );
      assert.equal(proxy.status, 1);
      assert.match(proxy.stderr, /--proxy needs a value/u);

      const emptyRepo = await runClient(
        ['issue', 'edit', '7', '--title', 'fixed', '--as-user', 'alice', '--repo', ''],
        host.root,
      );
      assert.equal(emptyRepo.status, 1);
      assert.match(emptyRepo.stderr, /--repo needs a value/u);

      const extra = await runClient(
        ['issue', 'edit', '7', '8', '--title', 'fixed', '--as-user', 'alice', '--repo', 'acme/widget'],
        host.root,
      );
      assert.equal(extra.status, 1);
      assert.match(extra.stderr, /unexpected argument "8"/u);

      const commentTitle = await runClient(
        ['issue', 'comment', '7', '--title', 't', '--body', 'b', '--as-user', 'alice', '--repo', 'acme/widget'],
        host.root,
      );
      assert.equal(commentTitle.status, 1);
      assert.match(commentTitle.stderr, /--title is only supported for issue edit/u);

      const emptyComment = await runClient(
        ['issue', 'comment', '7', '--body', '   ', '--as-user', '--repo', 'acme/widget'],
        host.root,
      );
      assert.equal(emptyComment.status, 1);
      assert.match(emptyComment.stderr, /issue comment needs --body or --body-file/u);

      const noBodyValue = await runClient(
        ['issue', 'edit', '7', '--title', 'fixed', '--body', '--as-user', 'alice', '--repo', 'acme/widget'],
        host.root,
      );
      assert.equal(noBodyValue.status, 1);
      assert.match(noBodyValue.stderr, /--body needs a value/u);

      const bareRepo = await runClient(
        ['issue', 'edit', '7', '--title', 'fixed', '--repo', '--as-user', 'alice'],
        host.root,
      );
      assert.equal(bareRepo.status, 1);
      assert.match(bareRepo.stderr, /--repo needs a value/u);

      const empty = await runClient(
        ['issue', 'edit', '7', '--as-user', 'alice', '--repo', 'acme/widget'],
        host.root,
      );
      assert.equal(empty.status, 1);
      assert.match(empty.stderr, /issue edit needs --title, --body or --body-file/u);

      const huge = await runClient(
        [
          'issue',
          'edit',
          '9223372036854775808',
          '--title',
          'fixed',
          '--as-user',
          'alice',
          '--repo',
          'acme/widget',
        ],
        host.root,
      );
      assert.equal(huge.status, 1);
      assert.match(huge.stderr, /safe positive issue number/u);

      const both = await runClient(
        [
          'issue',
          'edit',
          '7',
          '--title',
          'fixed',
          '--as-user',
          'alice',
          '--repo',
          'acme/widget',
          '--proxy',
          'http://p:1',
          '--no-proxy',
        ],
        host.root,
      );
      assert.equal(both.status, 1);
      assert.match(both.stderr, /mutually exclusive/u);
    } finally {
      host.cleanup();
    }
  });

  it('treats -h in an issue create title as help', async () => {
    const host = fixture();
    try {
      const result = await runClient(
        ['issue', 'create', '--as-user', 'alice', '--repo', 'acme/widget', '--title', '-h', '--body', 'b'],
        host.root,
      );
      assert.equal(result.status, 0);
      assert.match(result.stdout, /Usage: gcb issue/u);
      assert.deepEqual(requests(host.dir), [], 'no request is written');
    } finally {
      host.cleanup();
    }
  });

  it('never writes a request for issue edit help', async () => {
    const host = fixture();
    try {
      const edit = await runClient(['issue', 'edit', '--help'], host.root);
      assert.equal(edit.status, 0);
      assert.match(edit.stdout, /Usage: gcb gh/u);

      const before = requests(host.dir).length;
      const help = await runClient(
        ['issue', 'edit', '7', '--title', 't', '--as-user', 'alice', '--repo', 'acme/widget', '--help'],
        host.root,
      );
      assert.equal(help.status, 0);
      assert.match(help.stdout, /Usage: gcb gh/u);
      assert.equal(requests(host.dir).length, before, 'help writes no request');

      const helpAsValue = await runClient(
        ['issue', 'edit', '7', '--title', '-h', '--as-user', 'alice', '--repo', 'acme/widget'],
        host.root,
      );
      assert.equal(helpAsValue.status, 0);
      assert.match(helpAsValue.stdout, /Usage: gcb gh/u);
      assert.equal(requests(host.dir).length, before, '-h as a value still means help');
    } finally {
      host.cleanup();
    }
  });

  it('lets the catalog report unknown and missing options without a login', async () => {
    const host = fixture();
    try {
      const noSocket = { HOME: host.root, GIT_BROKER_SOCKET: undefined, GIT_BROKER_SOCKET_FILE: undefined };
      const unknown = await runClient(
        ['issue', 'edit', '7', '--bogus', '--repo', 'acme/widget'],
        host.root,
        noSocket,
      );
      assert.equal(unknown.status, 1);
      assert.match(unknown.stderr, /unknown option --bogus for gcb gh issue edit/u);

      const missing = await runClient(
        ['issue', 'edit', '7', '--title', '--repo', 'acme/widget'],
        host.root,
        noSocket,
      );
      assert.equal(missing.status, 1);
      assert.match(missing.stderr, /--title needs a value/u);
    } finally {
      host.cleanup();
    }
  });

  it('refuses flags the host route does not carry', async () => {
    const host = fixture();
    try {
      const cases: [readonly string[], RegExp][] = [
        [['--repo', ''], /--repo needs a value/u],
        [['--proxy'], /--proxy needs a value/u],
        [['--proxy', 'http://p:1', '--no-proxy'], /mutually exclusive/u],
        [['--as-user', 'alice', '--as-user', 'bob'], /may only be given once/u],
        [['--label', 'x'], /unknown option --label/u],
      ];
      for (const [extra, expected] of cases) {
        const result = await runClient(
          ['issue', 'create', '--as-user', 'alice', '--title', 't', ...extra],
          host.root,
        );
        assert.equal(result.status, 1, extra.join(' '));
        assert.match(result.stderr, expected);
        assert.deepEqual(requests(host.dir), [], 'a refusal writes no request');
      }
    } finally {
      host.cleanup();
    }
  });
});
