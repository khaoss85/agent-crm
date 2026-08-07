#!/usr/bin/env node
// @ts-check

import { startDocsMcpStdio } from '../src/stdio.js';

startDocsMcpStdio().catch((error) => {
  console.error(`[agent-crm:docs-mcp] ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
});
