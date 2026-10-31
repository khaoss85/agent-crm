// @ts-check

/**
 * Backoffice "regola per tutte le schermate" (backlog:9da124e5).
 *
 * What the supervisor saw in production on 2026-10-27 with the owner's real
 * session: Catalogo rendered `Catalogo non leggibile: Operation not found:
 * manual catalog`, Spazi e accessi rendered `Il team non si è potuto leggere
 * (NOT_FOUND)`, and Personalizzazione named the `space-permissions` package.
 * A customer never sees technical errors: no error codes, no package names,
 * no npm commands, no docs paths — every failed read answers a human text
 * with a retry, and the technical detail stays in the console.
 *
 * This file walks every customer-visible read view with failing reads and
 * fails when any rendered text leaks the technical detail.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createCatalogView } from '../apps/admin/public/admin-catalog.js';
import { createSpaziAccessiView } from '../apps/admin/public/admin-spazi-accessi.js';
import { createCustomerDataView } from '../apps/admin/public/admin-customer-data.js';
import { createCustomerListView } from '../apps/admin/public/admin-clienti.js';
import { createCalendarioView } from '../apps/admin/public/admin-calendario.js';
import { createPipelineBoard } from '../apps/admin/public/admin-pipeline.js';
import {
  createSequenzeView,
  loadSequenzeData,
} from '../apps/admin/public/admin-sequenze.js';
import { createReportingView } from '../apps/admin/public/admin-reporting.js';
import { createPersonalizzazioneView } from '../apps/admin/public/admin-personalizzazione.js';
import { createSyncView } from '../apps/admin/public/admin-sync.js';
import { createCustomerCardView } from '../apps/admin/public/admin-customer-card.js';
import { createConnectorsView } from '../apps/admin/public/admin-connectors.js';
import { createConnectorDetailView } from '../apps/admin/public/admin-connector-detail.js';
import { createQuoteView } from '../apps/admin/public/admin-quotes.js';
import { createWorkView } from '../apps/admin/public/admin-work.js';
import { createMarketingView } from '../apps/admin/public/admin-marketing.js';
import { createSpineView } from '../apps/admin/public/admin-spine.js';
import { createModuleAdmin } from '../apps/admin/public/admin-modules.js';
import { createAssistantPanel, runSuggestion } from '../apps/admin/public/admin-assistant.js';
import { loadOggiData, renderOggi } from '../apps/admin/public/admin-oggi.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';

/** Technical detail the production screens leaked: never rendered, only logged. */
const TECHNICAL_MARKERS = Object.freeze([
  'Operation not found',
  'manual catalog',
  'space-permissions',
  'registro metriche',
  'NOT_FOUND',
  'SPINE_',
  'UNKNOWN',
  'npm run',
  'docs/',
  'node_modules',
]);

const NASTY_MESSAGE =
  'Operation not found: manual catalog (manca il pacchetto space-permissions, vedi docs/setup.md, npm run verify)';

function opFail(message = NASTY_MESSAGE, code = 'NOT_FOUND', status = 404) {
  return Object.assign(new Error(message), { code, status });
}

/** Generic server failure: no 404, so no "not composed" branch may catch it. */
function failingClient() {
  return { async request() { throw opFail(NASTY_MESSAGE, 'BOOM', 500); } };
}

/** The backend answers 404: the view must say "not composed", never the code. */
function missingClient() {
  return { async request() { throw opFail(); } };
}

async function flush(rounds = 30) {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => { setImmediate(resolve); });
}

function checkHumanText(text, where) {
  assert.ok(typeof text === 'string' && text.length > 0, `${where} renders something`);
  for (const marker of TECHNICAL_MARKERS) {
    assert.ok(!text.includes(marker), `${where} leaks technical detail ${JSON.stringify(marker)}`);
  }
  assert.ok(!text.includes(NASTY_MESSAGE), `${where} renders the raw server message`);
  assert.ok(!/\([A-Z0-9_]{3,}\)/.test(text), `${where} renders a parenthesized error code`);
}

