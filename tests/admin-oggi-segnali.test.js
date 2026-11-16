import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ADVISOR_ACTION_LIMIT,
  SIGNAL_SILENCE_DAYS,
  applyTriageDecision,
  advisorProgress,
  buildAdvisorActions,
  buildSignalActions,
  missedAppointmentSignal,
  silentThreadSignal,
  siteFormSignal,
  triageState,
  undoTriage,
} from '../apps/admin/public/admin-oggi.js';

/**
 * Segnali in Oggi (backlog:d08331558c50): un segnale non è una pagina — tre
 * fatti interni (appuntamento saltato, filo senza risposta da giorni, modulo
 * del sito senza risposta) generano una riga in Oggi con motivo e azione
 * proposta, ognuna cita il record da cui nasce, e un segnale gestito (record
 * risolto) non ricompare alla rilettura.
 */

const NOW = new Date('2026-11-16T09:00:00Z');
const FOUR_DAYS_AGO = '2026-11-12T08:00:00Z';
const ONE_DAY_AGO = '2026-11-15T08:00:00Z';
const TWO_HOURS_AGO = '2026-11-16T07:00:00Z';

function noShowAppointment(overrides = {}) {
  return {
    id: 'appt-1',
    status: 'no-show',
    startsAt: '2026-11-14T13:00:00Z',
    subjectOwner: 'host',
    subjectResource: 'contact',
    subjectId: 'c1',
    subjectLabel: 'Mario Rossi',
    ...overrides,
  };
}

function inboundMessage(overrides = {}) {
  return {
    id: 'm1',
    direction: 'inbound',
    channel: 'whatsapp',
    conversationId: 'conv1',
    occurredAt: FOUR_DAYS_AGO,
    subjectOwner: 'host',
    subjectResource: 'contact',
    subjectId: 'c2',
    subjectLabel: 'Luisa Bianchi',
    remoteHandle: '+39123456789',
    ...overrides,
  };
}

function openConversation(overrides = {}) {
  return {
    id: 'conv1',
    status: 'open',
    subjectOwner: 'host',
    subjectResource: 'contact',
    subjectId: 'c2',
    subjectLabel: 'Luisa Bianchi',
    ...overrides,
  };
}

function formSubmission(overrides = {}) {
  return {
    id: 'form-1',
    status: 'pending',
    firstName: 'Marco',
    lastName: 'Verdi',
    email: 'marco@example.it',
    replyWhatsapp: true,
    replyEmail: false,
    occurredAt: TWO_HOURS_AGO,
    ...overrides,
  };
}

test('un appuntamento saltato propone di riprogrammare, citando il record', () => {
  const action = missedAppointmentSignal(noShowAppointment(), NOW);
  assert.ok(action, 'no-show genera una riga');
  assert.equal(action.kind, 'signal');
  assert.ok(action.title.includes('Riprogramma'), `titolo è l'azione proposta: ${action.title}`);
  assert.ok(action.title.includes('Mario Rossi'), 'il titolo nomina il cliente');
  assert.ok(action.why.includes('Ha saltato'), `il motivo dice cosa è successo: ${action.why}`);
  assert.ok(action.why.includes('del 14 novembre'), `il motivo dice quando: ${action.why}`);
  assert.ok(action.why.includes('14:00'), `il motivo dice l'ora di Roma: ${action.why}`);
  assert.equal(action.cta, 'Riprogramma');
  assert.equal(action.record.module, 'appointment');
  assert.equal(action.record.id, 'appt-1');
  assert.ok(action.record.label.includes('Mario Rossi'), 'il record citato ha un nome, mai un id tecnico');
  assert.equal(action.record.href, '#/customer-card/contact/c1');
  assert.equal(action.snapshot.status, 'no-show');
});

test('un appuntamento non saltato non genera righe', () => {
  assert.equal(missedAppointmentSignal(noShowAppointment({ status: 'done' }), NOW), null);
  assert.equal(missedAppointmentSignal(noShowAppointment({ status: 'booked' }), NOW), null);
  assert.equal(missedAppointmentSignal(noShowAppointment({ status: 'cancelled' }), NOW), null);
  assert.equal(missedAppointmentSignal(noShowAppointment({ id: '  ' }), NOW), null);
  assert.equal(missedAppointmentSignal(noShowAppointment({ startsAt: 'not-a-date' }), NOW), null);
  assert.equal(missedAppointmentSignal(null, NOW), null);
});

