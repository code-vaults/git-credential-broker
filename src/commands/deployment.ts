/**
 * Where each deployment expects its files, from the **broker's** point of view.
 *
 * This module exists because of one easily-missed fact: the paths inside `broker.config.json` are
 * resolved by whichever process reads the file. A broker running as a host process sees the
 * host's filesystem, and a broker running as a sidecar sees only what its `volumes:` mount.
 * The same file therefore means two different things, and one config cannot serve both.
 *
 * Both `init --mode` and `compose` derive from here, so the two halves cannot drift apart —
 * which they did once: `init` recorded host paths while `compose` mounted the files at container
 * paths, producing a sidecar that could not read its own key.
 */
import path from 'node:path';

import type { BrokerConfig } from '../types.ts';

/** The two supported deployments. */
export type DeploymentMode = 'host' | 'sidecar';

/** The modes, for validation and help text. */
export const DEPLOYMENT_MODES: readonly DeploymentMode[] = ['host', 'sidecar'];

/**
 * Fixed paths inside the sidecar.
 *
 * These are a contract with the compose file `compose` prints, which is why they are constants
 * rather than options: a mismatch here is a broker that will not start.
 */
export const SIDECAR = {
  configPath: '/etc/git-cred-broker/broker.config.json',
  keyPath: '/etc/git-cred-broker/app.pem',
  auditDir: '/var/log/git-cred-broker',
  auditPath: '/var/log/git-cred-broker/audit.jsonl',
  socketDir: '/run/git-broker',
  socketPath: '/run/git-broker/broker.sock',
} as const;

/** Paths recorded in the configuration, as the broker process will resolve them. */
export interface BrokerPaths {
  readonly socketPath: string;
  readonly privateKeyPath: string;
  readonly auditPath: string;
}

/** Files `init` writes on the host. The same in both modes; only the recorded paths differ. */
export interface HostArtifacts {
  readonly keyPath: string;
  readonly configPath: string;
  readonly auditDir: string;
}

/** The socket path a host-process deployment uses unless told otherwise. */
export const HOST_SOCKET_PATH_DEFAULT = '/run/git-cred-broker/broker.sock';

/**
 * The host-side files a deployment needs, regardless of mode.
 *
 * @param dir - the host directory holding the deployment.
 * @returns the paths on the host.
 */
export function hostArtifacts(dir: string): HostArtifacts {
  return {
    keyPath: path.join(dir, 'app.pem'),
    configPath: path.join(dir, 'broker.config.json'),
    auditDir: path.join(dir, 'log'),
  };
}

/**
 * The paths to record in the configuration for one deployment.
 *
 * @param mode - which deployment the broker will run as.
 * @param dir - the host directory holding the deployment.
 * @param hostSocketPath - the socket path a host process should use; ignored in sidecar mode.
 * @returns the paths as the broker will resolve them.
 */
export function brokerPaths(
  mode: DeploymentMode,
  dir: string,
  hostSocketPath: string = HOST_SOCKET_PATH_DEFAULT,
): BrokerPaths {
  if (mode === 'sidecar') {
    return {
      socketPath: SIDECAR.socketPath,
      privateKeyPath: SIDECAR.keyPath,
      auditPath: SIDECAR.auditPath,
    };
  }
  return {
    socketPath: hostSocketPath,
    privateKeyPath: path.join(dir, 'app.pem'),
    auditPath: path.join(dir, 'log', 'audit.jsonl'),
  };
}

/**
 * Which deployment a configuration was written for.
 *
 * Derived from its paths rather than stored, because the paths are what actually decide whether
 * a sidecar can find its key.
 *
 * @param config - a validated configuration.
 * @returns the deployment it suits.
 */
export function inferMode(config: BrokerConfig): DeploymentMode {
  const block = config.hosts['github.com'];
  const keyPath = block?.provider === 'github-app' ? block.privateKeyPath : undefined;
  return keyPath === SIDECAR.keyPath && config.socketPath === SIDECAR.socketPath ? 'sidecar' : 'host';
}

/**
 * Reject an override that cannot apply in sidecar mode.
 *
 * The compose file fixes these locations, so silently ignoring a different value would produce a
 * broker that starts and then cannot find its own key. Failing loudly is the only kind option.
 *
 * @param flag - the flag name, for the message.
 * @param given - the value the user supplied, if any.
 * @param fixed - the value the deployment requires.
 * @param mode - the chosen deployment.
 * @throws {Error} when sidecar mode was chosen and a conflicting value was supplied.
 */
export function requireFixedInSidecar(
  flag: string,
  given: string | undefined,
  fixed: string,
  mode: DeploymentMode,
): void {
  if (mode !== 'sidecar' || given === undefined || given === fixed) return;
  throw new Error(
    `${flag} must be ${fixed} with --mode sidecar, because the compose file mounts it there; got ${given}`,
  );
}
