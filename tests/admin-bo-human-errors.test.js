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
import { createAssistantPanel } from '../apps/admin/public/admin-assistant.js';
import { loadOggiData } from '../apps/admin/public/admin-oggi.js';
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
      text.includes('This list could not be read, so it is not shown.')
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
  // healthy import form labels its textarea 'Rows (JSON):', a static format
  // name that trips the blanket parenthesized-code heuristic without
  // leaking anything. What must never render is the server's error.
  for (const marker of TECHNICAL_MARKERS) {
    assert.ok(!text.includes(marker), `customer-data leaks technical detail ${JSON.stringify(marker)}`);
  }
  assert.ok(!text.includes(NASTY_MESSAGE), 'customer-data renders the raw server message');
  assert.ok(!text.includes('(BOOM)'), 'customer-data renders the parenthesized error code');
  assert.ok(
    text.includes('This list could not be read, so it is not shown.'),
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
