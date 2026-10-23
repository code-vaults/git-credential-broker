#!/usr/bin/env node
import { runCli } from 'gcb-cli';
import { hostBackend } from 'gcb-host';

process.exitCode = await runCli(process.argv.slice(2), hostBackend);
