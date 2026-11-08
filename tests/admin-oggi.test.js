import test from 'node:test';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ADVISOR_ACTION_LIMIT,
  DEMO_STRINGS,
  OGGI_NINE_CHANNELS,
  OGGI_TOTAL_CHANNELS,
  applyTriageDecision,
  advisorProgress,
  buildAdvisorActions,
  buildOggiLinks,
  buildPreCallBrief,
  buildTodayAgenda,
  buildTodayRecap,
  createOggiView,
  OGGI_LOAD_CEILING_MS,
  executeAdvisorAction,
  greetingForHour,
  isSpaceMount,
  isTodayInRome,
  loadOggiData,
  countConnectedNine,
  googleNineChannels,
  missingLeadChannels,
  nextAppointment,
  upcomingAppointment,
  oggiDateLine,
  renderOggi,
  romeDayKey,
  romeTime,
  staleFields,
  triageState,
  undoTriage,
} from '../apps/admin/public/admin-oggi.js';
import { renderDemoChrome } from '../apps/admin/public/admin-demo.js';
import {
  buildShellNav,
  createShellView,
} from '../apps/admin/public/admin-shell.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';

/**
 * Home under a space mount (backlog:7eee63a5): the Oggi frame instead of the
 * framework demo, and the demo kept for the standalone server. These tests
 * drive the real view code with the dependency-free fake DOM — no browser.
 */

test('isSpaceMount is true for any mount prefix, false at the domain root', () => {
  assert.equal(isSpaceMount(''), false);
  assert.equal(isSpaceMount('/bo'), true);
  assert.equal(isSpaceMount('/w/abc/bo'), true);
  assert.equal(isSpaceMount(undefined), false);
  assert.equal(isSpaceMount(null), false);
});

test('greeting follows the hour, in Italian', () => {
  assert.equal(greetingForHour(5), 'Buongiorno');
  assert.equal(greetingForHour(8), 'Buongiorno');
  assert.equal(greetingForHour(11), 'Buongiorno');
  assert.equal(greetingForHour(12), 'Buon pomeriggio');
  assert.equal(greetingForHour(15), 'Buon pomeriggio');
  assert.equal(greetingForHour(18), 'Buonasera');
  assert.equal(greetingForHour(23), 'Buonasera');
  assert.equal(greetingForHour(0), 'Buonasera');
  assert.equal(greetingForHour(4), 'Buonasera');
});

test('date line is the real date, in Italian', () => {
  // 2026-10-19 is a Monday: the line names the weekday and month in Italian.
  assert.equal(oggiDateLine(new Date(2026, 9, 19, 12)), 'Luned\u00EC 19 ottobre');
});

test('Oggi links are the delivered screens only, never Oggi itself', () => {
  const items = buildShellNav({
    pipelines: [{ name: 'vendite', label: 'Vendite' }],
    customModules: [{ name: 'magazzino', origin: 'bundle' }],
    customerDataAvailable: true,
  });
  const links = buildOggiLinks(items);
  const routes = links.map((link) => link.route);
  assert.ok(routes.includes('#/customer-data'), 'Clienti links the delivered screen');
  assert.ok(routes.includes('#/pipelines/vendite'), 'Pipeline links the composed board');
  assert.ok(routes.includes('#/modules/magazzino'), 'custom modules link their screen');
  assert.ok(routes.includes('#/personalizzazione'), 'Impostazioni links the Personalizzazione tab');
  assert.ok(!routes.includes('#/'), 'Oggi never links itself');
  assert.ok(links.every((link) => typeof link.label === 'string' && link.label !== ''));
  // Without composed packages Oggi links the always-available entries:
  // Calendario (BO-F3, delivered with honest empty states), Reporting,
  // Nuovo modulo (BO-F5-01) and Impostazioni.
  const bare = buildOggiLinks(buildShellNav());
  assert.deepEqual(
    bare.map((link) => link.route),
    ['#/calendario', '#/reporting', '#/nuovo-modulo', '#/personalizzazione'],
  );
  assert.deepEqual(buildOggiLinks(null), []);
  assert.deepEqual(buildOggiLinks('nope'), []);
});

test('Oggi frame greets with the space and shows no demo text', () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const seen = [];
  renderOggi({
    doc,
    mount,
    spaceName: 'Spazio di prova',
    links: [{ id: 'clienti', label: 'Clienti', route: '#/customer-data' }],
    navigate: (hash) => seen.push(hash),
    now: new Date(2026, 9, 19, 9),
  });
  const text = mount.textContent;
  assert.ok(text.includes('Luned\u00EC 19 ottobre'), 'real date line');
  assert.ok(text.includes('Buongiorno, Spazio di prova'), 'greeting with the space');
  for (const banned of DEMO_STRINGS) {
    assert.ok(!text.includes(banned), `no demo text: ${banned}`);
  }
  const anchors = mount.findAll('a');
  assert.equal(anchors.length, 1);
  assert.equal(anchors[0].getAttribute('href'), '#/customer-data');
  anchors[0].dispatch('click', { preventDefault: () => {} });
  assert.deepEqual(seen, ['#/customer-data']);
});

test('Oggi frame with no delivered screen says so honestly', () => {
  const doc = createFakeDocument();
  const mount = createMount();
  renderOggi({ doc, mount, spaceName: 'Spazio di prova', links: [], now: new Date(2026, 9, 19, 9) });
  assert.ok(mount.textContent.includes('Nessuna schermata pronta'));
  for (const banned of DEMO_STRINGS) {
    assert.ok(!mount.textContent.includes(banned), `no demo text: ${banned}`);
  }
});

test('hostile space name in the greeting is text, never markup', () => {
  const doc = createFakeDocument();
  const mount = createMount();
  renderOggi({
    doc,
    mount,
    spaceName: '<script>alert(1)</script>',
    links: [],
    now: new Date(2026, 9, 19, 9),
  });
  assert.equal(mount.findAll('script').length, 0);
  assert.ok(mount.textContent.includes('<script>alert(1)</script>'));
});

test('standalone demo chrome keeps the demo, with its controls', () => {
  const doc = createFakeDocument();
  const main = createMount();
  const moduleView = createMount();
  const dashboardView = createMount();
  main.appendChild(moduleView);
  main.appendChild(dashboardView);
  main.insertBefore = function insertBefore(node, ref) {
    const at = this.childNodes.indexOf(ref);
    if (at === -1) this.appendChild(node);
    else {
      this.childNodes.splice(at, 0, node);
      node.parentNode = this;
    }
    return node;
  };
  const refs = renderDemoChrome({ doc, main, moduleView, dashboardView });
  const text = main.textContent;
  for (const kept of DEMO_STRINGS) {
    assert.ok(text.includes(kept), `standalone keeps the demo: ${kept}`);
  }
  assert.equal(main.querySelector('button[id="demoButton"]').textContent, 'Run demo');
  assert.equal(main.querySelector('button[id="refreshButton"]').textContent, 'Refresh');
  assert.ok(main.querySelector('span[id="generatedNav"]'));
  assert.ok(refs.metrics && refs.opportunities && refs.approvals && refs.traces);
});

test('sidebar under a space mount shows the Italian voices and links the delivered screens', () => {
  const doc = createFakeDocument();
  const sidebar = createMount();
  const topbar = createMount();
  const seen = [];
  const items = buildShellNav({
    pipelines: [{ name: 'vendite', label: 'Vendite' }],
    customModules: [],
    customerDataAvailable: true,
  });
  createShellView({
    doc,
    sidebar,
    topbar,
    spaces: [{ id: 'prova', name: 'Spazio di prova', initials: 'SP' }],
    user: { name: 'Operatore', email: 'op@example.it' },
    screenId: 'oggi',
    screenLabel: 'Oggi',
    navigate: (hash) => seen.push(hash),
    win: null,
  }).update({ items, activeScreenId: 'oggi', screenLabel: 'Oggi' });
  const text = sidebar.textContent;
  // backlog:33782ba68747: Agenti took Sequenze's sidebar place.
  for (const voice of ['Spazio di prova', 'Oggi', 'Clienti', 'Pipeline', 'Calendario',
    'Agenti', 'Moduli nativi', 'Moduli personalizzati', '+ Nuovo modulo',
    'Impostazioni']) {
    assert.ok(text.includes(voice), `sidebar shows ${voice}`);
  }
  // BO-F6-01: the exit is an icon button, labelled for assistive tech.
  const logout = sidebar.findAll('button').find((node) => node.getAttribute('aria-label') === 'Esci');
  assert.ok(logout, 'sidebar shows the exit icon button');
  for (const banned of DEMO_STRINGS) {
    assert.ok(!text.includes(banned), `sidebar shows no demo text: ${banned}`);
  }
  const byHref = (href) => sidebar.findAll('a').find((node) => node.getAttribute('href') === href);
  for (const href of ['#/', '#/customer-data', '#/pipelines/vendite', '#/personalizzazione']) {
    assert.ok(byHref(href), `sidebar links ${href}`);
  }
  byHref('#/customer-data').dispatch('click', { preventDefault: () => {} });
  assert.deepEqual(seen, ['#/customer-data']);
});

/**
 * BO-F3-04 (backlog:8e07adfee555): the real Oggi screen. Fixtures are Rome
 * instants as ISO strings — what the records API returns — so the Rome-day
 * assertions hold whatever zone the machine runs in.
 */

