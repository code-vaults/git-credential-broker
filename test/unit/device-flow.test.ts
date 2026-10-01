/**
 * The device flow's three exchanges, against a fetch that answers on cue.
 *
 * The interesting parts are the ones a person would never see: which error means "keep waiting", which
 * means "wait longer", when the code has run out, and the fact that a refresh rotates the refresh token
 * — keeping the old one would work once and then stop.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  collectUserToken,
  DEVICE_CODE_URL,
  DEVICE_GRANT,
  refreshUserToken,
  startDeviceFlow,
  TOKEN_URL,
  type DeviceCode,
  type Fetcher,
} from '../../src/device-flow.ts';

/** One recorded call. */
interface Call {
  readonly url: string;
  readonly body: string;
}

/**
 * A fetch that answers each call in turn, and remembers what it was asked.
 *
 * @param answers - one body per call, in order.
 * @returns the fetch, and the calls it recorded.
 */
function stubFetch(answers: readonly { status?: number; body: string }[]): { fetcher: Fetcher; calls: Call[] } {
  const calls: Call[] = [];
  let index = 0;
  const fetcher: Fetcher = (url, init) => {
    calls.push({ url, body: init.body });
    const answer = answers[index] ?? { body: '{}' };
    index += 1;
    return Promise.resolve({
      ok: (answer.status ?? 200) < 400,
      status: answer.status ?? 200,
      text: () => Promise.resolve(answer.body),
    });
  };
  return { fetcher, calls };
}

/** A sleep that records how long it was asked to wait, and does not wait. */
function stubSleep(): { sleep: (ms: number) => Promise<void>; waits: number[] } {
  const waits: number[] = [];
  return {
    waits,
    sleep: (ms: number) => {
      waits.push(ms);
      return Promise.resolve();
    },
  };
}

/** A device code, as GitHub hands it out. */
const CODE: DeviceCode = {
  deviceCode: 'device-123',
  userCode: 'ABCD-1234',
  verificationUri: 'https://github.com/login/device',
  expiresIn: 900,
  interval: 5,
};

describe('starting a device flow', () => {
  it('asks for a code with the client id, and reads the answer', async () => {
    const { fetcher, calls } = stubFetch([
      {
        body: JSON.stringify({
          device_code: 'd',
          user_code: 'U-1',
          verification_uri: 'https://github.com/login/device',
          expires_in: 900,
          interval: 5,
        }),
      },
    ]);

    const code = await startDeviceFlow('Iv1.abc', fetcher);

    assert.equal(calls[0]?.url, DEVICE_CODE_URL);
    assert.match(calls[0]?.body ?? '', /client_id=Iv1\.abc/);
    assert.deepEqual(code, {
      deviceCode: 'd',
      userCode: 'U-1',
      verificationUri: 'https://github.com/login/device',
      expiresIn: 900,
      interval: 5,
    });
  });

  it('falls back to the usual expiry and interval when GitHub omits them', async () => {
    const { fetcher } = stubFetch([
      { body: JSON.stringify({ device_code: 'd', user_code: 'U', verification_uri: 'https://x' }) },
    ]);

    const code = await startDeviceFlow('id', fetcher);

    assert.equal(code.expiresIn, 900);
    assert.equal(code.interval, 5);
  });

  it('refuses an answer that is not a device code, and says what came back', async () => {
    const { fetcher } = stubFetch([{ status: 404, body: '{"message":"Not Found"}' }]);

    await assert.rejects(startDeviceFlow('id', fetcher), /404.*Not Found/s);
  });
});

describe('collecting the token', () => {
  it('waits through authorization_pending, then takes the token', async () => {
    const { fetcher } = stubFetch([
      { body: '{"error":"authorization_pending"}' },
      { body: '{"error":"authorization_pending"}' },
      { body: '{"access_token":"t","refresh_token":"r","expires_in":28800}' },
    ]);
    const { sleep, waits } = stubSleep();

    const token = await collectUserToken('id', CODE, fetcher, sleep);

    assert.deepEqual(token, { token: 't', refreshToken: 'r', expiresInSeconds: 28800 });
    assert.deepEqual(waits, [5000, 5000, 5000], 'it waited the interval the code asked for, each time');
  });

  it('sends the device grant, not a password grant', async () => {
    const { fetcher, calls } = stubFetch([{ body: '{"access_token":"t"}' }]);

    await collectUserToken('id', CODE, fetcher, stubSleep().sleep);

    assert.equal(calls[0]?.url, TOKEN_URL);
    const expected = `grant_type=${encodeURIComponent(DEVICE_GRANT)}`;
    assert.ok((calls[0]?.body ?? '').includes(expected), `the body should carry ${expected}`);
  });

  it('waits longer when GitHub says to slow down', async () => {
    const { fetcher } = stubFetch([
      { body: '{"error":"slow_down"}' },
      { body: '{"access_token":"t"}' },
    ]);
    const { sleep, waits } = stubSleep();

    await collectUserToken('id', CODE, fetcher, sleep);

    assert.deepEqual(waits, [5000, 10000], 'the second wait is the first plus five seconds');
  });

  it('stops with a reason when the authorization is denied', async () => {
    const { fetcher } = stubFetch([{ body: '{"error":"access_denied"}' }]);

    await assert.rejects(collectUserToken('id', CODE, fetcher, stubSleep().sleep), /denied/);
  });

  it('stops when the code has run out, before polling again', async () => {
    const { fetcher, calls } = stubFetch([{ body: '{"access_token":"t"}' }]);
    const expired: DeviceCode = { ...CODE, expiresIn: -1 };

    await assert.rejects(collectUserToken('id', expired, fetcher, stubSleep().sleep), /expired/);
    assert.equal(calls.length, 0, 'and it did not ask for a token it could not have');
  });

  it('reports an answer it does not recognise instead of looping forever', async () => {
    const { fetcher } = stubFetch([{ status: 500, body: 'boom' }]);

    await assert.rejects(collectUserToken('id', CODE, fetcher, stubSleep().sleep), /500.*boom/s);
  });
});

describe('refreshing the token', () => {
  it('keeps the new refresh token, because the old one stops working', async () => {
    const { fetcher, calls } = stubFetch([
      { body: '{"access_token":"t2","refresh_token":"r2","expires_in":28800}' },
    ]);

    const token = await refreshUserToken('id', 'r1', fetcher);

    assert.deepEqual(token, { token: 't2', refreshToken: 'r2', expiresInSeconds: 28800 });
    assert.match(calls[0]?.body ?? '', /grant_type=refresh_token/);
    assert.match(calls[0]?.body ?? '', /refresh_token=r1/);
  });

  it('keeps the old refresh token when GitHub does not send a new one', async () => {
    const { fetcher } = stubFetch([{ body: '{"access_token":"t2"}' }]);

    assert.equal((await refreshUserToken('id', 'r1', fetcher)).refreshToken, 'r1');
  });

  it('fails loudly when the refresh is refused, which means authorizing again', async () => {
    const { fetcher } = stubFetch([{ status: 400, body: '{"error":"bad_refresh_token"}' }]);

    await assert.rejects(refreshUserToken('id', 'r1', fetcher), /400.*bad_refresh_token/s);
  });
});
