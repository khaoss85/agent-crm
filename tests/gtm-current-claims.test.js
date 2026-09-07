import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BOUND_SURFACES, checkCitations, findRetiredClaims, parseCitations } from '../scripts/repo-truth.js';

test('restoring obsolete public negatives fails even when the attached fact is correct', () => {
  const cases = [
    ['site/answers.json', 'PostgreSQL is on the Production Spine track and is not implemented', 'spine.postgresql.implemented', 'implemented'],
    ['site/claims.json', 'Nothing bills, renews, amends or cancels', 'domain.lifecycle.package_native', 'package_native'],
    ['site/compare.json', 'no auth, no scheduler, no integrations, SQLite only', 'spine.timer_consumers.implemented', 'implemented'],
    ['site/capabilities.json', 'No import, export, dedupe, merge, bulk edit, saved views or global search', 'domain.customer_data.package_native', 'package_native'],
  ];
  for (const [surface, text, id, value] of cases) {
    assert.ok(BOUND_SURFACES.includes(surface), `${surface} must participate in the real check`);
    const restored = JSON.stringify({ text, evidence: { facts: [`${id}=${value}`] } }, null, 2);
    assert.deepEqual(checkCitations(parseCitations(restored), new Map([[id, { value }]]), surface), []);
    assert.ok(findRetiredClaims(restored).some((hit) => hit.claim === text), `${surface}: correct citations must not excuse stale wording`);
  }
});

test('scoped limitations remain legal after the capabilities ship', () => {
  assert.deepEqual(findRetiredClaims([
    'SQLite is the local default; the async factory supports dedicated PostgreSQL.',
    'The framework supplies authorization; deployments supply authentication.',
    'No managed worker service, physical customer merge or automatic renewal is included.',
    'Governed imports are not a full CDP, export or erasure service.',
  ].join('\n')), []);
});

test('current GTM sources cannot restore the recorded obsolete claims', () => {
  for (const surface of BOUND_SURFACES.filter((path) => path.startsWith('site/') || path.startsWith('docs/strategy/'))) {
    const text = readFileSync(new URL(`../${surface}`, import.meta.url), 'utf8');
    assert.deepEqual(findRetiredClaims(text), [], surface);
  }
});
