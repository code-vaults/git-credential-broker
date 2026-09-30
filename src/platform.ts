/**
 * Platform facts this design depends on.
 *
 * The broker's transport is a unix domain socket and its access control is file permissions with the
 * broker and its client sharing a uid. Both are POSIX. On **native Windows** neither exists, and the
 * failure is not obvious: the socket path becomes a named pipe, the mode bits stop meaning anything,
 * and the broker comes up looking healthy while nothing enforces who may ask it for credentials.
 *
 * Inside **WSL** all of that works, with one trap of its own: the Windows drives mounted at
 * `/mnt/<letter>` are 9p/drvfs, and a unix socket cannot live on them. WSL is a Linux kernel next to
 * a filesystem that will silently not support the thing you are about to create.
 *
 * So: refuse native Windows, and refuse to put a socket on a Windows-backed mount. Both are checks
 * against a configuration that would otherwise appear to work.
 */
import os from 'node:os';
import path from 'node:path';

/** Whether this process is running on native Windows, where this design cannot work. */
export function isNativeWindows(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32';
}

/**
 * Whether this is WSL: Linux, beside a Windows filesystem that cannot carry a socket.
 *
 * Detected the way everything else detects it — the variables WSL sets, or the kernel release string
 * — and either one alone is enough, because they have been added to over time.
 *
 * @param env - the environment to read.
 * @param release - the kernel release string to inspect.
 * @returns true inside a WSL distribution.
 */
export function isWsl(env: NodeJS.ProcessEnv = process.env, release: string = os.release()): boolean {
  return (
    env['WSL_DISTRO_NAME'] !== undefined || env['WSL_INTEROP'] !== undefined || /microsoft/i.test(release)
  );
}

/**
 * Whether a path is on a Windows drive mounted into WSL (`/mnt/c/...`), which is 9p/drvfs.
 *
 * @param target - the path to test.
 * @returns true when the path is Windows-backed.
 */
export function isWindowsBackedPath(target: string): boolean {
  return /^\/mnt\/[a-z](\/|$)/i.test(path.posix.normalize(target));
}

/**
 * The reason a socket may not be bound at this path, if there is one.
 *
 * @param socketPath - the configured socket path.
 * @param platform - the platform to answer for.
 * @param inWsl - whether this is WSL.
 * @returns a message to refuse with, or null to proceed.
 */
export function socketPathRefusal(
  socketPath: string,
  platform: NodeJS.Platform = process.platform,
  inWsl: boolean = isWsl(),
): string | null {
  if (isNativeWindows(platform)) {
    return 'native Windows is not supported: the socket would be a named pipe and the mode bits would enforce nothing';
  }
  if (inWsl && isWindowsBackedPath(socketPath)) {
    return (
      `${socketPath} is on a Windows-backed mount (/mnt/<drive>, 9p/drvfs), which cannot carry a unix socket. ` +
      "Put it on the WSL distribution's own filesystem, for example ~/git-broker"
    );
  }
  return null;
}

/**
 * The message to refuse with when this platform is unsupported, or null.
 *
 * @param platform - the platform to answer for.
 * @returns the refusal, in the shape the CLI prints.
 */
export function platformRefusal(platform: NodeJS.Platform = process.platform): string | null {
  if (!isNativeWindows(platform)) return null;
  return (
    'native Windows is not supported, and configuring git here would not change that: the transport\n' +
    "       is a unix socket and a Windows process cannot reach one. Run this inside WSL — with the\n" +
    "       socket on the distribution's own filesystem, not under /mnt — or in a container on the same\n" +
    '       machine as the broker.'
  );
}
