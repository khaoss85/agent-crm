import test from 'node:test';
import assert from 'node:assert/strict';
import { memberLabel, personLabel, teamPeople } from '../apps/admin/public/admin-labels.js';
import { memberLabelFor, personRows } from '../apps/admin/public/admin-calendario.js';
import { buildTeamRows } from '../apps/admin/public/admin-spazi-accessi.js';
import { createReportingView, withPersonNames } from '../apps/admin/public/admin-reporting.js';
import { createOfferDetail } from '../apps/admin/public/admin-offer.js';
import { createPipelineBoard } from '../apps/admin/public/admin-pipeline.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

/**
 * backlog:3ce220e60c33 (famiglia F5): one row per person on every screen
 * that names the team, through the one shared `teamPeople`. The Dan case of
 * the Mac check (09/11): three identities of one person — the adopted broker
 * member, github and google — are one row with the profile name; two
 * homonyms with no key and no mailbox stay two rows; no technical id
 * (`…@accordo.invalid`, `github|…`, `google|…`, a slug like `coach-guido`)
 * ever reaches the screen.
 */

const DAN = [
  { subject: 'broker+adopted-7f3a@accordo.invalid', displayName: 'Daniele Pelleri', email: 'broker+adopted-7f3a@accordo.invalid', operatorAccountId: 'op-dan', role: 'owner', status: 'active' },
  { subject: 'github|48571113', displayName: 'khaoss85', email: 'dan@example.com', operatorAccountId: 'op-dan', role: 'owner', status: 'active' },
  { subject: 'google|1049887766', displayName: 'daniele pelleri', email: 'dan@gmail.example', operatorAccountId: 'op-dan', role: 'owner', status: 'active' },
];
const HOMONYMS = [
  { subject: 'rossi-a', displayName: 'Marco Rossi', role: 'operator', status: 'active' },
  { subject: 'rossi-b', displayName: 'Marco Rossi', role: 'operator', status: 'active' },
];
const GUIDO = { subject: 'coach-guido', displayName: 'Guido Bianchi', email: 'guido@example.com', role: 'operator', status: 'active' };
const ROSTER = [...DAN, ...HOMONYMS, GUIDO];
const DAN_IDS = DAN.map((member) => member.subject);

const TECHNICAL = /@accordo\.invalid|coach-guido|github\||google\||broker\+|khaoss85|rossi-[ab]/;
const textOf = (mount) => [...mount.findAll('p'), ...mount.findAll('span'), ...mount.findAll('td'), ...mount.findAll('button'), ...mount.findAll('strong'), ...mount.findAll('h2'), ...mount.findAll('h3'), ...mount.findAll('div')]
  .map((node) => `${node.textContent} ${node.getAttribute('title') ?? ''} ${node.getAttribute('aria-label') ?? ''}`)
  .join(' ');

test('teamPeople: the Dan case is one row with the profile name', () => {
  const people = teamPeople(ROSTER);
  const dan = people.filter((row) => row.subjects.some((subject) => DAN_IDS.includes(subject)));
  assert.equal(dan.length, 1, 'broker+adopted, github and google with one person key are one row');
  assert.deepEqual(dan[0].subjects, DAN_IDS);
  assert.equal(dan[0].label, 'Daniele Pelleri', 'the full profile name, never the handle or a lower-case copy');
  assert.equal(dan[0].email, 'dan@example.com', 'the first real mailbox, never the broker one');
  assert.deepEqual(people.map((row) => row.label), ['Daniele Pelleri', 'Marco Rossi (1)', 'Marco Rossi (2)', 'Guido Bianchi']);
  for (const row of people) assert.doesNotMatch(row.label, TECHNICAL);
});

test('teamPeople joins on mailbox AND name only, never on one alone (agent-crm#644/#742)', () => {
  const rows = (roster) => teamPeople(roster).map((row) => row.subjects);
  assert.deepEqual(rows([
    { subject: 'a', displayName: 'Sara Neri', email: 'sara@example.com' },
    { subject: 'b', displayName: ' sara  neri ', email: 'SARA@example.com' },
  ]), [['a', 'b']], 'same mailbox and same name, trimmed and case-insensitive: one person');
  assert.deepEqual(rows([
    { subject: 'a', displayName: 'Sara Neri', email: 'info@example.com' },
    { subject: 'b', displayName: 'Luca Blu', email: 'info@example.com' },
  ]), [['a'], ['b']], 'a shared mailbox alone never merges');
  assert.deepEqual(rows([
    { subject: 'a', displayName: 'Sara Neri', email: 'sara@example.com' },
    { subject: 'b', displayName: 'Sara Neri', email: 'neri@example.com' },
  ]), [['a'], ['b']], 'a shared name alone never merges');
  assert.deepEqual(rows([
    { subject: 'a', displayName: 'Sara Neri', email: 'sara@example.com', operatorAccountId: 'op-1' },
    { subject: 'b', displayName: 'Sara Neri', email: 'sara@example.com', operatorAccountId: 'op-2' },
  ]), [['a'], ['b']], 'two different person keys never fold into one row');
});

