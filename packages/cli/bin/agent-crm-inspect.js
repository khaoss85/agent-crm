#!/usr/bin/env node
// @ts-check

import { writeSync } from 'node:fs';
import { inspectApplication } from '../src/app-inspect.js';

/**
 * The isolated loader for `crm app inspect`.
 *
 * Inspection has to import the project's checked-in composition, and importing
 * a code-first definition runs its module body. That is the framework's normal
 * trust boundary — repository source is trusted — but it is still a body of
 * code whose import-time behaviour nobody promised anything about: it may
 * mutate globals, monkey-patch a built-in, install a handler or simply never
 * return.
 *
 * Running it here, in a child process that exists only to produce one JSON
 * document and exit, means none of that reaches the process the operator
 * invoked. The parent applies the timeout. **This is isolation, not a sandbox:**
 * the child has this user's full authority, and the report says so.
 *
 * The report goes to **file descriptor 3**, not stdout. A package is entitled
 * to `console.log` during import, and that lands on stdout — if the report
 * shared the stream, one logging package would make the whole application
 * uninspectable. stdout and stderr here belong to the project's own source;
 * the parent forwards them, labelled, where they cannot corrupt the document.
 *
 * The exit code distinguishes "your composition is broken" from "I could not
 * read it", for anyone running this entry point directly.
 */

/** The report channel, opened by the parent as `stdio[3]`. */
const REPORT_FD = 3;

/** @param {string} text */
function writeReport(text) {
  try {
    writeSync(REPORT_FD, text);
  } catch (error) {
    // No fd 3 means someone ran the loader by hand. Say so rather than
    // silently printing a document onto a stream that is not the contract.
    process.stderr.write(
      'This loader writes its report to file descriptor 3, which is not open. '
        + 'Run `crm app inspect` instead of invoking it directly.\n',
    );
    throw error;
  }
}

const rootIndex = process.argv.indexOf('--root');
const rootDir = rootIndex === -1 ? process.cwd() : process.argv[rootIndex + 1];

try {
  const { report } = await inspectApplication({ rootDir });
  writeReport(`${JSON.stringify(report)}\n`);
  process.exitCode = report.valid ? 0 : 1;
} catch (error) {
  // A project that cannot be read at all is a different outcome from a project
  // whose composition is wrong, and it gets its own exit code so a caller never
  // mistakes one for the other.
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
