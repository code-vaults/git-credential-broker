#!/usr/bin/env node
import { runCli } from 'gcb-core';
import { hostBackend } from 'gcb-host';

process.exitCode = await runCli(process.argv.slice(2), hostBackend);