test('Team card and «Scegli una persona…» (Calendario personRows): one row for Dan, two for the homonyms', () => {
  const rows = personRows(['github|48571113'], [], ROSTER);
  assert.deepEqual(rows.map((row) => row.label), ['Daniele Pelleri', 'Marco Rossi (1)', 'Marco Rossi (2)', 'Guido Bianchi']);
  assert.deepEqual(rows[0].ids, DAN_IDS);
  assert.equal(memberLabelFor('google|1049887766', [], ROSTER), 'Daniele Pelleri', 'a booking line names the person');
  for (const row of rows) assert.doesNotMatch(`${row.label} ${row.name ?? ''}`, TECHNICAL);
  // backlog:f4a1f25048c8: the Calendario no longer merges on a mailbox alone.
  const shared = personRows([], [], [
    { subject: 'a', displayName: 'Sara Neri', email: 'info@example.com' },
    { subject: 'b', displayName: 'Luca Blu', email: 'info@example.com' },
  ]);
  assert.deepEqual(shared.map((row) => row.label), ['Sara Neri', 'Luca Blu']);
});

test('Spazi e accessi: one row for Dan, «Rimuovi» covers all his identities, two rows for the homonyms', () => {
  const rows = buildTeamRows(ROSTER);
  const names = rows.map((row) => row.name);
  assert.equal(names.filter((name) => name === 'Daniele Pelleri').length, 1);
  // Two homonyms are two rows, each with its own «Rimuovi».
  assert.deepEqual([...names].sort(), ['Daniele Pelleri', 'Guido Bianchi', 'Marco Rossi', 'Marco Rossi']);
  const dan = rows.find((row) => row.name === 'Daniele Pelleri');
  assert.deepEqual(dan.removable, [...DAN_IDS].sort());
  for (const row of rows) assert.doesNotMatch(`${row.name} ${row.email ?? ''}`, TECHNICAL);
});

test('Oggi (memberLabel): every identity of Dan reads the profile name', () => {
  for (const subject of DAN_IDS) assert.equal(memberLabel(subject, ROSTER), 'Daniele Pelleri');
  assert.equal(memberLabel('coach-guido', ROSTER), 'Guido Bianchi');
  assert.equal(memberLabel('coach-guido', []), 'Coach Guido', 'an unknown slug reads as words, never as the id');
});

test('personLabel: a roster slug reads the profile name; an unknown slug reads as words, never the id', () => {
  assert.equal(personLabel('coach-guido', ROSTER), 'Guido Bianchi');
  assert.equal(personLabel('op-dan', ROSTER), 'Daniele Pelleri', 'the person key names the person too');
  assert.equal(personLabel('coach-guido', []), 'Coach Guido');
  assert.equal(personLabel('Marco Rossi', []), 'Marco Rossi', 'a typed name stays');
  assert.equal(personLabel('user-12345', []), null);
  assert.equal(personLabel('broker+x@accordo.invalid', []), null);
});

test('review Muse #750 P2: a real mailbox owner stays on screen, only technical ones hide', () => {
  assert.equal(personLabel('mario.rossi@esempio.it', []), 'mario.rossi@esempio.it');
  assert.equal(personLabel('mario.rossi@esempio.it', ROSTER), 'mario.rossi@esempio.it');
  assert.equal(personLabel('broker+adopted-1@accordo.invalid', []), null);
  assert.equal(personLabel('google|1049', []), null);
});

test('review Muse #750 P2: a real name with a hyphen is never treated as a slug', () => {
  const people = teamPeople([{ subject: 'google|77', displayName: 'anna-maria', email: 'am@example.com' }]);
  assert.equal(people[0].label, 'anna-maria', 'a displayName is a name, whatever its shape');
  assert.equal(memberLabel('google|77', [{ subject: 'google|77', displayName: 'anna-maria' }]), 'anna-maria');
  // Only a stored id reads as words: a nameless roster slug, an offer owner.
  assert.equal(teamPeople([{ subject: 'coach-guido' }])[0].label, 'Coach Guido');
});

