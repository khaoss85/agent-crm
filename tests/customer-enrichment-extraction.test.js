import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { boot, project } from './helpers/customer-data-project.js';

/**
 * AI-assisted enrichment extraction (backlog:7837a4b1b3a9).
 *
 * The scheda's «Aggiorna» button asks the AI to extract contact fields
 * from the customer's linked sources and shows every proposed field with
 * its source, to accept or dismiss. The framework side: the extraction
 * stores one `proposed` enriched-field row per field, a human decision
 * flips it to `active` (accepted) or `dismissed` (refused with a reason),
 * and without an adapter the call refuses with ENRICHMENT_AI_UNAVAILABLE
 * instead of running anything. The contact record is never written.
 */

const ACTOR = { type: 'user', id: 'enrichment' };

async function scene(t, tag) {
  const root = project(t);
  const context = await boot(root, join(root, 'data', `${tag}.sqlite`));
  t.after(() => context.close());
  return { root, ...context };
}

function fakeAdapter(fields) {
  return {
    async extractFields() {
      return { fields };
    },
  };
}

const SOURCES = [
  {
    kind: 'email-signature',
    text: 'Luca Rossi\nIstruttore\nPresti Group\nTel +393331234567\nluca@prestigroup.example',
    detail: 'firma email del 18/10',
  },
  { kind: 'channel-message', text: 'ciao, sono Luca della Presti Group', detail: 'whatsapp:wamid.1' },
];

async function seedContact(app) {
  const resolved = await app.resolveChannelSender({
    channel: 'email', handle: 'luca@prestigroup.example', email: 'luca@prestigroup.example',
    firstName: 'Luca', lastName: 'Rossi', actor: ACTOR,
  });
  assert.equal(resolved.outcome, 'created');
  const identity = app.modules.get('external-identity').service
    .listWhere({ system: 'email', externalId: 'luca@prestigroup.example' })[0];
  assert.ok(identity, 'the sender resolution links the email');
  return { resource: 'contact', id: identity.subjectId };
}

function proposedRows(app, subject) {
  return app.modules.get('enriched-field').service
    .listWhere({ subjectResource: subject.resource, subjectId: subject.id, status: 'proposed' });
}

test('«Aggiorna» stores one proposed row per extracted field, each citing its source', async (t) => {
  const { app } = await scene(t, 'extraction-proposes');
  const subject = await seedContact(app);

  const answer = await app.extractCustomerEnrichment({
    actor: ACTOR,
    ...subject,
    sources: SOURCES,
    adapter: fakeAdapter([
      { field: 'phone', value: '+393331234567', source: 'email-signature', sourceDetail: 'firma email del 18/10' },
      { field: 'companyName', value: 'Presti Group', source: 'channel-message', sourceDetail: 'whatsapp:wamid.1' },
    ]),
  });

  assert.equal(answer.status, 'done');
  assert.deepEqual(answer.counts, { proposed: 2, replayed: 0, alreadyActive: 0, skippedDismissed: 0 });
  assert.equal(answer.proposals.length, 2);
  const byField = new Map(answer.proposals.map((proposal) => [proposal.field, proposal]));
  assert.equal(byField.get('phone').value, '+393331234567');
  assert.equal(byField.get('phone').source, 'email-signature');
  assert.equal(byField.get('phone').sourceDetail, 'firma email del 18/10');
  assert.equal(byField.get('companyName').source, 'channel-message');

  // A proposal is never a fact: the facts read stays empty.
  const facts = await app.readCustomerEnrichment(subject);
  assert.deepEqual(facts.items, []);
  const pending = await app.readCustomerEnrichmentProposals(subject);
  assert.equal(pending.proposals.length, 2, 'the scheda lists the proposals beside the facts');
});