const memStore = () => {
  const map = new Map();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => { map.set(k, v); } };
};

test('catalogo: a failed read never renders the operation error', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createCatalogView({ doc, mount, client: failingClient() });
  await view.renderTable({});
  await flush();
  const text = mount.textContent;
  checkHumanText(text, 'catalogo');
  assert.ok(text.includes('Catalogo prodotti'), 'the screen still names itself');
});

test('spazi e accessi: team and switches failures never render codes', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createSpaziAccessiView({
    doc,
    mount,
    client: failingClient(),
    navigate: () => {},
    spaces: () => [{ id: 'spazio-1', name: 'Negozio', initials: 'NE' }],
    activeSpaceId: () => 'spazio-1',
    toast: () => {},
  });
  await view.render();
  await flush();
  const text = mount.textContent;
  checkHumanText(text, 'spazi e accessi');
  assert.ok(text.includes('Spazi di lavoro'), 'the screen still names itself');
});

test('personalizzazione: a failed catalog read renders a human error with retry, not an empty list', async () => {
  // A 500 is not an empty catalog: the screen says so in human words and
  // offers a retry. checkHumanText alone would stay green on the silent
  // 'Nessun risultato' empty state, so presence is asserted, not just
  // absence of technical markers.
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createPersonalizzazioneView({
    doc,
    mount,
    client: failingClient(),
    navigate: () => {},
    spaceId: () => 'spazio-1',
  });
  // The catalog-backed tabs: Skill AI and Pacchetti read the catalog, so a
  // failed read lands there (the Connettori tab owns its own state).
  view.test.state.tab = 'pacchetti';
  await view.render();
  await flush();
  const text = mount.textContent;
  checkHumanText(text, 'personalizzazione');
  assert.ok(
    text.includes('La personalizzazione non si è potuta leggere. Riprova più tardi.'),
    'the failed read says so in human words',
  );
  assert.ok(!text.includes('Nessun risultato'), 'a failed read is never an empty list');
  assert.ok(!text.includes('Prova a cambiare ricerca'), 'a failed read never suggests searching');
  const retry = mount.findAll('button').find((node) => node.textContent === 'Riprova');
  assert.ok(retry, 'the failed read offers a retry');
});

test('personalizzazione: a catalog outage never hides the connectors directory', async () => {
  const connectorsOk = {
    async request(path) {
      if (path === '/api/space-packages/catalog') throw opFail(NASTY_MESSAGE, 'BOOM', 500);
      if (path.startsWith('/api/modules/space-package/records')) return { items: [] };
      if (path.startsWith('/api/connectors')) {
        return { connectors: [{ name: 'instagram', state: 'connected' }] };
      }
      throw opFail(NASTY_MESSAGE, 'BOOM', 500);
    },
  };
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createPersonalizzazioneView({
    doc,
    mount,
    client: connectorsOk,
    navigate: () => {},
    spaceId: () => 'spazio-1',
  });
  view.test.state.tab = 'connettori';
  await view.render();
  await flush();
  const text = mount.textContent;
  checkHumanText(text, 'personalizzazione');
  assert.ok(!text.includes('non si è potuta leggere'), 'the connectors tab is not blocked by the catalog');
});

test('personalizzazione: the retry reloads the catalog after a failure', async () => {
  let catalogCalls = 0;
  const flaky = {
    async request(path) {
      if (path === '/api/space-packages/catalog') {
        catalogCalls += 1;
        if (catalogCalls === 1) throw opFail(NASTY_MESSAGE, 'BOOM', 500);
        return { units: [] };
      }
      if (path.startsWith('/api/modules/space-package/records')) return { items: [] };
      if (path.startsWith('/api/connectors')) return { connectors: [] };
      throw opFail(NASTY_MESSAGE, 'BOOM', 500);
    },
  };
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createPersonalizzazioneView({
    doc,
    mount,
    client: flaky,
    navigate: () => {},
    spaceId: () => 'spazio-1',
  });
  view.test.state.tab = 'pacchetti';
  await view.render();
  await flush();
  assert.ok(
    mount.textContent.includes('La personalizzazione non si è potuta leggere. Riprova più tardi.'),
    'the first read fails loudly',
  );
  const retry = mount.findAll('button').find((node) => node.textContent === 'Riprova');
  assert.ok(retry, 'the failed read offers a retry');
  retry.dispatch('click');
  await flush();
  assert.ok(
    !mount.textContent.includes('La personalizzazione non si è potuta leggere.'),
    'the retry clears the error once the catalog reads',
  );
});

