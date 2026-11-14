import test from 'node:test';
import assert from 'node:assert/strict';
import { createCustomerCardView } from '../apps/admin/public/admin-customer-card.js';
import { offerActorLabel } from '../apps/admin/public/admin-labels.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

/**
 * backlog:6c40dcfaeb3f — production 14/11 01:40Z: on a cold load every note
 * read «dal team» for 8-15 s and then changed under the eyes, once the slow
 * roster read (/spine/memberships) answered. While the roster is read the
 * writer's place holds a neutral grey bar; «dal team» stays for a writer the
 * team really does not name. «Offerta creata» names its creator from the
 * same source as the offer page («Creata da»).
 */

const ME = 'google|601';
const CARD = {
  customerCardContract: 1, subject: { resource: 'contact', id: 'c1' }, name: 'Cliente Prova',
  company: { id: 'co1', name: 'Azienda Esempio' }, phone: { available: false, value: null },
  email: 'cliente@esempio.invalid', socials: [], status: { value: 'contatto' },
};
const timelineOf = (items) => ({
  customerTimelineContract: 1, subject: { resource: 'contact', id: 'c1' },
  conversations: { available: true, count: 0, truncated: false, items: [] },
  entries: { available: true, count: items.length, truncated: false, items },
  appointments: { available: true, count: 0, truncated: false, items: [] },
});
const NOTE = { entry: 'note', id: 'n1', body: 'Richiamare lunedì', teamAuthorId: ME, occurredAt: '2026-11-13T09:00:00.000Z' };
const SENT = {
  entry: 'message', id: 'm1', conversationId: 't1', channel: 'whatsapp', direction: 'outbound', sync: 'delivered',
  body: 'Ciao, ti scrivo per la prova', teamAuthorId: ME, remoteHandle: '+393330000000', errorCode: null, occurredAt: '2026-11-13T08:00:00.000Z',
};
const PROFILE = {
  customerProfileContract: 1, subject: { resource: 'contact', id: 'c1' },
  canonicalIdentity: { linked: false, members: [] },
  identity: { company: { id: 'co1', name: 'Azienda Esempio' }, contact: { id: 'c1', firstName: 'Cliente', lastName: 'Prova', email: 'cliente@esempio.invalid', companyId: 'co1' } },
  externalIdentities: [],
  opportunities: { available: true, count: 0, countIsComplete: true, truncated: false, items: [] },
  quotes: { available: true, count: 0, countIsComplete: true, truncated: false, items: [] },
};
const ROSTER = { items: [{ subject: ME, displayName: 'Operatrice Uno', email: 'uno@esempio.invalid' }] };

/** The roster read waits for `release()` (a cold load on the pilot: 8-15 s). */
function client({ items = [NOTE, SENT], roster = ROSTER, rosterFails = false, profile = PROFILE, audit = [] } = {}) {
  let open = () => {};
  const gate = new Promise((resolve) => { open = resolve; });
  return {
    release: () => open(),
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      if (path.startsWith('/api/customer-hub/card/')) return CARD;
      if (path.startsWith('/api/customer-hub/timeline/')) return timelineOf(items);
      if (path.startsWith('/api/customer-data/profile/')) return profile;
      if (path === '/api/spine/memberships') {
        await gate;
        if (rosterFails) throw Object.assign(new Error('slow'), { status: 503 });
        return roster;
      }
      if (path.startsWith('/api/audit')) return { items: audit };
      if (path === '/api/schema') return { pipelines: [] };
      throw Object.assign(new Error('Not Found'), { status: 404 });
    },
  };
}

const flush = async (rounds = 10) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

async function open(fake) {
  const mount = createMount();
  const view = createCustomerCardView({ doc: createFakeDocument(), mount, client: fake, spaceId: 'spazio-prova', toast: () => {} });
  void view.renderCard('contact', 'c1');
  await flush();
  return { mount };
}

const timelineText = (mount) => mount.findAll('section')
  .find((node) => String(node.getAttribute('class')).includes('bo-scheda-card-timeline'))?.textContent ?? '';
const pending = (mount) => mount.findAll('span').filter((node) => node.getAttribute('data-who-pending') === 'true');

test('6c40dcfaeb3f: while the roster is read a note and a sent message hold a grey bar, never «dal team»; then the name', async () => {
  const fake = client();
  const { mount } = await open(fake);
  const before = timelineText(mount);
  assert.ok(before.includes('Richiamare lunedì'), 'the note is on screen at once');
  assert.ok(!before.includes('dal team'), before);
  assert.ok(!before.includes('il team'), 'the sent message waits too');
  assert.ok(!before.includes('da utente'));
  assert.equal(pending(mount).length, 2, 'one neutral bar per waiting signature');
  fake.release();
  await flush();
  const after = timelineText(mount);
  assert.ok(after.includes('Nota · da Operatrice Uno'), after);
  assert.ok(after.includes('Operatrice Uno'), 'the sent message names its writer');
  assert.equal(pending(mount).length, 0, 'the bars are gone');
});

for (const [label, options] of [
  ['a roster that does not name the writer', { roster: { items: [] } }],
  ['a roster that fails', { rosterFails: true }],
]) {
  test(`6c40dcfaeb3f: with ${label} the note reads «dal team» once the roster has answered`, async () => {
    const fake = client(options);
    const { mount } = await open(fake);
    assert.ok(!timelineText(mount).includes('dal team'), 'not before the answer');
    fake.release();
    await flush();
    assert.ok(timelineText(mount).includes('Nota · dal team'), timelineText(mount));
    assert.equal(pending(mount).length, 0);
  });
}

test('6c40dcfaeb3f: a note named by the API, or with no writer at all, never waits', async () => {
  const named = { ...NOTE, id: 'n2', body: 'Nota firmata', teamAuthor: 'Operatrice Uno' };
  const anonymous = { ...NOTE, id: 'n3', body: 'Nota senza autore', teamAuthorId: null };
  const { mount } = await open(client({ items: [named, anonymous] }));
  const text = timelineText(mount);
  assert.ok(text.includes('Nota · da Operatrice Uno'), text);
  assert.ok(text.includes('Nota · dal team'), 'no writer on record: «dal team» at once');
  assert.equal(pending(mount).length, 0);
});

test('6c40dcfaeb3f: «Offerta creata» names its creator like the offer page «Creata da»', async () => {
  const offer = { id: 'o1', name: 'Pacchetto prova', stage: 'proposal', status: 'proposal', createdAt: '2026-11-12T08:00:00.000Z' };
  const audit = [{ id: 'a0', action: 'opportunity.created', actorType: 'user', actorId: ME, createdAt: '2026-11-12T08:00:00.000Z' }];
  const profile = { ...PROFILE, opportunities: { available: true, count: 1, countIsComplete: true, truncated: false, items: [offer] } };
  const fake = client({ items: [], profile, audit });
  const { mount } = await open(fake);
  fake.release();
  await flush();
  const text = timelineText(mount);
  assert.ok(text.includes('Offerta creata · da Operatrice Uno'), text);
  // The same rule as the offer page.
  assert.equal(offerActorLabel(audit[0], offer, [{ subjects: [ME], keys: [], name: 'Operatrice Uno', label: 'Operatrice Uno', known: true }]), 'Operatrice Uno');
});
