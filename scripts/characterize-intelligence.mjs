#!/usr/bin/env node
// @ts-check

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sortKeysDeep } from '../tests/characterization/characterization-contract.mjs';
import { generateBaseline } from '../tests/characterization/run-intelligence-characterization.mjs';

/**
 * Regenerate the Lead Intelligence characterization baseline — **explicitly**.
 *
 * Generation and verification are separate commands on purpose. A harness that
 * refreshed its own baseline during `npm run verify` would turn every behaviour
 * change into a silent baseline update, which is the one thing a
 * characterization suite must never do: the whole value is that a change to a
 * frozen behaviour *stops* somebody and asks for a decision.
 *
 * So: `npm run verify` compares. This script overwrites. Running it is the
 * deliberate act of saying "yes, that behaviour changed, and I meant it" — and
 * the resulting diff is what a reviewer reads.
 *
 * It writes nothing outside `tests/characterization/`, runs no migration
 * against any real database, and changes no source.
 */

const root = fileURLToPath(new URL('..', import.meta.url));
const output = join(root, 'tests/characterization/intelligence-baseline.json');

/** `node:test`'s TestContext, reduced to what the cases actually use. */
const cleanups = [];
const context = { after: (fn) => cleanups.push(fn) };

process.stdout.write('Characterizing Lead Intelligence — this boots real projects and takes a minute.\n');
let baseline;
try {
  baseline = await generateBaseline(context);
} finally {
  for (const cleanup of cleanups.reverse()) {
    try { await cleanup(); } catch { /* a throwaway project that is already gone is fine */ }
  }
}

mkdirSync(dirname(output), { recursive: true });
// Sorted keys: two regenerations of identical behaviour must produce an
// identical file, or every regeneration buries the real change in noise.
writeFileSync(output, `${JSON.stringify(sortKeysDeep(baseline), null, 2)}\n`);

process.stdout.write([
  '',
  `Wrote tests/characterization/intelligence-baseline.json`,
  `  domain       ${baseline.domain}`,
  `  attachment   ${baseline.attachment}`,
  `  fingerprint  ${baseline.fingerprint}`,
  `  observations ${baseline.observations.length}`,
  ...Object.entries(baseline.counts).map(([key, value]) => `    ${key.padEnd(24)} ${value}`),
  '',
  'Review the diff. An asserted value that moved is a behaviour change, not a',
  'baseline update — decide whether you meant it before committing.',
  '',
].join('\n'));

// Nothing else is left behind.
rmSync(join(root, 'data', 'characterization-scratch'), { recursive: true, force: true });