const OGGI_NOW = new Date('2026-10-19T07:00:00.000Z'); // 09:00 in Rome, Monday
const TASK_OPEN = {
  id: 'task-1',
  status: 'open',
  title: 'Richiama per il preventivo',
  subjectResource: 'lead',
  subjectId: 'lead-1',
  subjectOwner: 'host',
  subjectLabel: 'Giulia Romano',
  dueAt: '2026-10-19T00:00:00.000Z',
  openedAt: '2026-10-18T08:00:00.000Z',
};
const TASK_DONE = { ...TASK_OPEN, id: 'task-2', status: 'completed' };
const APPT_TODAY = {
  id: 'appt-1',
  status: 'booked',
  subjectResource: 'lead',
  subjectId: 'lead-1',
  subjectOwner: 'host',
  subjectLabel: 'Giulia Romano',
  startsAt: '2026-10-19T08:00:00.000Z', // 10:00 in Rome
  notes: 'Vuole la scheda con i prezzi del pacchetto.',
};
const APPT_TOMORROW = { ...APPT_TODAY, id: 'appt-2', startsAt: '2026-10-20T08:00:00.000Z' };
const MESSAGE_IN = {
  id: 'msg-1',
  channel: 'whatsapp',
  body: 'Ciao, posso passare giovedì per una prova?',
  occurredAt: '2026-10-18T15:00:00.000Z',
  subjectResource: 'lead',
  subjectId: 'lead-1',
};
const CALL_MADE = {
  id: 'call-1',
  outcome: 'Interessata, richiama dopo il preventivo',
  occurredAt: '2026-10-17T10:00:00.000Z',
  subjectResource: 'lead',
  subjectId: 'lead-1',
};

test('rome clock renders Rome time whatever zone the machine runs in', () => {
  assert.equal(romeTime('2026-10-19T08:00:00.000Z'), '10:00');
  assert.equal(romeDayKey('2026-10-19T08:00:00.000Z'), '2026-10-19');
  assert.equal(isTodayInRome('2026-10-19T20:00:00.000Z', OGGI_NOW), true);
  assert.equal(isTodayInRome('2026-10-20T00:30:00.000Z', OGGI_NOW), false);
  assert.equal(romeTime('nope'), null);
  assert.equal(romeDayKey(null), null);
});

test('every advisor action cites the record that motivates it', () => {
  const { actions, capped } = buildAdvisorActions({
    tasks: [TASK_OPEN, TASK_DONE],
    appointments: [APPT_TODAY, APPT_TOMORROW],
    now: OGGI_NOW,
  });
  assert.equal(capped, false);
  assert.deepEqual(actions.map((action) => action.id), ['bo04:followup:task-1', 'bo04:appointment:appt-1']);
  for (const action of actions) {
    assert.ok(action.record && typeof action.record.module === 'string', 'record cited');
    assert.ok(typeof action.record.id === 'string' && action.record.id !== '', 'record id cited');
    assert.ok(typeof action.record.href === 'string' && action.record.href !== '', 'record clickable');
    assert.ok(typeof action.record.label === 'string' && action.record.label !== '', 'record labeled');
    assert.ok(action.why.includes('Giulia Romano'), 'motive names the cited subject');
  }
  const followup = actions[0];
  assert.equal(followup.record.module, 'work-task');
  assert.equal(followup.record.href, '#/work/task-1');
  assert.equal(followup.run, 'complete-task');
  assert.ok(followup.why.includes('Giulia Romano'), 'motive names the subject label');
  const prep = actions[1];
  assert.equal(prep.record.module, 'appointment');
  assert.equal(prep.record.href, '#/customer-card/lead/lead-1');
});

test('advisor list is capped and says so', () => {
  const tasks = Array.from({ length: ADVISOR_ACTION_LIMIT + 1 }, (_, index) => ({
    ...TASK_OPEN, id: `task-${index}`,
  }));
  const { actions, capped } = buildAdvisorActions({ tasks, appointments: [], now: OGGI_NOW });
  assert.equal(actions.length, ADVISOR_ACTION_LIMIT);
  assert.equal(capped, true);
});

test('advisor CTA speaks the channel verb, like the prototype', () => {
  // CONFRONTO.md sezione Oggi (29/10): the primary button carries the
  // channel verb — «Invia follow-up», «Rispondi», «Chiama», «Riscrivi»,
  // «Invia promemoria» — never the generic «Completa» when the channel
  // is known. The run behind the button is unchanged.
  const verbs = {
    email: 'Invia follow-up',
    tiktok: 'Rispondi',
    whatsapp: 'Rispondi',
    sms: 'Rispondi',
    phone: 'Chiama',
    voice: 'Chiama',
    instagram: 'Riscrivi',
    stripe: 'Invia promemoria',
  };
  for (const [channel, verb] of Object.entries(verbs)) {
    const [action] = buildAdvisorActions({
      tasks: [{ ...TASK_OPEN, channel }],
      appointments: [],
      now: OGGI_NOW,
    }).actions;
    assert.equal(action.cta, verb, `${channel} says ${verb}`);
    assert.equal(action.run, 'complete-task', 'the verb never changes the run');
  }
  const [generic] = buildAdvisorActions({ tasks: [TASK_OPEN], appointments: [], now: OGGI_NOW }).actions;
  assert.equal(generic.cta, 'Completa', 'no channel keeps the generic verb');
  assert.equal(generic.mono, 'GR', 'no channel keeps the client initials tile');
  const [mailed] = buildAdvisorActions({
    tasks: [{ ...TASK_OPEN, channel: 'email' }],
    appointments: [],
    now: OGGI_NOW,
  }).actions;
  assert.equal(mailed.mono, '@', 'a known channel paints its tile, not initials');
});

test('agenda titles paint as dark ink, never green links', () => {
  // CONFRONTO.md sezione Oggi (29/10): the prototype's agenda title is
  // dark text, not a green underlined link. The title stays clickable —
  // only the hook changes, so the paint follows the prototype.
  const doc = createFakeDocument();
  const mount = createMount();
  const seen = [];
  const agenda = buildTodayAgenda([APPT_TODAY], OGGI_NOW);
  renderOggi({
    doc,
    mount,
    spaceName: 'Spazio di prova',
    userName: 'Elena',
    links: [],
    navigate: (href) => seen.push(href),
    now: new Date(2026, 9, 19, 9),
    home: {
      recap: 'x', actions: [], triage: {}, agenda, brief: null, missing: [],
      availability: { work: true, appointments: true, channels: true },
    },
  });
  const title = mount.findAll('a').find((node) => node.textContent === 'Giulia Romano');
  assert.ok(title, 'the agenda title renders');
  assert.equal(title.getAttribute('class'), 'bo-oggi-title', 'dark ink hook, like the advisor titles');
  title.dispatch('click', { preventDefault: () => {} });
  assert.deepEqual(seen, ['#/customer-card/lead/lead-1'], 'the title still opens the scheda');
});

test('triage done and postpone are both reversible with undo', () => {
  let triage = {};
  triage = applyTriageDecision(triage, 'bo04:followup:task-1', 'done');
  assert.equal(triageState(triage, 'bo04:followup:task-1'), 'done');
  triage = undoTriage(triage, 'bo04:followup:task-1');
  assert.equal(triageState(triage, 'bo04:followup:task-1'), 'open');
  triage = applyTriageDecision(triage, 'bo04:followup:task-1', 'postpone');
  assert.equal(triageState(triage, 'bo04:followup:task-1'), 'postponed');
  triage = undoTriage(triage, 'bo04:followup:task-1');
  assert.equal(triageState(triage, 'bo04:followup:task-1'), 'open');
  assert.deepEqual(applyTriageDecision(triage, '', 'done'), {}, 'empty keys stay out');
  assert.deepEqual(applyTriageDecision(triage, null, 'done'), {}, 'missing keys stay out');
  assert.deepEqual(applyTriageDecision({}, 'bo04:x', 'snooze'), {}, 'unknown decisions ignored');
  assert.deepEqual(advisorProgress([{ id: 'a' }, { id: 'b' }], { a: 'done' }), { handled: 1, total: 2 });
});

test('execute re-reads the record and refuses a changed datum', async () => {
  const action = buildAdvisorActions({ tasks: [TASK_OPEN], appointments: [], now: OGGI_NOW }).actions[0];
  const calls = [];
  const matching = async (path, options = {}) => {
    enforceAdminWriteGate(path, options);
    assert.ok(path.endsWith('/records/task-1'), `re-reads by id: ${path}`);
    return { ...TASK_OPEN };
  };
  const fresh = await executeAdvisorAction({ request: matching }, action, async (checked, row) => {
    calls.push([checked, row]);
    return 'ran';
  });
  assert.equal(fresh, 'ran');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].status, 'open');

  const changed = async (path = '', options = {}) => {
    enforceAdminWriteGate(path, options);
    return { ...TASK_OPEN, title: 'Titolo cambiato nel frattempo' };
  };
  let ran = false;
  await assert.rejects(
    executeAdvisorAction({ request: changed }, action, async () => { ran = true; }),
    (error) => error.code === 'OGGI_STALE_RECORD' && error.details.fields.includes('title'),
  );
  assert.equal(ran, false, 'the domain action never fires on stale data');

  const closed = async (path = '', options = {}) => {
    enforceAdminWriteGate(path, options);
    return { ...TASK_OPEN, status: 'completed' };
  };
  await assert.rejects(
    executeAdvisorAction({ request: closed }, action, async () => {}),
    (error) => error.code === 'OGGI_STALE_RECORD',
  );

  let requested = false;
  await assert.rejects(
    executeAdvisorAction({ request: async (path = '', options = {}) => { enforceAdminWriteGate(path, options); requested = true; } }, { record: {} }, async () => {}),
    (error) => error.code === 'OGGI_INVALID_RECORD',
  );
  assert.equal(requested, false, 'no read without a cited record');
});

