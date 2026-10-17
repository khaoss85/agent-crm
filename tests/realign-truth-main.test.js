import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { classifyDocumentDrift } from '../scripts/repo-truth.js';
import { REALIGN_BRANCH, REALIGN_FILES, REALIGN_PR_TITLE, realignDecision, stripCiOwnedFacts } from '../scripts/realign-truth-main.js';

const doc = (facts, sourceSha = 'a'.repeat(64)) => ({ facts, sourceSha });

const measurement = (value) => ({ id: 'measurement.test_tree_current', value, status: 'current' });
const author = (id, value) => ({ id, value });

test('measurement-only drift needs no realign: the ledger is CI-owned', () => {
  const committed = doc([author('spine.identity.contract', 1), measurement('true')]);
  const disk = doc([author('spine.identity.contract', 1), measurement('false')]);
  // Without the strip the ledger move would look blocking; with it, silence.
  assert.equal(classifyDocumentDrift(committed, disk).blocking, true);
  assert.deepEqual(realignDecision({ committed, disk }), {
    action: 'none',
    drift: classifyDocumentDrift(
      { ...committed, facts: stripCiOwnedFacts(committed.facts) },
      { ...disk, facts: stripCiOwnedFacts(disk.facts) },
    ),
    reason: 'the author-owned facts agree; nothing to realign',
  });
});

test('added author facts commit; a moved author value refuses', () => {
  const committed = doc([author('spine.identity.contract', 1), measurement('true')]);
  const added = doc(
    [author('spine.identity.contract', 1), author('probe.added_package', 'package_native'), measurement('false')],
  );
  const commit = realignDecision({ committed, disk: added });
  assert.equal(commit.action, 'commit');
  assert.equal(commit.drift.kind, 'facts-added');

  const moved = doc([author('spine.identity.contract', 2), measurement('false')]);
  const refuse = realignDecision({ committed, disk: moved });
  assert.equal(refuse.action, 'refuse');
  assert.equal(refuse.drift.kind, 'facts-changed');
  assert.match(refuse.reason, /spine\.identity\.contract/);
});

test('a dropped author fact refuses, and in-sync documents stay untouched', () => {
  const committed = doc([author('spine.identity.contract', 1), author('probe.old', 'absent')]);
  const dropped = doc([author('spine.identity.contract', 1)]);
  const refuse = realignDecision({ committed, disk: dropped });
  assert.equal(refuse.action, 'refuse');
  assert.match(refuse.reason, /probe\.old/);

  const same = realignDecision({ committed, disk: structuredClone(committed) });
  assert.equal(same.action, 'none');
});

test('the realign step only ever touches the ledger and the truth document', () => {
  assert.deepEqual([...REALIGN_FILES].sort(), ['docs/repository-truth.json', 'site/claims.json']);
});

test('measurement-only drift on a real document needs no realign, fingerprint included', () => {
  // The P1 this exists to close: realignDecision stripped the CI-owned
  // measurement facts but kept the derived fingerprint, so every re-anchor
  // looked like committable metadata drift. The unit doc() above hides it
  // (no fingerprint field); a real document does not.
  const committed = JSON.parse(readFileSync(new URL('../docs/repository-truth.json', import.meta.url), 'utf8'));
  assert.ok(committed.fingerprint, 'the committed document carries a derived fingerprint');
  assert.ok(committed.facts.some((fact) => String(fact.id).startsWith('measurement.')),
    'the committed document carries CI-owned measurement facts');
  const disk = structuredClone(committed);
  for (const fact of disk.facts) {
    if (String(fact.id).startsWith('measurement.')) fact.value = 'flipped-by-re-anchor';
  }
  // A fresh generation recomputes the derived fingerprint over the moved
  // facts — the field must move here too, or the drift below is vacuous.
  disk.fingerprint = 'f'.repeat(64);
  assert.notEqual(disk.fingerprint, committed.fingerprint);
  // Sanity: the stripped comparison without derived-field normalization is
  // genuinely adrift, so `none` below proves the normalization, not a vacuous
  // equality.
  const raw = classifyDocumentDrift(
    { ...committed, facts: stripCiOwnedFacts(committed.facts) },
    { ...disk, facts: stripCiOwnedFacts(disk.facts) },
  );
  assert.equal(raw.inSync, false);
  assert.equal(realignDecision({ committed, disk }).action, 'none');
});

test('the realign target is one fixed branch and one titled PR, never a push to main', () => {
  assert.equal(REALIGN_BRANCH, 'chore/truth-realign-main');
  assert.equal(REALIGN_PR_TITLE, 'chore(truth): realign main');
});
