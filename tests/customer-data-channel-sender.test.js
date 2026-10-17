import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { boot, project } from './helpers/customer-data-project.js';

/**
 * **Channel sender resolution (backlog:a4f40325).**
 *
 * Every channel identity — a WhatsApp number, an Instagram id, a Facebook id,
 * an email address, a TikTok id, a phone number — links to a contact through
 * the `external-identity` record and the `deterministic-customer-match` rule
 * this package already owns. An unknown sender carrying an email creates its
 * contact; ambiguous evidence becomes an unresolved `duplicate-candidate`
 * for a human and is never merged.
 */

const ACTOR = { type: 'user', id: 'sender' };

async function scene(t, tag) {
  const root = project(t, {});
  const context = await boot(root, join(root, 'data', `${tag}.sqlite`));
  t.after(() => context.close());
  return { root, ...context };
}

function identitiesOf(app, contactId) {
  return app.modules.get('external-identity').service
    .listWhere({ subjectResource: 'contact', subjectId: contactId, status: 'active' });
}

function contactsCount(app) {
  return app.database.raw.prepare('SELECT COUNT(*) AS n FROM contacts').get().n;
}

test('the same customer writing from three channels resolves to one contact', async (t) => {
  const { app } = await scene(t, 'sender-three-channels');

  const first = await app.resolveChannelSender({
    channel: 'whatsapp', handle: '+39 333 123 4567', email: 'luca@prestigroup.example',
    firstName: 'Luca', lastName: 'Rossi', companyName: 'Presti Group', actor: ACTOR,
  });
  assert.equal(first.outcome, 'created');
  assert.equal(first.contact.resource, 'contact');
  assert.equal(first.identity, 'linked');

  const second = await app.resolveChannelSender({
    channel: 'instagram', handle: 'luca.rossi.pg', email: 'luca@prestigroup.example', actor: ACTOR,
  });
  assert.equal(second.outcome, 'matched');
  assert.equal(second.contact.id, first.contact.id, 'the Instagram handle names the same contact');

  const third = await app.resolveChannelSender({
    channel: 'email', handle: 'Luca@PrestiGroup.Example', actor: ACTOR,
  });
  assert.equal(third.outcome, 'matched');
  assert.equal(third.contact.id, first.contact.id, 'the email handle names the same contact');

  // A repeated sighting replays the winner instead of writing twice.
  const replay = await app.resolveChannelSender({
    channel: 'whatsapp', handle: '+393331234567', email: 'luca@prestigroup.example', actor: ACTOR,
  });
  assert.equal(replay.outcome, 'matched');
  assert.equal(replay.contact.id, first.contact.id);

  assert.equal(contactsCount(app), 1, 'three channels, one contact row');
  const systems = identitiesOf(app, first.contact.id).map((row) => row.system).sort();
  assert.deepEqual(systems, ['email', 'instagram', 'whatsapp'], 'each channel identity is recorded once');

  const profile = await app.readCustomerProfile({ resource: 'contact', id: first.contact.id });
  assert.equal(profile.externalIdentities.length, 3, 'one card carries all three channel identities');
  assert.deepEqual(
    profile.externalIdentities.map((identity) => identity.system).sort(),
    ['email', 'instagram', 'whatsapp']);
});

test('a handle naming one contact with an email naming another becomes a candidate, never a merge', async (t) => {
  const { app } = await scene(t, 'sender-conflict');

  const anna = await app.resolveChannelSender({
    channel: 'email', handle: 'anna@prestigroup.example',
    firstName: 'Anna', lastName: 'Bianchi', companyName: 'Presti Group', domain: 'prestigroup.example', actor: ACTOR,
  });
  assert.equal(anna.outcome, 'created');

  const bruno = await app.resolveChannelSender({
    channel: 'whatsapp', handle: '+393330000001', email: 'bruno@prestigroup.example',
    firstName: 'Bruno', lastName: 'Neri', companyName: 'Presti Group', domain: 'prestigroup.example', actor: ACTOR,
  });
  assert.equal(bruno.outcome, 'created');

  // The WhatsApp handle belongs to Bruno, but the sender also carries Anna's
  // email: conflicting evidence about one sender.
  const conflict = await app.resolveChannelSender({
    channel: 'whatsapp', handle: '+393330000001', email: 'anna@prestigroup.example', actor: ACTOR,
  });
  assert.equal(conflict.outcome, 'unresolved');
  assert.equal(conflict.contact, null);
  assert.equal(conflict.rule, 'external-identity');

  const candidates = app.modules.get('duplicate-candidate').service.listWhere({ status: 'unresolved' });
  assert.equal(candidates.length, 1, 'the conflict became exactly one candidate for a human');
  assert.equal(candidates[0].rule, 'external-identity');
  const pair = [`${candidates[0].leftResource}:${candidates[0].leftId}`, `${candidates[0].rightResource}:${candidates[0].rightId}`].sort();
  assert.deepEqual(pair, [`contact:${anna.contact.id}`, `contact:${bruno.contact.id}`].sort());

  assert.equal(contactsCount(app), 2, 'no contact was fused or removed');
  const identities = identitiesOf(app, bruno.contact.id);
  assert.equal(identities.length, 1, 'no identity was re-linked by the conflict');
  assert.equal(identities[0].externalId, '+393330000001');

  const profile = await app.readCustomerProfile({ resource: 'contact', id: bruno.contact.id });
  assert.equal(profile.duplicateCandidates.length, 1, 'the card shows the open candidate instead of hiding it');
});