test('stale detection compares only the cited snapshot', () => {
  assert.deepEqual(staleFields({ status: 'open' }, { status: 'open', extra: 'new field' }), []);
  assert.deepEqual(staleFields({ dueAt: null }, { dueAt: undefined }), []);
});

test('recap follows the prototype sentence with real counts', () => {
  const drafted = { ...TASK_OPEN, note: '✦ Ho preparato una bozza: la vedi prima di inviarla' };
  const recap = buildTodayRecap({
    appointments: [APPT_TODAY, APPT_TOMORROW],
    openTasks: [drafted, TASK_DONE],
    now: OGGI_NOW,
  });
  assert.equal(
    recap,
    'Oggi hai 1 cosa da fare e 1 appuntamento. Ti servono circa 3 minuti: ho già preparato i messaggi.',
  );
  assert.equal(
    buildTodayRecap({ appointments: [APPT_TODAY], openTasks: [TASK_OPEN, { ...TASK_OPEN, id: 'task-9' }], now: OGGI_NOW }),
    'Oggi hai 2 cose da fare e 1 appuntamento. Ti servono circa 6 minuti.',
  );
  assert.equal(
    buildTodayRecap({ appointments: [], openTasks: [], now: OGGI_NOW }),
    'Niente in sospeso. Ti restano 0 appuntamenti.',
  );
  assert.equal(
    buildTodayRecap({ appointments: [APPT_TODAY, APPT_TOMORROW], openTasks: [], now: OGGI_NOW }),
    'Niente in sospeso. Ti restano 1 appuntamento.',
  );
  assert.ok(!recap.includes('AI') && !recap.includes('artificiale'), 'deterministic, never generated insight');
});

test('agenda rows link the scheda when it resolves, the record otherwise', () => {
  const agenda = buildTodayAgenda([APPT_TODAY, APPT_TOMORROW, { ...APPT_TODAY, id: 'appt-3', status: 'cancelled' }], OGGI_NOW);
  assert.equal(agenda.length, 1, 'only today booked/confirmed');
  assert.equal(agenda[0].time, '10:00');
  assert.equal(agenda[0].href, '#/customer-card/lead/lead-1');
  const packaged = buildTodayAgenda([{
    ...APPT_TODAY, subjectOwner: 'package', subjectOwnerPackage: 'lifecycle', subjectLabel: 'Seq-9',
  }], OGGI_NOW);
  assert.equal(packaged[0].href, '#/modules/appointment/appt-1', 'package subjects fall back to the record');
});

test('next appointment is the upcoming one, null when the day holds nothing else', () => {
  assert.equal(nextAppointment([APPT_TODAY, APPT_TOMORROW], OGGI_NOW)?.id, 'appt-1');
  assert.equal(nextAppointment([APPT_TOMORROW], OGGI_NOW), null);
  assert.equal(nextAppointment([], OGGI_NOW), null);
});

test('brief quotes records and every source opens its record', () => {
  const brief = buildPreCallBrief({ appointment: APPT_TODAY, messages: [MESSAGE_IN], calls: [CALL_MADE] });
  assert.ok(brief.bullets.some((line) => line.includes('Ciao, posso passare giovedì')), 'message quoted');
  assert.ok(brief.bullets.some((line) => line.includes('Interessata')), 'call quoted');
  const hrefs = brief.sources.map((source) => source.href);
  assert.ok(hrefs.includes('#/modules/appointment/appt-1'), 'appointment source');
  assert.ok(hrefs.includes('#/modules/interaction-message/msg-1'), 'message source');
  assert.ok(hrefs.includes('#/modules/interaction-call/call-1'), 'call source');
  assert.ok(hrefs.includes('#/customer-card/lead/lead-1'), 'card source');
  assert.ok(brief.sources.every((source) => typeof source.label === 'string' && source.label !== ''));

  const bare = buildPreCallBrief({ appointment: APPT_TODAY, messages: [], calls: [] });
  assert.ok(bare.bullets.some((line) => line.includes('Nessun messaggio o chiamata registrati')));
  assert.ok(bare.sources.some((source) => source.href === '#/modules/appointment/appt-1'));
  assert.equal(buildPreCallBrief({ appointment: null }), null);
});

test('channel invite lists only the disconnected lead channels', () => {
  const missing = missingLeadChannels([
    { channel: 'whatsapp', status: 'active' },
    { channel: 'instagram', status: 'suspended' },
  ]);
  const channels = missing.map((entry) => entry.channel);
  assert.ok(!channels.includes('whatsapp'), 'connected stays out');
  assert.ok(channels.includes('instagram'), 'suspended counts as missing');
  assert.ok(channels.includes('facebook') && channels.includes('site-form'));
  assert.ok(!channels.includes('calendar') && !channels.includes('stripe'), 'non-lead channels stay out');
  assert.ok(missing.every((entry) => typeof entry.label === 'string' && entry.label !== ''), 'Italian labels');
});

test('full home renders every section with clickable sources', () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const seen = [];
  const { actions } = buildAdvisorActions({ tasks: [TASK_OPEN], appointments: [APPT_TODAY], now: OGGI_NOW });
  let triage = {};
  const paint = () => renderOggi({
    doc,
    mount,
    spaceName: 'Spazio di prova',
    userName: 'Elena',
    links: [],
    navigate: (hash) => seen.push(hash),
    now: new Date(2026, 9, 19, 9),
    home: {
      recap: buildTodayRecap({ appointments: [APPT_TODAY], openTasks: [TASK_OPEN], now: OGGI_NOW }),
      actions,
      triage,
      capped: false,
      agenda: buildTodayAgenda([APPT_TODAY], OGGI_NOW),
      brief: buildPreCallBrief({ appointment: APPT_TODAY, messages: [MESSAGE_IN], calls: [] }),
      missing: missingLeadChannels([]),
      availability: { work: true, appointments: true, channels: true },
      events: {
        onPostpone: (id) => { triage = applyTriageDecision(triage, id, 'postpone'); paint(); },
        onUndo: (id) => { triage = undoTriage(triage, id); paint(); },
        onExecute: (action) => { seen.push(`exec:${action.id}`); triage = applyTriageDecision(triage, action.id, 'done'); paint(); },
      },
    },
  });
  paint();

  const text = mount.textContent;
  assert.ok(text.includes('Buongiorno, Elena'), 'greets the person');
  assert.ok(text.includes('Oggi hai 1 cosa da fare e 1 appuntamento. Ti servono circa 3 minuti.'), 'one-sentence recap');
  assert.ok(text.includes('✦ Il tuo advisor'), 'advisor header');
  assert.ok(text.includes('0 di 2'), 'progress starts at zero');
  assert.ok(text.includes('Agenda di oggi') && text.includes('10:00'), 'agenda with Rome time');
  assert.ok(text.includes('✦ Prima della prossima call'), 'brief header');
  assert.ok(text.includes('Fonti:'), 'brief sources labeled');
  assert.ok(text.includes('Collega WhatsApp'), 'channel invite names the missing channel');
  assert.ok(text.includes('di 9 collegati'), 'channel invite counts the connected channels');
  for (const banned of DEMO_STRINGS) {
    assert.ok(!text.includes(banned), `no demo text: ${banned}`);
  }

  const byHref = (href) => mount.findAll('a').find((node) => node.getAttribute('href') === href);
  for (const href of ['#/modules/appointment/appt-1', '#/modules/interaction-message/msg-1',
    '#/customer-card/lead/lead-1', '#/connettori']) {
    assert.ok(byHref(href), `source opens its record: ${href}`);
  }
  // The advisor title opens its record through the shell router.
  const advisorTitle = mount.findAll('a').find((node) => node.getAttribute('class') === 'bo-oggi-title');
  assert.ok(advisorTitle, 'advisor title is a link');
  const navigations = seen.length;
  advisorTitle.dispatch('click', { preventDefault: () => {} });
  assert.equal(seen[navigations], advisorTitle.getAttribute('href'), 'title click navigates to its record');
  seen.pop(); // Keep the shared log clean for the execute assertions below.

  const buttons = mount.findAll('button');
  assert.ok(buttons.some((button) => button.textContent === 'Domani'), 'postpone offered');
  assert.ok(buttons.some((button) => button.textContent === 'Completa'), 'CTA offered');
  assert.ok(!buttons.some((button) => button.textContent === 'Annulla'), 'no undo while open');

  mount.querySelector('button[data-triage="postpone"]').dispatch('click', {});
  assert.ok(mount.textContent.includes('0 di 2'), 'a postponed card is not «fatta» (prototype bar counts done only)');
  assert.ok(mount.textContent.includes('Rimandato a domani'), 'the postponed card names its state');
  // A durable deferral moved the due date for real: no session undo may
  // imply it was cancelled (Codex P2 on #380).
  const durableUndos = mount.findAll('button').filter((button) => button.getAttribute('data-triage') === 'undo');
  assert.equal(durableUndos.length, 0, 'no undo on a durable deferral');

  // The prep suggestion postpones session-only: its Annulla stays honest.
  mount.querySelector('button[data-triage="postpone"]').dispatch('click', {});
  assert.ok(mount.textContent.includes('0 di 2'), 'postponing is still not doing');
  assert.ok(mount.querySelector('button[data-triage="undo"]'), 'undo appears for the session-only postpone');
  mount.querySelector('button[data-triage="undo"]').dispatch('click', {});
  assert.ok(mount.querySelector('button[data-triage="execute"]'), 'undo restores the session suggestion');

  mount.querySelector('button[data-triage="execute"]').dispatch('click', {});
  assert.deepEqual(seen, ['exec:bo04:appointment:appt-1'], 'the prep run navigates');
  assert.ok(mount.textContent.includes('Fatto'), 'executed action reads done');
});

