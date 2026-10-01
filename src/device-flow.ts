/**
 * The device flow: how a person authorizes the app when the host has no browser.
 *
 * The point of it here is that it is the only way to obtain a **user** token without a callback
 * server: GitHub hands the tool a short code to display, the person types it on whatever device has a
 * browser, and the tool collects the token by polling. An installation token can never be a person's,
 * which is exactly what is wanted — a pull request authored by the app is one reviewers may skip.
 *
 * Only the three exchanges live here, with fetch and sleep injected so they can be tested without a
 * network or a clock. Deciding where the refresh token is stored, and who is allowed to ask for one, is
 * somebody else's business.
 */

/** What a fetch has to look like for these exchanges. */
export type Fetcher = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** How long to wait between polls. */
export type Sleep = (ms: number) => Promise<void>;

/** What GitHub hands out to start with. */
export interface DeviceCode {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  /** Seconds the code stays valid. */
  readonly expiresIn: number;
  /** Seconds to wait between polls, as GitHub asks. */
  readonly interval: number;
}

/** A user token, and what it takes to get another one. */
export interface UserToken {
  readonly token: string;
  /** Present when the app expires user tokens, which is the default and what is wanted here. */
  readonly refreshToken?: string;
  readonly expiresInSeconds?: number;
}

/** GitHub's endpoints. A constant so a test can see what is being called. */
export const DEVICE_CODE_URL = 'https://github.com/login/device/code';
export const TOKEN_URL = 'https://github.com/login/oauth/access_token';
/** The grant type the device flow uses when it collects the token. */
export const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

/**
 * Read a JSON body, without pretending a non-JSON one is a mystery.
 *
 * A refused request can answer with a page rather than with JSON. Letting `JSON.parse` throw there
 * replaces "GitHub answered 500" with an error about a token, which is the wrong story entirely.
 *
 * @param text - the response body.
 * @returns the parsed object, or an empty one when it is not JSON.
 */
function parseJson(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
/**
 * Ask for a code to show a person.
 *
 * @param clientId - the app's client id, which a device flow needs and a secret it does not.
 * @param fetcher - how to make the request.
 * @returns the code to display and how to poll for it.
 * @throws {Error} when GitHub refuses, naming the status and whatever it said.
 */
export async function startDeviceFlow(clientId: string, fetcher: Fetcher): Promise<DeviceCode> {
  const body = new URLSearchParams({ client_id: clientId }).toString();
  const response = await fetcher(DEVICE_CODE_URL, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`GitHub answered ${response.status} to the device code request: ${text.slice(0, 200)}`);
  }
  const parsed = parseJson(text) as {
    device_code?: string;
    user_code?: string;
    verification_uri?: string;
    expires_in?: number;
    interval?: number;
  };
  if (!parsed.device_code || !parsed.user_code || !parsed.verification_uri) {
    throw new Error(`GitHub did not answer with a device code: ${text.slice(0, 200)}`);
  }
  return {
    deviceCode: parsed.device_code,
    userCode: parsed.user_code,
    verificationUri: parsed.verification_uri,
    expiresIn: parsed.expires_in ?? 900,
    interval: parsed.interval ?? 5,
  };
}

/**
 * Wait until the person has authorized, then collect the token.
 *
 * `authorization_pending` is the normal answer while waiting, `slow_down` means GitHub wants a longer
 * pause, and the rest are endings. Anything else is a failure worth showing.
 *
 * @param clientId - the app's client id.
 * @param code - what {@link startDeviceFlow} returned.
 * @param fetcher - how to make the request.
 * @param sleep - how to wait.
 * @returns the token, and the refresh token when there is one.
 * @throws {Error} when the code expires, is refused, or GitHub answers something unexpected.
 */
export async function collectUserToken(
  clientId: string,
  code: DeviceCode,
  fetcher: Fetcher,
  sleep: Sleep,
): Promise<UserToken> {
  const deadline = Date.now() + code.expiresIn * 1_000;
  let interval = code.interval;
  for (;;) {
    await sleep(Math.max(interval, 1) * 1_000);
    if (Date.now() > deadline) throw new Error('the device code expired before it was authorized');

    const response = await fetcher(TOKEN_URL, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        device_code: code.deviceCode,
        grant_type: DEVICE_GRANT,
      }).toString(),
    });
    const text = await response.text();
    const parsed = parseJson(text) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      error?: string;
    };

    if (parsed.access_token) {
      return {
        token: parsed.access_token,
        refreshToken: parsed.refresh_token,
        expiresInSeconds: parsed.expires_in,
      };
    }
    if (parsed.error === 'authorization_pending') continue;
    if (parsed.error === 'slow_down') {
      interval += 5;
      continue;
    }
    if (parsed.error === 'access_denied') throw new Error('the authorization was denied');
    if (parsed.error === 'expired_token') throw new Error('the device code expired');
    throw new Error(`GitHub answered ${response.status} to the token request: ${text.slice(0, 200)}`);
  }
}

/**
 * Trade a refresh token for a fresh user token.
 *
 * @param clientId - the app's client id.
 * @param refreshToken - the one from last time.
 * @param fetcher - how to make the request.
 * @returns the new token, and the new refresh token to keep instead of the old one.
 * @throws {Error} when GitHub refuses, which one day means the person has to authorize again.
 */
export async function refreshUserToken(
  clientId: string,
  refreshToken: string,
  fetcher: Fetcher,
): Promise<UserToken> {
  const response = await fetcher(TOKEN_URL, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }).toString(),
  });
  const text = await response.text();
  const parsed = parseJson(text) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
  };
  if (!parsed.access_token) {
    throw new Error(`GitHub answered ${response.status} to the refresh: ${text.slice(0, 200)}`);
  }
  return {
    token: parsed.access_token,
    refreshToken: parsed.refresh_token ?? refreshToken,
    expiresInSeconds: parsed.expires_in,
  };
}