test('personalizzazione: the not-composed note never names the package', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createPersonalizzazioneView({
    doc,
    mount,
    client: missingClient(),
    navigate: () => {},
    spaceId: () => 'spazio-1',
  });
  await view.render();
  await flush();
  const text = mount.textContent;
  checkHumanText(text, 'personalizzazione');
  assert.ok(
    text.includes('non composta in questo progetto'),
    'the 404 names the state, never the package',
  );
});

test('clienti: a failed list read never renders the server message', async () => {
  for (const client of [failingClient(), missingClient()]) {
    const doc = createFakeDocument();
    const mount = createMount();
    const view = createCustomerListView({
      doc,
      mount,
      client,
      storage: memStore(),
      notify: () => {},
    });
    await view.render();
    await flush();
    checkHumanText(mount.textContent, 'clienti');
  }
});

test('customer-data: schema, list and profile failures never render the message', async () => {
  for (const failing of [
    failingClient(),
    {
      async request(path) {
        if (path === '/api/schema') return { modules: {} };
        throw opFail();
      },
    },
  ]) {
    const doc = createFakeDocument();
    const mount = createMount();
    const view = createCustomerDataView({
      doc,
      mount,
      client: failing,
      navigate: () => {},
      notify: () => {},
      spaceId: 'spazio-1',
      storage: memStore(),
    });
    await view.render();
    await flush();
    const text = mount.textContent;
    checkHumanText(text, 'customer-data');
    assert.ok(
      text.includes('Questa lista non si è potuta leggere')
        || text.includes('non composto')
        || text.includes('non si è potuto leggere'),
      'a failed customer-data read says so in human words, never silently',
    );
    assert.ok(
      !text.includes('(la lettura non è riuscita)'),
      'no parenthesized Italian fragment inside the English sentence',
    );
  }
  // The failing module rows carry their own retry, not just a note. The
  // schema composes here, so the section reaches rowsOf with failing rows.
  const rowsFail = {
    async request(path) {
      if (path === '/api/schema') return { domains: { 'customer-data': { metadata: {} } } };
      throw opFail();
    },
  };
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createCustomerDataView({
    doc,
    mount,
    client: rowsFail,
    navigate: () => {},
    notify: () => {},
    spaceId: 'spazio-1',
    storage: memStore(),
  });
  await view.render();
  await flush();
  const text = mount.textContent;
  // Targeted leak assertions instead of the blanket checkHumanText: the
  // healthy import form labels its textarea 'Righe (JSON):', a static format
  // name that trips the blanket parenthesized-code heuristic without
  // leaking anything. What must never render is the server's error.
  for (const marker of TECHNICAL_MARKERS) {
    assert.ok(!text.includes(marker), `customer-data leaks technical detail ${JSON.stringify(marker)}`);
  }
  assert.ok(!text.includes(NASTY_MESSAGE), 'customer-data renders the raw server message');
  assert.ok(!text.includes('(BOOM)'), 'customer-data renders the parenthesized error code');
  assert.ok(
    text.includes('Questa lista non si è potuta leggere e non viene mostrata.'),
    'an unreadable module list says so in a full sentence',
  );
  const retry = mount.findAll('button').find((node) => node.getAttribute('data-action') === 'retry-customer-data-list');
  assert.ok(retry, 'an unreadable customer-data list offers a retry');
});