test('hostile record strings stay text in every Oggi section', () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const evil = { ...TASK_OPEN, title: '<script>alert(1)</script>', subjectLabel: '<img src=x onerror=1>' };
  const { actions } = buildAdvisorActions({ tasks: [evil], appointments: [], now: OGGI_NOW });
  renderOggi({
    doc,
    mount,
    spaceName: '<script>alert(2)</script>',
    links: [],
    now: new Date(2026, 9, 19, 9),
    home: {
      recap: 'x', actions, triage: {}, agenda: [], brief: null, missing: [],
      availability: { work: true, appointments: true, channels: true },
    },
  });
  assert.equal(mount.findAll('script').length, 0);
  assert.equal(mount.findAll('img').length, 0);
  assert.ok(mount.textContent.includes('<script>alert(1)</script>'));
});

test('home with nothing open says the day is done', () => {
  const doc = createFakeDocument();
  const mount = createMount();
  renderOggi({
    doc,
    mount,
    links: [{ id: 'clienti', label: 'Clienti', route: '#/customer-data' }],
    now: new Date(2026, 9, 19, 9),
    home: {
      recap: buildTodayRecap({ appointments: [], openTasks: [], now: OGGI_NOW }),
      actions: [], triage: {}, agenda: [],
      brief: null, missing: [],
      availability: { work: true, appointments: true, channels: true },
    },
  });
  assert.ok(mount.textContent.includes('✓ Hai finito per oggi. Ti scrivo io se arriva qualcosa di urgente.'));
  // The prototype's home ends with the channel invite: no module shortcut
  // list below (the sidebar already links every screen).
  assert.ok(!mount.textContent.includes('Clienti'), 'no module shortcut list under the home');
});

test('advisor note renders verbatim, never with a doubled AI mark', () => {
  const aiNote = { ...TASK_OPEN, id: 'task-ai', channel: 'email', note: '✦ Ho preparato una bozza: la vedi prima di inviarla' };
  const plainNote = { ...TASK_OPEN, id: 'task-plain', note: 'Ti avviso io alle 18:00' };
  const { actions } = buildAdvisorActions({ tasks: [aiNote, plainNote], appointments: [], now: OGGI_NOW });
  const doc = createFakeDocument();
  const mount = createMount();
  renderOggi({
    doc,
    mount,
    spaceName: 'Spazio di prova',
    links: [],
    now: new Date(2026, 9, 19, 9),
    home: {
      recap: 'x', actions, triage: {}, agenda: [], brief: null, missing: [],
      availability: { work: true, appointments: true, channels: true },
    },
  });
  const notes = mount.findAll('p').filter((node) => node.getAttribute('class') === 'bo-oggi-note');
  assert.equal(notes.length, 2, 'one violet line per action carrying a note');
  assert.equal(notes[0].textContent, '✦ Ho preparato una bozza: la vedi prima di inviarla');
  assert.ok(!notes[0].textContent.startsWith('✦ ✦'), 'no doubled AI mark');
  assert.equal(notes[1].textContent, 'Ti avviso io alle 18:00');
  assert.ok(!notes[1].textContent.includes('✦'), 'a plain note gains no AI mark');
});

test('agenda rows carry the chi line from the team member or the notes', () => {
  const withTeam = { ...APPT_TODAY, id: 'appt-team', teamMemberId: 'Marco' };
  const withNotesOnly = { ...APPT_TODAY, id: 'appt-notes' };
  const agenda = buildTodayAgenda([withTeam, withNotesOnly], OGGI_NOW);
  assert.equal(agenda[0].who, 'Marco', 'team member first');
  assert.ok(
    agenda[1].who.includes('Vuole la scheda'),
    'notes cue when no team member is stored',
  );
  const doc = createFakeDocument();
  const mount = createMount();
  renderOggi({
    doc,
    mount,
    spaceName: 'Spazio di prova',
    userName: 'Elena',
    links: [],
    navigate: () => {},
    now: new Date(2026, 9, 19, 9),
    home: {
      recap: 'x', actions: [], triage: {}, agenda, brief: null, missing: [],
      availability: { work: true, appointments: true, channels: true },
    },
  });
  const text = mount.textContent;
  assert.ok(text.includes('Marco'), 'chi line paints under the appointment');
  assert.ok(text.includes('Vuole la scheda'), 'notes cue paints under the appointment');
});

test('brief CTA is a button opening the customer scheda', () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const seen = [];
  const brief = buildPreCallBrief({ appointment: APPT_TODAY, messages: [MESSAGE_IN], calls: [] });
  renderOggi({
    doc,
    mount,
    spaceName: 'Spazio di prova',
    userName: 'Elena',
    links: [],
    navigate: (hash) => seen.push(hash),
    now: new Date(2026, 9, 19, 9),
    home: {
      recap: 'x', actions: [], triage: {}, agenda: [], brief, missing: [],
      availability: { work: true, appointments: true, channels: true },
    },
  });
  const cta = mount.findAll('button').find((node) => node.textContent === 'Apri la scheda');
  assert.ok(cta, 'the brief ends with a real button, like the prototype');
  assert.equal(mount.findAll('a').filter((node) => node.textContent === 'Apri la scheda').length, 0, 'no link CTA left');
  const ctaClasses = String(cta.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
  assert.ok(ctaClasses.includes('bo-oggi-cta'), 'the CTA keeps the violet prototype hook');
  assert.ok(ctaClasses.some((cls) => cls === 'ui-btn' || cls.startsWith('ui-')), 'the CTA stays on the ui-* system');
  assert.ok(!ctaClasses.includes('ui-btn-secondary'), 'no white secondary override on the violet CTA');
  cta.dispatch('click', {});
  assert.deepEqual(seen, ['#/customer-card/lead/lead-1'], 'the button navigates to the scheda');
});

test('the nine counted channels are the Stato sync nine', async () => {
  const { SYNC_CHANNELS } = await import('../apps/admin/public/admin-sync.js');
  assert.deepEqual(
    [...OGGI_NINE_CHANNELS],
    SYNC_CHANNELS.map((row) => row.id),
    'oggi counts the same nine channels as the sync table',
  );
});

test('connected count reads actual connections against the nine', () => {
  assert.equal(countConnectedNine([]), 0, 'no connections, zero connected');
  assert.equal(
    countConnectedNine([
      { channel: 'whatsapp', status: 'active' },
      { channel: 'whatsapp', status: 'active' },
      { channel: 'calendar', status: 'active' },
      { channel: 'stripe', status: 'active' },
      { channel: 'sms', status: 'active' },
      { channel: 'facebook', status: 'suspended' },
      { channel: '', status: 'active' },
    ]),
    3,
    'distinct active nine-channels only: sms is not one of the nine, suspended and blank stay out',
  );
});

test('Google connections from GET /api/profile vote Email and Calendar', () => {
  const both = {
    connections: {
      available: true,
      items: [
        { connector: 'gmail', status: 'connected', account: 'op@palestra.it' },
        { connector: 'calendar', status: 'connected', account: 'op@palestra.it' },
      ],
    },
  };
  assert.deepEqual(googleNineChannels(both), ['email', 'calendar']);
  assert.equal(countConnectedNine([], both), 2, 'Gmail and Calendar alone read «2 di 9»');
  // A Gmail vote never doubles an Email row: one vote per channel.
  assert.equal(
    countConnectedNine([{ channel: 'email', status: 'active' }], both),
    2,
    'email row plus gmail still counts Email once',
  );
  // Only `connected` counts: revoked, error and missing stay out.
  assert.equal(countConnectedNine([], {
    connections: {
      available: true,
      items: [
        { connector: 'gmail', status: 'revoked' },
        { connector: 'calendar', status: 'error' },
      ],
    },
  }), 0);
  // Unreadable or unavailable profiles contribute nothing, never a guess.
  assert.equal(countConnectedNine([], null), 0);
  assert.equal(countConnectedNine([], undefined), 0);
  assert.equal(countConnectedNine([], { connections: { available: false, items: [] } }), 0);
  assert.equal(countConnectedNine([], { connections: { available: true, items: 'nope' } }), 0);
  assert.deepEqual(googleNineChannels({ connections: { available: true, items: [{ connector: 'toString', status: 'connected' }] } }), []);
  // A connected Gmail removes Email from the lead invite, like an Email row.
  const missing = missingLeadChannels([], both);
  assert.ok(!missing.some((entry) => entry.channel === 'email'), 'Gmail-connected Email stays out of the invite');
  assert.ok(missing.some((entry) => entry.channel === 'whatsapp'), 'other lead channels stay in');
});

