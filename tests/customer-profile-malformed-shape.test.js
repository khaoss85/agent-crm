import test from 'node:test';
import assert from 'node:assert/strict';
import { profileFor } from '../packages/customer-data/src/profile.js';
import { resolvedNames } from '../packages/customer-data/src/store.js';

/**
 * Voce 908f2eb9bbfb, review round 2: one malformed shape must never poison
 * the shapes that did answer. A listWhere shape resolving to a non-array
 * (a handwritten service returning undefined for a shape it does not
 * declare) is skipped exactly like a rejecting shape, so the section stays
 * readable from the good shapes.
 */

const managed = (service) => ({ service: { createManaged() {}, ...service } });

function modulesWithMalformedOpportunityShape() {
  const emptyQuery = async () => [];
  return new Map([
    ['canonical-link', managed({ listWhere: emptyQuery })],
    ['external-identity', managed({ listWhere: emptyQuery })],
    ['data-quality-issue', managed({ listWhere: emptyQuery })],
    ['duplicate-candidate', managed({ listWhere: emptyQuery })],
    ['opportunity', managed({
      list: async () => [],
      listWhere: async (filters) => {
        // The companyId shape answers; the subject-scoped shape is malformed.
        if (filters.subjectResource) return undefined;
        return [{ id: 'opp-1', companyId: 'co-1', name: 'Pacchetto sede', status: 'open' }];
      },
    })],
  ]);
}

test('a malformed listWhere shape is skipped, the good shapes still read', async () => {
  const profile = await profileFor({
    modules: modulesWithMalformedOpportunityShape(),
    core: null,
    names: resolvedNames(),
    subject: { resource: 'company', id: 'co-1' },
  });
  assert.equal(profile.opportunities.available, true, 'the section stays readable from the good shape');
  assert.deepEqual(
    profile.opportunities.items.map((item) => item.id),
    ['opp-1'],
    'the good rows survive the malformed sibling shape');
});
