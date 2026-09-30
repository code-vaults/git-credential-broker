#!/usr/bin/env node
/**
 * One command, two jobs.
 *
 * git runs `git-credential-broker <get|store|erase>` and speaks the credential protocol on
 * stdin/stdout; a human runs `git-credential-broker <setup|init|compose|probe|diagnose>`. The
 * protocol operations are recognised exactly and everything else goes to the CLI, so `git push`
 * and `git-credential-broker setup` are served by the same installed command.
 *
 * Wire it up with the name git derives from the helper id:
 *   git config --global credential.helper broker
 *   git config --global credential.useHttpPath true
 * or with the one command that does both:
 *   git-credential-broker setup
 */
import { runCli } from '../commands/index.ts';
import { runHelper } from '../helper.ts';

/** The three operations of the git credential-helper protocol. */
const HELPER_OPERATIONS = new Set(['get', 'store', 'erase']);

const argv = process.argv.slice(2);
const operation = argv[0];

if (operation !== undefined && HELPER_OPERATIONS.has(operation)) {
  process.exitCode = await runHelper(argv);
} else {
  process.exitCode = await runCli(argv);
}