test('sender evidence reaching two companies becomes a candidate pair, never a company pick', async (t) => {
  const { app } = await scene(t, 'sender-company-ambiguous');

  const first = await app.services.companies.create({ name: 'Acme Srl', domain: 'acme.example' }, { actor: ACTOR });
  const second = await app.services.companies.create({ name: 'Acme Srl', domain: 'acme.example' }, { actor: ACTOR });

  const answer = await app.resolveChannelSender({
    channel: 'phone', handle: '+3902000000', companyName: 'Acme Srl', domain: 'acme.example', actor: ACTOR,
  });
  assert.equal(answer.outcome, 'unresolved');
  assert.equal(answer.contact, null);

  const candidates = app.modules.get('duplicate-candidate').service.listWhere({ status: 'unresolved' });
  assert.equal(candidates.length, 1, 'the ambiguity became a candidate pair for a human');
  const pair = [`${candidates[0].leftResource}:${candidates[0].leftId}`, `${candidates[0].rightResource}:${candidates[0].rightId}`].sort();
  assert.deepEqual(pair, [`company:${first.id}`, `company:${second.id}`].sort());
  assert.equal(contactsCount(app), 0, 'no contact was created from company-only evidence');
});

test('a sender reaching only a company is never matched to it', async (t) => {
  const { app } = await scene(t, 'sender-company-only');

  const company = await app.services.companies.create({ name: 'Solo Srl', domain: 'solo.example' }, { actor: ACTOR });

  // Company evidence alone, no email: no contact can be created or confirmed.
  const companyOnly = await app.resolveChannelSender({
    channel: 'phone', handle: '+3902000001', companyName: 'Solo Srl', domain: 'solo.example', actor: ACTOR,
  });
  assert.equal(companyOnly.outcome, 'unresolved');
  assert.equal(companyOnly.contact, null);
  assert.equal(contactsCount(app), 0, 'a sender is never matched to a company');

  // The same evidence with an email creates the contact under that company.
  const withEmail = await app.resolveChannelSender({
    channel: 'phone', handle: '+3902000001', email: 'info@solo.example',
    firstName: 'Solo', lastName: 'Referente', companyName: 'Solo Srl', domain: 'solo.example', actor: ACTOR,
  });
  assert.equal(withEmail.outcome, 'created');
  assert.equal(withEmail.rule, 'company-name-domain');
  const contact = app.database.raw.prepare('SELECT * FROM contacts WHERE id = ?').get(withEmail.contact.id);
  assert.equal(contact.company_id, company.id, 'the contact is created under the matched company');
  assert.equal(contactsCount(app), 1);
});

test('a sender with no linkable identity and no email stays unresolved with no writes', async (t) => {
  const { app } = await scene(t, 'sender-bare-handle');

  const answer = await app.resolveChannelSender({
    channel: 'tiktok', handle: '@unknown-passerby', actor: ACTOR,
  });
  assert.equal(answer.outcome, 'unresolved');
  assert.equal(answer.contact, null);
  assert.deepEqual(answer.candidates, []);
  assert.equal(contactsCount(app), 0, 'a contact needs an email and none was invented');
  assert.equal(
    app.modules.get('external-identity').service.listWhere({ status: 'active' }).length,
    0,
    'an identity with no subject is not recorded');
  assert.equal(
    app.modules.get('duplicate-candidate').service.listWhere({ status: 'unresolved' }).length,
    0,
    'one bare handle with no other evidence names no pair');
});

test('malformed sender requests are refused before anything is read or written', async (t) => {
  const { app } = await scene(t, 'sender-validation');

  const refusals = [
    { channel: 'sms', handle: '+393331234567' },
    { channel: 'whatsapp', handle: '   ' },
    { channel: 'email', handle: 'not-an-address' },
    { channel: 'instagram', handle: 'luca.rossi', email: 'not-an-address' },
    { channel: 'phone', handle: '  - ( ) . ' },
    null,
  ];
  for (const request of refusals) {
    await assert.rejects(
      app.resolveChannelSender({ ...request, actor: ACTOR }),
      (error) => error?.name === 'ValidationError',
      `must refuse ${JSON.stringify(request)}`);
  }
  assert.equal(contactsCount(app), 0, 'refused requests write nothing');
});
