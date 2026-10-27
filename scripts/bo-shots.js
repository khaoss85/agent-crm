// @ts-check

/**
 * Backoffice BO-F6-05 — `npm run bo:shots [--out <dir>] [--screen <name>]`.
 *
 * Serves the real `/bo` static assets (`apps/admin/public`) on loopback with
 * demo fixtures and saves one PNG per backoffice screen, at 1440x1800 and
 * at 390x1600:
 *
 *   login, oggi, clienti, cliente, pipeline, calendario, sequenze, reporting,
 *   personalizzazione, catalogo, stato-sync, spazi-accessi, componenti
 *   (the F6-02 component catalog)
 *
 * Each screen renders its real view module plus the real `styles.css` inside
 * a real Chromium, driven by the same demo-shaped fixtures the repo's unit
 * and `*-shots` tests already prove filled — nothing is invented for the
 * camera. The Chromium lookup mirrors the `*-shots` tests (`CHROMIUM_BIN`,
 * then the Playwright headless-shell caches). Where no binary exists, or it
 * cannot run here, the command exits 0 with a skip message: shots are a
 * publishing convenience, not a gate.
 *
 * The command never touches the network: the fixture server binds 127.0.0.1
 * and Chromium runs with background networking disabled. The default output
 * directory is outside the repo (`<repo>/../bo-shots`); `--out` overrides
 * it, `--screen` renders a single screen.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = join(fileURLToPath(import.meta.url), '..');

export const DESKTOP = Object.freeze({ width: 1440, height: 1800 });
export const PHONE = Object.freeze({ width: 390, height: 1600 });

export const SCREEN_NAMES = Object.freeze([
  'login',
  'oggi',
  'clienti',
  'cliente',
  'pipeline',
  'calendario',
  'sequenze',
  'reporting',
  'personalizzazione',
  'catalogo',
  'stato-sync',
  'spazi-accessi',
  'componenti',
]);

/**
 * Parse the CLI arguments. Pure: `root` defaults to the working directory.
 * @param {Array<string>} argv arguments without the node/script prefix
 * @param {{ root?: string }} [options]
 */
export function parseArgs(argv, options = {}) {
  const root = options.root ?? process.cwd();
  let out = null;
  let screen = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--out') {
      out = argv[index + 1];
      index += 1;
      if (typeof out !== 'string' || out === '' || out.startsWith('--')) {
        throw new Error('bo:shots --out needs a directory (for example --out /tmp/bo-shots)');
      }
    } else if (arg === '--screen') {
      screen = argv[index + 1];
      index += 1;
      if (typeof screen !== 'string' || screen === '') {
        throw new Error(`bo:shots --screen needs one of: ${SCREEN_NAMES.join(', ')}`);
      }
      if (!SCREEN_NAMES.includes(screen)) {
        throw new Error(`bo:shots unknown screen "${screen}" (one of: ${SCREEN_NAMES.join(', ')})`);
      }
    } else if (arg === '--help' || arg === '-h') {
      return { help: true, out: null, screen: null };
    } else {
      throw new Error(`bo:shots unknown argument "${arg}" (see --help)`);
    }
  }
  return { help: false, out: resolve(root, out ?? join('..', 'bo-shots')), screen };
}

export const USAGE = `usage: npm run bo:shots [--out <dir>] [--screen <nome>]

Renders every /bo screen to PNG with demo data, at 1440x1800 and 390x1600.
Output defaults outside the repo (<repo>/../bo-shots).

screens: ${SCREEN_NAMES.join(', ')}`;

/**
 * PNG dimensions and byte size. Throws on a missing or non-PNG file, so an
 * empty or failed render can never pass as a shot.
 * @param {string} file
 */