test('calendario: a failed week read never renders the message', async () => {
  for (const client of [failingClient(), missingClient()]) {
    const doc = createFakeDocument();
    const mount = createMount();
    const view = createCalendarioView({
      doc,
      mount,
      client,
      now: () => new Date('2026-10-27T10:00:00Z'),
    });
    await view.render();
    await flush();
    const filter = mount.findAll('input').find((node) => node.getAttribute('name') === 'members');
    filter.value = 'marco';
    const button = mount.findAll('button').find((node) => node.textContent === 'Mostra settimana');
    button.dispatch('click');
    await flush();
    checkHumanText(mount.textContent, 'calendario');
  }
});

test('pipeline: a failed board read never renders the message', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const board = createPipelineBoard({ doc, mount, client: failingClient() });
  await board.renderBoard('b2b-sales');
  await flush();
  checkHumanText(mount.textContent, 'pipeline');
});

test('sequenze: failed reads fail closed with flags, never with text', async () => {
  const outcome = await loadSequenzeData(failingClient(), 'spazio-1');
  assert.equal(outcome.sequencesAvailable, false, 'sequenze stay unavailable');
  const text = JSON.stringify(outcome);
  checkHumanText(text, 'sequenze data');
});

test('reporting: failed dashboard and rows stay human', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createReportingView({
    doc,
    mount,
    client: failingClient(),
    navigate: () => {},
  });
  await view.renderReporting();
  await flush();
  const text = mount.textContent;
  checkHumanText(text, 'reporting');
  assert.ok(text.includes('Riprova più tardi'), 'reporting keeps its retry invite');
});

test('stato sync: a failed load never renders message or code', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const toasts = [];
  const view = createSyncView({
    doc,
    mount,
    client: failingClient(),
    storage: { getItem: () => 'spazio-1', setItem: () => {}, removeItem: () => {} },
    navigate: () => {},
    toast: (message, isError = false) => toasts.push({ message, isError }),
  });
  await view.render();
  await flush();
  checkHumanText(mount.textContent, 'stato sync');
  for (const { message } of toasts) checkHumanText(String(message), 'stato sync toast');
});

test('scheda cliente: a failed card read never renders the message', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createCustomerCardView({
    doc,
    mount,
    client: failingClient(),
    navigate: () => {},
    spaceId: 'spazio-1',
  });
  await view.renderCard('customer', 'c1');
  await flush();
  checkHumanText(mount.textContent, 'scheda cliente');
});

test('connettori: a failed load never renders message or code', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createConnectorsView({
    doc,
    mount,
    client: failingClient(),
    navigate: () => {},
    storage: { getItem: () => 'spazio-1', setItem: () => {}, removeItem: () => {} },
  });
  await view.render();
  await flush();
  checkHumanText(mount.textContent, 'connettori');
});

test('preventivi: a failed quote read never renders the message', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createQuoteView({ doc, mount, client: failingClient() });
  await view.renderQuoteDetail('q1');
  await flush();
  checkHumanText(mount.textContent, 'preventivi');
});

test('lavoro: a failed queue read never renders the message', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createWorkView({ doc, mount, client: failingClient(), navigate: () => {} });
  await view.renderQueue();
  await flush();
  checkHumanText(mount.textContent, 'lavoro');
});

test('proposte: a failed proposal list never renders the message', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createMarketingView({ doc, mount, client: failingClient(), navigate: () => {} });
  await view.renderProposalList();
  await flush();
  checkHumanText(mount.textContent, 'proposte');
});

test('identità e accessi: a failed spine read never renders the message', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  await createSpineView({ doc, mount, client: failingClient() }).render();
  await flush();
  checkHumanText(mount.textContent, 'identità e accessi');
});

test('nuovo modulo: a failed bundle list never renders the message', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createModuleAdmin({
    doc,
    mount,
    client: failingClient(),
    navigate: () => {},
    storage: memStore(),
  });
  await view.renderList('partner');
  await flush();
  checkHumanText(mount.textContent, 'nuovo modulo');
});

test('dettaglio connettore: a failed load never renders the message', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createConnectorDetailView({
    doc,
    mount,
    client: failingClient(),
    storage: { getItem: () => 'spazio-1', setItem: () => {}, removeItem: () => {} },
    navigate: () => {},
  });
  await view.render('whatsapp');
  await flush();
  checkHumanText(mount.textContent, 'dettaglio connettore');
});

