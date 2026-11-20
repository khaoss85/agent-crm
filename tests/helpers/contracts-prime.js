// @ts-check

import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { project } from './contracts-project.js';

/**
 * A prime-cache over `contracts-project.js` `project`, for the split
 * delivery-execution suites.
 *
 * A fresh project root costs ~50 s of `module create` child processes (one
 * per manifest), and every test paid it: the six shards carried ~660 s of
 * setup for 12 tests. The prime pays it once per option set; each test then
 * copies the prime in seconds. The copy is byte-identical to a fresh build,
 * so test isolation is unchanged — no test ever sees the prime root itself,
 * and every test keeps its own database file, server and app.
 *
 * A separate file (rather than a change inside `contracts-project.js`) so the
 * fast gate's selection does not move: 47 test files import that helper, and
 * touching it overflows the gate's file budget into the warned fallback. Only
 * the six shards import this file, and they already run.
 *
 * @param {import('node:test').TestContext} t
 * @param {Parameters<typeof project>[1]} [options]
 */
const primedRoots = new Map();
let primedCleanupArmed = false;

function armPrimedCleanup() {
  if (primedCleanupArmed) return;
  primedCleanupArmed = true;
  process.once('exit', () => {
    for (const { cleanups } of primedRoots.values()) {
      for (const cleanup of cleanups) {
        try { cleanup(); } catch { /* a prime that never formed needs no cleanup */ }
      }
    }
    primedRoots.clear();
  });
}

export function primedProject(t, options = {}) {
  const key = JSON.stringify(options);
  const cached = primedRoots.get(key);
  let prime = cached?.root;
  if (prime === undefined) {
    // The prime outlives any single test, so it takes no test's lifetime: it
    // collects the cleanup `project` registers and owns it until process exit.
    // A failed prime build runs what it registered and is never cached, so the
    // next test retries the full build instead of copying a half-built root.
    const cleanups = [];
    try {
      prime = project({ after: (fn) => cleanups.push(fn) }, options);
    } catch (error) {
      for (const cleanup of cleanups.splice(0)) {
        try { cleanup(); } catch { /* best effort on a failed build */ }
      }
      throw error;
    }
    primedRoots.set(key, { cleanups, root: prime });
    armPrimedCleanup();
  }
  const root = mkdtempSync(join(tmpdir(), 'accordo-contracts-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(prime, root, { recursive: true });
  return root;
}