test('accepting flips the proposal to an active fact; deciding twice replays', async (t) => {
  const { app } = await scene(t, 'extraction-accept');
  const subject = await seedContact(app);

  const answer = await app.extractCustomerEnrichment({
    actor: ACTOR,
    ...subject,
    sources: SOURCES,
    adapter: fakeAdapter([
      { field: 'phone', value: '+393331234567', source: 'email-signature', sourceDetail: 'firma email del 18/10' },
    ]),
  });
  const decided = await app.decideEnrichmentProposal({
    actor: ACTOR, id: answer.proposals[0].id, decision: 'accepted', reason: 'confermato dal cliente',
  });
  assert.equal(decided.outcome, 'accepted');

  const facts = await app.readCustomerEnrichment(subject);
  assert.equal(facts.items.length, 1);
  assert.equal(facts.items[0].source, 'email-signature');

  const again = await app.decideEnrichmentProposal({
    actor: ACTOR, id: answer.proposals[0].id, decision: 'dismissed', reason: 'ripensamento',
  });
  assert.equal(again.outcome, 'already-decided', 'the stored decision wins over a second, different one');
  assert.equal(
    app.modules.get('enriched-field').service
      .listWhere({ subjectResource: subject.resource, subjectId: subject.id, status: 'active' }).length,
    1,
    'deciding twice stores no second row');
});

test('dismissing records the refusal; a re-run replays without resurrecting', async (t) => {
  const { app } = await scene(t, 'extraction-dismiss');
  const subject = await seedContact(app);
  const fields = [
    { field: 'role', value: 'Istruttore', source: 'email-signature', sourceDetail: 'firma email del 18/10' },
  ];

  const first = await app.extractCustomerEnrichment({ actor: ACTOR, ...subject, sources: SOURCES, adapter: fakeAdapter(fields) });
  const dismissed = await app.decideEnrichmentProposal({
    actor: ACTOR, id: first.proposals[0].id, decision: 'dismissed', reason: 'ruolo non richiesto',
  });
  assert.equal(dismissed.outcome, 'dismissed');
  const stored = app.modules.get('enriched-field').service.get(first.proposals[0].id);
  assert.equal(stored.status, 'dismissed');
  assert.equal(stored.decisionReason, 'ruolo non richiesto');

  const second = await app.extractCustomerEnrichment({ actor: ACTOR, ...subject, sources: SOURCES, adapter: fakeAdapter(fields) });
  assert.equal(second.status, 'done');
  assert.deepEqual(second.counts, { proposed: 0, replayed: 0, alreadyActive: 0, skippedDismissed: 1 });
  assert.deepEqual(second.proposals, []);
  assert.deepEqual((await app.readCustomerEnrichmentProposals(subject)).proposals, []);
  assert.equal(proposedRows(app, subject).length, 0, 'no proposal row is resurrected');
});

test('a repeated extraction replays instead of duplicating', async (t) => {
  const { app } = await scene(t, 'extraction-replay');
  const subject = await seedContact(app);
  const fields = [
    { field: 'phone', value: '+393331234567', source: 'email-signature', sourceDetail: 'firma email del 18/10' },
  ];

  const first = await app.extractCustomerEnrichment({ actor: ACTOR, ...subject, sources: SOURCES, adapter: fakeAdapter(fields) });
  assert.equal(first.counts.proposed, 1);
  const second = await app.extractCustomerEnrichment({ actor: ACTOR, ...subject, sources: SOURCES, adapter: fakeAdapter(fields) });
  assert.deepEqual(second.counts, { proposed: 0, replayed: 1, alreadyActive: 0, skippedDismissed: 0 });
  assert.equal(second.proposals.length, 1, 'the still-pending proposal is listed again');
  assert.equal(proposedRows(app, subject).length, 1, 'no second row is stored');
});

test('without an AI adapter the extraction refuses instead of doing nothing', async (t) => {
  const { app } = await scene(t, 'extraction-no-ai');
  const subject = await seedContact(app);

  await assert.rejects(
    app.extractCustomerEnrichment({ actor: ACTOR, ...subject, sources: SOURCES }),
    (error) => error.code === 'ENRICHMENT_AI_UNAVAILABLE');
});