test('un filo senza risposta da giorni propone un follow-up, citando il messaggio', () => {
  const action = silentThreadSignal(inboundMessage(), { conversation: openConversation(), now: NOW });
  assert.ok(action, 'quattro giorni di silenzio generano una riga');
  assert.equal(action.kind, 'signal');
  assert.ok(action.title.includes('follow-up'), `titolo è l'azione proposta: ${action.title}`);
  assert.ok(action.title.includes('Luisa Bianchi'), 'il titolo nomina il cliente');
  assert.ok(action.why.includes('Nessuna risposta da 4 giorni'), `il motivo dice da quanto: ${action.why}`);
  assert.ok(action.why.includes('WhatsApp'), `il motivo dice il canale: ${action.why}`);
  assert.equal(action.record.module, 'interaction-message');
  assert.equal(action.record.id, 'm1');
  assert.equal(action.snapshot.direction, 'inbound');
});

test('un filo recente, risposto o chiuso non genera righe', () => {
  const recent = inboundMessage({ occurredAt: ONE_DAY_AGO });
  assert.equal(silentThreadSignal(recent, { conversation: openConversation(), now: NOW }), null);
  const answered = inboundMessage();
  const outbound = { ...inboundMessage(), id: 'm2', direction: 'outbound', occurredAt: '2026-11-13T08:00:00Z' };
  const actions = buildSignalActions({
    messages: [answered, outbound],
    conversations: [openConversation()],
    now: NOW,
  });
  assert.ok(actions.every((action) => action.record.module !== 'interaction-message'), 'il filo risposto non segnala');
  const closed = openConversation({ status: 'closed' });
  assert.equal(silentThreadSignal(inboundMessage(), { conversation: closed, now: NOW }), null);
  assert.equal(silentThreadSignal(inboundMessage({ id: '' }), { now: NOW }), null);
  assert.equal(silentThreadSignal(inboundMessage({ direction: 'outbound' }), { now: NOW }), null);
  assert.equal(silentThreadSignal(null, { now: NOW }), null);
});

test('la posta automatica non è una persona in attesa', () => {
  const receipt = inboundMessage({
    id: 'm-auto',
    channel: 'email',
    conversationId: 'conv-auto',
    remoteHandle: 'receipts@paypal.com',
    subjectLabel: 'PayPal',
  });
  const actions = buildSignalActions({
    messages: [receipt],
    conversations: [{ ...openConversation(), id: 'conv-auto' }],
    now: NOW,
  });
  assert.ok(actions.every((action) => action.record.module !== 'interaction-message'), 'la ricevuta non propone follow-up');
  const own = inboundMessage({ id: 'm-own', remoteHandle: 'io@studio.it', channel: 'email', conversationId: 'conv-own' });
  const ownActions = buildSignalActions({
    messages: [own],
    conversations: [{ ...openConversation(), id: 'conv-own' }],
    now: NOW,
    ownAddresses: ['io@studio.it'],
  });
  assert.ok(ownActions.every((action) => !action.id.endsWith('m-own')), 'ciò che si è scritto da soli non segnala');
});

test('un modulo del sito senza risposta propone di rispondere sul canale giusto', () => {
  const action = siteFormSignal(formSubmission());
  assert.ok(action, 'pending genera una riga');
  assert.equal(action.kind, 'signal');
  assert.ok(action.title.includes('Marco Verdi'), `titolo è l'azione proposta: ${action.title}`);
  assert.ok(action.why.includes('Richiesta dal sito di Marco Verdi'), `il motivo dice da dove nasce: ${action.why}`);
  assert.ok(action.why.includes('su WhatsApp'), `il motivo dice il canale: ${action.why}`);
  assert.equal(action.cta, 'Rispondi');
  assert.equal(action.record.module, 'site-form-submission');
  assert.equal(action.record.id, 'form-1');
  const emailOnly = siteFormSignal(formSubmission({ id: 'form-2', replyWhatsapp: false, replyEmail: true }));
  assert.ok(emailOnly.why.includes('via email'), 'solo email: si risponde via email');
  const both = siteFormSignal(formSubmission({ id: 'form-3', replyWhatsapp: true, replyEmail: true }));
  assert.ok(both.why.includes('su WhatsApp e via email'), 'entrambi i recapiti: si risponde su entrambi');
  assert.equal(siteFormSignal(formSubmission({ status: 'accepted' })), null);
  assert.equal(siteFormSignal(formSubmission({ status: 'rejected' })), null);
  assert.ok(siteFormSignal(formSubmission({ status: 'needs-review', id: 'form-nr' })), 'needs-review aspetta ancora risposta');
  assert.equal(siteFormSignal(formSubmission({ id: '  ' })), null);
  assert.equal(siteFormSignal(null), null);
});