export function readPngSize(file) {
  const bytes = readFileSync(file);
  if (bytes.length < 8 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    throw new Error(`not a PNG: ${file}`);
  }
  return { bytes: bytes.length, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

// ---------------------------------------------------------------------------
// Demo fixtures. Same shapes as the repo's unit and `*-shots` tests, which
// already prove each view renders them filled: the Palestra Esempio space
// (Giulia Romano's trial, Guido Presti's card, the B2B pipeline, October
// 2026 agendas) the whole backoffice is demoed against.
// ---------------------------------------------------------------------------

const DEMO_TASKS = [
  {
    id: 'task-1', status: 'open', title: 'Richiama per il preventivo',
    subjectResource: 'lead', subjectId: 'lead-1', subjectOwner: 'host',
    subjectLabel: 'Giulia Romano', dueAt: '2026-10-19T00:00:00.000Z',
    openedAt: '2026-10-18T08:00:00.000Z',
  },
  {
    id: 'task-2', status: 'open', title: 'Prepara la call con i prezzi del pacchetto',
    subjectResource: 'lead', subjectId: 'lead-1', subjectOwner: 'host',
    subjectLabel: 'Giulia Romano', dueAt: '2026-10-20T00:00:00.000Z',
    openedAt: '2026-10-18T09:00:00.000Z',
  },
];

const DEMO_APPOINTMENTS = [
  {
    id: 'appt-1', status: 'booked', subjectResource: 'lead', subjectId: 'lead-1',
    subjectOwner: 'host', subjectLabel: 'Giulia Romano',
    startsAt: '2026-10-19T08:00:00.000Z', notes: 'Vuole la scheda con i prezzi del pacchetto.',
  },
  {
    id: 'appt-2', status: 'booked', subjectResource: 'lead', subjectId: 'lead-2',
    subjectOwner: 'host', subjectLabel: 'Marco Rossi',
    startsAt: '2026-10-19T14:00:00.000Z', notes: 'Prova gratuita, portare il modulo.',
  },
];

const DEMO_MESSAGES = [
  {
    id: 'msg-1', channel: 'whatsapp', body: 'Ciao, posso passare giovedi per una prova?',
    occurredAt: '2026-10-18T15:00:00.000Z', subjectResource: 'lead', subjectId: 'lead-1',
  },
];

const DEMO_CLIENTS = [
  {
    resource: 'contact', id: 'c1', name: 'Marco Rossi',
    company: { id: 'co1', name: 'Palestra Esempio' }, email: 'marco@palestra-esempio.it',
    phone: { value: '+393331234567', system: 'whatsapp' }, channels: ['whatsapp'],
    status: { value: 'cliente', reason: 'signed business on record: orders' },
    lastContactAt: '2026-10-20T09:00:00.000Z', lastContactChannel: 'whatsapp',
    offerValueCents: 120000, offerCurrency: 'EUR',
    nextStep: { title: 'Prova gratuita', dueAt: '2026-10-22', overdue: false },
    budget: { available: true, value: '200/mese', source: { resource: 'contact', id: 'c1' }, reason: null },
  },
  {
    resource: 'contact', id: 'c2', name: 'Anna Bianchi',
    company: null, email: 'anna@esempio.it', phone: null, channels: ['instagram'],
    status: { value: 'contatto', reason: 'no signed business on record' },
    lastContactAt: null, lastContactChannel: null,
    offerValueCents: null, offerCurrency: null, nextStep: null,
    budget: { available: false, value: null, source: null, reason: 'nessun budget estratto per questo cliente' },
  },
  {
    resource: 'contact', id: 'c3', name: 'Luca Verdi',
    company: { id: 'co2', name: 'Studio Aurora' }, email: 'luca@studioaurora.it',
    phone: { value: '+393339876543', system: 'phone' }, channels: ['phone'],
    status: { value: 'contatto', reason: 'no signed business on record' },
    lastContactAt: '2026-10-19T16:30:00.000Z', lastContactChannel: 'phone',
    offerValueCents: 9900, offerCurrency: 'EUR',
    nextStep: { title: 'Inviare il preventivo', dueAt: '2026-10-24', overdue: false },
    budget: { available: false, value: null, source: null, reason: 'nessun budget estratto per questo cliente' },
  },
];

const DEMO_CARD = {
  customerCardContract: 1,
  subject: { resource: 'contact', id: 'c1' },
  name: 'Guido Presti',
  company: { id: 'co1', name: 'Palestra Esempio' },
  phone: { available: true, value: '+39 333 1234567', system: 'whatsapp', reason: null },
  email: 'guido@palestra-esempio.it',
  socials: [{ system: 'instagram', handle: 'guido.presti' }],
  status: { value: 'contatto', reason: 'no signed business in the composed packages' },
  activePackage: {
    available: true, count: 1, countIsComplete: true, countNote: null, truncated: false,
    active: [{ id: 'sub1', name: '10 ingressi', status: 'active' }],
    items: [{ id: 'sub1', name: '10 ingressi', status: 'active' }],
    reason: null,
  },
  notes: { available: false, items: null, reason: 'this application composes no notes record' },
  history: { available: false, items: [], count: 0, truncated: false, completeTimeline: false, reason: 'no history' },
};

const DEMO_TIMELINE = {
  customerTimelineContract: 1,
  subject: { resource: 'contact', id: 'c1' },
  conversations: { available: true, count: 2, truncated: false, items: [], unthreadedMessages: 0, unthreadedCalls: 0 },
  entries: {
    available: true, count: 4, truncated: false,
    items: [
      {
        entry: 'message', id: 'm1', conversationId: 't1', channel: 'whatsapp', direction: 'inbound',
        sync: 'received', body: 'Ciao, vorrei prenotare una prova', teamAuthorId: null,
        remoteHandle: '+39 333 1234567', errorCode: null, occurredAt: '2026-10-20T09:00:00.000Z',
      },
      {
        entry: 'message', id: 'm2', conversationId: 't1', channel: 'whatsapp', direction: 'outbound',
        sync: 'delivered', body: 'Certo, ti propongo giovedi alle 18', teamAuthorId: 'elena',
        remoteHandle: '+39 333 1234567', errorCode: null, occurredAt: '2026-10-20T09:05:00.000Z',
      },
      {
        entry: 'message', id: 'm3', conversationId: 't2', channel: 'instagram', direction: 'inbound',
        sync: 'received', body: 'Quanto costa il pacchetto?', teamAuthorId: null,
        remoteHandle: 'guido.presti', errorCode: null, occurredAt: '2026-10-20T11:00:00.000Z',
      },
      {
        entry: 'call', id: 'c9', conversationId: null, channel: 'phone', direction: 'outbound',
        sync: 'completed', durationSec: 372, teamAuthorId: 'marco',
        remoteHandle: '+39 333 1234567', errorCode: null, occurredAt: '2026-10-20T12:00:00.000Z',
      },
    ],
  },
  appointments: {
    available: true, count: 1, truncated: false,
    items: [{
      id: 'b1', status: 'booked', startsAt: '2099-10-23T16:00:00.000Z', endsAt: '2099-10-23T17:00:00.000Z',
      serviceKey: 'pt-single', teamMemberId: 'coach-guido', priceCents: 4000, currency: 'EUR', notes: null,
    }],
  },
  contactPoints: { available: true, count: 3, items: [] },
  timelineNote: 'Accordo-managed threads and bookings only.',
};

const DEMO_PROFILE = {
  customerProfileContract: 1,
  subject: { resource: 'contact', id: 'c1' },
  canonicalIdentity: {
    linked: true, clusterKey: 'k1',
    canonical: { resource: 'contact', id: 'c1', role: 'canonical' },
    members: [
      {
        resource: 'contact', id: 'c1', role: 'canonical', decisionId: 'd1',
        decidedAt: '2026-10-19T10:00:00.000Z', reason: 'stesso numero su WhatsApp e Instagram',
        decidedBy: { type: 'user', id: 'elena' },
      },
    ],
    note: 'every record below still exists and was never rewritten',
  },
  identity: { company: { id: 'co1', name: 'Palestra Esempio' }, contact: { id: 'c1', email: 'guido@palestra-esempio.it' } },
  externalIdentities: [],
  opportunities: { available: true, count: 1, countIsComplete: true, items: [{ id: 'o1', status: 'open', name: 'Pacchetto 10 ingressi' }], truncated: false },
  quotes: { available: true, count: 1, countIsComplete: true, items: [{ id: 'q1', status: 'sent', name: 'Preventivo 10 ingressi' }], truncated: false },
  orders: { available: false, reason: 'not composed', items: null, count: null },
  contracts: { available: false, reason: 'not composed', items: null, count: null },
  subscriptions: { available: false, reason: 'not composed', items: null, count: null },
  deliveryProjects: { available: false, reason: 'not composed', items: null, count: null },
  serviceCoverages: { available: false, reason: 'not composed', items: null, count: null },
  supportCases: { available: false, reason: 'not composed', items: null, count: null },
  workTasks: {
    available: true, count: 2, countIsComplete: true,
    items: [
      { id: 'w1', status: 'open', name: 'Richiamare per la prova' },
      { id: 'w2', status: 'done', name: 'Inviare il listino' },
    ],
    truncated: false,
  },
  successions: { available: false, reason: 'not composed', items: null, count: null },
  dataQualityIssues: [],
  duplicateCandidates: [],
  completeTimeline: false,
  timelineNote: 'This profile spans Accordo-managed records only.',
  limitations: [],
};

const DEMO_PIPELINE = {
  pipelineContract: 1,
  name: 'b2b-sales',
  label: 'B2B Sales',
  module: 'opportunity',
  defaultStage: 'discovery',
  movePath: '/api/modules/opportunity/records/:id/actions/move-stage',
  stages: [
    { key: 'discovery', label: 'Discovery', order: 10, type: 'open', probability: 10 },
    { key: 'demo', label: 'Demo', order: 20, type: 'open', probability: 30 },
    { key: 'won', label: 'Won', order: 50, type: 'won', probability: 100 },
    { key: 'lost', label: 'Lost', order: 60, type: 'lost', probability: 0 },
  ],
};

const DEMO_DEALS = [
  { id: 'a', name: 'Palestra Esempio', companyName: 'Palestra Esempio', valueCents: 120000, currency: 'EUR', pipelineKey: 'b2b-sales', pipelineStage: 'discovery' },
  { id: 'b', name: 'Studio Aurora', companyName: 'Studio Aurora', valueCents: 50000, currency: 'EUR', pipelineKey: 'b2b-sales', pipelineStage: 'discovery' },
  { id: 'c', name: 'Deal estero', companyName: 'Gym Intl', valueCents: 2500, currency: 'USD', pipelineKey: 'b2b-sales', pipelineStage: 'demo' },
  { id: 'd', name: 'Cliente vinto', companyName: 'Fit Club', valueCents: 9900, currency: 'EUR', pipelineKey: 'b2b-sales', pipelineStage: 'won' },
  { id: 'e', name: 'Perso per budget', companyName: 'Acme', valueCents: 30000, currency: 'EUR', pipelineKey: 'b2b-sales', pipelineStage: 'lost', closeReason: 'No budget' },
];

const DEMO_WEEK = {
  from: '2026-10-19T00:00:00.000Z',
  to: '2026-10-26T00:00:00.000Z',
  members: [
    {
      teamMemberId: 'marco',
      appointments: [
        {
          id: 'a1', status: 'booked', startsAt: '2026-10-22T16:00:00.000Z', endsAt: '2026-10-22T16:30:00.000Z',
          serviceKey: 'taglio', teamMemberId: 'marco', priceCents: 4500, currency: 'EUR', notes: null,
          sourceKey: 'calendario:marco:1:c1', subject: { resource: 'contact', id: 'c1', owner: 'host', ownerPackage: null, label: 'Ada' },
        },
      ],
    },
    {
      teamMemberId: 'sara',
      appointments: [
        {
          id: 'a2', status: 'booked', startsAt: '2026-10-23T07:00:00.000Z', endsAt: '2026-10-23T07:30:00.000Z',
          serviceKey: 'barba', teamMemberId: 'sara', priceCents: 2000, currency: 'EUR', notes: null,
          sourceKey: 'calendario:sara:1:c2', subject: { resource: 'contact', id: 'c2', owner: 'host', ownerPackage: null, label: 'Bo' },
        },
      ],
    },
  ],
};

const DEMO_SLOTS = [
  { startsAt: '2026-10-22T16:00:00.000Z', endsAt: '2026-10-22T16:30:00.000Z' },
  { startsAt: '2026-10-22T17:00:00.000Z', endsAt: '2026-10-22T17:30:00.000Z' },
];

const DEMO_SEQUENCES = [
  { id: 7, sourceKey: 'seq-bentornato', spaceId: 'presti', name: 'Bentornato in palestra', status: 'draft' },
  { id: 8, sourceKey: 'seq-promemoria', spaceId: 'presti', name: 'Promemoria appuntamento', status: 'active' },
];

const DEMO_SEQUENCE_STEPS = [
  { id: 1, sequenceSourceKey: 'seq-bentornato', spaceId: 'presti', stepOrder: 0, dayOffset: 0, channel: 'whatsapp', templateName: 'Ciao, ci manchi', templateLanguage: 'it', templateVars: '["name"]' },
  { id: 2, sequenceSourceKey: 'seq-bentornato', spaceId: 'presti', stepOrder: 1, dayOffset: 2, channel: 'email', templateName: 'Ritroviamoci', templateLanguage: 'it', templateVars: '["name"]' },
];

const DEMO_ENROLLMENTS = [
  { id: 11, sequenceSourceKey: 'seq-bentornato', spaceId: 'presti', subjectLabel: 'Giulia Rossi', status: 'active', currentStep: 0, nextDueAt: '2026-10-26T09:00:00.000Z' },
  { id: 12, sequenceSourceKey: 'seq-bentornato', spaceId: 'presti', subjectLabel: 'Marco Bianchi', status: 'stopped-replied', currentStep: 1, nextDueAt: null },
];

const DEMO_SENDS = [
  { id: 21, sequenceSourceKey: 'seq-bentornato', spaceId: 'presti', status: 'sent' },
  { id: 22, sequenceSourceKey: 'seq-bentornato', spaceId: 'presti', status: 'waiting-approval' },
];

const DEMO_REPORT = {
  period: '2026-10-20',
  periodLabel: 'ottobre 2026',
  owner: null,
  currency: 'EUR',
  currencies: { shown: 'EUR', others: ['USD'] },
  generatedAt: '2026-10-22T20:00:00.000Z',
  metrics: { modelVersion: 1 },
  truncated: false,
  kpis: [
    { id: 'open-value', label: 'Valore pipeline aperto', display: '26.000,00 EUR', sub: '6 preventivi aperti' },
    { id: 'open-count', label: 'Preventivi aperti', display: '6', sub: '26.000,00 EUR' },
    { id: 'won-period', label: 'Vinte in ottobre 2026', display: '14.000,00 EUR', sub: '2 chiusure' },
    { id: 'win-rate', label: 'Tasso di chiusura', display: '67%', sub: '2 vinte, 1 perse' },
    { id: 'closing-period', label: 'In chiusura in ottobre 2026', display: '14.000,00 EUR', sub: '2 preventivi' },
  ],
  funnel: [
    { stage: 'qualification', label: 'Qualifica', count: 3, minor: 14500 },
    { stage: 'negotiation', label: 'Trattativa', count: 2, minor: 10000 },
    { stage: 'won', label: 'Vinte', count: 2, minor: 14000 },
  ],
  valueByStage: [
    { stage: 'qualification', label: 'Qualifica', count: 3, minor: 14500 },
    { stage: 'negotiation', label: 'Trattativa', count: 2, minor: 10000 },
  ],
  monthly: [
    { month: '2026-09', label: 'settembre 2026', openCount: 1, expectedMinor: 2500, wonCount: 0, wonMinor: 0 },
    { month: '2026-10', label: 'ottobre 2026', openCount: 2, expectedMinor: 14000, wonCount: 2, wonMinor: 14000 },
  ],
  team: [
    { owner: 'alice', openCount: 2, openMinor: 14000, wonCount: 1, wonMinor: 9000, lostCount: 1, winRate: 0.5, winRateDisplay: '50%' },
    { owner: 'bob', openCount: 0, openMinor: 0, wonCount: 1, wonMinor: 5000, lostCount: 0, winRate: 1, winRateDisplay: '100%' },
  ],
  owners: ['alice', 'bob'],
  forecast: {
    currency: 'EUR', closedMinor: 14000, probableMinor: 9333, bestMinor: 14000, targetMinor: 2000000,
    heuristic: true, label: 'Stima euristica',
    method: 'Le probabili usano il tasso di chiusura storico (vinte su vinte + perse); non e una promessa.',
    note: 'Obiettivo 2.000.000,00 EUR dal bundle reporting.',
  },
  insights: [
    { id: 'redistribute', text: 'alice tiene molto aperto con il tasso piu basso: propone di spostare i lead senza data a bob.' },
  ],
  proposal: {
    title: 'Proposta di ridistribuzione lead',
    moves: [{ from: 'alice', to: 'bob', count: 1, reason: '1 preventivi senza data, tasso 50% contro 100%' }],
    note: 'La proposta non sposta nulla da sola: la riassegnazione resta all operatore.',
  },
  csv: { filename: 'reporting-2026-10.csv', content: 'reporting;2026-10;tutti;EUR\nalice;2;14000;1;9000;1;50%\n' },
};

const DEMO_UNITS = [
  { name: 'channels', kind: 'package', label: 'Canali', blurb: 'Messaggi in un unico inbox.' },
  { name: 'payments', kind: 'package', label: 'Pagamenti', blurb: 'Richieste di pagamento.' },
  { name: 'skill:debug-crm-run', kind: 'skill', label: 'Diagnosi', blurb: 'Diagnosi di un workflow.' },
];

const DEMO_PACKAGE_ROWS = [
  { unit: 'channels', status: 'active', id: 'row-channels' },
];

const DEMO_CATALOG = {
  products: [{
    productId: 'p1', sku: 'YOGA-10', name: 'Pacchetto 10 lezioni',
    description: 'Dieci ingressi.', category: 'pacchetti', source: 'manual',
    priceReadOnly: false, active: true, version: 2,
    offers: [{
      offerId: 'o1', name: 'Pacchetto 10 lezioni', active: true,
      currency: 'EUR', quoteEligible: true, unsupportedReason: null,
      components: [{
        key: 'prezzo-pacchetto', label: 'Prezzo del pacchetto',
        chargeType: 'one_time', pricingModel: 'flat_fee',
        interval: null, intervalCount: null, unitAmountCents: null,
        flatAmountCents: 9900, externalPriceId: null,
        sourcePricingModel: 'manual:flat_fee', tiers: [],
      }],
    }],
  }],
  summary: { manual: 1, byProvider: { 'stripe-test': 1 }, stripeConnected: true },
};

const DEMO_SYNC_ACTIVITY = {
  spaceId: 'locale',
  connections: [
    {
      connectionKey: 'wa-1', channel: 'whatsapp', account: '+39 333 1234567',
      adapter: 'whatsapp', adapterVersion: 1, status: 'active', importable: true,
      sync: null,
      inbox: {
        received: 10, applied: 9, quarantined: 0, ignored: 0, duplicate: 1, pending: 0,
        lastReceivedAt: '2026-10-25T11:30:00.000Z',
      },
      outbox: { openDeadLetters: 0, lastFailedAt: null },
      direction: 'both', health: 'ok', needsFix: 0,
    },
  ],
  feed: [
    { direction: 'in', connectionKey: 'wa-1', channel: 'whatsapp', at: '2026-10-25T11:30:00.000Z', kind: 'applied' },
  ],
  needsFix: 0,
  lastActivityAt: '2026-10-25T11:30:00.000Z',
};

const DEMO_SPACES = [
  { id: 'spazio-1', name: 'Negozio via Roma', initials: 'NE' },
  { id: 'spazio-2', name: 'Palestra centro', initials: 'PA' },
];

const DEMO_MEMBERS = [
  { subject: 'owner-1', role: 'owner', status: 'active' },
  { subject: 'marco', role: 'operator', status: 'active' },
];

// ---------------------------------------------------------------------------
// Screens. `module` is the real view served from apps/admin/public (null for
// the static login page). `code` drives the view with the fixtures above and
// ends by setting document.title to `<name>-ready`, the same convention the
// `*-shots` tests use to prove the harness ran to completion. `expect` lists
// demo strings that must appear in the painted DOM: a screen that renders
// empty fails even when Chromium writes a PNG.
// ---------------------------------------------------------------------------

export const SCREENS = Object.freeze([
  { name: 'login', module: null, ready: null, expect: ['Ricevi il link di accesso', 'Ogni conversazione'] },
  { name: 'oggi', module: 'admin-oggi.js', ready: 'oggi-ready', expect: ['Richiama per il preventivo', 'Giulia Romano'] },
  { name: 'clienti', module: 'admin-clienti.js', ready: 'clienti-ready', expect: ['Marco Rossi', 'Anna Bianchi'] },
  { name: 'cliente', module: 'admin-customer-card.js', ready: 'cliente-ready', expect: ['Guido Presti', 'Ciao, vorrei prenotare una prova'] },
  { name: 'pipeline', module: 'admin-pipeline.js', ready: 'pipeline-ready', expect: ['Palestra Esempio', 'Discovery'] },
  { name: 'calendario', module: 'admin-calendario.js', ready: 'calendario-ready', expect: ['taglio', 'Mostra settimana'] },
  { name: 'sequenze', module: 'admin-sequenze.js', ready: 'sequenze-ready', expect: ['Bentornato in palestra', 'Promemoria appuntamento'] },
  { name: 'reporting', module: 'admin-reporting.js', ready: 'reporting-ready', expect: ['Valore pipeline aperto', 'ottobre 2026'] },
  { name: 'personalizzazione', module: 'admin-personalizzazione.js', ready: 'personalizzazione-ready', expect: ['Kit social', 'Canali di conversazione'] },
  { name: 'catalogo', module: 'admin-catalog.js', ready: 'catalogo-ready', expect: ['Pacchetto 10 lezioni', 'Stripe collegato'] },
  { name: 'stato-sync', module: 'admin-sync.js', ready: 'stato-sync-ready', expect: ['Tutto a posto', 'WhatsApp'] },
  { name: 'spazi-accessi', module: 'admin-spazi-accessi.js', ready: 'spazi-accessi-ready', expect: ['Negozio via Roma', 'Palestra centro'] },
  { name: 'componenti', module: 'admin-ui-catalog.js', ready: 'componenti-ready', expect: ['Catalogo dei componenti', 'Primario scuro'] },
]);

export const BO_SCREENS = Object.freeze(SCREENS.map((screen) => screen.name));

const MIN_BYTES = Object.freeze({ desktop: 20000, phone: 10000 });

/** @param {string} name */
function fixtureScript(name) {
  switch (name) {
    case 'oggi': return `
import { createOggiView, buildOggiLinks } from './admin-oggi.js';
import { buildShellNav } from './admin-shell.js';
const TASKS = ${JSON.stringify(DEMO_TASKS)};
const APPOINTMENTS = ${JSON.stringify(DEMO_APPOINTMENTS)};
const MESSAGES = ${JSON.stringify(DEMO_MESSAGES)};
const client = {
  async request(path, options = {}) {
    if (String(options.method ?? 'GET').toUpperCase() !== 'GET') {
      return { task: { ...TASKS[0], status: 'completed' } };
    }
    if (path === '/api/schema') return { domains: { work: {}, appointments: {}, channels: {}, interactions: {} } };
    if (path.startsWith('/api/modules/work-task/records/')) {
      const id = path.split('/').pop();
      return TASKS.find((task) => task.id === id) ?? TASKS[0];
    }
    if (path.startsWith('/api/modules/work-task/records')) return { items: TASKS };
    if (path.startsWith('/api/modules/appointment/records')) return { items: APPOINTMENTS };
    if (path.startsWith('/api/modules/channel-connection/records')) return { items: [] };
    if (path.startsWith('/api/modules/interaction-message/records')) return { items: MESSAGES };
    if (path.startsWith('/api/modules/interaction-call/records')) return { items: [] };
    throw new Error('unexpected read: ' + path);
  },
};
const links = buildOggiLinks(buildShellNav({
  pipelines: [{ name: 'vendite', label: 'Vendite' }],
  customerDataAvailable: true,
  sequencesAvailable: true,
}));
const view = createOggiView({ doc: document, mount: document.getElementById('mount'), client, navigate: () => {} });
await view.render({ spaceName: 'Spazio locale', userName: 'Elena', links, now: new Date('2026-10-19T07:00:00.000Z') });
document.getElementById('probe').textContent = JSON.stringify({
  recap: document.body.textContent.includes('Oggi hai 2 appuntamenti'),
  tasks: (document.body.textContent.match(/Richiama per il preventivo|Prepara la call/g) ?? []).length,
});
document.title = 'oggi-ready';`;
    case 'clienti': return `
import { createCustomerListView } from './admin-clienti.js';
const ROWS = ${JSON.stringify(DEMO_CLIENTS)};
const MENUS = {
  views: [
    { id: 'tutti', label: 'Tutti' },
    { id: 'nuovi-lead', label: 'Nuovi lead' },
    { id: 'clienti-attivi', label: 'Clienti attivi' },
    { id: 'ricontattare-oggi', label: 'Da ricontattare oggi' },
    { id: 'rinnovi-30-giorni', label: 'Rinnovi entro 30 giorni' },
  ],
  sorts: [
    { id: 'recent', label: 'Ultimo contatto' },
    { id: 'name', label: 'Nome A-Z' },
    { id: 'value', label: 'Valore offerta' },
    { id: 'status', label: 'Stato' },
  ],
  columns: [
    { id: 'canali', label: 'Canali', always: false, ai: false, def: true },
    { id: 'stato', label: 'Stato', always: false, ai: false, def: true },
    { id: 'ultimo', label: 'Ultimo contatto', always: false, ai: false, def: true },
    { id: 'prossimo', label: 'Prossimo passo', always: false, ai: false, def: true },
    { id: 'email', label: 'Email', always: false, ai: false, def: false },
    { id: 'telefono', label: 'Telefono', always: false, ai: false, def: false },
    { id: 'offerta', label: 'Valore offerta', always: false, ai: false, def: false },
    { id: 'budget', label: 'Budget dichiarato', always: false, ai: true, def: false },
  ],
  pageSizes: [10, 25, 50],
};
const client = {
  async request(path) {
    if (path === '/api/schema') return { customerListContract: 1 };
    return { customerListContract: 1, items: ROWS, total: ROWS.length, page: 1, pageSize: 10, pages: 1, totalIsExact: true, ...MENUS };
  },
};
const store = { map: new Map(), getItem(k) { return this.map.get(k) ?? null; }, setItem(k, v) { this.map.set(k, v); } };
const view = createCustomerListView({ doc: document, mount: document.getElementById('mount'), client, storage: store, notify: () => {} });
await view.render();
document.getElementById('probe').textContent = JSON.stringify({
  rows: (document.body.textContent.match(/Marco Rossi|Anna Bianchi|Luca Verdi/g) ?? []).length,
});
document.title = 'clienti-ready';`;
    case 'cliente': return `
import { createCustomerCardView } from './admin-customer-card.js';
const CARD = ${JSON.stringify(DEMO_CARD)};
const TIMELINE = ${JSON.stringify(DEMO_TIMELINE)};
const PROFILE = ${JSON.stringify(DEMO_PROFILE)};
const client = {
  async request(path) {
    if (path.startsWith('/api/customer-hub/')) {
      if (path.includes('/card/')) return CARD;
      return TIMELINE;
    }
    if (path.startsWith('/api/customer-data/profile/')) return PROFILE;
    if (path.startsWith('/api/customer-data/enriched/')) {
      return { customerEnrichmentContract: 1, subject: { resource: 'contact', id: 'c1' }, linked: false, optedOut: null, items: [] };
    }
    if (path.startsWith('/api/call-intelligence/calls/')) return { calls: [] };
    throw new Error('unexpected request ' + path);
  },
};
await createCustomerCardView({ doc: document, mount: document.getElementById('mount'), client }).renderCard('contact', 'c1');
document.getElementById('probe').textContent = JSON.stringify({
  name: document.body.textContent.includes('Guido Presti'),
});
document.title = 'cliente-ready';`;
    case 'pipeline': return `
import { createPipelineBoard } from './admin-pipeline.js';
const PIPELINE = ${JSON.stringify(DEMO_PIPELINE)};
const DEALS = ${JSON.stringify(DEMO_DEALS)};
const client = {
  async request(path, options = {}) {
    if (path === '/api/schema') return { pipelineContract: 1, pipelines: [PIPELINE] };
    if (options.method === 'POST') return { ok: true };
    return { items: DEALS };
  },
};
const board = createPipelineBoard({ doc: document, mount: document.getElementById('mount'), client });
await board.renderBoard('b2b-sales');
document.getElementById('probe').textContent = JSON.stringify({
  deals: (document.body.textContent.match(/Palestra Esempio|Studio Aurora|Deal estero|Cliente vinto|Perso per budget/g) ?? []).length,
});
document.title = 'pipeline-ready';`;
    case 'calendario': return `
import { createCalendarioView } from './admin-calendario.js';
const WEEK = ${JSON.stringify(DEMO_WEEK)};
const SLOTS = ${JSON.stringify(DEMO_SLOTS)};
const client = {
  async request(path) {
    if (path.startsWith('/api/appointments/team-week')) return WEEK;
    if (path.startsWith('/api/appointments/suggest-slots')) {
      return { from: '', to: '', slotMinutes: 30, members: [{ teamMemberId: 'marco', slots: SLOTS }] };
    }
    throw new Error('unexpected ' + path);
  },
};
const byName = (inputName) => document.querySelector('input[name="' + inputName + '"]');
const click = (label) => [...document.querySelectorAll('button')].find((b) => b.textContent.includes(label)).click();
const view = createCalendarioView({
  doc: document,
  mount: document.getElementById('mount'),
  client,
  now: () => new Date('2026-10-25T10:00:00Z'),
});
await view.render();
byName('members').value = 'marco, sara';
byName('members').dispatchEvent(new Event('input', { bubbles: true }));
click('Mostra settimana');
await new Promise((r) => setTimeout(r, 100));
await new Promise((r) => setTimeout(r, 100));
byName('slotMember').value = 'marco';
byName('slotDay').value = '2026-10-22';
click('Trova slot');
await new Promise((r) => setTimeout(r, 100));
await new Promise((r) => setTimeout(r, 100));
const firstSlot = [...document.querySelectorAll('.cal-slots button')][0];
if (firstSlot) firstSlot.click();
await new Promise((r) => setTimeout(r, 100));
document.getElementById('probe').textContent = JSON.stringify({
  days: document.querySelectorAll('.cal-day').length,
  events: [...document.querySelectorAll('.cal-event strong')].map((n) => n.textContent),
});
document.title = 'calendario-ready';`;
    case 'sequenze': return `
import { createSequenzeView } from './admin-sequenze.js';
const SEQUENCES = ${JSON.stringify(DEMO_SEQUENCES)};
const STEPS = ${JSON.stringify(DEMO_SEQUENCE_STEPS)};
const ENROLLMENTS = ${JSON.stringify(DEMO_ENROLLMENTS)};
const SENDS = ${JSON.stringify(DEMO_SENDS)};
const client = {
  async request(path) {
    if (path === '/api/schema') return { domains: { sequences: { sequencesContract: 1 } } };
    if (path.includes('/sequence-step/')) return { items: STEPS.filter((s) => path.includes(encodeURIComponent(s.sequenceSourceKey)) || !path.includes('filter.sequenceSourceKey')) };
    if (path.includes('/sequence-enrollment/')) return { items: ENROLLMENTS };
    if (path.includes('/sequence-send/')) return { items: SENDS };
    if (path.includes('/sequence/')) return { items: SEQUENCES };
    throw new Error('unexpected ' + path);
  },
};
const view = createSequenzeView({ doc: document, mount: document.getElementById('mount'), client, spaceId: () => 'presti' });
await view.renderSequenze();
await new Promise((r) => setTimeout(r, 100));
await new Promise((r) => setTimeout(r, 100));
document.querySelector('button[data-open]').click();
await new Promise((r) => setTimeout(r, 100));
await new Promise((r) => setTimeout(r, 100));
await new Promise((r) => setTimeout(r, 100));
document.querySelector('button[data-action]').click();
await new Promise((r) => setTimeout(r, 100));
document.getElementById('probe').textContent = JSON.stringify({
  rows: document.querySelectorAll('.bo-seq-row').length,
  names: [...document.querySelectorAll('.bo-seq-name')].map((n) => n.textContent),
});
document.title = 'sequenze-ready';`;
    case 'reporting': return `
import { createReportingView } from './admin-reporting.js';
const MODEL = ${JSON.stringify(DEMO_REPORT)};
const BUNDLE_ROWS = [{ id: 'r1', metric: 'chiamate', period: '2026-10', value: 20, unit: 'call' }];
const client = {
  async request(path) {
    if (path.includes('/api/reporting/dashboard')) return MODEL;
    return { items: BUNDLE_ROWS };
  },
};
const view = createReportingView({ doc: document, mount: document.getElementById('mount'), client, navigate: () => {}, log: () => {}, download: () => {} });
await view.renderReporting();
document.getElementById('probe').textContent = JSON.stringify({
  kpis: (document.body.textContent.match(/Valore pipeline aperto|Preventivi aperti|Tasso di chiusura/g) ?? []).length,
});
document.title = 'reporting-ready';`;
    case 'personalizzazione': return `
import { createPersonalizzazioneView } from './admin-personalizzazione.js';
const UNITS = ${JSON.stringify(DEMO_UNITS)};
const ROWS = ${JSON.stringify(DEMO_PACKAGE_ROWS)};
const client = {
  async request(path, options = {}) {
    if (path === '/api/space-packages/catalog') return { units: UNITS };
    if (path.startsWith('/api/modules/space-package/records')) return { items: ROWS };
    if (path.startsWith('/api/space-packages/preview')) {
      return { headline: 'Canali: 1 riga. La Prova non scrive nulla.', counts: [{ module: 'channel-connection', count: 1 }], uncomposed: [], writes: 0 };
    }
    if (path.startsWith('/api/connectors?')) return { connectors: [] };
    throw new Error('unexpected request ' + path);
  },
};
const view = createPersonalizzazioneView({ doc: document, mount: document.getElementById('mount'), client, navigate: () => {}, spaceId: () => 'locale' });
// The shots prove the Connettori content (hero + prototype card sections),
// the screen the review compares against the prototype.
view.test.state.tab = 'connettori';
await view.render();
document.getElementById('probe').textContent = JSON.stringify({
  hero: document.body.textContent.includes('Kit social'),
  sections: (document.body.textContent.match(/Canali di conversazione|Agenda, lead e pagamenti/g) ?? []).length,
});
document.title = 'personalizzazione-ready';`;
    case 'catalogo': return `
import { createCatalogView } from './admin-catalog.js';
const MANUAL = ${JSON.stringify(DEMO_CATALOG)};
const SCHEMA = { commercial: { commercialContract: 1, discountPolicies: [{
  name: 'catalog-price-rules', version: 1, label: 'Catalog price rules',
  fingerprint: 'shot', config: { autoApproveMaxBps: 1000, ownerApprovalMaxBps: 3000, approvalKey: 'owner' },
}] } };
const client = {
  async request(path) {
    if (path === '/api/schema') return SCHEMA;
    if (path.startsWith('/api/catalog/products')) return MANUAL;
    throw new Error('unexpected ' + path);
  },
};
const view = createCatalogView({ doc: document, mount: document.getElementById('mount'), client });
await view.renderTable({});
document.getElementById('probe').textContent = JSON.stringify({
  table: document.querySelector('.catalog-list') ? document.querySelector('.catalog-list').textContent.slice(0, 60) : null,
});
document.title = 'catalogo-ready';`;
    case 'stato-sync': return `
import { createSyncView } from './admin-sync.js';
const ACTIVITY = ${JSON.stringify(DEMO_SYNC_ACTIVITY)};
const client = {
  async request(path, options = {}) {
    if (String(options.method ?? 'GET').toUpperCase() !== 'GET') {
      if (path === '/api/connectors/sync-now') return { pulled: 1 };
      throw new Error('unexpected mutation ' + path);
    }
    if (path === '/api/schema') return { domains: { channels: { metadata: { channelsContract: 1, adapters: [] } } } };
    if (path.startsWith('/api/connectors/activity')) return ACTIVITY;
    if (path.startsWith('/api/modules/data-quality-issue/records')) return { items: [] };
    if (path.startsWith('/api/modules/duplicate-candidate/records')) return { items: [] };
    throw new Error('unexpected GET ' + path);
  },
};
const storage = { getItem: () => 'locale', setItem: () => {}, removeItem: () => {} };
const view = createSyncView({ doc: document, mount: document.getElementById('mount'), client, storage, navigate: () => {}, toast: () => {} });
await view.render();
document.getElementById('probe').textContent = JSON.stringify({
  ok: document.body.textContent.includes('Tutto a posto'),
});
document.title = 'stato-sync-ready';`;
    case 'spazi-accessi': return `
import { createSpaziAccessiView } from './admin-spazi-accessi.js';
const SPACES = ${JSON.stringify(DEMO_SPACES)};
const MEMBERS = ${JSON.stringify(DEMO_MEMBERS)};
const client = {
  async request(path, options) {
    const opts = options || {};
    if (path === '/api/spine/context') {
      return { membership: { role: 'owner' }, roles: { owner: [], operator: [], observer: [] } };
    }
    if (path === '/api/spine/memberships' && String(opts.method || 'GET').toUpperCase() !== 'POST') {
      return { items: MEMBERS };
    }
    if (path.indexOf('/api/space-permissions/effective') === 0) {
      return { spaceId: 'spazio-1', overrides: [] };
    }
    throw new Error('unexpected ' + path);
  },
};
const view = createSpaziAccessiView({
  doc: document,
  mount: document.getElementById('mount'),
  client,
  spaces: function () { return SPACES; },
  activeSpaceId: function () { return 'spazio-1'; },
});
await view.render();
document.getElementById('probe').textContent = JSON.stringify({
  spaces: document.querySelectorAll('.bo-spazi-card').length,
  members: document.querySelectorAll('.bo-spazi-member').length,
});
document.title = 'spazi-accessi-ready';`;
    case 'componenti': return `
import { createUiCatalogView } from './admin-ui-catalog.js';
createUiCatalogView({ doc: document, mount: document.getElementById('mount') }).render();
document.getElementById('probe').textContent = JSON.stringify({
  sections: document.querySelectorAll('.ui-section').length,
  controls: document.querySelectorAll('button,select,input,textarea').length,
});
document.title = 'componenti-ready';`;
    default:
      throw new Error(`bo:shots has no harness for screen "${name}"`);
  }
}

// ---------------------------------------------------------------------------
// Harness pages and the loopback fixture server. The server only serves the
// repo's own static assets plus one generated harness page per screen: no
// proxy, no external fetch, so the run works fully offline.
// ---------------------------------------------------------------------------

const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
});

