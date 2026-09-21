// @ts-check

import { deciding, subjectKey, subjectOf } from './store.js';

/**
 * **Customer Data Operations v2 — the indexed/windowed identity-conflict
 * detector (backlog:48de928b2dfa, TASKS.md:45).**
 *
 * v1 found `conflicting_external_identity` with a correctness-first
 * whole-table read: every active identity row in memory, grouped by source
 * key. That read is correct for exactly as long as the table fits in memory
 * comfortably, and it stops being comfortable at the largest customer — the
 * worst moment. v2 replaces it with two bounded reads:
 *
 * - a **window**: the newest `windowSize` active identities off the display
 *   page. The bound is the declared `IDENTITY_CONFLICT_WINDOW`, never
 *   discovered under load;
 * - an **indexed** point lookup per windowed key: the complete exact-match
 *   read for that source key, which is exactly the read a conflict lives or
 *   dies by.
 *
 * A conflict is found whenever at least one of its rows is inside the
 * window, because the per-key read is complete for that key — never a page.
 * A conflict with no row in the window is **out of scope, not absent**: the
 * report always carries its coverage, and `complete` is claimed only when
 * the window held every active row. Callers must read `coverage`, not the
 * length of `conflicts`, before saying "no conflict".
 */

export const IDENTITY_CONFLICT_DETECTOR = 'customer-data-identity-conflict-v2';

/**
 * The declared window bound. It sits at the display-page clamp on purpose: a
 * window larger than one page would silently become a page, and a detector
 * whose bound is a page it never names is the defect v1 of the complete-read
 * review fixed elsewhere. Smaller windows are a caller choice per call.
 */
export const IDENTITY_CONFLICT_WINDOW = 500;

/** The persisted kind for a windowed-coverage scope finding. */
export const IDENTITY_CONFLICT_SCOPE_KIND = 'identity_conflict_windowed_scope';

/**
 * Find the external identities active against more than one record, without
 * reading the whole table.
 *
 * @param {{identityService: any, windowSize?: number}} input
 */
export async function detectIdentityConflicts({ identityService, windowSize = IDENTITY_CONFLICT_WINDOW }) {
  if (!identityService || typeof identityService.list !== 'function'
    || typeof identityService.countWhere !== 'function') {
    throw new Error('identity-conflict detection needs the identity record service (list, listWhere, countWhere)');
  }
  const window = Math.min(Math.max(Math.floor(windowSize) || IDENTITY_CONFLICT_WINDOW, 1), 500);

  // The only unbounded-shaped read here is per key, and a per-key read is
  // complete by construction: conflicts sharing a key are never split by a
  // page. The window read below is newest-first, so "inside the window"
  // always means "among the newest active identities".
  const newest = await identityService.list({ limit: window, where: { status: 'active' } });
  const totalActive = await identityService.countWhere({ status: 'active' });
  const examinedActive = newest.length;
  const complete = totalActive <= examinedActive;

  const keys = [];
  const seenKeys = new Set();
  for (const row of newest) {
    if (!seenKeys.has(row.sourceKey)) {
      seenKeys.add(row.sourceKey);
      keys.push(row.sourceKey);
    }
  }

  const conflicts = [];
  for (const key of keys) {
    // deciding(), not list(): a conflicted key answered from a page would
    // drop the older claimants of exactly the conflict being reported.
    const rows = await deciding(identityService, { sourceKey: key, status: 'active' });
    // The v1 replay, row for row: the first claimant sets the baseline, a
    // claimant naming another record is a conflict, and a claimant naming
    // the baseline record re-baselines without flagging — byte for byte the
    // grouping v1 ran over the whole table, restricted to this key.
    let baseline = null;
    const others = [];
    for (const row of rows) {
      if (!baseline) {
        baseline = row;
        continue;
      }
      if (subjectKey({ resource: baseline.subjectResource, id: baseline.subjectId })
        !== subjectKey({ resource: row.subjectResource, id: row.subjectId })) {
        others.push(row);
        continue;
      }
      baseline = row;
    }
    if (others.length > 0) {
      conflicts.push({
        sourceKey: key,
        first: subjectOf(baseline),
        others: others.map((row) => subjectOf(row)),
      });
    }
  }

  return {
    detector: IDENTITY_CONFLICT_DETECTOR,
    coverage: {
      mode: complete ? 'complete' : 'windowed',
      windowSize: window,
      examinedActive,
      totalActive,
      outOfWindow: !complete,
    },
    conflicts,
  };
}
