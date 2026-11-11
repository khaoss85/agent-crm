// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import {
  buildInbox, buildPreCallBrief, buildTodayAgenda, createOggiView, ownMailboxes, renderOggi,
} from '../apps/admin/public/admin-oggi.js';
import { isAutomatedSender, isNotificationMessage } from '../apps/admin/public/admin-labels.js';
import { takePendingCalendarEvent, writePendingCalendarEvent } from '../apps/admin/public/admin-prefill.js';
import { createCalendarioView } from '../apps/admin/public/admin-calendario.js';
import { isAutomatedGmailSender } from '../packages/channels/src/gmail.js';
import { isTechnicalLocalPart } from '../packages/customer-data/src/display-name.js';
import { leadNamesForEmail } from '../packages/customer-data/src/sender.js';

/**
 * Giro esplorativo UX in produzione, 11/11 ~14:50Z (Dan), schermata Oggi:
 * - backlog:bd5e84545021 — for 6-9 s the day showed stand-ins that read as
 *   data («un ospite da confermare», a stored label, the notes cue) and a
 *   «Domani» whose first click did nothing; «Fonti: Appuntamento delle
 *   12:00» opened the technical record page `#/modules/appointment/<id>`.
 * - backlog:bab63e32acdb — PayPal receipts, Google Docs comments and other
 *   no-reply mail sat in «Da rispondere» with a «Rispondi» button.
 */

const NOW = new Date('2026-10-19T07:00:00.000Z'); // Monday, 09:00 in Rome
const host = { subjectOwner: 'host', subjectResource: 'contact' };
/** A synced appointment: no stored name a person would trust, a team member. */
const APPT = {
  id: 'appt-9', status: 'booked', ...host, subjectId: 'fio', subjectLabel: 'Prova verifica 07/11 L1 github',
  teamMemberId: 'google|1049', startsAt: '2026-10-19T10:00:00.000Z', notes: 'Prova verifica 07/11 L1 github',
};
const TASK = {
  id: 'task-1', status: 'open', title: 'Richiama per il preventivo', ...host, subjectId: 'ada',
  subjectLabel: 'Ada Rossi', dueAt: '2026-10-19T00:00:00.000Z', openedAt: '2026-10-18T08:00:00.000Z',
};
const PERSON_MSG = {
  id: 'm1', conversationId: 'c1', direction: 'inbound', channel: 'email', body: 'Info sui prezzi',
  occurredAt: '2026-10-19T06:00:00.000Z', ...host, subjectId: 'lia', remoteHandle: 'lia.marroni@gmail.com',
};

function deferred() {
  /** @type {(value?: any) => void} */
  let resolve = () => {};
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

const flush = async () => {
  for (let i = 0; i < 20; i += 1) await new Promise((done) => { setImmediate(done); });
};

/** Every essential read answers at once; profile and roster reads wait for `names`. */
function slowNamesClient({ messages = [PERSON_MSG], appointments = [APPT] } = {}) {
  const names = deferred();
  /** @type {Array<{ path: string, method: string }>} */
  const calls = [];
  return {
    names,
    calls,
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      calls.push({ path, method: options.method ?? 'GET' });
      if (path === '/api/schema') return { domains: { work: {}, appointments: {}, channels: {}, interactions: {} } };
      if (path === '/api/profile') return {};
      if (path.startsWith('/api/customer-data/profile/contact/fio')) {
        await names.promise;
        return { identity: { displayName: 'Fio Neri' } };
      }
      if (path.startsWith('/api/customer-data/profile/contact/lia')) {
        await names.promise;
        return { identity: { displayName: 'Lia Marroni' } };
      }
      if (path === '/api/spine/memberships') {
        await names.promise;
        return { items: [{ subject: 'google|1049', displayName: 'Daniele Pelleri', email: 'dan@example.com' }] };
      }
      if (path.startsWith('/api/modules/work-task/records?')) return { items: [TASK] };
      if (path.startsWith('/api/modules/appointment/records')) return { items: appointments };
      if (path.startsWith('/api/modules/channel-connection/records')) return { items: [] };
      if (path.startsWith('/api/modules/conversation/records')) return { items: [] };
      if (path.startsWith('/api/modules/interaction-message/records')) return { items: messages };
      if (path.startsWith('/api/modules/interaction-call/records')) return { items: [] };
      throw new Error(`unexpected read: ${path}`);
    },
  };
}