/**
 * The page Chromium opens for a screen: the static login page as-is, or a
 * harness that mounts the real view module with the demo fixtures.
 * @param {string} name
 * @param {string} publicDir
 */
export function harnessHtml(name, publicDir) {
  if (name === 'login') {
    return readFileSync(join(publicDir, 'login.html'), 'utf8');
  }
  const screen = SCREENS.find((entry) => entry.name === name);
  if (!screen || !screen.module) throw new Error(`bo:shots has no harness for screen "${name}"`);
  return `<!doctype html><html lang="it"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<link rel="stylesheet" href="/styles.css"></head>`
    + `<body><div id="mount"></div><div id="probe"></div>`
    + `<script type="module">${fixtureScript(name)}</script></body></html>`;
}

/**
 * Serves the public /bo assets and the harness pages on 127.0.0.1 only.
 * @param {string} publicDir
 * @param {(name: string) => string} pageFor
 */
function startServer(publicDir, pageFor) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://shot.test');
    const page = /^\/shot-([a-z-]+)\.html$/.exec(url.pathname);
    if (page) {
      try {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(pageFor(page[1]));
      } catch {
        res.writeHead(404);
        res.end('no');
      }
      return;
    }
    if (url.pathname === '/login.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(pageFor('login'));
      return;
    }
    const relative = normalize(url.pathname.replace(/^\/+/, ''));
    const file = join(publicDir, relative);
    const extension = relative.includes('.') ? `.${relative.split('.').pop()}` : '';
    if (relative === '' || relative.startsWith('..') || !file.startsWith(publicDir + sep)) {
      res.writeHead(404);
      res.end('no');
      return;
    }
    if (MIME[extension] && existsSync(file)) {
      res.writeHead(200, { 'content-type': MIME[extension] });
      res.end(readFileSync(file));
      return;
    }
    res.writeHead(404);
    res.end('no');
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function readDirSafe(directory) {
  try {
    return readdirSync(directory);
  } catch {
    return [];
  }
}