test('assistente: a failed backend probe never renders the message', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const panel = createAssistantPanel({
    doc,
    mount,
    client: failingClient(),
    navigate: () => {},
    notify: () => {},
  });
  await panel.open('clienti');
  await flush();
  checkHumanText(mount.textContent, 'assistente');
});

test('oggi: failed reads fail closed with flags, never with text', async () => {
  const outcome = await loadOggiData(failingClient(), new Date('2026-10-27T09:00:00+01:00'));
  assert.equal(outcome.workAvailable, false, 'follow-up stay unavailable');
  assert.equal(outcome.appointmentsAvailable, false, 'calendar stays unavailable');
  assert.equal(outcome.channelsAvailable, false, 'channels stay unavailable');
  checkHumanText(JSON.stringify(outcome), 'oggi data');
});

test('sequenze view: a failed read never renders the message', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createSequenzeView({
    doc,
    mount,
    client: failingClient(),
    submissions: { submit: async () => { throw opFail(); } },
    storage: memStore(),
    spaceId: 'spazio-1',
  });
  await view.renderSequenze();
  await flush();
  checkHumanText(mount.textContent, 'sequenze view');
});

/**
 * Backoffice "niente inglese tecnico in pagina" (backlog:de45d1b1).
 *
 * What the supervisor saw in production on 2026-10-28: inside the customer
 * sheet an English block about contact import and merge, and on Nuovo modulo
 * technical bundle-verify sentences. None of the listed phrases may appear
 * in any rendered /bo view. The views that carry the phrases in their
 * healthy state mount healthy (customer-data with the server still sending
 * its English metadata, nuovo modulo, the assistant guide, spine); every
 * other view mounts with failing reads, which still renders all its static
 * chrome (oggi renders its frame directly, the same static chrome the router
 * paints). If any phrase reappears anywhere, this test fails.
 */
const LISTED_BO_PHRASES = Object.freeze([
  'a preview writes nothing at all — not a business record, not an import run',
  'Mapping customer-rows@1',
  'at most 500 rows',
  'the mapping fingerprint',
  'partial — keep the good rows, receipt the rest',
  'Deciding these is a human judgement. Linking is a logical canonical merge: nothing is deleted.',
  'What this does not do',
  'Matching is exact only',
  'No warehouse, no activation and no external system is written',
  'Deciding here requires a signed-in user actor',
  'None of this is a GDPR, consent, retention or erasure claim',
  'bundle verify avvia',
]);

const listedSweepMeta = () => ({
  customerDataContract: 1,
  records: [],
  import: {
    mapping: { name: 'customer-rows', version: 1, fingerprint: 'a'.repeat(64) },
    maxRows: 500,
    acceptance: ['partial', 'all_or_nothing'],
    preview: 'a preview writes nothing at all — not a business record, not an import run',
    idempotency: 'derived from the system, the mapping fingerprint and the sorted row digests',
  },
  deferred: { track: 'Customer Data Operations v2', items: ['global search'] },
});

function listedSweepCustomerDataClient() {
  return {
    async request(path, options = {}) {
      if (path === '/api/schema') {
        return { domains: { 'customer-data': { metadata: listedSweepMeta() } } };
      }
      if (path.startsWith('/api/customer-data/profile/')) {
        return {
          subject: { resource: 'contact', id: 'c1' },
          identity: {}, canonicalIdentity: { linked: false, members: [] },
          externalIdentities: [], dataQualityIssues: [],
        };
      }
      if (options.method === 'POST') {
        if (path === '/api/customer-data/import/preview') {
          return {
            mode: 'preview', runId: null,
            writes: 'nothing — this is a preview, and it records neither business data nor an import run',
            counts: { rows: 1, accepted: 1, rejected: 0, skipped: 0 },
            receipts: [{ index: 0, outcome: 'accepted', reasonCode: 'CREATED_RECORD', reason: 'ok' }],
          };
        }
        return { ok: true, result: {} };
      }
      return { items: [] };
    },
  };
}