function memoryStorage() {
  const map = new Map();
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
  };
}

// ---------------------------------------------------------------------------
// backlog:bd5e84545021 — skeleton and waiting actions
// ---------------------------------------------------------------------------

test('bd5e84545021: before the first answer Oggi shows a grey skeleton, no button and no word that passes for data', () => {
  const doc = createFakeDocument();
  const mount = createMount();
  renderOggi({ doc, mount, spaceName: 'Spazio', userName: 'Elena', now: new Date(2026, 9, 19, 9), loading: true });
  const skeleton = mount.querySelector('div[data-oggi-skeleton="true"]');
  assert.ok(skeleton, 'the day skeleton is on screen');
  assert.equal(skeleton.getAttribute('aria-busy'), 'true');
  assert.ok(skeleton.findAll('span').filter((node) => node.getAttribute('data-skeleton') === 'true').length >= 6, 'grey bars for recap, cards and agenda');
  assert.equal(skeleton.textContent, '', 'no text inside the skeleton');
  assert.equal(mount.findAll('button').length, 0, 'nothing to press yet');
  assert.equal(mount.findAll('a').length, 0, 'nothing to follow yet');
  const status = mount.querySelector('p[role="status"]');
  assert.equal(status?.textContent, 'Carico la tua giornata…', 'the wait is announced once for assistive tech');
});

test('bd5e84545021: while the names are read the day shows grey bars and every action waits; then the same buttons wake up', async () => {
  const client = slowNamesClient();
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createOggiView({ doc, mount, client, navigate: () => {}, setTimer: () => null, clearTimer: () => {} });
  let rendered = false;
  void view.render({ spaceName: 'Spazio', links: [], now: NOW }).then(() => { rendered = true; });
  await flush();
  assert.ok(mount.textContent.includes('Richiama per il preventivo'), 'the essentials painted');
  assert.equal(rendered, false, 'the names are still being read');

  const text = mount.textContent;
  for (const standIn of ['ospite da confermare', 'il cliente', 'Prova verifica 07/11 L1 github', 'lia.marroni@gmail.com']) {
    assert.ok(!text.includes(standIn), `no stand-in on screen while the names are read: ${standIn}`);
  }
  const agenda = mount.querySelector('section[data-oggi-section="agenda"]');
  assert.ok(agenda.querySelector('span[data-skeleton="true"]'), 'the agenda row waits with a grey bar');
  const inbox = mount.querySelector('section[data-oggi-section="inbox"]');
  assert.ok(inbox.querySelector('span[data-skeleton="true"]'), 'the Da rispondere name waits with a grey bar');
  const brief = mount.querySelector('section[data-oggi-section="brief"]');
  assert.ok(brief.querySelector('span[data-skeleton="true"]'), 'the next call guest waits with a grey bar');

  const buttons = mount.findAll('button').filter((node) => ['postpone', 'execute'].includes(node.getAttribute('data-triage') ?? '')
    || node.getAttribute('data-action') === 'inbox-reply');
  assert.ok(buttons.length >= 5, 'Domani, the CTAs and Rispondi are on screen');
  assert.ok(buttons.every((node) => node.disabled === true), 'every action waits for the names');
  // A click on a waiting «Domani» runs nothing (production: the first click did nothing, silently).
  const postpone = mount.querySelector('button[data-triage="postpone"]');
  postpone.dispatch('click');
  await flush();
  assert.ok(!client.calls.some((call) => call.method === 'POST'), 'nothing is written while waiting');

  client.names.resolve();
  await flush();
  assert.equal(rendered, true);
  const after = mount.textContent;
  assert.ok(after.includes('Fio Neri') && after.includes('Lia Marroni') && after.includes('Daniele Pelleri'), after);
  assert.equal(mount.querySelector('span[data-skeleton="true"]'), null, 'no grey bar left');
  assert.equal(mount.querySelector('button[data-triage="postpone"]'), postpone, 'the same Domani button');
  const advisorButtons = buttons.filter((node) => node.getAttribute('data-triage') !== null);
  assert.ok(advisorButtons.every((node) => node.disabled === false && mount.contains(node)), 'the advisor buttons are live, in place');
  assert.ok(mount.findAll('button').filter((node) => node.getAttribute('data-action') === 'inbox-reply').every((node) => node.disabled === false));
});

