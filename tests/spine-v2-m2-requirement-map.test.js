import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { m2Units, inspectCoverage } from '../scripts/spine-v2-m2-map.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const plan = readFileSync(join(root, 'docs', 'plans', 'production-spine-v2-postgresql.md'), 'utf8');
const data = JSON.parse(readFileSync(join(root, 'docs', 'plans', 'spine-v2-m2-requirements.json'), 'utf8'));

/**
 * **The map answers for the whole ratified section, or it answers for nothing.**
 *
 * A milestone checklist that omits a requirement does not look wrong — it looks
 * finished, which is worse. This is the gate that makes omission fail: every
 * unit the M2 section states must be claimed by exactly one group.
 */
test('every M2 requirement unit is classified exactly once', () => {
  assert.deepEqual(inspectCoverage(m2Units(plan), data), []);
});

/**
 * **A guard nobody has watched fail is not a guard.** Each mutation below is a
 * way this map could quietly stop describing the plan: a requirement added to
 * the ratified text and never classified, a classification invented to fit an
 * implementation, and a deferral that names no milestone to prove it. Every one
 * must be refused, and refused for its own reason — a gate that fails for the
 * wrong reason is a gate that will pass for the wrong reason later.
 */
test('the map refuses drift it must not survive', () => {
  const addedRequirement = plan.replace(
    '### M3 — Add PostgreSQL migrations and adapter',
    'Every production write additionally proves an unrelated new invariant nobody has classified yet.\n\n### M3 — Add PostgreSQL migrations and adapter',
  );
  assert.notEqual(addedRequirement, plan, 'the M2/M3 boundary anchor moved; fix this fixture, not the plan');
  const unclassified = inspectCoverage(m2Units(addedRequirement), data);
  assert.equal(unclassified.length, 1);
  assert.match(unclassified[0], /unclassified/);

  const invented = { groups: data.groups.map((g) => (g.id === 'G01' ? { ...g, classification: 'DONE_TRUST_ME' } : g)) };
  assert.ok(inspectCoverage(m2Units(plan), invented).some((f) => /unknown classification/.test(f)));

  const homeless = {
    groups: data.groups.map((g) => (g.classification === 'DEFERRED_OUTSIDE_M2' ? { ...g, provedIn: undefined } : g)),
  };
  assert.ok(inspectCoverage(m2Units(plan), homeless).some((f) => /deferred without naming where it is proved/.test(f)));

  const overlapping = { groups: [...data.groups, { id: 'GXX', classification: 'CURRENT_CAMPAIGN', units: [0] }] };
  assert.ok(inspectCoverage(m2Units(plan), overlapping).some((f) => /claimed by both/.test(f)));
});

/**
 * The deferrals are the half of this map that could hide work, so they carry
 * the stricter rule: each one names the milestone that proves it instead.
 */
test('no deferral is a dead end', () => {
  for (const group of data.groups.filter((g) => g.classification === 'DEFERRED_OUTSIDE_M2')) {
    assert.match(group.provedIn, /^M[345]$/, `${group.id} must name the milestone that proves it`);
    assert.ok(String(group.reason ?? '').length > 40, `${group.id} must say why it cannot be proved at M2-complete`);
  }
});
