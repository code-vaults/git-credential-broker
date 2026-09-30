#!/usr/bin/env node
/**
 * Broker daemon entry point. Runs on the host, outside every path the agent container can
 * see, and holds the only long-lived secret.
 *
 *   git-credential-brokerd --config /volume1/docker/git-cred-broker/config.json
 *   git-credential-brokerd --config ... --check    # validate and exit
 */
import { runDaemon } from '../daemon.ts';

process.exitCode = await runDaemon(process.argv.slice(2));
