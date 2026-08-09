#!/usr/bin/env node
// @ts-check

import { startMcpStdio } from '../src/stdio.js';

startMcpStdio().catch((error) => {
  console.error(`[accordo:mcp] ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
});