test('an adapter failure reads as an error with no provider text and nothing stored', async (t) => {
  const { app } = await scene(t, 'extraction-failed');
  const subject = await seedContact(app);

  const leaking = { extractFields: async () => { throw new Error('sk-live-SECRET-PROVIDER-TEXT'); } };
  await assert.rejects(
    app.extractCustomerEnrichment({ actor: ACTOR, ...subject, sources: SOURCES, adapter: leaking }),
    (error) => error.code === 'ENRICHMENT_EXTRACTION_FAILED'
      && typeof error.message === 'string'
      && !error.message.includes('sk-live-SECRET-PROVIDER-TEXT'));
  assert.equal(proposedRows(app, subject).length, 0);
});

test('an unusable adapter answer refuses with nothing stored', async (t) => {
  const { app } = await scene(t, 'extraction-invalid');
  const subject = await seedContact(app);

  await assert.rejects(
    app.extractCustomerEnrichment({
      actor: ACTOR,
      ...subject,
      sources: SOURCES,
      adapter: fakeAdapter([{ field: 'budget', value: 'alto', source: 'channel-message' }]),
    }),
    (error) => error.code === 'ENRICHMENT_EXTRACTION_INVALID');
  await assert.rejects(
    app.extractCustomerEnrichment({
      actor: ACTOR,
      ...subject,
      sources: SOURCES,
      adapter: fakeAdapter([{ field: 'phone', value: '   ', source: 'email-signature' }]),
    }),
    (error) => error.code === 'ENRICHMENT_EXTRACTION_INVALID');
  await assert.rejects(
    app.extractCustomerEnrichment({
      actor: ACTOR,
      ...subject,
      sources: SOURCES,
      adapter: fakeAdapter([{ field: 'phone', value: '+393331234567', source: 'paid-broker' }]),
    }),
    (error) => error.code === 'ENRICHMENT_EXTRACTION_INVALID');
  assert.equal(proposedRows(app, subject).length, 0, 'one bad field refuses the whole run');
});

test('an opted-out subject is never extracted and no proposal is accepted after the purge', async (t) => {
  const { app } = await scene(t, 'extraction-optout');
  const subject = await seedContact(app);
  await app.optOutContactEnrichment({ actor: ACTOR, email: 'luca@prestigroup.example', reason: 'non mi interessa' });

  await assert.rejects(
    app.extractCustomerEnrichment({
      actor: ACTOR,
      ...subject,
      sources: SOURCES,
      adapter: fakeAdapter([{ field: 'phone', value: '+393331234567', source: 'email-signature' }]),
    }),
    (error) => error.code === 'ENRICHMENT_OPTED_OUT');
});

