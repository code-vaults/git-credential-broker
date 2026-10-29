#!/usr/bin/env node
import { runCli } from 'gcb-core';
import { clientBackend, runHelper } from 'gcb-client';

const argv = process.argv.slice(2);
const operation = argv[0];

if (operation === 'get' || operation === 'store' || operation === 'erase') {
  process.exitCode = await runHelper(argv);
} else {
  process.exitCode = await runCli(argv, clientBackend);
}