test("almeno tre segnali generano righe con motivo e azione, ognuna cita il suo record", () => {
  const built = buildAdvisorActions({
    appointments: [noShowAppointment()],
    messages: [inboundMessage()],
    conversations: [openConversation()],
    submissions: [formSubmission()],
    now: NOW,
  });
  const signals = built.actions.filter((action) => action.kind === 'signal');
  assert.ok(signals.length >= 3, `almeno tre segnali: ${signals.length}`);
  const modules = signals.map((action) => action.record.module).sort();
  assert.deepEqual(modules, ['appointment', 'interaction-message', 'site-form-submission']);
  for (const signal of signals) {
    assert.ok(typeof signal.title === 'string' && signal.title !== '', 'ogni riga ha un titolo');
    assert.ok(typeof signal.why === 'string' && signal.why !== '', 'ogni riga ha un motivo');
    assert.ok(typeof signal.cta === 'string' && signal.cta !== '', 'ogni riga ha un’azione proposta');
    assert.ok(typeof signal.record.id === 'string' && signal.record.id !== '', 'ogni riga cita un record');
  }
});

test('un segnale gestito non ricompare: record risolto, riga sparita', () => {
  const before = buildSignalActions({
    appointments: [noShowAppointment()],
    messages: [inboundMessage()],
    conversations: [openConversation()],
    submissions: [formSubmission()],
    now: NOW,
  });
  assert.equal(before.length, 3, 'prima: tre segnali');
  const after = buildSignalActions({
    appointments: [noShowAppointment({ status: 'done' })],
    messages: [inboundMessage()],
    conversations: [openConversation({ status: 'closed' })],
    submissions: [formSubmission({ status: 'accepted' })],
    now: NOW,
  });
  assert.equal(after.length, 0, 'dopo la gestione: nessun segnale');
});

test('la decisione sul segnale resta in triage e si può annullare', () => {
  const [first] = buildSignalActions({ appointments: [noShowAppointment()], now: NOW });
  let triage = applyTriageDecision({}, first.id, 'done');
  assert.equal(triageState(triage, first.id), 'done');
  const progress = advisorProgress([first], triage);
  assert.equal(progress.handled, 1);
  assert.equal(progress.total, 1);
  triage = undoTriage(triage, first.id);
  assert.equal(triageState(triage, first.id), 'open');
});

test('righe malformate non rompono la lista', () => {
  assert.deepEqual(buildSignalActions({}), []);
  assert.deepEqual(buildSignalActions({ appointments: [null, {}, { id: 'x' }], messages: [null], submissions: [undefined] }), []);
  const built = buildAdvisorActions({ tasks: [{ id: 't1', status: 'open', title: 'Chiama' }], now: NOW });
  assert.ok(built.actions.length >= 1, 'i follow-up restano anche senza segnali');
});

test('i segnali contano nel tetto come le altre righe', () => {
  const tasks = Array.from({ length: 9 }, (_, index) => ({ id: `t${index}`, status: 'open', title: `C${index}` }));
  const built = buildAdvisorActions({
    tasks,
    appointments: [noShowAppointment()],
    messages: [inboundMessage()],
    conversations: [openConversation()],
    submissions: [formSubmission()],
    now: NOW,
  });
  assert.equal(built.capped, true);
  assert.equal(built.actions.length, ADVISOR_ACTION_LIMIT);
});

test('la soglia di silenzio è dichiarata', () => {
  assert.equal(SIGNAL_SILENCE_DAYS, 3);
});