function listedSweepSpineClient() {
  return {
    async request(path, options = {}) {
      if (options.method === 'POST') return { ok: true };
      if (path === '/api/spine/context') {
        return {
          spineContract: 1, mode: 'production', warning: null,
          tenantStrategy: 'one-tenant-per-instance',
          boundTenant: { slug: 'tenant-a' },
          tenantIsolation: { crmDataPlaneEnforced: true, sharedDatabaseMultiTenancy: false },
          roles: { owner: ['records.read'] }, permissions: [],
          identity: { kind: 'verified-user', subject: 'alice', issuer: 'issuer', method: 'oidc' },
          organization: { name: 'Tenant A', slug: 'tenant-a' },
          membership: { role: 'viewer' },
          limitations: [], notModeled: [],
        };
      }
      if (path === '/api/spine/memberships') return { items: [] };
      return {};
    },
  };
}

test('le frasi elencate non appaiono in nessuna vista montata', async () => {
  const texts = [];
  const collect = (name, text) => texts.push([name, String(text ?? '')]);
  const fresh = () => ({ doc: createFakeDocument(), mount: createMount() });

  // The customer-data section mounts healthy while the server still sends
  // its English metadata: the view must render its own Italian copy.
  {
    const { doc, mount } = fresh();
    const view = createCustomerDataView({
      doc, mount, client: listedSweepCustomerDataClient(),
      navigate: () => {}, notify: () => {}, spaceId: 'spazio-1', storage: memStore(),
    });
    await view.render();
    await flush();
    // Since backlog:5b164ab5 the tool loads a CSV file, not a JSON field:
    // the sweep walks the same file flow the operator walks.
    const fileInput = mount.findAll('input').find((node) => node.getAttribute('name') === 'file');
    assert.ok(fileInput, 'the customer-data sweep finds the file control');
    fileInput.files = [{
      name: 'clienti.csv',
      async arrayBuffer() {
        return new TextEncoder().encode('nome,email\nAda,a@b.example').buffer;
      },
    }];
    fileInput.dispatch('change');
    await new Promise((resolve) => setTimeout(resolve, 20));
    mount.findAll('button').find((node) => node.getAttribute('data-action') === 'preview-customer-import').dispatch('click');
    await new Promise((resolve) => setTimeout(resolve, 20));
    collect('dati clienti', mount.textContent);
    await view.renderProfile('contact', 'c1');
    await flush();
    collect('profilo cliente', mount.textContent);
  }

  // Nuovo modulo mounts healthy; the assistant guide answers as text.
  {
    const { doc, mount } = fresh();
    createReportingView({ doc, mount, client: { request: async () => ({ items: [] }) }, navigate: () => {}, onAskAi: () => {} }).renderNuovoModulo();
    await flush();
    collect('nuovo modulo', mount.textContent);
    const answer = await runSuggestion({ request: async () => ({}) }, 'bo05:nuovo-modulo:crea-ai');
    collect('assistente nuovo modulo', answer.lines.join(' '));
  }

  // Spine mounts healthy: its limits block shares one listed heading.
  {
    const { doc, mount } = fresh();
    await createSpineView({ doc, mount, client: listedSweepSpineClient() }).render();
    await flush();
    collect('identità e accessi', mount.textContent);
  }

  // Every other mounted view, with failing reads: the static chrome renders.
  const failingMounts = [
    ['oggi', async (doc, mount) => {
      renderOggi({
        doc, mount, spaceName: 'Spazio di prova', userName: 'Elena',
        links: [{ id: 'clienti', label: 'Clienti', route: '#/customer-data' }],
        navigate: () => {}, now: new Date('2026-10-27T09:00:00+01:00'),
      });
    }],
    ['catalogo', async (doc, mount) => { await createCatalogView({ doc, mount, client: failingClient() }).renderTable({}); }],
    ['spazi e accessi', async (doc, mount) => {
      await createSpaziAccessiView({
        doc, mount, client: failingClient(), navigate: () => {},
        spaces: () => [{ id: 'spazio-1', name: 'Negozio', initials: 'NE' }],
        activeSpaceId: () => 'spazio-1', toast: () => {},
      }).render();
    }],
    ['personalizzazione', async (doc, mount) => {
      await createPersonalizzazioneView({
        doc, mount, client: failingClient(), navigate: () => {}, spaceId: () => 'spazio-1',
      }).render();
    }],
    ['clienti', async (doc, mount) => {
      await createCustomerListView({ doc, mount, client: failingClient(), storage: memStore(), notify: () => {} }).render();
    }],
    ['calendario', async (doc, mount) => {
      await createCalendarioView({ doc, mount, client: failingClient(), now: () => new Date('2026-10-27T10:00:00Z') }).render();
    }],
    ['pipeline', async (doc, mount) => { await createPipelineBoard({ doc, mount, client: failingClient() }).renderBoard('b2b-sales'); }],
    ['reporting', async (doc, mount) => {
      await createReportingView({ doc, mount, client: failingClient(), navigate: () => {} }).renderReporting();
    }],
    ['stato sync', async (doc, mount) => {
      await createSyncView({
        doc, mount, client: failingClient(),
        storage: { getItem: () => 'spazio-1', setItem: () => {}, removeItem: () => {} },
        navigate: () => {}, toast: () => {},
      }).render();
    }],
    ['scheda cliente', async (doc, mount) => {
      await createCustomerCardView({ doc, mount, client: failingClient(), navigate: () => {}, spaceId: 'spazio-1' }).renderCard('customer', 'c1');
    }],
    ['connettori', async (doc, mount) => {
      await createConnectorsView({
        doc, mount, client: failingClient(), navigate: () => {},
        storage: { getItem: () => 'spazio-1', setItem: () => {}, removeItem: () => {} },
      }).render();
    }],
    ['dettaglio connettore', async (doc, mount) => {
      await createConnectorDetailView({
        doc, mount, client: failingClient(),
        storage: { getItem: () => 'spazio-1', setItem: () => {}, removeItem: () => {} },
        navigate: () => {},
      }).render('whatsapp');
    }],
    ['preventivi', async (doc, mount) => { await createQuoteView({ doc, mount, client: failingClient() }).renderQuoteDetail('q1'); }],
    ['lavoro', async (doc, mount) => { await createWorkView({ doc, mount, client: failingClient(), navigate: () => {} }).renderQueue(); }],
    ['proposte', async (doc, mount) => { await createMarketingView({ doc, mount, client: failingClient(), navigate: () => {} }).renderProposalList(); }],
    ['nuovo modulo (elenco)', async (doc, mount) => {
      await createModuleAdmin({ doc, mount, client: failingClient(), navigate: () => {}, storage: memStore() }).renderList('partner');
    }],
    ['assistente', async (doc, mount) => {
      await createAssistantPanel({ doc, mount, client: failingClient(), navigate: () => {}, notify: () => {} }).open('clienti');
    }],
    ['sequenze vista', async (doc, mount) => {
      await createSequenzeView({
        doc, mount, client: failingClient(),
        submissions: { submit: async () => { throw opFail(); } },
        storage: memStore(), spaceId: 'spazio-1',
      }).renderSequenze();
    }],
  ];
  for (const [name, mountIt] of failingMounts) {
    const { doc, mount } = fresh();
    await mountIt(doc, mount);
    await flush();
    collect(name, mount.textContent);
  }
  collect('sequenze dati', JSON.stringify(await loadSequenzeData(failingClient(), 'spazio-1')));
  collect('oggi dati', JSON.stringify(await loadOggiData(failingClient(), new Date('2026-10-27T09:00:00+01:00'))));

  assert.ok(texts.length > 20, `the sweep covers every mounted view, got ${texts.length}`);
  for (const [name, text] of texts) {
    assert.ok(text.length > 0, `${name} renders something`);
    for (const phrase of LISTED_BO_PHRASES) {
      assert.ok(!text.includes(phrase), `${name} renders the listed phrase ${JSON.stringify(phrase)}`);
    }
  }
});
