import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccordoApp } from '../packages/app/src/index.js';
import { createHttpServer } from '../apps/server/src/index.js';
import { createModuleAdmin } from '../apps/admin/public/admin-modules.js';
import { writePendingCustomerPick } from '../apps/admin/public/admin-prefill.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

/**
 * Voce 1d99c8207f90 («Nuova offerta»: niente «OPPORTUNITY» in inglese).
 * The dedicated offer screen already reads Italian on main (kicker
 * «Offerta», title «Nuova offerta», crumb via moduleScreenLabel — covered
 * by tests/admin-italian-formats.test.js). This file makes the second
 * acceptance criterion observable: it renders the real «Nuova offerta»
 * screen, both with a scheda pick and without, and scans every visible
 * string (text, placeholders, aria labels) for English labels, so a raw
 * module key or an English fallback can never come back unnoticed.
 */

function startServer(t, configure) {
  const app = createAccordoApp({ dbPath: ':memory:' });
  configure(app);
  const server = createHttpServer(app);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const baseUrl = `http://127.0.0.1:${port}`;
      t.after(async () => {
        await new Promise((r) => server.close(r));
        app.close();
      });
      resolve({ app, baseUrl });
    });
  });
}

function clientFor(baseUrl) {
  return {
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      const response = await fetch(`${baseUrl}${path}`, {
        ...options,
        headers: { 'content-type': 'application/json', 'x-actor-type': 'user', 'x-actor-id': 'admin-ui', ...(options.headers || {}) },
      });
      const text = await response.text();
      const payload = text === '' ? null : JSON.parse(text);
      if (!response.ok) {
        const error = new Error(payload?.error?.message || `failed ${response.status}`);
        Object.assign(error, { status: response.status, code: payload?.error?.code, details: payload?.error?.details });
        throw error;
      }
      return payload;
    },
  };
}

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
  };
}

const ACTOR = { type: 'user', id: 'admin-ui' };

/** English words no «Nuova offerta» string may read, in any branch or hint. */
const ENGLISH_SCREEN = /\b(opportunit(?:y|ies)|compan(?:y|ies)|contacts?|create[sd]?|creating|loading|save[sd]?|submit(?:ted)?|retr(?:y|ies)|required|invalid|fail(?:ed|s)?|errors?|values?|owners?|delete[sd]?|cancel(?:led)?|edit(?:ed|ing)?|success(?:ful)?|update[sd]?|records?|fields?|forms?|later|please|enter|select|choose|missing|wrong)\b/i;

/** Every string the operator reads: text plus the shown input attributes. */
function visibleStrings(mount) {
  const out = [mount.textContent];
  for (const tag of ['input', 'select', 'textarea', 'button']) {
    for (const node of mount.findAll(tag)) {
      for (const attr of ['placeholder', 'aria-label', 'title']) {
        const value = node.getAttribute(attr);
        if (typeof value === 'string' && value !== '') out.push(value);
      }
    }
  }
  return out;
}

function assertNoEnglish(mount, where) {
  for (const text of visibleStrings(mount)) {
    assert.ok(!ENGLISH_SCREEN.test(text), `${where}: English label «${text}»`);
  }
}

test('1d99c8207f90: the rendered «Nuova offerta» screen reads Italian, never «OPPORTUNITY»', async (t) => {
  const { app, baseUrl } = await startServer(t, () => {});
  const company = await app.services.companies.create({ name: 'Palestra Esempio' }, { actor: ACTOR });
  const contact = await app.services.contacts.create({
    companyId: company.id, firstName: 'Guido', lastName: 'Presti', email: 'guido@palestra-esempio.it',
  }, { actor: ACTOR });

  const storage = memoryStorage();
  assert.equal(writePendingCustomerPick(storage, 'offer', {
    resource: 'contact', id: contact.id, name: 'Guido Presti',
    company: { id: company.id, name: 'Palestra Esempio' },
  }), true);
  const doc = createFakeDocument();
  const mount = createMount();
  const admin = createModuleAdmin({ doc, mount, client: clientFor(baseUrl), navigate: () => {}, storage });

  await admin.renderNew('opportunity');
  const kicker = mount.findByText('p', 'Offerta');
  assert.ok(kicker, 'the kicker names the record in Italian');
  assert.ok(mount.findByText('h2', 'Nuova offerta'), 'the title is «Nuova offerta»');
  assert.ok(mount.findByText('button', 'Crea offerta'), 'the submit reads «Crea offerta»');
  assert.ok(mount.textContent.includes('Cliente: Guido Presti'), 'the picked customer is named');
  assertNoEnglish(mount, 'with a scheda pick');
});

test('1d99c8207f90: «Nuova offerta» without a pick reads Italian in every branch', async (t) => {
  const { app, baseUrl } = await startServer(t, () => {});
  await app.services.companies.create({ name: 'Palestra Esempio' }, { actor: ACTOR });
  const doc = createFakeDocument();
  const mount = createMount();
  const admin = createModuleAdmin({ doc, mount, client: clientFor(baseUrl), navigate: () => {}, storage: memoryStorage() });

  await admin.renderNew('opportunity');
  assert.ok(mount.textContent.includes('Nuova offerta'), 'the offer screen paints');
  assert.ok(mount.findByText('button', 'Crea offerta'), 'the submit reads «Crea offerta»');
  assertNoEnglish(mount, 'choosing the customer in the form');
});

test('1d99c8207f90: «Nuova offerta» with no customers reads Italian, never an empty choice', async (t) => {
  const { baseUrl } = await startServer(t, () => {});
  const doc = createFakeDocument();
  const mount = createMount();
  const admin = createModuleAdmin({ doc, mount, client: clientFor(baseUrl), navigate: () => {}, storage: memoryStorage() });

  await admin.renderNew('opportunity');
  assert.ok(mount.textContent.includes('Nuova offerta'), 'the offer screen paints');
  assertNoEnglish(mount, 'with no customers yet');
});