test('an opt-out after proposals purges proposed and dismissed rows, not just active facts', async (t) => {
  const { app } = await scene(t, 'extraction-optout-after-proposals');
  const subject = await seedContact(app);

  const answer = await app.extractCustomerEnrichment({
    actor: ACTOR,
    ...subject,
    sources: SOURCES,
    adapter: fakeAdapter([
      { field: 'phone', value: '+393331234567', source: 'email-signature', sourceDetail: 'firma email del 18/10' },
      { field: 'role', value: 'Istruttore', source: 'channel-message', sourceDetail: 'whatsapp:wamid.1' },
    ]),
  });
  assert.equal(answer.proposals.length, 2);

  // One proposal is refused by the human, one stays pending, one becomes a fact.
  const dismissed = await app.decideEnrichmentProposal({
    actor: ACTOR, id: answer.proposals.find((proposal) => proposal.field === 'role').id,
    decision: 'dismissed', reason: 'ruolo non richiesto',
  });
  assert.equal(dismissed.outcome, 'dismissed');
  const accepted = await app.decideEnrichmentProposal({
    actor: ACTOR, id: answer.proposals.find((proposal) => proposal.field === 'phone').id,
    decision: 'accepted', reason: 'confermato dal cliente',
  });
  assert.equal(accepted.outcome, 'accepted');

  const left = await app.optOutContactEnrichment({
    actor: ACTOR, email: 'luca@prestigroup.example', reason: 'non mi interessa',
  });
  assert.equal(left.outcome, 'opted-out');
  assert.equal(left.purged, 2, 'the fact and the dismissal are both purged');

  const enriched = app.modules.get('enriched-field').service;
  const remaining = enriched.listWhere({ subjectResource: subject.resource, subjectId: subject.id });
  assert.ok(remaining.length > 0, 'purged rows stay recorded, never deleted');
  for (const row of remaining) {
    assert.equal(row.status, 'purged');
    assert.equal(row.value, null, 'no refused value survives the opt-out readable');
  }
  assert.deepEqual((await app.readCustomerEnrichmentProposals(subject)).proposals, [],
    'no proposal survives the opt-out on the scheda');
  assert.deepEqual((await app.readCustomerEnrichment(subject)).items, [],
    'no fact survives the opt-out on the scheda');

  const afterPurge = await app.decideEnrichmentProposal({
    actor: ACTOR, id: answer.proposals.find((proposal) => proposal.field === 'role').id,
    decision: 'accepted', reason: 'ripensamento',
  });
  assert.equal(afterPurge.outcome, 'already-decided', 'a purged row is never resurrected by deciding');
  assert.deepEqual((await app.readCustomerEnrichment(subject)).items, [],
    'deciding after the purge stores no new fact');
});

test('proposals and opt-outs follow the canonical cluster, not just the named record', async (t) => {
  const { app } = await scene(t, 'extraction-cluster');
  const subject = await seedContact(app);
  const company = await app.services.companies.create(
    { name: 'Presti Group', domain: 'prestigroup.example' }, { actor: ACTOR });

  const links = app.modules.get('canonical-link').service;
  for (const [member, role] of [
    [{ resource: 'contact', id: subject.id }, 'canonical'],
    [{ resource: 'company', id: company.id }, 'alias'],
  ]) {
    await links.createManaged({
      sourceKey: `test:extraction-cluster:${member.id}`,
      clusterKey: 'cluster-extraction-1',
      subjectResource: member.resource,
      subjectId: member.id,
      subjectOwner: 'host',
      subjectOwnerPackage: null,
      subjectLabel: null,
      role,
      decisionId: 'decision-extraction-1',
      reason: 'stesso cliente su email e sito',
      decidedByType: 'user',
      decidedById: 'elena',
      decidedAt: '2026-10-20T10:00:00.000Z',
      status: 'active',
      withdrawnReason: null,
      withdrawnAt: null,
    }, { actor: ACTOR });
  }

  // Proposals extracted for the member contact show on the company scheda too.
  const companySources = [
    ...SOURCES,
    { kind: 'company-website', text: 'Presti Group, palestra a Milano. Istruttore: Luca.', detail: 'prestigroup.example' },
  ];
  await app.extractCustomerEnrichment({
    actor: ACTOR,
    ...subject,
    sources: companySources,
    adapter: fakeAdapter([
      { field: 'companyName', value: 'Presti Group', source: 'company-website', sourceDetail: 'prestigroup.example' },
    ]),
  });

  const fromCompany = await app.readCustomerEnrichmentProposals({ resource: 'company', id: company.id });
  assert.equal(fromCompany.proposals.length, 1,
    'the company scheda lists the member contact proposal beside its facts');
  assert.equal(fromCompany.proposals[0].field, 'companyName');

  // A proposal stored under the company id survives the member purge
  // (the purge is contact-scoped), so it exercises the decide-side check.
  await app.extractCustomerEnrichment({
    actor: ACTOR,
    resource: 'company', id: company.id,
    sources: companySources,
    adapter: fakeAdapter([
      { field: 'role', value: 'Istruttore', source: 'company-website' },
    ]),
  });

  // The member contact opts out: an extraction named for the company must refuse too.
  await app.optOutContactEnrichment({
    actor: ACTOR, email: 'luca@prestigroup.example', reason: 'non mi interessa',
  });
  await assert.rejects(
    app.extractCustomerEnrichment({
      actor: ACTOR,
      resource: 'company', id: company.id,
      sources: companySources,
      adapter: fakeAdapter([
        { field: 'role', value: 'Istruttore', source: 'company-website' },
      ]),
    }),
    (error) => error.code === 'ENRICHMENT_OPTED_OUT');
  await assert.rejects(
    app.decideEnrichmentProposal({
      actor: ACTOR,
      id: (await app.readCustomerEnrichmentProposals({ resource: 'company', id: company.id })).proposals[0].id,
      decision: 'accepted', reason: 'ripensamento',
    }),
    (error) => error.code === 'ENRICHMENT_OPTED_OUT',
    'a member opt-out blocks accepting from the company side too');
});