test('Oggi strip with Gmail and Calendar connected counts them and links Connettori', () => {
  const profile = {
    connections: {
      available: true,
      items: [
        { connector: 'gmail', status: 'connected', account: 'op@palestra.it' },
        { connector: 'calendar', status: 'connected', account: 'op@palestra.it' },
      ],
    },
  };
  const doc = createFakeDocument();
  const mount = createMount();
  renderOggi({
    doc,
    mount,
    spaceName: 'Spazio di prova',
    links: [],
    now: new Date(2026, 9, 19, 9),
    home: {
      recap: 'x', actions: [], triage: {}, agenda: [], brief: null,
      missing: missingLeadChannels([], profile),
      connections: [],
      profile,
      availability: { work: true, appointments: true, channels: true },
    },
  });
  assert.ok(mount.textContent.includes('2 di 9 collegati'), 'Gmail plus Calendar read as two connected');
  assert.ok(!mount.textContent.includes('Collega Email'), 'Email is not invited once Gmail is connected');
  const strip = mount.findAll('a').find((node) => node.getAttribute('class') === 'bo-oggi-invite');
  assert.ok(strip, 'the strip renders');
  assert.equal(strip.getAttribute('href'), '#/connettori', 'the strip lands on Connettori');
  // Connettori heads with the Collegamenti Google card, so the Collega
  // links are one click from the strip (covered by admin-connectors.test.js
  // 'Google Calendar and Gmail offer Collega even without composed channels').
});

test('loadOggiData reads the Google links from GET /api/profile, fail-soft', async () => {
  const profile = {
    connections: {
      available: true,
      items: [{ connector: 'gmail', status: 'connected', account: 'op@palestra.it' }],
    },
  };
  const seen = [];
  const data = await loadOggiData({
    request: async (path, options = {}) => {
      enforceAdminWriteGate(path, options);
      seen.push(path);
      if (path === '/api/schema') return { domains: {} };
      if (path === '/api/profile') return profile;
      throw new Error(`unexpected read: ${path}`);
    },
  }, OGGI_NOW);
  assert.equal(data.profile, profile, 'the profile travels with the load');
  assert.ok(seen.includes('/api/profile'), 'the load reads the Google links');
  assert.equal(countConnectedNine(data.connections, data.profile), 1, 'Gmail counts Email as connected');

  const refused = await loadOggiData({
    request: async (path, options = {}) => {
      enforceAdminWriteGate(path, options);
      if (path === '/api/schema') return { domains: {} };
      throw new Error('no profile here');
    },
  }, OGGI_NOW);
  assert.equal(refused.profile, null, 'an unreadable profile stays null, never a guess');
  assert.equal(countConnectedNine(refused.connections, refused.profile), 0);
});

test('channel invite counts connected of nine, names exactly the missing ones, and hides when all nine connect', () => {
  assert.equal(OGGI_TOTAL_CHANNELS, 9, 'the prototype counts nine backoffice channels');
  const connections = [
    { channel: 'whatsapp', status: 'active' },
    { channel: 'instagram', status: 'active' },
    { channel: 'email', status: 'active' },
    { channel: 'voice', status: 'active' },
    { channel: 'site-form', status: 'active' },
    { channel: 'calendar', status: 'active' },
    { channel: 'stripe', status: 'active' },
  ];
  const doc = createFakeDocument();
  const mount = createMount();
  renderOggi({
    doc,
    mount,
    spaceName: 'Spazio di prova',
    links: [],
    now: new Date(2026, 9, 19, 9),
    home: {
      recap: 'x', actions: [], triage: {}, agenda: [], brief: null,
      missing: missingLeadChannels(connections),
      connections,
      availability: { work: true, appointments: true, channels: true },
    },
  });
  assert.ok(mount.textContent.includes('7 di 9 collegati'), 'seven nine-channels active, whatever the lead list says');
  // backlog:5083e7a77c26: the names are the two channels missing from the
  // same nine the number counts — never Telegram or SMS beside «di 9».
  assert.ok(mount.textContent.includes('Collega Facebook, TikTok per non perdere nessun lead'), 'invite names exactly the missing nine-channels');

  const full = createMount();
  const fullConnections = OGGI_NINE_CHANNELS.map((channel) => ({ channel, status: 'active' }));
  renderOggi({
    doc,
    mount: full,
    spaceName: 'Spazio di prova',
    links: [],
    now: new Date(2026, 9, 19, 9),
    home: {
      recap: 'x', actions: [], triage: {}, agenda: [], brief: null,
      missing: missingLeadChannels(fullConnections),
      connections: fullConnections,
      availability: { work: true, appointments: true, channels: true },
    },
  });
  assert.ok(!full.textContent.includes('collegati'), 'no invite once every counted channel connects');
});

test('no technical resource-id label reaches the Oggi screen', () => {
  const unlabeledTask = {
    id: 'task-nolabel', status: 'open', title: 'Richiama per il preventivo',
    subjectResource: 'lead', subjectId: 'lead-1',
    dueAt: '2026-10-19T00:00:00.000Z', openedAt: '2026-10-18T08:00:00.000Z',
  };
  const unlabeledAppt = {
    id: 'appt-nolabel', status: 'booked', startsAt: '2026-10-19T08:00:00.000Z',
    subjectResource: 'lead', subjectId: 'lead-1', subjectOwner: 'host',
  };
  const { actions } = buildAdvisorActions({ tasks: [unlabeledTask], appointments: [], now: OGGI_NOW });
  const agenda = buildTodayAgenda([unlabeledAppt], OGGI_NOW);
  const doc = createFakeDocument();
  const mount = createMount();
  renderOggi({
    doc,
    mount,
    spaceName: 'Spazio di prova',
    links: [],
    now: new Date(2026, 9, 19, 9),
    home: {
      recap: buildTodayRecap({ appointments: [unlabeledAppt], openTasks: [unlabeledTask], now: OGGI_NOW }),
      actions, triage: {}, agenda, brief: null, missing: [],
      availability: { work: true, appointments: true, channels: true },
    },
  });
  const text = mount.textContent;
  assert.ok(!text.includes('lead · lead-1'), 'no technical label on screen');
  assert.ok(text.includes('il cliente'), 'an Italian fallback names the customer');
});

test('the greeting is the only h1 of the Oggi screen', () => {
  const doc = createFakeDocument();
  const mount = createMount();
  renderOggi({
    doc,
    mount,
    spaceName: 'Spazio di prova',
    userName: 'Elena',
    links: [],
    now: new Date(2026, 9, 19, 9),
    home: {
      recap: 'x', actions: [], triage: {}, agenda: [], brief: null, missing: [],
      availability: { work: true, appointments: true, channels: true },
    },
  });
  const titles = mount.findAll('h1');
  assert.equal(titles.length, 1, 'a single h1, like the prototype');
  assert.ok(titles[0].textContent.includes('Buongiorno, Elena'), 'the h1 is the greeting');
});

test('the oggi screen renders no raw control', () => {
  // Acceptance: a button without a ui-* system class fails this screen.
  // Every control reaches the DOM through the shared `el` helper, which
  // normalizes legacy classes onto `ui-*`.
  const rawControls = (root) => {
    const out = [];
    const walk = (node) => {
      const tag = String(node.tagName ?? '').toLowerCase();
      if (['button', 'select', 'input', 'textarea'].includes(tag)) {
        const classes = String(node.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
        if (!classes.some((cls) => cls === 'ui' || cls.startsWith('ui-'))) out.push(`${tag}[${classes.join('.')}]`);
      }
      for (const child of node.childNodes ?? []) walk(child);
    };
    walk(root);
    return out;
  };
  const doc = createFakeDocument();
  const mount = createMount();
  const { actions } = buildAdvisorActions({ tasks: [TASK_OPEN], appointments: [APPT_TODAY], now: OGGI_NOW });
  const brief = buildPreCallBrief({ appointment: APPT_TODAY, messages: [MESSAGE_IN], calls: [] });
  const agenda = buildTodayAgenda([APPT_TODAY], OGGI_NOW);
  const paint = (triage) => renderOggi({
    doc,
    mount,
    spaceName: 'Spazio di prova',
    userName: 'Elena',
    links: [],
    navigate: () => {},
    now: new Date(2026, 9, 19, 9),
    home: {
      recap: 'x', actions, triage, agenda, brief,
      missing: missingLeadChannels([]),
      availability: { work: true, appointments: true, channels: true },
      events: { onPostpone: () => {}, onUndo: () => {}, onExecute: () => {} },
    },
  });
  paint({});
  assert.deepEqual(rawControls(mount), [], 'open rows carry no raw control');
  paint({ 'bo04:followup:task-1': 'postpone', 'bo04:appointment:appt-1': 'done' });
  assert.deepEqual(rawControls(mount), [], 'decided rows carry no raw control');
});

test('loadOggiData degrades honestly without packages', async () => {
  const data = await loadOggiData({ request: async () => ({}) }, OGGI_NOW);
  assert.deepEqual(
    [data.workAvailable, data.appointmentsAvailable, data.channelsAvailable],
    [false, false, false],
  );
  assert.deepEqual(data.tasks, []);
  assert.equal(data.next, null);
});

/** Flush the view's async work: clicks resolve promises across ticks. */
async function settle(predicate, tries = 100) {
  for (let i = 0; i < tries; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => { setImmediate(resolve); });
  }
  assert.ok(predicate(), 'view settled');
}