// ---------------------------------------------------------------------------
// backlog:bd5e84545021 — «Fonti: Appuntamento delle …» opens the calendar event
// ---------------------------------------------------------------------------

test('bd5e84545021: no Oggi link opens the technical appointment page', () => {
  const unlinked = { ...APPT, subjectOwner: 'package', subjectLabel: null };
  const brief = buildPreCallBrief({ appointment: unlinked, now: NOW });
  const agenda = buildTodayAgenda([unlinked], NOW);
  const hrefs = [...brief.sources.map((source) => source.href), ...agenda.map((row) => row.href)];
  assert.ok(hrefs.every((href) => !String(href).startsWith('#/modules/appointment')), hrefs.join(', '));
  assert.deepEqual(brief.sources[0], { label: 'Appuntamento delle 12:00', href: '#/calendario', calendarEvent: { id: 'appt-9', day: '2026-10-19' } });
  assert.deepEqual(agenda[0].calendarEvent, { id: 'appt-9', day: '2026-10-19' });
});

test('bd5e84545021: a click on the appointment source hands the event to the calendar and goes there', async () => {
  const client = slowNamesClient();
  client.names.resolve();
  const storage = memoryStorage();
  const seen = [];
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createOggiView({ doc, mount, client, storage, navigate: (hash) => seen.push(hash), setTimer: () => null, clearTimer: () => {} });
  await view.render({ spaceName: 'Spazio', links: [], now: NOW });
  const source = mount.findAll('a').find((node) => node.textContent === 'Appuntamento delle 12:00');
  assert.ok(source, 'the appointment source is a link');
  assert.equal(source.getAttribute('href'), '#/calendario');
  let prevented = false;
  source.dispatch('click', { preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.deepEqual(seen, ['#/calendario']);
  assert.deepEqual(takePendingCalendarEvent(storage), { id: 'appt-9', day: '2026-10-19' }, 'the event waits for the calendar, once');
  assert.equal(takePendingCalendarEvent(storage), null, 'taken once');
});

test('bd5e84545021: the calendar takes the event once, shows its week and opens it', async () => {
  const storage = memoryStorage();
  assert.equal(writePendingCalendarEvent(storage, { id: 'a1', day: '2026-11-05' }), true);
  const week = {
    from: '2026-11-02T00:00:00.000Z',
    to: '2026-11-09T00:00:00.000Z',
    members: [{
      teamMemberId: 'marco',
      appointments: [{
        id: 'a1', status: 'booked', startsAt: '2026-11-05T11:00:00.000Z', endsAt: '2026-11-05T11:30:00.000Z',
        serviceKey: 'prova', teamMemberId: 'marco', subject: { resource: 'contact', id: 'c1', owner: 'host', ownerPackage: null, label: 'Ada' },
      }],
    }],
  };
  const calls = [];
  const client = {
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      calls.push(path);
      if (path === '/api/spine/memberships') return { items: [{ subject: 'marco', displayName: 'Marco' }] };
      if (path === '/api/profile') return { member: null, connections: { available: false, items: [] } };
      if (path.startsWith('/api/appointments/team-week')) return week;
      const error = new Error('not composed');
      Object.assign(error, { code: 'NOT_FOUND', status: 404 });
      throw error;
    },
  };
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createCalendarioView({ searchDelayMs: 0, doc, mount, client, storage, now: () => new Date('2026-10-21T06:00:00Z') });
  await view.render();
  await flush();
  const weekRead = calls.find((path) => path.startsWith('/api/appointments/team-week'));
  assert.ok(weekRead?.includes('from=2026-11-0'), `the event's week, not today's: ${weekRead}`);
  const detail = mount.querySelector('div[data-role="event-detail"]');
  assert.ok(detail, 'the event detail is open');
  assert.equal(takePendingCalendarEvent(storage), null, 'the handoff is consumed');

  // A later visit starts on its own week, nothing selected.
  const again = createMount();
  const second = createCalendarioView({ searchDelayMs: 0, doc, mount: again, client, storage, now: () => new Date('2026-10-21T06:00:00Z') });
  await second.render();
  await flush();
  assert.equal(again.querySelector('div[data-role="event-detail"]'), null, 'no selection on a plain visit');
});

test('bd5e84545021: the event handoff refuses malformed picks and survives a broken storage', () => {
  const storage = memoryStorage();
  assert.equal(writePendingCalendarEvent(storage, { id: '', day: '2026-11-05' }), false);
  assert.equal(writePendingCalendarEvent(storage, { id: 'a1', day: '5 novembre' }), false);
  assert.equal(writePendingCalendarEvent(null, { id: 'a1', day: '2026-11-05' }), false);
  storage.setItem('accordo.bo.calendar-event', '{not json');
  assert.equal(takePendingCalendarEvent(storage), null);
  const throwing = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); }, removeItem: () => {} };
  assert.equal(writePendingCalendarEvent(throwing, { id: 'a1', day: '2026-11-05' }), false);
  assert.equal(takePendingCalendarEvent(throwing), null);
});

