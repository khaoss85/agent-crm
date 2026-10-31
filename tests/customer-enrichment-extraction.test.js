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

  // Two proposals stored under the company id: one becomes an active
  // fact before the opt-out, one stays pending.
  const companyAnswer = await app.extractCustomerEnrichment({
    actor: ACTOR,
    resource: 'company', id: company.id,
    sources: companySources,
    adapter: fakeAdapter([
      { field: 'role', value: 'Istruttore', source: 'company-website' },
      { field: 'companyName', value: 'Presti Group', source: 'company-website' },
    ]),
  });
  assert.equal(companyAnswer.proposals.length, 2);
  const acceptedCompany = await app.decideEnrichmentProposal({
    actor: ACTOR,
    id: companyAnswer.proposals.find((proposal) => proposal.field === 'role').id,
    decision: 'accepted', reason: 'confermato dal cliente',
  });
  assert.equal(acceptedCompany.outcome, 'accepted');

  // The member contact opts out: only the contact's own rows are purged.
  // The company rows keep their values, but the cluster's proposals are
  // no longer listed while any member carries an opt-out.
  const left = await app.optOutContactEnrichment({
    actor: ACTOR, email: 'luca@prestigroup.example', reason: 'non mi interessa',
  });
  assert.equal(left.outcome, 'opted-out');
  assert.equal(left.purged, 1, 'only the opted-out contact rows are purged');
  const enriched = app.modules.get('enriched-field').service;
  for (const row of enriched.listWhere({ subjectResource: subject.resource, subjectId: subject.id })) {
    assert.equal(row.status, 'purged', 'every row of the opted-out contact is purged');
    assert.equal(row.value, null, 'no refused contact value survives readable');
  }
  const companyRows = enriched.listWhere({ subjectResource: 'company', subjectId: company.id });
  assert.ok(companyRows.some((row) => row.status === 'active' && row.value === 'Istruttore'),
    'the rows of members who never opted out keep their values');
  assert.deepEqual((await app.readCustomerEnrichmentProposals({ resource: 'company', id: company.id })).proposals, [],
    'no cluster proposal is listed after a member opt-out');
  assert.deepEqual((await app.readCustomerEnrichmentProposals(subject)).proposals, [],
    'no member proposal survives its own opt-out on the scheda');
  const companyFacts = await app.readCustomerEnrichment({ resource: 'company', id: company.id });
  assert.ok(companyFacts.items.some((item) => item.field === 'role' && item.value === 'Istruttore'),
    'the facts of members who never opted out stay readable');
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

  // Accepting the surviving company proposal after the member opt-out
  // refuses: extract and accept stay blocked cluster-wide.
  await assert.rejects(
    app.decideEnrichmentProposal({
      actor: ACTOR,
      id: companyAnswer.proposals.find((proposal) => proposal.field === 'companyName').id,
      decision: 'accepted', reason: 'ripensamento',
    }),
    (error) => error.code === 'ENRICHMENT_OPTED_OUT');
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