function oggiFakeClient(state) {
  return {
    posts: [],
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      const method = String(options.method ?? 'GET').toUpperCase();
      if (method !== 'GET') {
        this.posts.push({ path, body: options.body });
        return { task: { ...TASK_OPEN, status: 'completed' } };
      }
      if (path === '/api/schema') return { domains: { work: {}, appointments: {}, channels: {}, interactions: {} } };
      if (path.startsWith('/api/modules/work-task/records/')) {
        return state.task ?? { ...TASK_OPEN };
      }
      // Like the server: a completed task leaves the open list, so the row
      // is gone on the next load instead of lingering as done.
      if (path.startsWith('/api/modules/work-task/records')) {
        return { items: this.posts.length > 0 ? [] : state.tasks };
      }
      if (path.startsWith('/api/modules/appointment/records')) return { items: state.appointments };
      if (path.startsWith('/api/modules/channel-connection/records')) return { items: [] };
      if (path.startsWith('/api/modules/interaction-message/records')) return { items: [MESSAGE_IN] };
      if (path.startsWith('/api/modules/interaction-call/records')) return { items: [] };
      throw new Error(`unexpected read: ${path}`);
    },
  };
}

test('Oggi view completes a task with a fresh read, then keeps its row as done (C12)', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = oggiFakeClient({ tasks: [TASK_OPEN], appointments: [APPT_TODAY] });
  const view = createOggiView({ doc, mount, client, navigate: () => {} });
  await view.render({ spaceName: 'Spazio', links: [], now: OGGI_NOW });
  assert.ok(mount.textContent.includes('Richiama per il preventivo'));

  mount.querySelector('button[data-triage="execute"]').dispatch('click', {});
  await settle(() => client.posts.length > 0);
  assert.ok(client.posts[0].path.endsWith('/records/task-1/actions/complete'), 'same server action as Work');
  // backlog:9c7d1477a8d4: like the prototype the completed card stays,
  // struck through with its confirmation, and the bar counts it — but with
  // no Annulla: the work package has no reopen, so an undo would lie.
  await settle(() => mount.textContent.includes('1 di 2 fatte'));
  const row = mount.findAll('div').find((node) => node.getAttribute('data-action') === 'bo04:followup:task-1');
  assert.ok(row, 'the completed row stays on screen');
  assert.equal(row.getAttribute('data-state'), 'done');
  assert.ok(row.textContent.includes('Richiama per il preventivo') && row.textContent.includes('✓ Fatto'));
  assert.equal(row.findAll('button').length, 0, 'no undo on a durable completion');
  assert.ok(mount.textContent.includes('Prepara la call'), 'the prep row survives on its own record');
  const rows = mount.findAll('div').filter((node) => node.getAttribute('data-action'));
  assert.equal(rows[0], row, 'the completed card keeps its place');
});

test('Oggi view drops a completed card once the Rome day changes (review #642 P2)', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = oggiFakeClient({ tasks: [TASK_OPEN], appointments: [] });
  const view = createOggiView({ doc, mount, client, navigate: () => {} });
  await view.render({ spaceName: 'Spazio', links: [], now: OGGI_NOW });
  mount.querySelector('button[data-triage="execute"]').dispatch('click', {});
  await settle(() => mount.textContent.includes('✓ Fatto'));
  const doneRow = () => mount.findAll('div').find((node) => node.getAttribute('data-action') === 'bo04:followup:task-1');
  assert.ok(doneRow(), 'the completed card stays for the rest of the day');

  // Same day, later: the completion is still today's.
  await view.render({ spaceName: 'Spazio', links: [], now: new Date('2026-10-19T21:30:00.000Z') });
  assert.ok(doneRow(), 'still listed before Rome midnight');
  // 23:30Z on the 19th is already the 20th in Rome: yesterday's card is gone.
  await view.render({ spaceName: 'Spazio', links: [], now: new Date('2026-10-19T23:30:00.000Z') });
  assert.equal(doneRow(), undefined, 'a completion from another Rome day is not re-injected');
  assert.ok(!mount.textContent.includes('Richiama per il preventivo'));
});

test('Oggi view caps the merged list, completed cards included, and discloses it (review #642 P3)', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const tasks = Array.from({ length: ADVISOR_ACTION_LIMIT + 1 }, (_, index) => ({
    ...TASK_OPEN, id: `task-${index}`, title: `Compito ${index}`,
  }));
  let completedId = null;
  const client = {
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      const method = String(options.method ?? 'GET').toUpperCase();
      if (method !== 'GET') {
        completedId = 'task-0';
        return { task: { ...tasks[0], status: 'completed' } };
      }
      if (path === '/api/schema') return { domains: { work: {}, appointments: {}, channels: {}, interactions: {} } };
      if (path.startsWith('/api/modules/work-task/records/')) return { ...tasks[0] };
      // Before: exactly the cap is open. After: task-0 left the open list and
      // the cap's worth is still open, so open + completed exceeds the cap.
      if (path.startsWith('/api/modules/work-task/records')) {
        return { items: completedId === null ? tasks.slice(0, ADVISOR_ACTION_LIMIT) : tasks.slice(1) };
      }
      if (path.startsWith('/api/modules/appointment/records')) return { items: [] };
      if (path.startsWith('/api/modules/channel-connection/records')) return { items: [] };
      if (path.startsWith('/api/modules/interaction-message/records')) return { items: [] };
      if (path.startsWith('/api/modules/interaction-call/records')) return { items: [] };
      throw new Error(`unexpected read: ${path}`);
    },
  };
  const view = createOggiView({ doc, mount, client, navigate: () => {} });
  await view.render({ spaceName: 'Spazio', links: [], now: OGGI_NOW });
  const rows = () => mount.findAll('div').filter((node) => node.getAttribute('data-action'));
  assert.equal(rows().length, ADVISOR_ACTION_LIMIT);
  assert.ok(!mount.textContent.includes('Mostro le prime'), 'exactly the cap: no disclosure');

  mount.querySelector('button[data-triage="execute"]').dispatch('click', {});
  await settle(() => completedId !== null && mount.textContent.includes('✓ Fatto'));
  assert.equal(rows().length, ADVISOR_ACTION_LIMIT, 'never more cards than the cap');
  assert.equal(rows()[0].getAttribute('data-action'), 'bo04:followup:task-0', 'the completed card keeps its place');
  assert.ok(mount.textContent.includes(`Mostro le prime ${ADVISOR_ACTION_LIMIT} azioni.`), 'the cap is disclosed');
});

test('Oggi view postpones through the work-task action, then keeps the open row', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  let postponedAt = null;
  const client = {
    posts: [],
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      const method = String(options.method ?? 'GET').toUpperCase();
      if (method !== 'GET') {
        this.posts.push({ path, body: options.body });
        postponedAt = '2026-10-20T07:00:00.000Z';
        return { task: { ...TASK_OPEN, dueAt: postponedAt }, activity: { kind: 'note' }, replayed: false };
      }
      if (path === '/api/schema') return { domains: { work: {}, appointments: {}, channels: {}, interactions: {} } };
      if (path.startsWith('/api/modules/work-task/records/')) {
        return postponedAt === null ? { ...TASK_OPEN } : { ...TASK_OPEN, dueAt: postponedAt };
      }
      if (path.startsWith('/api/modules/work-task/records')) {
        return { items: [{ ...TASK_OPEN, ...(postponedAt === null ? {} : { dueAt: postponedAt }) }] };
      }
      if (path.startsWith('/api/modules/appointment/records')) return { items: [APPT_TODAY] };
      if (path.startsWith('/api/modules/channel-connection/records')) return { items: [] };
      if (path.startsWith('/api/modules/interaction-message/records')) return { items: [] };
      if (path.startsWith('/api/modules/interaction-call/records')) return { items: [] };
      throw new Error(`unexpected read: ${path}`);
    },
  };
  const view = createOggiView({ doc, mount, client, navigate: () => {} });
  await view.render({ spaceName: 'Spazio', links: [], now: OGGI_NOW });
  assert.ok(mount.textContent.includes('Richiama per il preventivo'));

  mount.querySelector('button[data-triage="postpone"]').dispatch('click', {});
  await settle(() => client.posts.length > 0);
  assert.ok(client.posts[0].path.endsWith('/records/task-1/actions/postpone'), 'Domani runs the durable action');
  await settle(() => mount.textContent.includes('Rimandato a domani'));
  // The task stays open with its new due date: the row attenuates, it does
  // not disappear, and no session undo is offered — clearing triage would
  // display the suggestion as undecided while tomorrow's date stays stored
  // (Codex P2 on #380).
  assert.ok(mount.textContent.includes('Richiama per il preventivo'), 'the postponed row stays');
  const undos = mount.findAll('button').filter((button) => button.getAttribute('data-triage') === 'undo');
  assert.equal(undos.length, 0, 'no undo after a durable postpone');
  const postpones = mount.findAll('button').filter((button) => button.getAttribute('data-triage') === 'postpone');
  assert.equal(postpones.length, 1, 'only the session-only prep keeps Domani');
});