export function findChromium() {
  const candidates = [
    process.env.CHROMIUM_BIN,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  const bases = [
    join(homedir(), '.cache', 'ms-playwright'),
    join(homedir(), 'Library', 'Caches', 'ms-playwright'),
  ];
  for (const base of bases) {
    for (const entry of readDirSafe(base)) {
      for (const suffix of [
        ['chrome-headless-shell-mac-arm64', 'chrome-headless-shell'],
        ['chrome-headless-shell-mac-x64', 'chrome-headless-shell'],
        ['chrome-linux', 'headless_shell'],
      ]) {
        const path = join(base, entry, ...suffix);
        if (existsSync(path)) return path;
      }
    }
  }
  return null;
}

/**
 * A present binary is not a runnable one: sandboxed executors (and bare CI
 * images) carry the Playwright cache while the OS refuses Chromium's Mach
 * bootstrap, so every launch dies before painting. Probe once with a blank
 * page: only an exit-0 HTML dump counts as runnable.
 * @param {string | null} binary
 */
export function chromiumRuns(binary) {
  if (!binary) return false;
  try {
    const probe = spawnSync(binary, ['--headless', '--disable-gpu', '--dump-dom', 'about:blank'], {
      encoding: 'utf8',
      timeout: 60_000,
    });
    return probe.status === 0 && String(probe.stdout ?? '').includes('<html');
  } catch {
    return false;
  }
}

/**
 * The browser must run WITHOUT blocking this process: the fixture server
 * lives on the same event loop, so a synchronous spawn would starve it and
 * the page could never load. Async spawn keeps the loop free to serve.
 * @param {string} binary
 * @param {Array<string>} args
 * @param {number} timeoutMs
 */
function runChromium(binary, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`chromium timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

/**
 * Renders one screen at both viewports. Throws on the first failed proof:
 * a missing PNG, a wrong width, a too-small file (nothing painted), a
 * harness that never finished, or demo text missing from the painted DOM.
 * @param {{ binary: string, port: number, screen: object, outDir: string }} options
 */
async function renderScreen({ binary, port, screen, outDir }) {
  const page = screen.name === 'login'
    ? `http://127.0.0.1:${port}/login.html`
    : `http://127.0.0.1:${port}/shot-${screen.name}.html`;
  // Prove the page serves before launching anything, so a server failure
  // can never disguise itself as a passing render.
  const served = await fetch(page).then((response) => response.text());
  const marker = screen.module ?? 'login-magic';
  if (!served.includes(marker)) {
    throw new Error(`${screen.name}: the harness does not serve the real ${marker} markup`);
  }
  const shots = [];
  for (const [kind, viewport] of [['desktop', DESKTOP], ['phone', PHONE]]) {
    const file = join(outDir, `${screen.name}-${viewport.width}x${viewport.height}.png`);
    const run = await runChromium(binary, [
      '--headless',
      `--screenshot=${file}`,
      `--window-size=${viewport.width},${viewport.height}`,
      '--virtual-time-budget=8000',
      '--hide-scrollbars',
      '--disable-background-networking',
      page,
    ], 120000);
    if (run.status !== 0) {
      throw new Error(`${screen.name} ${kind}: chromium exits ${run.status} (stderr: ${(run.stderr ?? '').slice(-500)})`);
    }
    const dom = await runChromium(binary, [
      '--headless', '--dump-dom',
      `--window-size=${viewport.width},${viewport.height}`,
      '--virtual-time-budget=8000',
      '--disable-background-networking',
      page,
    ], 120000);
    if (dom.status !== 0) {
      throw new Error(`${screen.name} ${kind}: the probe run exits ${dom.status}`);
    }
    if (screen.ready !== null && !dom.stdout.includes(`<title>${screen.ready}</title>`)) {
      throw new Error(`${screen.name} ${kind}: the harness module did not run to completion (no ${screen.ready})`);
    }
    for (const expected of screen.expect) {
      if (!dom.stdout.includes(expected)) {
        throw new Error(`${screen.name} ${kind}: the painted screen misses its demo data (${JSON.stringify(expected)})`);
      }
    }
    if (!existsSync(file)) {
      throw new Error(`${screen.name} ${kind}: chromium exits ${run.status} without writing the screenshot`);
    }
    const shot = readPngSize(file);
    if (shot.width !== viewport.width || shot.height !== viewport.height) {
      throw new Error(`${screen.name} ${kind}: the PNG is ${shot.width}x${shot.height}, expected ${viewport.width}x${viewport.height}`);
    }
    const floor = kind === 'desktop' ? MIN_BYTES.desktop : MIN_BYTES.phone;
    if (shot.bytes < floor) {
      throw new Error(`${screen.name} ${kind}: the PNG holds ${shot.bytes} bytes, below the ${floor}-byte painted floor`);
    }
    shots.push({ file, width: shot.width, height: shot.height, bytes: shot.bytes, viewport: kind });
    console.log(`  ✓ ${screen.name} ${kind} ${shot.width}×${shot.height} ${shot.bytes} bytes`);
  }
  return shots;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`bo:shots: ${error.message}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  if (args.help) {
    console.log(USAGE);
    return;
  }
  const publicDir = join(process.cwd(), 'apps', 'admin', 'public');
  if (!existsSync(join(publicDir, 'styles.css')) || !existsSync(join(publicDir, 'login.html'))) {
    console.error('bo:shots: run from the agent-crm checkout root (apps/admin/public not found).');
    process.exitCode = 1;
    return;
  }
  const binary = findChromium();
  if (!chromiumRuns(binary)) {
    console.log('Skipping bo:shots: no runnable Chromium found (set CHROMIUM_BIN to override).');
    return;
  }
  const wanted = args.screen ?? null;
  const screens = SCREENS.filter((screen) => wanted === null || screen.name === wanted);
  const outDir = args.out;
  mkdirSync(outDir, { recursive: true });
  const server = await startServer(publicDir, (name) => harnessHtml(name, publicDir));
  const address = server.address();
  if (!address || typeof address !== 'object') {
    console.error('bo:shots: the fixture server did not listen on 127.0.0.1.');
    process.exitCode = 1;
    server.close();
    return;
  }
  const manifest = [];
  try {
    for (const screen of screens) {
      const shots = await renderScreen({ binary, port: address.port, screen, outDir });
      for (const shot of shots) manifest.push({ screen: screen.name, ...shot });
    }
  } catch (error) {
    console.error(`bo:shots: ${error.message}`);
    process.exitCode = 1;
    server.close();
    return;
  }
  server.close();
  writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify({ generatedAt: new Date().toISOString(), shots: manifest }, null, 2)}\n`);
  console.log(`\n${manifest.length} PNG(s) in ${outDir}`);
}

// Importing this module (the committed tests do) never starts the run:
// under node:test, process.argv[1] is the test file, not this script.
const isMain = process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(`bo:shots: ${error?.message ?? error}`);
    process.exitCode = 1;
  });
}