test('accepting a phone already held beside another customer refuses 409 and keeps the first card', async (t) => {
  const { app } = await scene(t, 'extraction-phone-held-elsewhere');
  const subjectA = await seedContact(app);
  const resolvedB = await app.resolveChannelSender({
    channel: 'email', handle: 'maria@prestigroup.example', email: 'maria@prestigroup.example',
    firstName: 'Maria', lastName: 'Bianchi', actor: ACTOR,
  });
  assert.equal(resolvedB.outcome, 'created');
  const subjectB = {
    resource: 'contact',
    id: app.modules.get('external-identity').service
      .listWhere({ system: 'email', externalId: 'maria@prestigroup.example' })[0].subjectId,
  };

  const first = await app.extractCustomerEnrichment({
    actor: ACTOR,
    ...subjectA,
    sources: SOURCES,
    adapter: fakeAdapter([
      { field: 'phone', value: '+393331234567', source: 'email-signature', sourceDetail: 'firma email del 18/10' },
    ]),
  });
  const accepted = await app.decideEnrichmentProposal({
    actor: ACTOR, id: first.proposals[0].id, decision: 'accepted',
  });
  assert.equal(accepted.outcome, 'accepted');

  const second = await app.extractCustomerEnrichment({
    actor: ACTOR,
    ...subjectB,
    sources: SOURCES,
    adapter: fakeAdapter([
      { field: 'phone', value: '+393331234567', source: 'email-signature' },
    ]),
  });
  assert.equal(second.proposals.length, 1, 'the same number proposes beside the second customer too');
  await assert.rejects(
    app.decideEnrichmentProposal({ actor: ACTOR, id: second.proposals[0].id, decision: 'accepted' }),
    (error) => error?.code === 'PHONE_ALREADY_HELD' && error?.status === 409,
    'a phone held beside another customer is refused, never re-linked');

  const phones = app.modules.get('external-identity').service
    .listWhere({ system: 'phone', externalId: '+393331234567' });
  assert.equal(phones.length, 1, 'no second identity row is stored');
  assert.equal(phones[0].subjectId, subjectA.id, 'the number stays on the first card');
  assert.equal(proposedRows(app, subjectB).length, 1, 'the refused proposal stays proposed, not active');
  const factsB = await app.readCustomerEnrichment(subjectB);
  assert.deepEqual(factsB.items, [], 'the refused number never reads as a fact beside the second customer');
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

test('accepting a dismissed proposal answers already-decided and keeps the dismissal', async (t) => {
  const { app } = await scene(t, 'extraction-accept-after-dismiss');
  const subject = await seedContact(app);

  const answer = await app.extractCustomerEnrichment({
    actor: ACTOR,
    ...subject,
    sources: SOURCES,
    adapter: fakeAdapter([
      { field: 'role', value: 'Istruttore', source: 'channel-message', sourceDetail: 'whatsapp:wamid.1' },
    ]),
  });
  assert.equal(answer.proposals.length, 1);

  const dismissed = await app.decideEnrichmentProposal({
    actor: ACTOR, id: answer.proposals[0].id, decision: 'dismissed', reason: 'ruolo non richiesto',
  });
  assert.equal(dismissed.outcome, 'dismissed');

  // A concurrent accept that committed after the dismissal must not
  // resurrect the row: the decide re-reads the status inside the write
  // transaction and the dismissal wins.
  const late = await app.decideEnrichmentProposal({
    actor: ACTOR, id: answer.proposals[0].id, decision: 'accepted', reason: 'ripensamento',
  });
  assert.equal(late.outcome, 'already-decided', 'a dismissed row is never resurrected by accepting');
  const stored = app.modules.get('enriched-field').service
    .listWhere({ subjectResource: subject.resource, subjectId: subject.id });
  assert.equal(stored.length, 1);
  assert.equal(stored[0].status, 'dismissed', 'the recorded dismissal stays put');
  assert.deepEqual((await app.readCustomerEnrichment(subject)).items, [],
    'deciding after a dismissal stores no new fact');
});

test('extraction and accept on a subject that is not there refuse 404 with nothing stored', async (t) => {
  const { app } = await scene(t, 'extraction-missing-subject');
  let calls = 0;
  const adapter = {
    async extractFields() {
      calls += 1;
      return { fields: [] };
    },
  };
  const ghost = { resource: 'contact', id: '00000000-0000-0000-0000-000000000000' };

  await assert.rejects(
    app.extractCustomerEnrichment({ actor: ACTOR, ...ghost, sources: SOURCES, adapter }),
    (error) => error?.code === 'SUBJECT_NOT_FOUND' && error?.status === 404);
  assert.equal(calls, 0, 'the adapter never runs for a subject that is not there');
  assert.equal(proposedRows(app, ghost).length, 0, 'no proposal row is stored for a ghost');

  await assert.rejects(
    app.extractCustomerEnrichment({
      actor: ACTOR, resource: 'company', id: '00000000-0000-0000-0000-000000000000',
      sources: SOURCES, adapter,
    }),
    (error) => error?.code === 'SUBJECT_NOT_FOUND' && error?.status === 404);
  await assert.rejects(
    app.extractCustomerEnrichment({
      actor: ACTOR, resource: 'opportunity', id: 'whatever', sources: SOURCES, adapter,
    }),
    (error) => error?.code === 'SUBJECT_NOT_FOUND' && error?.status === 404,
    'there is no other subject to extract for');

  // Accepting a proposal whose subject is gone refuses before the flip and
  // the phone identity write: the row stays proposed, no fact lands.
  const enriched = app.modules.get('enriched-field').service;
  const row = await enriched.createManaged({
    sourceKey: 'aiex:contact:00000000-0000-0000-0000-000000000000:role:email-signature:test',
    subjectResource: ghost.resource, subjectId: ghost.id,
    subjectOwner: 'host', subjectOwnerPackage: null, subjectLabel: null,
    field: 'role', value: 'Istruttore', source: 'email-signature', sourceDetail: null,
    observedAt: new Date().toISOString(), observedByRunId: 'test:ghost',
    status: 'proposed', purgedAt: null, purgeReason: null, decisionReason: null,
  }, { actor: ACTOR });
  await assert.rejects(
    app.decideEnrichmentProposal({ actor: ACTOR, id: row.id, decision: 'accepted' }),
    (error) => error?.code === 'SUBJECT_NOT_FOUND' && error?.status === 404);
  assert.equal(enriched.get(row.id).status, 'proposed', 'the refused accept flips nothing');
  assert.deepEqual((await app.readCustomerEnrichment(ghost)).items, [], 'no fact lands for a ghost');
  assert.equal(
    app.modules.get('external-identity').service.listWhere({ system: 'phone' }).length,
    0, 'no phone identity was stored for a ghost');
});

test('dismissing a proposal after the cluster opted out refuses 409 with nothing flipped', async (t) => {
  const { app } = await scene(t, 'extraction-dismiss-after-optout');
  const subject = await seedContact(app);
  const company = await app.services.companies.create(
    { name: 'Presti Group', domain: 'prestigroup.example' }, { actor: ACTOR });

  const links = app.modules.get('canonical-link').service;
  for (const [member, role] of [
    [{ resource: 'contact', id: subject.id }, 'canonical'],
    [{ resource: 'company', id: company.id }, 'alias'],
  ]) {
    await links.createManaged({
      sourceKey: `test:extraction-dismiss-optout:${member.id}`,
      clusterKey: 'cluster-dismiss-optout-1',
      subjectResource: member.resource,
      subjectId: member.id,
      subjectOwner: 'host',
      subjectOwnerPackage: null,
      subjectLabel: null,
      role,
      decisionId: 'decision-dismiss-optout-1',
      reason: 'stesso cliente su email e sito',
      decidedByType: 'user',
      decidedById: 'elena',
      decidedAt: '2026-10-20T10:00:00.000Z',
      status: 'active',
      withdrawnReason: null,
      withdrawnAt: null,
    }, { actor: ACTOR });
  }

  const companySources = [
    ...SOURCES,
    { kind: 'company-website', text: 'Presti Group, palestra a Milano.', detail: 'prestigroup.example' },
  ];
  const answer = await app.extractCustomerEnrichment({
    actor: ACTOR,
    resource: 'company', id: company.id,
    sources: companySources,
    adapter: fakeAdapter([
      { field: 'role', value: 'Istruttore', source: 'company-website' },
    ]),
  });
  assert.equal(answer.proposals.length, 1);

  // The member contact opts out: only its own rows are purged, the company
  // proposal stays proposed — but deciding it refuses like «Accetta» does.
  const left = await app.optOutContactEnrichment({
    actor: ACTOR, email: 'luca@prestigroup.example', reason: 'non mi interessa',
  });
  assert.equal(left.outcome, 'opted-out');

  await assert.rejects(
    app.decideEnrichmentProposal({
      actor: ACTOR, id: answer.proposals[0].id, decision: 'dismissed', reason: 'non serve',
    }),
    (error) => error?.code === 'ENRICHMENT_OPTED_OUT' && error?.status === 409,
    '«Scarta» checks the same group opt-out «Accetta» checks');
  const stored = app.modules.get('enriched-field').service.get(answer.proposals[0].id);
  assert.equal(stored.status, 'proposed', 'the refused dismissal flips nothing');
});

test('accepting a value the free source already made a fact stores no duplicate', async (t) => {
  const { app } = await scene(t, 'extraction-free-source-duplicate');
  const subject = await seedContact(app);

  const free = await app.applyContactEnrichment({
    actor: ACTOR, email: 'luca@prestigroup.example',
    fields: { phone: '+393331234567' }, source: 'email-signature', sourceDetail: 'firma email',
  });
  assert.equal(free.outcome, 'enriched');

  // The same value proposed by the AI is never stored again.
  const answer = await app.extractCustomerEnrichment({
    actor: ACTOR,
    ...subject,
    sources: SOURCES,
    adapter: fakeAdapter([
      { field: 'phone', value: '+393331234567', source: 'email-signature' },
    ]),
  });
  assert.deepEqual(answer.counts, { proposed: 0, replayed: 0, alreadyActive: 1, skippedDismissed: 0 });
  assert.deepEqual(answer.proposals, []);
  assert.equal(proposedRows(app, subject).length, 0, 'no duplicate proposal row is stored');

  // The race the other way round: the proposal is pending when the free
  // source lands the same value — accepting replays the fact, no second row.
  const pending = await app.extractCustomerEnrichment({
    actor: ACTOR,
    ...subject,
    sources: SOURCES,
    adapter: fakeAdapter([
      { field: 'role', value: 'Istruttore', source: 'channel-message' },
    ]),
  });
  assert.equal(pending.proposals.length, 1);
  const landed = await app.applyContactEnrichment({
    actor: ACTOR, email: 'luca@prestigroup.example',
    fields: { role: 'Istruttore' }, source: 'email-signature', sourceDetail: 'firma email',
  });
  assert.equal(landed.outcome, 'enriched');

  const decided = await app.decideEnrichmentProposal({
    actor: ACTOR, id: pending.proposals[0].id, decision: 'accepted', reason: 'confermato',
  });
  assert.equal(decided.outcome, 'already-decided', 'the stored fact wins over the late accept');
  const actives = app.modules.get('enriched-field').service
    .listWhere({ subjectResource: subject.resource, subjectId: subject.id, status: 'active' })
    .filter((row) => row.field === 'role' && row.value === 'Istruttore');
  assert.equal(actives.length, 1, 'accepting beside a free-source fact flips no duplicate');
  const loser = app.modules.get('enriched-field').service.get(pending.proposals[0].id);
  assert.equal(loser.status, 'dismissed', 'the losing proposal is settled in the same transaction');
  assert.match(loser.decisionReason ?? '', /superseded by the active .* fact for the same value/,
    'the loser names the winning fact');
  const stillPending = await app.readCustomerEnrichmentProposals(subject);
  assert.equal(stillPending.proposals.length, 0, 'the pending set drains after the late accept');
});

test('accepting a still-proposed row refuses when the cluster opted out after the read', async (t) => {
  const { app } = await scene(t, 'extraction-accept-after-optout-row');
  const subject = await seedContact(app);

  const answer = await app.extractCustomerEnrichment({
    actor: ACTOR,
    ...subject,
    sources: SOURCES,
    adapter: fakeAdapter([
      { field: 'role', value: 'Istruttore', source: 'channel-message', sourceDetail: 'whatsapp:wamid.1' },
    ]),
  });
  assert.equal(answer.proposals.length, 1);

  // The refusal lands after the operator opened the scheda, without the
  // purge running: the decide re-checks the cluster opt-out inside the
  // write transaction on the fresh read, so the flip rolls back.
  await app.modules.get('enrichment-opt-out').service.createManaged({
    sourceKey: `optout:contact:${subject.id}`,
    subjectResource: subject.resource, subjectId: subject.id,
    subjectOwner: 'host', subjectOwnerPackage: null, subjectLabel: null,
    reason: 'non mi interessa',
    optedOutAt: new Date().toISOString(),
    optedOutByRunId: 'enrichment:opt-out',
  }, { actor: ACTOR });

  await assert.rejects(
    app.decideEnrichmentProposal({
      actor: ACTOR, id: answer.proposals[0].id, decision: 'accepted', reason: 'ripensamento',
    }),
    (error) => error.code === 'ENRICHMENT_OPTED_OUT',
    'a refusal that lands after the read still blocks the accept');
  const stored = app.modules.get('enriched-field').service
    .listWhere({ subjectResource: subject.resource, subjectId: subject.id });
  assert.equal(stored.length, 1);
  assert.equal(stored[0].status, 'proposed', 'the refused accept flips nothing');
  assert.deepEqual((await app.readCustomerEnrichment(subject)).items, [],
    'no fact lands after the cluster opted out');
});

test('an AI phone is dialable like on main: separators normalize, a national number proposes', async (t) => {
  const { app } = await scene(t, 'extraction-phone-national');
  const subject = await seedContact(app);

  // A national-shape guess is dialable, like the free-source path stores
  // it: it proposes, it is not refused with the run.
  const national = await app.extractCustomerEnrichment({
    actor: ACTOR,
    ...subject,
    sources: SOURCES,
    adapter: fakeAdapter([
      { field: 'phone', value: '3331234567', source: 'email-signature' },
    ]),
  });
  assert.equal(national.proposals.length, 1, 'a national-shape phone proposes like on main');
  assert.equal(national.proposals[0].value, '3331234567');

  const answer = await app.extractCustomerEnrichment({
    actor: ACTOR,
    ...subject,
    sources: SOURCES,
    adapter: fakeAdapter([
      { field: 'phone', value: '+39 333 123 4567', source: 'email-signature' },
    ]),
  });
  assert.equal(answer.proposals.length, 1);
  assert.equal(answer.proposals[0].value, '+393331234567', 'separators normalize');

  const decided = await app.decideEnrichmentProposal({
    actor: ACTOR, id: answer.proposals[0].id, decision: 'accepted', reason: 'confermato dal cliente',
  });
  assert.equal(decided.outcome, 'accepted');
  const phones = app.modules.get('external-identity').service
    .listWhere({ system: 'phone', externalId: '+393331234567' });
  assert.equal(phones.length, 1, 'the accepted AI phone links its identity like a free-source phone');
  assert.equal(phones[0].subjectId, subject.id);
});

test('dismissing a proposal whose subject is gone refuses 404 with nothing flipped', async (t) => {
  const { app } = await scene(t, 'extraction-dismiss-ghost');
  const ghost = { resource: 'contact', id: '00000000-0000-0000-0000-000000000000' };
  const enriched = app.modules.get('enriched-field').service;
  const row = await enriched.createManaged({
    sourceKey: 'aiex:contact:00000000-0000-0000-0000-000000000000:role:email-signature:test-dismiss',
    subjectResource: ghost.resource, subjectId: ghost.id,
    subjectOwner: 'host', subjectOwnerPackage: null, subjectLabel: null,
    field: 'role', value: 'Istruttore', source: 'email-signature', sourceDetail: null,
    observedAt: new Date().toISOString(), observedByRunId: 'test:ghost-dismiss',
    status: 'proposed', purgedAt: null, purgeReason: null, decisionReason: null,
  }, { actor: ACTOR });
  await assert.rejects(
    app.decideEnrichmentProposal({ actor: ACTOR, id: row.id, decision: 'dismissed', reason: 'non serve' }),
    (error) => error?.code === 'SUBJECT_NOT_FOUND' && error?.status === 404,
    'a ghost dismissal refuses like a ghost accept');
  assert.equal(enriched.get(row.id).status, 'proposed', 'the refused dismissal flips nothing');
});

test('a storage fault while checking the subject keeps its own error, never 404', async (t) => {
  const { app } = await scene(t, 'extraction-subject-fault');
  const subject = await seedContact(app);
  const service = app.modules.get('contact').service;
  const originalGet = service.get;
  service.get = async () => {
    throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY', status: 503 });
  };
  try {
    await assert.rejects(
      app.extractCustomerEnrichment({ actor: ACTOR, ...subject, sources: SOURCES, adapter: fakeAdapter([]) }),
      (error) => error?.code === 'SQLITE_BUSY' && error?.status === 503,
      'a backend fault is never reported as a deleted subject');
  } finally {
    service.get = originalGet;
  }
});

test('a national-shape free phone is stored, and its identical AI twin proposes no duplicate', async (t) => {
  const { app } = await scene(t, 'extraction-free-phone-national');
  const subject = await seedContact(app);

  // Like on main, a dialable national number is a stored fact, never a
  // refused field: the parser output '02123456' lands the same way.
  const free = await app.applyContactEnrichment({
    actor: ACTOR, email: 'luca@prestigroup.example',
    fields: { firstName: 'Luca', phone: '3331234567' }, source: 'email-signature', sourceDetail: 'firma email',
  });
  assert.equal(free.outcome, 'enriched');
  const enriched = app.modules.get('enriched-field').service;
  assert.equal(
    enriched.listWhere({ subjectResource: subject.resource, subjectId: subject.id, status: 'active' })
      .filter((row) => row.field === 'phone' && row.value === '3331234567').length,
    1, 'the national-shape phone is stored like on main');
  assert.equal(
    app.modules.get('external-identity').service
      .listWhere({ system: 'phone', externalId: '3331234567' }).length,
    1, 'the national-shape phone links its identity');

  // The identical value via AI is already an active fact: no new proposal,
  // and accepting beside it would flip no duplicate.
  const answer = await app.extractCustomerEnrichment({
    actor: ACTOR,
    ...subject,
    sources: SOURCES,
    adapter: fakeAdapter([
      { field: 'phone', value: '3331234567', source: 'email-signature' },
    ]),
  });
  assert.deepEqual(answer.counts, { proposed: 0, replayed: 0, alreadyActive: 1, skippedDismissed: 0 });
});
