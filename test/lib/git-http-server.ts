/**
 * A minimal authenticated git smart-HTTP server, used to prove the whole chain end to end
 * without touching the internet or a real GitHub App.
 *
 * It enforces HTTP Basic auth before anything else, then hands the request to the real
 * `git http-backend` CGI program. That is the same backend GitHub-style forges use for
 * `git-upload-pack`/`git-receive-pack` over HTTP, so the client under test exercises genuine
 * git protocol negotiation rather than a stub.
 */
import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type { IncomingMessage, Server } from 'node:http';

/** One request the server saw. */
export interface AuthAttempt {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly authorized: boolean;
  readonly username: string | null;
}

/** Options for {@link createGitHttpServer}. */
export interface GitHttpServerOptions {
  /** `GIT_PROJECT_ROOT`: the directory holding the bare repositories. */
  readonly root: string;
  /** The only accepted Basic auth username. */
  readonly username: string;
  /** The only accepted Basic auth password. */
  readonly password: string;
  /** Diagnostics sink. */
  readonly log?: (message: string) => void;
}

/** The running server. */
export interface GitHttpServer {
  readonly attempts: AuthAttempt[];
  readonly server: Server;
  listen(): Promise<number>;
  close(): Promise<void>;
}

/**
 * Compare two strings without leaking their length or content through timing.
 *
 * @param a - first value.
 * @param b - second value.
 * @returns whether they are equal.
 */
function constantTimeEqual(a: unknown, b: unknown): boolean {
  const left = Buffer.from(String(a), 'utf8');
  const right = Buffer.from(String(b), 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Parse an HTTP Basic `Authorization` header.
 *
 * @param header - the raw header value.
 * @returns the decoded pair, or null.
 */
export function parseBasicAuth(header: unknown): { username: string; password: string } | null {
  if (typeof header !== 'string') return null;
  const match = /^Basic\s+(.+)$/i.exec(header.trim());
  const encoded = match?.[1];
  if (!encoded) return null;
  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  if (separator < 0) return null;
  return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
}

/**
 * Read a request body fully.
 *
 * Read eagerly rather than streamed, so `CONTENT_LENGTH` can always be set: CGI has no way
 * to describe a chunked request body, and git uses chunked encoding for some pushes.
 *
 * @param request - the request.
 * @returns the body.
 */
function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

/** A parsed CGI response. */
interface CgiResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: Buffer;
}

/**
 * Split CGI output into status, headers and body.
 *
 * @param buffer - the CGI program's stdout.
 * @returns the parsed response, or null when the output is not CGI.
 */
function parseCgiOutput(buffer: Buffer): CgiResponse | null {
  const separator = buffer.indexOf('\r\n\r\n');
  if (separator < 0) return null;
  const headers: Record<string, string> = {};
  let status = 200;
  for (const line of buffer.subarray(0, separator).toString('utf8').split('\r\n')) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (name.toLowerCase() === 'status') status = Number.parseInt(value, 10) || 200;
    else headers[name] = value;
  }
  return { status, headers, body: buffer.subarray(separator + 4) };
}

/**
 * Create the server.
 *
 * @param options - server options.
 * @returns the server handle.
 */
export function createGitHttpServer(options: GitHttpServerOptions): GitHttpServer {
  const { root, username, password, log = () => {} } = options;
  const attempts: AuthAttempt[] = [];
  let port = 0;

  const server = http.createServer((request, response) => {
    void (async (): Promise<void> => {
      const credentials = parseBasicAuth(request.headers.authorization);
      const authorized =
        credentials !== null &&
        constantTimeEqual(credentials.username, username) &&
        constantTimeEqual(credentials.password, password);
      attempts.push({
        method: request.method,
        url: request.url,
        authorized,
        username: credentials?.username ?? null,
      });
      log(`[git-http] ${request.method ?? '?'} ${request.url ?? '?'} authorized=${String(authorized)}`);

      if (!authorized) {
        response.writeHead(401, {
          'www-authenticate': 'Basic realm="git"',
          'content-type': 'text/plain',
        });
        response.end('authentication required\n');
        return;
      }

      const body = await readBody(request);
      const requestUrl = request.url ?? '/';
      const queryIndex = requestUrl.indexOf('?');
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: '1',
        PATH_INFO: new URL(requestUrl, 'http://localhost').pathname,
        QUERY_STRING: queryIndex >= 0 ? requestUrl.slice(queryIndex + 1) : '',
        REQUEST_METHOD: request.method ?? 'GET',
        CONTENT_TYPE: request.headers['content-type'] ?? '',
        CONTENT_LENGTH: String(body.length),
        REMOTE_USER: username,
        REMOTE_ADDR: '127.0.0.1',
        SERVER_PROTOCOL: 'HTTP/1.1',
        SERVER_NAME: 'localhost',
        SERVER_PORT: String(port),
        GATEWAY_INTERFACE: 'CGI/1.1',
      };
      const protocol = request.headers['git-protocol'];
      if (typeof protocol === 'string') env['HTTP_GIT_PROTOCOL'] = protocol;

      const child = spawn('git', ['http-backend'], { env });
      const chunks: Buffer[] = [];
      let responded = false;
      const finish = (callback: () => void): void => {
        if (responded) return;
        responded = true;
        callback();
      };

      child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => log(`[git-http-backend] ${chunk.toString('utf8').trim()}`));
      child.on('error', (error: Error) =>
        finish(() => {
          response.writeHead(500, { 'content-type': 'text/plain' });
          response.end(`cannot run git http-backend: ${error.message}`);
        }),
      );
      child.on('close', () =>
        finish(() => {
          const parsed = parseCgiOutput(Buffer.concat(chunks));
          if (!parsed) {
            response.writeHead(500, { 'content-type': 'text/plain' });
            response.end('git http-backend produced no CGI output');
            return;
          }
          response.writeHead(parsed.status, parsed.headers);
          response.end(parsed.body);
        }),
      );
      // git http-backend can exit without reading the body (it refuses some requests before
      // touching stdin). Writing to that closed pipe would raise an unhandled EPIPE and crash
      // the server instead of returning a response.
      child.stdin.on('error', () => {});
      child.stdin.end(body);
    })();
  });

  return {
    attempts,
    server,
    async listen(): Promise<number> {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      const address = server.address();
      port = typeof address === 'object' && address !== null ? address.port : 0;
      return port;
    },
    close(): Promise<void> {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