// ---------------------------------------------------------------------------
// backlog:bab63e32acdb — notifications apart from Da rispondere
// ---------------------------------------------------------------------------

const MACHINE_SENDERS = [
  ['noreply@namecheap.com', 'Namecheap'],
  ['support@namecheap.com', 'Namecheap Support'],
  ['comments-noreply@docs.google.com', 'Ada Rossi (Documenti Google)'],
  ['drive-shares-dm-noreply@google.com', 'Ada Rossi (tramite Google Drive)'],
  ['notifications@ahrefs.com', 'Ahrefs'],
  ['hello@news.ahrefs.com', 'Ahrefs'],
  ['avvisi@unicredit.it', 'UniCredit S.p.A. NO-REPLY'],
];
const PEOPLE = [
  ['lia.marroni@gmail.com', 'Lia Marroni'],
  ['marco123@libero.it', 'Marco'],
  ['info@palestra-esempio.it', 'Palestra Esempio'],
  ['@lia.marroni', null],
  ['+393331234567', null],
];

test('bab63e32acdb: the sender rules the repo already has call machines machines and people people', () => {
  for (const [handle, label] of MACHINE_SENDERS) assert.equal(isAutomatedSender(handle, label), true, handle);
  for (const [handle, label] of PEOPLE) assert.equal(isAutomatedSender(handle, label), false, handle);
  assert.equal(isAutomatedSender(null, 'Studio Noreply'), true, 'a display name with a no-reply marker');
  assert.equal(isAutomatedSender(undefined), false, 'nothing to read is a person');
});

test('bab63e32acdb: the browser twin agrees with the package sender rules on every address', () => {
  const addresses = [
    ...MACHINE_SENDERS.map(([handle]) => handle), ...PEOPLE.map(([handle]) => handle),
    'no-reply@fastweb.it', 'noreply-it@amazon.it', 'order-update-2@shop.it', 'mailer-daemon@googlemail.com',
    'billing@stripe.com', 'hello@notify.railway.app', 'x@bounce.example.com', 'a@em.brand.it',
    'promo@mailchimp.com', 'x@a.sendgrid.net', 'service@paypal.it', '9xq7exampletoken42-abc@identity-reachout.bounces.google.com',
    'giuseppe1985@gmail.com', 'anna-maria@studio.it', 'Support+tag@Example.com', 'no-reply', '@', 'a@b',
  ];
  for (const address of addresses) {
    const pkg = isAutomatedGmailSender(address) || (address.includes('@') && isTechnicalLocalPart(address));
    assert.equal(isAutomatedSender(address), pkg, address);
  }
  assert.deepEqual(leadNamesForEmail('comments-noreply@docs.google.com'), { firstName: 'Google', lastName: '—' },
    'a no-reply piece names the sender domain, never «Comments Noreply»');
});

