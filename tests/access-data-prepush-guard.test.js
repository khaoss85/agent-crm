// @ts-check
/**
 * backlog:1395b971 — guardia pre-push: invarianti di accesso e dati.
 *
 * Quattro P1 arrivati alla review Muse su codice nuovo tra il 25 e il
 * 26/11, su invarianti già noti. Ogni prova inchioda l'invariante sul seam
 * condiviso: verde su main, rossa sulla copia col difetto nominata.
 *
 * - 6acf0a73bfc3 (agent-crm#1154): lo spaceId della serie non arriva mai
 *   dall'input — vale solo lo spazio della serie salvata (o nessuno).
 * - 30f7ce51c87a (agent-crm#1088): la mutazione generica su una prenotazione
 *   privata altrui risponde 404, mai 403 (stesso hunk di c53cd033, riusato
 *   qui; #1088 si ribasa sopra questa guardia tenendo il suo test esteso).
 * - 4eec2e48b3a3 (agent-crm#1161): la riga azienda-sola vive nelle viste
 *   attive anche quando l'azienda ha solo contatti archiviati.
 * - 573a1e85942f (agent-crm#1162): un annullo con scope spinge una sola
 *   volta, e la chiave spinta è quella della testa della serie.
 *
 * Uso: `npm run guard:access-data` (anche come
 * `--guard 'npm run guard:access-data'` di install-prepush.sh).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bookAppointment,
  cancelAppointment,
} from '../packages/appointments/src/appointments.js';
import { createAccordoApp } from '../packages/app/src/index.js';
import { listCustomerRecords } from '../packages/customer-data/src/operations.js';
import { NotFoundError } from '../packages/core/index.js';

const ACTOR = { type: 'user', id: 'guardia' };
const SUBJECT = { resource: 'contact', id: 'c-presti', owner: 'host' };
const SOURCE = { package: 'host', action: 'book' };

const single = (overrides = {}) => ({
  sourceKey: 'gym:singola:1',
  subject: SUBJECT,
  teamMemberId: 'coach-guido',
  serviceKey: 'pt-single',
  priceCents: 4000,
  currency: 'EUR',
  startsAt: '2026-11-17T16:00:00.000Z',
  endsAt: '2026-11-17T17:00:00.000Z',
  source: SOURCE,
  ...overrides,
});

function fakeAppointments(seed = []) {
  const rows = seed.map((row, index) => ({ id: `a-${index + 1}`, ...row }));
  return {
    rows,
    async listWhere(where) {
      return rows.filter((row) => Object.entries(where).every(([key, value]) => row[key] === value));
    },
    async createManaged(row) {
      const stored = { id: `a-${rows.length + 1}`, ...row };
      rows.push(stored);
      return stored;
    },
    async applyManaged(id, patch) {
      const row = rows.find((candidate) => candidate.id === id);
      if (!row) throw new NotFoundError(`appointment ${id} not found`);
      Object.assign(row, patch);
      return row;
    },
    async get(id) {
      const row = rows.find((candidate) => candidate.id === id);
      if (!row) throw new NotFoundError(`appointment ${id} not found`);
      return row;
    },
  };
}

const contextFor = (service, extra = {}) => ({
  modules: {
    get: (name) => {
      if (name === 'appointment') return { service };
      throw new NotFoundError(`module ${name} not found`);
    },
  },
  actor: ACTOR,
  now: () => '2026-11-10T09:00:00.000Z',
  consumer: 'host',
  followUps: null,
  ...extra,
});

test('6acf0a73bfc3: una singola con serie e spazio altrui non attribuisce righe a quello spazio', async () => {
  const service = fakeAppointments([{
    sourceKey: 'gym:serie:9:r1',
    seriesKey: 'serie-altra',
    spaceId: 'spazio-vittima',
    teamMemberId: 'coach-altro',
    status: 'booked',
    startsAt: '2026-11-18T16:00:00.000Z',
    endsAt: '2026-11-18T17:00:00.000Z',
    actorId: 'altri',
    visibility: 'default',
  }]);
  const result = await bookAppointment(
    contextFor(service),
    single({ seriesKey: 'serie-altra', spaceId: 'spazio-estraneo' }),
  );
  assert.equal(result.appointment.sourceKey, 'gym:singola:1');
  // Lo spazio salvato non è mai quello dichiarato dal chiamante: o manca
  // (main prima della cura #1154) o è quello della serie salvata (dopo).
  assert.notEqual(result.appointment.spaceId ?? null, 'spazio-estraneo');
  assert.ok(
    service.rows.every((row) => (row.spaceId ?? null) !== 'spazio-estraneo'),
    'no stored row may carry the caller-claimed space',
  );
});

const PRIVATE_ROW = Object.freeze({
  id: 'a-priv',
  status: 'booked',
  startsAt: '2026-11-20T17:00:00.000Z',
  endsAt: '2026-11-20T18:00:00.000Z',
  teamMemberId: 'coach-guido',
  visibility: 'private',
  actorId: 'creator-A',
  subjectResource: 'contact',
  subjectId: 'c-presti',
  serviceKey: 'pt-single',
  priceCents: 4000,
  currency: 'EUR',
  sourceKey: 'gym:mutation:1',
  sourcePackage: 'host',
});

// Il finto server di backlog:30f7ce51 (test esteso in agent-crm#1088):
// stessa forma, solo i due percorsi che la guardia inchioda.
function stubApp() {
  const calls = [];
  const rows = [{ ...PRIVATE_ROW }];
  const appointment = {
    name: 'appointment',
    kind: 'generated',
    manifestVersion: 1,
    capabilities: ['create', 'get', 'list', 'update'],
    fields: [{ name: 'notes', type: 'string', required: false, unique: false }],
    filterableFields: ['id', 'status', 'teamMemberId', 'startsAt'],
    service: {
      async list({ limit, where } = {}) {
        calls.push({ method: 'list', limit, where });
        return rows.filter((row) => !where
          || Object.entries(where).every(([key, value]) => String(row[key]) === String(value)));
      },
      async get(id) {
        return rows.find((row) => row.id === id) ?? null;
      },
      async update(id, input) {
        calls.push({ method: 'update', id, input });
        const index = rows.findIndex((row) => row.id === id);
        if (index < 0) throw new Error('update ran on a missing row');
        rows[index] = { ...rows[index], ...input };
        return rows[index];
      },
    },
  };
  return {
    calls,
    modules: {
      get(name) {
        if (name === 'appointment') return appointment;
        throw new Error(`unknown module ${name}`);
      },
      list() {
        return [appointment];
      },
    },
    actions: {
      listForModule() {
        return [];
      },
    },
    async runAction(input) {
      calls.push({ method: 'runAction', input });
      return { ok: true, recordId: input.recordId };
    },
  };
}

async function withServer(app, fn) {
  const { createHttpServer } = await import('../apps/server/src/index.js');
  const server = createHttpServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const as = (actorId) => ({
  'x-actor-type': 'user',
  'x-actor-id': actorId,
  'content-type': 'application/json',
  connection: 'close',
});

test('30f7ce51c87a: PATCH generica su prenotazione privata altrui risponde 404, mai 403, e non scrive', async () => {
  const app = stubApp();
  await withServer(app, async (base) => {
    const response = await fetch(`${base}/api/modules/appointment/records/a-priv`, {
      method: 'PATCH',
      headers: as('teammate-B'),
      body: JSON.stringify({ notes: 'prova a sovrascrivere' }),
    });
    assert.equal(response.status, 404, 'a private booking must read as not-found, not forbidden');
    assert.equal((await response.json())?.error?.code, 'NOT_FOUND');
    assert.deepEqual(
      app.calls.filter((call) => call.method === 'update'),
      [],
      'the refused write must never run',
    );
    const missing = await fetch(`${base}/api/modules/appointment/records/a-missing`, {
      method: 'PATCH',
      headers: as('teammate-B'),
      body: JSON.stringify({ notes: 'x' }),
    });
    assert.equal(missing.status, 404, 'a missing row and a private row answer alike');
    assert.equal((await missing.json())?.error?.code, 'NOT_FOUND');
  });
});

test('30f7ce51c87a: azione generica su prenotazione privata altrui risponde 404 e non gira', async () => {
  const app = stubApp();
  await withServer(app, async (base) => {
    const response = await fetch(`${base}/api/modules/appointment/records/a-priv/actions/cancel`, {
      method: 'POST',
      headers: as('teammate-B'),
      body: JSON.stringify({ reason: 'prova' }),
    });
    assert.equal(response.status, 404, 'a private booking must read as not-found, not forbidden');
    assert.equal((await response.json())?.error?.code, 'NOT_FOUND');
    assert.deepEqual(
      app.calls.filter((call) => call.method === 'runAction'),
      [],
      'the refused action must never run',
    );
  });
});

test('4eec2e48b3a3: la vista attiva mostra la riga azienda anche con soli contatti archiviati', async (t) => {
  const app = createAccordoApp({ dbPath: ':memory:' });
  t.after(() => app.close());
  const archivedCo = await app.services.companies.create({ name: 'Solo Archiviati' });
  const archived = await app.services.contacts.create({
    companyId: archivedCo.id, firstName: 'Archiviato', lastName: 'Uno', email: 'archiviato-uno@esempio.it',
  });
  await app.services.contacts.archive(archived.id, { actor: ACTOR });
  const liveCo = await app.services.companies.create({ name: 'Attivi' });
  const live = await app.services.contacts.create({
    companyId: liveCo.id, firstName: 'Attivo', lastName: 'Uno', email: 'attivo-uno@esempio.it',
  });
  const match = (rows, filters) => rows.filter((row) => Object.entries(filters)
    .every(([key, value]) => (Array.isArray(value) ? value.includes(row?.[key]) : row?.[key] === value)));
  const exact = (rows) => ({ listWhere: async (filters) => match(rows, filters) });
  const base = {
    modules: {
      get: (name) => {
        if (name === 'contact') return { service: app.services.contacts };
        if (name === 'company') return { service: app.services.companies };
        if (name === 'interaction-message') return { service: exact([]) };
        if (name === 'interaction-call') return { service: exact([]) };
        throw Object.assign(new Error(`Unknown module ${name}`), { code: 'MODULE_NOT_FOUND' });
      },
    },
    core: {},
    names: {},
  };
  const page = await listCustomerRecords(base, {});
  assert.ok(
    page.items.some((item) => item.contact?.id === live.id),
    'the active contact is still listed',
  );
  assert.ok(
    page.items.every((item) => item.contact?.id !== archived.id),
    'no archived row leaks into the active view',
  );
  assert.ok(
    page.items.some((item) => item.contact === null && item.company?.id === archivedCo.id),
    'the company-only row stays visible while its contacts are all archived',
  );
});

test('573a1e85942f: annullo con scope spinge una sola volta, la chiave della testa', async () => {
  const head = {
    sourceKey: 'gym:serie:7:r1', seriesKey: 'gym:serie:7', occurrenceIndex: 0,
    status: 'booked', teamMemberId: 'coach-guido', visibility: 'default', actorId: 'guardia',
  };
  const tail = {
    sourceKey: 'gym:serie:7:r2', seriesKey: 'gym:serie:7', occurrenceIndex: 1,
    status: 'booked', teamMemberId: 'coach-guido', visibility: 'default', actorId: 'guardia',
  };
  const pushes = [];
  const service = fakeAppointments([head, tail]);
  const calendarSync = {
    async pushAppointment(calendarId, sourceKey, options) {
      pushes.push({ calendarId, sourceKey, spaceId: options?.spaceId ?? null });
      return { ok: true };
    },
  };
  const result = await cancelAppointment(
    contextFor(service, { calendarSync }),
    {
      sourceKey: 'gym:serie:7:r1', scope: 'all', reason: 'serie annullata',
      calendar: { calendarId: 'cal-1' }, spaceId: 'spazio-1',
    },
  );
  assert.equal(result.cancelled, true, 'the head is cancelled');
  assert.equal(pushes.length, 1, 'one cancellation, one push — never one per occurrence');
  assert.equal(pushes[0].sourceKey, 'gym:serie:7:r1', 'the push names the head key, never a later occurrence');
});