test('review Muse #750 P2: «Cosa noto» swaps every owner once, never a name just written in', () => {
  const roster = [
    { subject: 'coach-guido', displayName: 'Guido Bianchi' },
    { subject: 'Bianchi', displayName: 'Luca Neri' },
  ];
  const model = {
    owners: ['coach-guido', 'Bianchi'], team: [],
    insights: [{ text: 'coach-guido tiene i lead: spostarli a Bianchi.' }],
  };
  assert.equal(withPersonNames(model, roster).insights[0].text, 'Guido Bianchi tiene i lead: spostarli a Luca Neri.');
});

test('review Muse #750 P2: Pipeline and Offerta show a mailbox referente as written', async () => {
  const owner = 'mario.rossi@esempio.it';
  const client = (base) => ({
    async request(path, options) {
      if (path.startsWith('/api/modules/opportunity/records/') || path.startsWith('/api/opportunities')) {
        const answer = await base.request(path, options);
        return answer.items ? { items: answer.items.map((item) => ({ ...item, owner })) } : { ...answer, owner };
      }
      return base.request(path, options);
    },
  });
  const doc = createFakeDocument();
  const mount = createMount();
  await createOfferDetail({ doc, mount, client: client(offerClient(ROSTER)) }).renderOfferDetail('off1');
  const facts = Object.fromEntries(mount.findAll('p')
    .filter((node) => node.getAttribute('class') === 'offer-fact')
    .map((node) => [node.findAll('span')[0].textContent, node.findAll('span')[1].textContent]));
  assert.equal(facts.Referente, owner);
  const boardMount = createMount();
  await createPipelineBoard({ doc: createFakeDocument(), mount: boardMount, client: client(offerClient(ROSTER)) }).renderBoard('b2b-sales');
  assert.match(textOf(boardMount), /mario\.rossi@esempio\.it/);
  assert.doesNotMatch(textOf(boardMount), /Membro del team/);
});

function dashboard() {
  return {
    period: '2026-11', periodLabel: 'novembre 2026', currency: 'EUR', truncated: false,
    kpis: [], funnel: [], valueByStage: [], monthly: [],
    owners: ['coach-guido', 'github|48571113'],
    team: [
      { owner: 'coach-guido', openCount: 2, openMinor: 300000, wonCount: 1, wonMinor: 100000, winRateDisplay: '50%' },
      { owner: 'github|48571113', openCount: 1, openMinor: 100000, wonCount: 0, wonMinor: 0, winRateDisplay: 'n.d.' },
    ],
    insights: [{ text: 'coach-guido tiene 3.000 € aperti con il tasso più basso: propone di spostare i lead a github|48571113.' }],
    forecast: { label: 'stima', items: [] },
    csv: { filename: 'reporting.csv', content: 'a' },
    currencies: { others: [] },
    channels: { weeks: [], channels: [], total: 0 },
  };
}

test('Reporting: the persona filter, the team table and «Cosa noto» name people, never «coach-guido»', async () => {
  const shown = withPersonNames(dashboard(), ROSTER);
  assert.deepEqual(shown.team.map((entry) => entry.owner), ['Guido Bianchi', 'Daniele Pelleri']);
  assert.deepEqual(shown.owners, ['coach-guido', 'github|48571113'], 'the filter still sends the stored owner');
  assert.doesNotMatch(shown.insights[0].text, TECHNICAL);

  const doc = createFakeDocument();
  const mount = createMount();
  const requests = [];
  const view = createReportingView({
    doc,
    mount,
    client: {
      request: async (path, options = {}) => {
        enforceAdminWriteGate(path, options);
        requests.push(path);
        if (path.includes('/api/reporting/dashboard')) return dashboard();
        if (path === '/api/spine/memberships') return { items: ROSTER };
        return { items: [] };
      },
    },
    navigate: () => {},
    log: () => {},
    download: () => {},
  });
  await view.renderReporting();
  const text = textOf(mount);
  assert.match(text, /Guido Bianchi/);
  assert.match(text, /Daniele Pelleri/);
  assert.doesNotMatch(text, TECHNICAL);
});

const SCHEMA = {
  pipelineContract: 1,
  pipelines: [{
    pipelineContract: 1, name: 'b2b-sales', label: 'B2B Sales', module: 'opportunity', defaultStage: 'discovery',
    movePath: '/api/modules/opportunity/records/:id/actions/move-stage',
    stages: [{ key: 'discovery', label: 'Scoperta', order: 10, type: 'open', probability: 10 }],
  }],
};
const OFFER = {
  id: 'off1', name: 'Cucina per Giulia', contactName: 'Giulia Verdi', companyName: null,
  pipelineKey: 'b2b-sales', pipelineStage: 'discovery', valueCents: 2750000, currency: 'EUR',
  expectedCloseDate: '2026-11-20', createdAt: '2026-10-02T09:15:00.000Z', updatedAt: '2026-10-28T18:40:00.000Z',
  owner: 'coach-guido',
};

