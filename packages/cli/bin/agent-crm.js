#!/usr/bin/env node
// @ts-check

import { runCli } from '../src/commands.js';

runCli(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