test('Oggi view keeps the row open and shows the refusal on stale data', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = oggiFakeClient({
    tasks: [TASK_OPEN],
    appointments: [APPT_TODAY],
    task: { ...TASK_OPEN, status: 'completed' },
  });
  const view = createOggiView({ doc, mount, client, navigate: () => {} });
  await view.render({ spaceName: 'Spazio', links: [], now: OGGI_NOW });

  mount.querySelector('button[data-triage="execute"]').dispatch('click', {});
  await settle(() => mount.textContent.includes('Il dato è cambiato'));
  assert.equal(client.posts.length, 0, 'no mutation on stale data');
  assert.ok(mount.querySelector('button[data-triage="postpone"]'), 'the row stays open');
});

test('Da rispondere: one row per conversation waiting on the team, newest first (MVP Presti, Dan 04/11)', async () => {
  const { buildInbox, waitedFor } = await import('../apps/admin/public/admin-oggi.js');
  const now = new Date('2026-11-04T15:00:00Z');
  const host = { subjectOwner: 'host', subjectResource: 'contact' };
  const conversations = [
    { id: 'c1', subjectLabel: 'Fio Neri', channel: 'whatsapp', status: 'open' },
    { id: 'c2', subjectLabel: 'Lia Marroni', channel: 'instagram', status: 'open' },
    { id: 'c3', subjectLabel: 'Ada Rossi', channel: 'email', status: 'open' },
    { id: 'c4', subjectLabel: 'Chiusa', channel: 'whatsapp', status: 'closed' },
  ];
  const messages = [
    { conversationId: 'c1', direction: 'inbound', channel: 'whatsapp', body: 'Quanto costa il pacchetto?', occurredAt: '2026-11-04T12:00:00Z', ...host, subjectId: 'p1' },
    { conversationId: 'c2', direction: 'inbound', channel: 'instagram', body: 'Fate anche Milano?', occurredAt: '2026-11-04T14:30:00Z', ...host, subjectId: 'p2' },
    { conversationId: 'c3', direction: 'inbound', channel: 'email', body: 'Ciao', occurredAt: '2026-11-04T10:00:00Z', ...host, subjectId: 'p3' },
    { conversationId: 'c3', direction: 'outbound', channel: 'email', body: 'Risposto', occurredAt: '2026-11-04T11:00:00Z', ...host, subjectId: 'p3' },
    { conversationId: 'c4', direction: 'inbound', channel: 'whatsapp', body: 'vecchia', occurredAt: '2026-11-04T14:50:00Z', ...host, subjectId: 'p4' },
  ];
  const inbox = buildInbox({ messages, conversations, now });
  assert.equal(inbox.total, 2, 'the answered and the closed conversations are not waiting');
  assert.deepEqual(inbox.rows.map((row) => row.name), ['Lia Marroni', 'Fio Neri'], 'newest first');
  assert.equal(inbox.rows[0].mono, 'IG');
  assert.equal(inbox.rows[0].when, 'da 30 min · Instagram');
  assert.equal(inbox.rows[1].href, '#/customer-card/contact/p1', 'Rispondi opens the scheda');
  assert.equal(waitedFor('2026-11-03T15:00:00Z', now), 'da ieri');
});

test('Da rispondere renders its rows, the empty line and the unreadable line', async () => {
  const { renderOggi } = await import('../apps/admin/public/admin-oggi.js');
  const draw = (inbox) => {
    const doc = createFakeDocument();
    const mount = createMount();
    const navigated = [];
    renderOggi({ doc, mount, userName: 'Dan', navigate: (h) => navigated.push(h), home: { actions: [], agenda: [], inbox } });
    return { mount, navigated };
  };
  const full = draw({ available: true, total: 1, rows: [{ id: 'c1', channel: 'whatsapp', mono: 'WA', name: 'Fio Neri', preview: 'Quanto costa?', when: 'da 3 ore · WhatsApp', href: '#/customer-card/contact/p1' }] });
  assert.ok(full.mount.textContent.includes('Da rispondere'));
  assert.ok(full.mount.textContent.includes('1 in attesa'));
  assert.ok(full.mount.textContent.includes('Fio Neri') && full.mount.textContent.includes('Quanto costa?'));
  full.mount.findAll('button').find((b) => b.getAttribute('data-action') === 'inbox-reply').dispatch('click');
  assert.deepEqual(full.navigated, ['#/customer-card/contact/p1']);
  assert.ok(draw({ available: true, total: 0, rows: [] }).mount.textContent.includes('Nessun messaggio aspetta una risposta'));
  assert.ok(draw({ available: false, total: 0, rows: [] }).mount.textContent.includes('non si sono potuti leggere'));
  assert.ok(!draw(null).mount.textContent.includes('Da rispondere'), 'without interactions composed the section is absent');
});

/**
 * Oggi come il prototipo (backlog:9c7d1477a8d4): the checklist items the
 * earlier slices left open — C12 (done row struck through with its
 * confirmation), C14 («Hai finito» once nothing is open), C23 (no technical
 * wording) and the prototype's attenuated past agenda row.
 */

const homeFor = (triage, extra = {}) => {
  const { actions } = buildAdvisorActions({ tasks: [TASK_OPEN], appointments: [APPT_TODAY], now: OGGI_NOW });
  return {
    recap: 'x', actions, triage, agenda: [], brief: null, missing: [],
    availability: { work: true, appointments: true, channels: true },
    events: { onPostpone: () => {}, onUndo: () => {}, onExecute: () => {} },
    ...extra,
  };
};
const drawHome = (home) => {
  const doc = createFakeDocument();
  const mount = createMount();
  renderOggi({ doc, mount, userName: 'Elena', now: new Date(2026, 9, 19, 9), home });
  return mount;
};
const rowFor = (mount, id) => mount.findAll('div').find((node) => node.getAttribute('data-action') === id);