function offerClient(roster) {
  return {
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      if (path === '/api/schema') return SCHEMA;
      if (path.startsWith('/api/modules/opportunity/records/')) return { ...OFFER };
      if (path === '/api/spine/memberships') return { items: roster };
      if (path.startsWith('/api/opportunities')) return { items: [{ ...OFFER }] };
      if (path.startsWith('/api/audit')) {
        return { items: [
          { action: 'opportunity.created', actorType: 'user', actorId: 'google|1049887766', createdAt: '2026-10-02T09:15:00.000Z' },
          { action: 'opportunity.updated', actorType: 'user', actorId: 'coach-guido', createdAt: '2026-10-28T18:40:00.000Z' },
        ] };
      }
      return { items: [] };
    },
  };
}

test('Offerta: Referente and «Creata da» name people from the team, never an id or «utente»', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const detail = createOfferDetail({ doc, mount, client: offerClient(ROSTER) });
  await detail.renderOfferDetail('off1');
  const facts = Object.fromEntries(mount.findAll('p')
    .filter((node) => node.getAttribute('class') === 'offer-fact')
    .map((node) => [node.findAll('span')[0].textContent, node.findAll('span')[1].textContent]));
  assert.equal(facts.Referente, 'Guido Bianchi');
  assert.equal(facts['Creata da'], 'Daniele Pelleri');
  const text = textOf(mount);
  assert.match(text, /da Guido Bianchi/, 'the history names the author');
  assert.doesNotMatch(text, TECHNICAL);
});

test('Offerta without a readable team: the slug reads as words, never as the id', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const detail = createOfferDetail({ doc, mount, client: offerClient([]) });
  await detail.renderOfferDetail('off1');
  const text = textOf(mount);
  assert.match(text, /Coach Guido/);
  assert.doesNotMatch(text, TECHNICAL);
});

test('Pipeline: the referente filter, the card badge and the list name the person', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const board = createPipelineBoard({ doc, mount, client: offerClient(ROSTER) });
  await board.renderBoard('b2b-sales');
  const text = textOf(mount);
  assert.match(text, /Guido Bianchi/);
  assert.doesNotMatch(text, TECHNICAL);
});

test('design check #750: an id with no person behind it reads as a name, never raw', async () => {
  // Calendario: the week names «marco» and «sara», the roster knows neither.
  assert.deepEqual(personRows(['marco', 'sara'], [], null).map((row) => row.label), ['Marco', 'Sara']);
  assert.equal(memberLabelFor('sara', [], []), 'Sara');
  // …and once the roster joins «marco» to Marco Ferri, the row is the person.
  const roster = [
    { subject: 'google|1002', displayName: 'Marco Ferri', email: 'marco@studioaurora.it', operatorAccountId: 'op-marco' },
    { subject: 'marco', operatorAccountId: 'op-marco' },
  ];
  const rows = personRows(['marco', 'sara'], [], roster);
  assert.deepEqual(rows.map((row) => row.label), ['Marco Ferri', 'Sara']);
  assert.deepEqual(rows[0].ids.sort(), ['google|1002', 'marco']);
  // Reporting: owners «alice» and «bob» with no roster read Alice and Bob,
  // and the chips take their initials from that name.
  const model = { ...dashboard(), owners: ['alice', 'bob'], team: [
    { owner: 'alice', openCount: 1, openMinor: 100, wonCount: 0, wonMinor: 0, winRateDisplay: 'n.d.' },
    { owner: 'bob', openCount: 1, openMinor: 100, wonCount: 0, wonMinor: 0, winRateDisplay: 'n.d.' },
  ], insights: [{ text: 'alice tiene molto aperto: propone di spostare i lead a bob.' }] };
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createReportingView({
    doc, mount, navigate: () => {}, log: () => {}, download: () => {},
    client: { request: async (path) => (path.includes('/api/reporting/dashboard') ? model : { items: [] }) },
  });
  await view.renderReporting();
  const chips = mount.findAll('button').filter((node) => node.getAttribute('data-owner') !== null);
  assert.deepEqual(chips.map((node) => [node.textContent, node.getAttribute('title')]), [['A', 'Alice'], ['B', 'Bob']]);
  const text = textOf(mount);
  assert.match(text, /Alice tiene molto aperto: propone di spostare i lead a Bob\./);
  assert.doesNotMatch(text, /\balice\b|\bbob\b/);
});