test('bab63e32acdb: receipts and no-reply notices leave Da rispondere for a closed «Notifiche automatiche» group', () => {
  const machine = (id, handle, label, at) => ({
    id: `m-${id}`, conversationId: id, direction: 'inbound', channel: 'email', body: 'Ricevuta del pagamento',
    mailSubject: 'Hai inviato un pagamento', occurredAt: at, ...host, subjectId: `s-${id}`, remoteHandle: handle, subjectLabel: label,
  });
  const messages = [
    PERSON_MSG,
    machine('c2', 'comments-noreply@docs.google.com', 'Ada Rossi (Documenti Google)', '2026-10-19T06:30:00.000Z'),
    machine('c3', 'assistenza@paypal.it', 'PayPal Noreply', '2026-10-19T05:30:00.000Z'),
  ];
  const inbox = buildInbox({ messages, now: NOW });
  assert.equal(inbox.total, 1, 'only the person waits');
  assert.deepEqual(inbox.rows.map((row) => row.id), ['c1']);
  assert.equal(inbox.notifications.total, 2);
  assert.deepEqual(inbox.notifications.rows.map((row) => row.id), ['c2', 'c3'], 'newest first');

  const doc = createFakeDocument();
  const mount = createMount();
  let toggled = null;
  renderOggi({
    doc, mount, spaceName: 'Spazio', now: new Date(2026, 9, 19, 9),
    home: {
      recap: 'x', actions: [], triage: {}, agenda: [], brief: null, missing: [], connections: [],
      availability: { work: true, appointments: true, channels: true },
      inbox: { available: true, ...inbox },
      events: { onToggleNotifications: (open) => { toggled = open; } },
    },
  });
  const section = mount.querySelector('section[data-oggi-section="inbox"]');
  assert.ok(section.textContent.includes('1 in attesa'), 'the head counts people only');
  const replies = section.findAll('button').filter((node) => node.getAttribute('data-action') === 'inbox-reply');
  assert.equal(replies.length, 1, '«Rispondi» on the person only');
  const toggle = section.querySelector('button[data-action="inbox-notifications"]');
  assert.ok(toggle, 'the notifications group has its toggle');
  assert.ok(toggle.textContent.includes('Notifiche automatiche (2)'), toggle.textContent);
  assert.equal(toggle.getAttribute('aria-expanded'), 'false', 'closed by default');
  const list = section.querySelector('div[data-oggi-notifications-list="true"]');
  assert.ok(list.getAttribute('class').split(' ').includes('hidden'), 'its rows are hidden');
  assert.equal(list.findAll('button').length, 0, 'no «Rispondi» on a notification');
  toggle.dispatch('click');
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.ok(!list.getAttribute('class').split(' ').includes('hidden'), 'open on click');
  assert.equal(toggled, true, 'the view keeps the open state');
  assert.ok(list.textContent.includes('Hai inviato un pagamento'));
  toggle.dispatch('click');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false', 'closes again');
  assert.equal(toggled, false);
});

test('bab63e32acdb: the open group stays open when the day repaints, and its rows never read profile names', async () => {
  const notice = {
    id: 'm-2', conversationId: 'c2', direction: 'inbound', channel: 'email', body: 'Nuovo commento',
    occurredAt: '2026-10-19T06:30:00.000Z', ...host, subjectId: 'docs', remoteHandle: 'comments-noreply@docs.google.com', subjectLabel: 'Documenti Google',
  };
  const client = slowNamesClient({ messages: [PERSON_MSG, notice], appointments: [] });
  client.names.resolve();
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createOggiView({ doc, mount, client, navigate: () => {}, setTimer: () => null, clearTimer: () => {} });
  await view.render({ spaceName: 'Spazio', links: [], now: NOW });
  assert.ok(!client.calls.some((call) => call.path.includes('/profile/contact/docs')), 'no profile read for a notification');
  const toggle = () => mount.querySelector('button[data-action="inbox-notifications"]');
  assert.equal(toggle().getAttribute('aria-expanded'), 'false');
  toggle().dispatch('click');
  await view.render({ spaceName: 'Spazio', links: [], now: NOW });
  assert.equal(toggle().getAttribute('aria-expanded'), 'true', 'still open after a repaint');
});