test('C12: a done card is struck through, confirms in green and offers Annulla', () => {
  const mount = drawHome(homeFor({ 'bo04:appointment:appt-1': 'done' }));
  const row = rowFor(mount, 'bo04:appointment:appt-1');
  assert.equal(row.getAttribute('data-state'), 'done');
  assert.ok(row.textContent.includes('✓ Fatto'), 'the confirmation reads like the prototype');
  assert.ok(row.findAll('button').some((button) => button.textContent === 'Annulla'), 'the session decision can be undone');
  const css = readFileSync(new URL('../apps/admin/public/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.bo-oggi-row\[data-state="done"\] \.bo-oggi-title \{[^}]*line-through/, 'the done title is struck through');
});

test('C8: «fatte» counts done cards only, like the prototype bar', () => {
  assert.deepEqual(advisorProgress([{ id: 'a' }, { id: 'b' }], { a: 'postpone' }), { handled: 0, total: 2 });
  assert.deepEqual(advisorProgress([{ id: 'a' }, { id: 'b' }], { a: 'postpone', b: 'done' }), { handled: 1, total: 2 });
  assert.ok(drawHome(homeFor({ 'bo04:followup:task-1': 'postpone' })).textContent.includes('0 di 2 fatte'));
});

test('C14: «Hai finito» appears once no card is open, the decided cards stay listed', () => {
  const open = drawHome(homeFor({ 'bo04:followup:task-1': 'postpone' }));
  assert.ok(!open.textContent.includes('Hai finito per oggi'), 'one card still open');
  const mount = drawHome(homeFor({ 'bo04:followup:task-1': 'postpone', 'bo04:appointment:appt-1': 'done' }));
  assert.ok(mount.textContent.includes('✓ Hai finito per oggi. Ti scrivo io se arriva qualcosa di urgente.'));
  assert.ok(mount.textContent.includes('Richiama per il preventivo'), 'the postponed card stays, attenuated');
  assert.ok(mount.textContent.includes('Rimandato a domani'));
});

test('C23: missing packages and stale data read in plain Italian, never technical', async () => {
  const mount = drawHome(homeFor({}, { actions: [], availability: { work: false, appointments: false, channels: false } }));
  assert.doesNotMatch(mount.textContent, /compost|NOT_FOUND|undefined/i);
  await assert.rejects(
    executeAdvisorAction(
      { request: async () => ({ ...TASK_OPEN, status: 'completed' }) },
      { record: { module: 'work-task', id: 'task-1' }, snapshot: { status: 'open', dueAt: TASK_OPEN.dueAt } },
      async () => ({}),
    ),
    (error) => {
      assert.equal(error.code, 'OGGI_STALE_RECORD');
      assert.deepEqual(error.details.fields, ['status'], 'the drifted fields stay in the details');
      assert.doesNotMatch(error.message, /status|dueAt|\(/, 'no field name reaches the screen');
      return true;
    },
  );
});

test('agenda: a past appointment of today renders attenuated, like the prototype', () => {
  const early = { ...APPT_TODAY, id: 'appt-0', startsAt: '2026-10-19T06:30:00.000Z' }; // 08:30 in Rome
  const agenda = buildTodayAgenda([early, APPT_TODAY], OGGI_NOW);
  assert.deepEqual(agenda.map((row) => row.past), [true, false]);
  const mount = drawHome(homeFor({}, { agenda }));
  const rows = mount.findAll('div').filter((node) => String(node.getAttribute('class') ?? '').includes('bo-oggi-agenda-row'));
  assert.deepEqual(rows.map((row) => row.getAttribute('data-state') ?? null), ['past', null]);
});

test('C2: on Oggi the Oggi voice is the only active one', () => {
  const doc = createFakeDocument();
  const sidebar = createMount();
  createShellView({
    doc, sidebar, topbar: createMount(),
    spaces: [{ id: 'prova', name: 'Spazio di prova', initials: 'SP' }],
    user: { name: 'Operatore', email: 'op@example.it' },
    screenId: 'oggi', screenLabel: 'Oggi', navigate: () => {}, win: null,
  }).update({ items: buildShellNav({ customerDataAvailable: true }), activeScreenId: 'oggi', screenLabel: 'Oggi' });
  const active = sidebar.findAll('a').filter((node) => String(node.getAttribute('class') ?? '').split(/\s+/).includes('active'));
  assert.equal(active.length, 1);
  assert.equal(active[0].getAttribute('href'), '#/');
  assert.equal(active[0].getAttribute('aria-current'), 'page');
});

test('C16: the agenda card links «Apri il calendario →» to the calendar', () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const seen = [];
  renderOggi({ doc, mount, userName: 'Elena', navigate: (hash) => seen.push(hash), now: new Date(2026, 9, 19, 9), home: homeFor({}, { agenda: buildTodayAgenda([APPT_TODAY], OGGI_NOW) }) });
  const link = mount.findAll('a').find((node) => node.textContent === 'Apri il calendario →');
  assert.equal(link.getAttribute('href'), '#/calendario');
  link.dispatch('click', { preventDefault: () => {} });
  assert.deepEqual(seen, ['#/calendario']);
});

test('2a075e2d9250: Oggi has a load ceiling, then an Italian note with Riprova, never «Carico…» forever', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const base = oggiFakeClient({ tasks: [TASK_OPEN], appointments: [APPT_TODAY] });
  let hold = true;
  /** @type {Array<() => void>} */
  const held = [];
  const client = {
    ...base,
    request(path, options) {
      if (!hold) return base.request(path, options);
      return new Promise((resolve, reject) => { held.push(() => base.request(path, options).then(resolve, reject)); });
    },
  };
  /** @type {Array<{ fn: () => void, ms: number }>} */
  const timers = [];
  const view = createOggiView({
    doc, mount, client, navigate: () => {},
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimer: () => {},
  });
  const first = view.render({ spaceName: 'Spazio', links: [], now: OGGI_NOW });
  assert.ok(mount.textContent.includes('Carico la tua giornata'), 'the loading line shows first');
  assert.equal(timers.length, 1, 'one ceiling per render');
  assert.equal(timers[0].ms, OGGI_LOAD_CEILING_MS);
  assert.equal(OGGI_LOAD_CEILING_MS, 10_000);
  timers[0].fn();
  assert.ok(!mount.textContent.includes('Carico la tua giornata'), 'past the ceiling the loading line is gone');
  const note = mount.findAll('div').find((node) => node.getAttribute('role') === 'alert');
  assert.ok(note, 'an honest note replaces it');
  assert.ok(note.textContent.includes('La tua giornata ci mette più del solito.'), note.textContent);
  const retry = mount.findAll('button').find((node) => node.getAttribute('data-action') === 'oggi-retry');
  assert.equal(retry?.textContent, 'Riprova');

  // Riprova reads again; this time the reads answer and the home paints.
  hold = false;
  retry.dispatch('click', {});
  await settle(() => mount.textContent.includes('Richiama per il preventivo'));
  assert.ok(!mount.findAll('div').some((node) => node.getAttribute('role') === 'alert'), 'the note is gone');
  // The first render's late answer never repaints over the newer one.
  for (const release of held.splice(0)) release();
  await first;
  assert.ok(mount.textContent.includes('Richiama per il preventivo'));
});

// backlog:5083e7a77c26 (b): production read «2 di 9 collegati» over eight
// names. Gmail and Calendar from the profile, nothing else: the number and
// the names must come from one list, so connected + named = total.
test('5083e7a77c26: the strip count equals the list it names', () => {
  const profile = {
    connections: {
      available: true,
      items: [
        { connector: 'gmail', status: 'connected', account: 'op@palestra.it' },
        { connector: 'calendar', status: 'connected', account: 'op@palestra.it' },
      ],
    },
  };
  const doc = createFakeDocument();
  const mount = createMount();
  renderOggi({
    doc, mount, spaceName: 'Spazio di prova', links: [], now: new Date(2026, 9, 19, 9),
    home: {
      recap: 'x', actions: [], triage: {}, agenda: [], brief: null,
      missing: missingLeadChannels([], profile), connections: [], profile,
      availability: { work: true, appointments: true, channels: true },
    },
  });
  const strip = mount.findAll('a').find((node) => node.getAttribute('class') === 'bo-oggi-invite');
  assert.ok(strip, 'the strip renders');
  const count = /(\d+) di (\d+) collegati/.exec(strip.textContent);
  assert.ok(count, 'the strip carries a count');
  const named = /Collega (.+) per non perdere/.exec(strip.textContent);
  assert.ok(named, 'the strip names the channels to connect');
  const names = named[1].split(', ');
  assert.equal(Number(count[1]) + names.length, Number(count[2]), `«${count[0]}» and ${names.length} names tell one story`);
  assert.equal(count[0], '2 di 9 collegati');
  assert.ok(!names.includes('Email') && !names.includes('Google Calendar'), 'connected channels are not invited');
});

// backlog:5083e7a77c26 (a): the prototype always pairs the agenda with
// «Prima della prossima call»; with no call ahead the card disappeared.
test('5083e7a77c26: «Prima della prossima call» stays on screen with no call ahead', () => {
  const doc = createFakeDocument();
  const mount = createMount();
  renderOggi({
    doc, mount, spaceName: 'Spazio di prova', links: [], now: new Date(2026, 9, 19, 9),
    home: {
      recap: 'x', actions: [], triage: {}, agenda: [], brief: null, missing: [],
      availability: { work: true, appointments: true, channels: true },
    },
  });
  assert.ok(mount.findAll('h3').some((node) => node.textContent === '✦ Prima della prossima call'), 'the card heading is there');
  assert.ok(mount.textContent.includes('Nessuna call in programma.'), 'an honest empty line instead of a missing card');

  const off = createMount();
  renderOggi({
    doc, mount: off, spaceName: 'Spazio di prova', links: [], now: new Date(2026, 9, 19, 9),
    home: {
      recap: 'x', actions: [], triage: {}, agenda: [], brief: null, missing: [],
      availability: { work: true, appointments: false, channels: true },
    },
  });
  assert.ok(off.findAll('h3').some((node) => node.textContent === '✦ Prima della prossima call'));
  assert.ok(off.textContent.includes('Il calendario non è attivo in questo spazio: qui comparirà'));
});

test('5083e7a77c26: with no more calls today the card prepares the next one ahead', () => {
  const lateToday = new Date('2026-10-19T16:00:00.000Z'); // 18:00 in Rome, after APPT_TODAY
  assert.equal(nextAppointment([APPT_TODAY, APPT_TOMORROW], lateToday), null, 'nothing else today');
  assert.equal(upcomingAppointment([APPT_TODAY, APPT_TOMORROW], lateToday)?.id, 'appt-2', 'tomorrow is the next call');
  assert.equal(upcomingAppointment([APPT_TODAY, APPT_TOMORROW], OGGI_NOW)?.id, 'appt-1', 'today first');
  assert.equal(upcomingAppointment([{ ...APPT_TOMORROW, status: 'cancelled' }], lateToday), null, 'a cancelled call prepares nothing');
  const brief = buildPreCallBrief({ appointment: APPT_TOMORROW, messages: [], calls: [], now: lateToday });
  assert.equal(brief.when, 'domani alle 10:00');
  assert.ok(brief.bullets[0].startsWith('Appuntamento di domani alle 10:00 con Giulia Romano'), brief.bullets[0]);
  const later = buildPreCallBrief({ appointment: { ...APPT_TOMORROW, startsAt: '2026-10-23T08:00:00.000Z' }, now: lateToday });
  assert.equal(later.when, '23 ott alle 10:00');
  const today = buildPreCallBrief({ appointment: APPT_TODAY, now: OGGI_NOW });
  assert.equal(today.when, 'oggi alle 10:00', 'today keeps its wording');
});

test('5083e7a77c26: a stored channel alias counts as its channel, never as a tenth one', async () => {
  const { channelConnectionCount } = await import('../apps/admin/public/admin-channels-count.js');
  const count = channelConnectionCount([
    { channel: 'google-calendar', status: 'active' },
    { channel: 'gmail', status: 'active' },
    { channel: 'messenger', status: 'pending' },
  ]);
  assert.equal(count.connected, 2);
  assert.equal(count.total, 9, 'aliases add no channel to the universe');
  assert.ok(!count.missing.some((entry) => entry.channel === 'calendar' || entry.channel === 'email'));
  assert.ok(count.missing.some((entry) => entry.channel === 'facebook'), 'a pending Messenger row leaves Facebook to connect');
  assert.equal(countConnectedNine([{ channel: 'google-calendar', status: 'active' }]), 1);
});
