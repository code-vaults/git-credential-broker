#!/usr/bin/env node
/**
 * git credential helper entry point.
 *
 * git invokes this as:
 *   git-credential-broker <get|store|erase>
 * with the credential description on stdin and expects `key=value` lines on stdout.
 *
 * Wire it up with the command name git derives from the helper id:
 *   git config --global credential.helper broker
 *   git config --global credential.useHttpPath true
 * and export the socket path the broker listens on:
 *   export GIT_BROKER_SOCKET=/run/git-cred-broker/broker.sock
 *   export GIT_BROKER_REQUIRE=1
 */
import { runHelper } from '../helper.ts';

process.exitCode = await runHelper(process.argv.slice(2));
