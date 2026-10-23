#!/usr/bin/env node
/**
 * Broker daemon entry point. Runs on the host, outside every path the agent container can
 * see, and holds the only long-lived secret.
 *
 *   git-credential-brokerd --config /volume1/docker/git-cred-broker/broker.config.toml
 *   git-credential-brokerd --config ... --check    # validate and exit
 */


import { platformRefusal } from '../platform.ts';
import { assertProxyEnabled } from '../proxy.ts';

assertProxyEnabled();

// Refuse before importing the configuration layer. That layer imports smol-toml, and the Windows
// CI job deliberately runs without installing dependencies: the refusal must not depend on a
// package that only exists on a supported platform.
const refusal = platformRefusal();
if (refusal !== null) {
  process.stderr.write(`git-credential-brokerd: ${refusal}\n`);
  process.exitCode = 1;
} else {
  const { runDaemon } = await import('../daemon.ts');
  process.exitCode = await runDaemon(process.argv.slice(2));
}