// The rows of Presti › Da rispondere on 11/11 ~15:00 (giro esplorativo).
// Verified addresses: the PEC copy and the PayPal receipt; for Google Docs,
// Namecheap and Ahrefs only the display name was visible, so their
// addresses are the senders' usual ones.
const PRESTI = {
  pec: { channel: 'email', remoteHandle: 'daniele.pelleri@pec.libero.it', subjectLabel: 'Daniele Pelleri', mailSubject: 'POSTA CERTIFICATA: Copia di messaggio', body: 'Copia di messaggio di Posta Elettronica Certificata' },
  paypal: { channel: 'email', remoteHandle: 'assistenza@paypal.it', subjectLabel: 'PayPal', mailSubject: 'Ricevuta del pagamento a Sky Italia', body: 'Ciao daniele pelleri Hai pagato 4,99 € EUR a Sky Italia' },
  docs: { channel: 'email', remoteHandle: 'comments-noreply@docs.google.com', subjectLabel: 'Francesco Tirsi (Documenti Google)', body: 'Nuova attività nel seguente documento' },
  namecheap: { channel: 'email', remoteHandle: 'support@namecheap.com', subjectLabel: 'Namecheap Support', body: 'Download the new Private Email mobile app' },
  ahrefs: { channel: 'email', remoteHandle: 'noreply@ahrefs.com', subjectLabel: 'Ahrefs Site Audit', body: 'New crawl for Danielepelleri400 internal URLs' },
  form: { channel: 'email', remoteHandle: 'noreply@arvo.app', subjectLabel: 'Arvo Contact', mailSubject: 'New contact form submission', body: 'NEW CONTACT FORM SUBMISSION Name: Julian Ross' },
  person: { channel: 'email', remoteHandle: 'lia.marroni@gmail.com', subjectLabel: 'Lia Marroni', body: 'Avete posto giovedì?' },
};

test('bab63e32acdb: the general rule on the real Presti rows — receipts, PEC, no-reply in Notifiche; the contact form and people in Da rispondere', () => {
  for (const key of ['pec', 'paypal', 'docs', 'namecheap', 'ahrefs']) {
    assert.equal(isNotificationMessage(PRESTI[key]), true, `${key} is a notification`);
  }
  assert.equal(isNotificationMessage(PRESTI.form), false, 'a website contact form is a person writing, even from a no-reply mailbox');
  assert.equal(isNotificationMessage(PRESTI.person), false);
  assert.equal(isNotificationMessage({ channel: 'website-form', remoteHandle: 'noreply@sito.it', body: 'Ciao' }), false, 'the form channel is a person');
  assert.equal(isNotificationMessage({ channel: 'whatsapp', remoteHandle: '+393331234567', subjectLabel: 'Noreply' }), false, 'only e-mail is classified');
  assert.equal(isNotificationMessage({ channel: 'email', remoteHandle: 'avvocato@legalmail.it' }), true, 'a PEC-only provider');
  // The owner writing to themselves, whatever the mailbox looks like.
  const own = ownMailboxes({ member: { email: 'Dan@Presti.it' }, connections: { available: true, items: [{ connector: 'gmail', status: 'connected', account: 'op@presti.it' }] } });
  assert.deepEqual(own, ['op@presti.it', 'dan@presti.it']);
  assert.equal(isNotificationMessage({ channel: 'email', remoteHandle: 'Daniele <dan@presti.it>' }, { ownAddresses: own }), true, 'a message from the owner to the owner');
  assert.equal(isNotificationMessage({ channel: 'email', remoteHandle: 'dan@presti.it' }), false, 'without the profile the same address is a person');
  assert.deepEqual(ownMailboxes(null), []);
});

test('bab63e32acdb: Presti › Da rispondere keeps Arvo Contact and the person, the other five go to Notifiche', () => {
  const messages = Object.entries(PRESTI).map(([key, row], index) => ({
    ...row, id: `m-${key}`, conversationId: `c-${key}`, direction: 'inbound', ...host, subjectId: key,
    occurredAt: `2026-10-19T0${index}:00:00.000Z`,
  }));
  const inbox = buildInbox({ messages, now: NOW });
  assert.deepEqual(inbox.rows.map((row) => row.id).sort(), ['c-form', 'c-person']);
  assert.equal(inbox.total, 2);
  assert.deepEqual(inbox.notifications.rows.map((row) => row.id).sort(), ['c-ahrefs', 'c-docs', 'c-namecheap', 'c-paypal', 'c-pec']);
});