test('an undialable AI phone is refused with the run, and an accepted phone links its identity', async (t) => {
  const { app } = await scene(t, 'extraction-phone-discipline');
  const subject = await seedContact(app);

  await assert.rejects(
    app.extractCustomerEnrichment({
      actor: ACTOR,
      ...subject,
      sources: SOURCES,
      adapter: fakeAdapter([
        { field: 'phone', value: 'not-a-phone', source: 'email-signature' },
      ]),
    }),
    (error) => error.code === 'ENRICHMENT_EXTRACTION_INVALID');
  assert.equal(proposedRows(app, subject).length, 0, 'a malformed phone is never stored as a proposal');

  const answer = await app.extractCustomerEnrichment({
    actor: ACTOR,
    ...subject,
    sources: SOURCES,
    adapter: fakeAdapter([
      { field: 'phone', value: '+393331234567', source: 'email-signature', sourceDetail: 'firma email del 18/10' },
    ]),
  });
  const decided = await app.decideEnrichmentProposal({
    actor: ACTOR, id: answer.proposals[0].id, decision: 'accepted', reason: 'confermato dal cliente',
  });
  assert.equal(decided.outcome, 'accepted');

  const phones = app.modules.get('external-identity').service
    .listWhere({ system: 'phone', externalId: '+393331234567' });
  assert.equal(phones.length, 1, 'the accepted phone links exactly like a free-source phone');
  assert.equal(phones[0].subjectId, subject.id);
});

test('only a human decides a proposal; a read that fails and an empty source list refuse', async (t) => {
  const { app } = await scene(t, 'extraction-guards');
  const subject = await seedContact(app);
  const answer = await app.extractCustomerEnrichment({
    actor: ACTOR,
    ...subject,
    sources: SOURCES,
    adapter: fakeAdapter([{ field: 'phone', value: '+393331234567', source: 'email-signature' }]),
  });

  await assert.rejects(
    app.decideEnrichmentProposal({ actor: { type: 'system', id: 'pilot' }, id: answer.proposals[0].id, decision: 'accepted' }),
    (error) => error.code === 'HUMAN_APPROVAL_REQUIRED');
  await assert.rejects(
    app.decideEnrichmentProposal({ actor: ACTOR, id: 'no-such-row', decision: 'accepted' }),
    (error) => error.name === 'NotFoundError');

  await assert.rejects(
    app.extractCustomerEnrichment({ actor: ACTOR, ...subject, sources: [], adapter: fakeAdapter([]) }),
    (error) => error.name === 'ValidationError');
  await assert.rejects(
    app.extractCustomerEnrichment({
      actor: ACTOR,
      ...subject,
      sources: [{ kind: 'paid-broker', text: 'x' }],
      adapter: fakeAdapter([]),
    }),
    (error) => error.name === 'ValidationError');
});
