import test from 'node:test';
import assert from 'node:assert/strict';
import { WORKBOOK_REFUSAL } from '../apps/admin/public/admin-import-file.js';
import { createCustomerDataView } from '../apps/admin/public/admin-customer-data.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';

/**
 * The Clienti import tool flow (backlog:5b164ab5): header, breadcrumb,
 * file load, column mapping and the table preview.
 *
 * What it must prove: the page reads like the rest of the /bo («← Clienti»,
 * the clickable «Presti Group / Clienti / Importa» path), a CSV loads and its
 * columns are matched to the customer fields, the preview is a table with an
 * Italian outcome per row, workbooks are refused honestly, and no English or
 * technical sentence reaches the screen.
 */

const META = {
  customerDataContract: 1,
  records: ['customer-import-run', 'customer-import-row', 'external-identity',
    'duplicate-candidate', 'canonical-link', 'data-quality-issue'],
  import: {
    mapping: { name: 'customer-rows', version: 1, fingerprint: 'a'.repeat(64) },
    maxRows: 500,
    acceptance: ['partial', 'all_or_nothing'],
    preview: 'a preview writes nothing at all — not a business record, not an import run',
    idempotency: 'derived from the system, the mapping fingerprint and the sorted row digests; never a clock or a random value',
  },
  deferred: { track: 'Customer Data Operations v2', items: ['global search', 'saved views', 'physical merge'] },
};

const PREVIEW_RECEIPTS = [
  { index: 0, outcome: 'accepted', reasonCode: 'CREATED_RECORD', reason: 'no existing record matched', matchRule: 'none' },
  { index: 1, outcome: 'rejected', reasonCode: 'INVALID_EMAIL', reason: 'the email is not a valid address shape', matchRule: 'none' },
];

const APPLY_RECEIPTS = [
  { index: 0, outcome: 'accepted', reasonCode: 'CREATED_RECORD', reason: 'no existing record matched', matchRule: 'none', subject: { resource: 'person', id: 'p-ada' } },
  { index: 1, outcome: 'rejected', reasonCode: 'INVALID_EMAIL', reason: 'the email is not a valid address shape', matchRule: 'none', subject: null },
];

const PHONE_RECEIPTS = [
  { index: 0, outcome: 'accepted', reasonCode: 'CREATED_RECORD', reason: 'ok', matchRule: 'none', subject: { resource: 'person', id: 'p-ada' } },
];

function stubClient(overrides = {}) {
  const calls = [];
  const mainReceipts = overrides.mainReceipts ?? APPLY_RECEIPTS;
  const phoneReceipts = overrides.phoneReceipts ?? PHONE_RECEIPTS;
  return {
    calls,
    async request(path, options = {}) {
      calls.push({ path, method: options.method ?? 'GET', body: options.body });
      if (path === '/api/schema') {
        return { domains: { 'customer-data': { metadata: META } } };
      }
      if (options.method === 'POST' && path === '/api/customer-data/import/preview') {
        return {
          mode: 'preview', runId: null,
          counts: { rows: 2, accepted: 1, rejected: 1, skipped: 0 },
          receipts: PREVIEW_RECEIPTS,
        };
      }
      if (options.method === 'POST' && path === '/api/customer-data/import/apply') {
        const body = JSON.parse(options.body);
        if (body.system === 'phone') {
          return {
            counts: { rows: phoneReceipts.length, accepted: phoneReceipts.length, rejected: 0, skipped: 0 },
            receipts: phoneReceipts,
          };
        }
        return {
          counts: { rows: mainReceipts.length, accepted: 1, rejected: 1, skipped: 0 },
          receipts: mainReceipts,
        };
      }
      return { items: [] };
    },
  };
}

const CSV = 'nome,email,telefono\nAda,ada@esempio.it,+39 333 1234567\nBo,,+39 333 0000000\n';

const fakeFile = (name, text) => ({
  name,
  async arrayBuffer() {
    return new TextEncoder().encode(text).buffer;
  },
});

const renderTool = async (client, overrides = {}) => {
  const navigated = [];
  const doc = createFakeDocument();
  const mount = createMount();
  await createCustomerDataView({
    doc,
    mount,
    client,
    navigate: (hash) => { navigated.push(hash); },
    notify: () => {},
    spaceName: 'Presti Group',
    ...overrides,
  }).render();
  return { doc, mount, navigated };
};

const loadCsv = async (mount, name = 'clienti.csv', text = CSV) => {
  const input = mount.findAll('input').find((node) => node.getAttribute('name') === 'file');
  assert.ok(input, 'the file control renders');
  input.files = [fakeFile(name, text)];
  input.dispatch('change');
  await new Promise((resolve) => setTimeout(resolve, 20));
};

const byText = (mount, tag, text) =>
  mount.findAll(tag).find((node) => node.textContent === text) ?? null;

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

test('the page reads like the rest of the /bo: back link, kicker, title, crumb', async () => {
  const { mount, navigated } = await renderTool(stubClient());
  const crumb = mount.findAll('nav').find((node) => node.getAttribute('aria-label') === 'Percorso');
  assert.ok(crumb, 'a breadcrumb nav renders');
  assert.ok(crumb.textContent.includes('Presti Group'), 'the workspace names itself');
  assert.ok(crumb.textContent.includes('Clienti'), 'the list is named');
  assert.ok(crumb.textContent.includes('Importa'), 'the current page is named');
  const clientiLink = crumb.findAll('a').find((node) => node.textContent === 'Clienti');
  assert.ok(clientiLink, 'Clienti is a link');
  assert.equal(clientiLink.getAttribute('href'), '#/customer-data');
  assert.equal(crumb.findAll('span').find((node) => node.getAttribute('aria-current') === 'page')?.textContent, 'Importa');

  const back = byText(mount, 'button', '← Clienti');
  assert.ok(back, 'the scheda-style back link renders on top');
  back.dispatch('click');
  assert.deepEqual(navigated, ['#/customer-data']);

  assert.ok(byText(mount, 'p', 'Clienti'), 'the kicker reads Clienti');
  assert.ok(byText(mount, 'h1', 'Importa clienti'), 'the title reads Importa clienti');
});

test('a CSV loads, its columns are matched, and the check is a table', async () => {
  const { mount } = await renderTool(stubClient());
  await loadCsv(mount);
  const text = mount.textContent;
  assert.ok(text.includes('File «clienti.csv»: 2 righe, 3 colonne.'), `the loaded file is named, got: ${text.slice(0, 400)}`);
  assert.ok(text.includes('2. Abbina le colonne'), 'step two renders');
  assert.ok(text.includes('3. Controlla e importa'), 'step three renders');

  const mapping = [0, 1, 2].map((index) =>
    mount.findAll('select').find((node) => node.getAttribute('name') === `mapping-${index}`));
  assert.ok(mapping.every(Boolean), 'one mapping control per column');
  assert.deepEqual(mapping.map((node) => node.value), ['firstName', 'email', 'phone'], 'headers are guessed');

  const table = mount.findAll('table')[0];
  assert.ok(table, 'the check is a table');
  assert.deepEqual(
    table.findAll('th').map((node) => node.textContent),
    ['Nome', 'Email', 'Telefono', 'Esito'],
  );
  const cells = table.findAll('td').map((node) => node.textContent);
  assert.ok(cells.includes('Ada'), 'values render as table cells');
  assert.ok(cells.includes('ada@esempio.it'));
});

test('the preview fills one Italian outcome per row and sends the mapped rows', async () => {
  const client = stubClient();
  const { mount } = await renderTool(client);
  await loadCsv(mount);

  const preview = mount.findAll('button').find((node) => node.getAttribute('data-action') === 'preview-customer-import');
  preview.dispatch('click');
  await tick();

  const table = mount.findAll('table')[0];
  const esiti = table.findAll('td').filter((node) => node.getAttribute('class') === 'bo-import-esito')
    .map((node) => node.textContent);
  assert.ok(mount.textContent.includes('L\u2019anteprima non scrive nulla:'));

  const posted = client.calls.filter((call) => call.method === 'POST'
    && call.path === '/api/customer-data/import/preview').at(-1);
  assert.ok(posted, 'the preview was sent');
  const body = JSON.parse(posted.body);
  assert.equal(body.system, 'clienti', 'the origin defaults to the file name');
  assert.deepEqual(body.rows, [
    { firstName: 'Ada', email: 'ada@esempio.it' },
    { firstName: 'Bo' },
  ], 'only the matched fields travel; the phone rides apart');
});

test('applying registers the import and links the phones, then says so', async () => {
  const client = stubClient();
  const { mount } = await renderTool(client);
  await loadCsv(mount);

  mount.findAll('button').find((node) => node.getAttribute('data-action') === 'preview-customer-import').dispatch('click');
  await tick();
  mount.findAll('button').find((node) => node.getAttribute('data-action') === 'apply-customer-import').dispatch('click');
  await tick();

  const posts = client.calls.filter((call) => call.method === 'POST'
    && call.path === '/api/customer-data/import/apply');
  assert.equal(posts.length, 2, 'main rows plus the phone batch');
  assert.deepEqual(JSON.parse(posts[1].body), {
    system: 'phone',
    rows: [{ externalId: '+393331234567', email: 'ada@esempio.it' }],
    acceptance: 'partial',
  });
  const text = mount.textContent;
  assert.ok(text.includes('Importazione registrata: 1 accettate, 1 scartate, 0 da decidere.'), text.slice(0, 600));
  assert.ok(text.includes('Telefoni: 1 collegati su 1.'), 'the phone batch is reported');
  assert.ok(text.includes('1 telefoni senza email non si collegano.'), 'the unlinked phone is counted, not dropped silently');

  // The mapping survives the apply: the operator keeps working from it.
  const mapping = mount.findAll('select').find((node) => node.getAttribute('name') === 'mapping-0');
  assert.equal(mapping?.value, 'firstName');
});

test('a phone is never sent for a row the main import rejected', async () => {
  const csv = 'nome,email,telefono\nAda,ada@esempio.it,+39 333 1234567\nZed,zed@esempio.it,+39 333 9999999\n';
  const client = stubClient({
    mainReceipts: [
      { index: 0, outcome: 'accepted', reasonCode: 'CREATED_RECORD', reason: 'ok', matchRule: 'none', subject: { resource: 'person', id: 'p-ada' } },
      { index: 1, outcome: 'rejected', reasonCode: 'INVALID_DOMAIN', reason: 'bad domain', matchRule: 'none', subject: null },
    ],
  });
  const { mount } = await renderTool(client);
  await loadCsv(mount, 'clienti.csv', csv);
  mount.findAll('button').find((node) => node.getAttribute('data-action') === 'apply-customer-import').dispatch('click');
  await tick();

  const posts = client.calls.filter((call) => call.method === 'POST'
    && call.path === '/api/customer-data/import/apply');
  assert.equal(posts.length, 2, 'main rows plus the phone batch');
  assert.deepEqual(JSON.parse(posts[1].body).rows, [
    { externalId: '+393331234567', email: 'ada@esempio.it' },
  ], 'the rejected row lends no phone to the batch');
  assert.ok(mount.textContent.includes('1 telefoni scartati insieme alla loro riga.'), mount.textContent.slice(0, 600));
});

test('a phone accepted under another customer is not counted as linked', async () => {
  const csv = 'nome,email,telefono\nAda,ada@esempio.it,+39 333 1234567\n';
  const client = stubClient({
    mainReceipts: [
      { index: 0, outcome: 'accepted', reasonCode: 'CREATED_RECORD', reason: 'ok', matchRule: 'none', subject: { resource: 'person', id: 'p-ada' } },
    ],
    phoneReceipts: [
      { index: 0, outcome: 'accepted', reasonCode: 'CREATED_RECORD', reason: 'ok', matchRule: 'none', subject: { resource: 'person', id: 'p-other' } },
    ],
  });
  const { mount } = await renderTool(client);
  await loadCsv(mount, 'clienti.csv', csv);
  mount.findAll('button').find((node) => node.getAttribute('data-action') === 'apply-customer-import').dispatch('click');
  await tick();

  const text = mount.textContent;
  assert.ok(text.includes('Telefoni: 0 collegati su 1.'), text.slice(0, 600));
  assert.ok(text.includes("già collegati a un'altra scheda"), 'the conflict is named, never counted as linked');
});

test('no phone batch is sent when every row is rejected', async () => {
  const csv = 'nome,email,telefono\nAda,ada@esempio.it,+39 333 1234567\n';
  const client = stubClient({
    mainReceipts: [
      { index: 0, outcome: 'rejected', reasonCode: 'INVALID_DOMAIN', reason: 'bad domain', matchRule: 'none', subject: null },
    ],
  });
  const { mount } = await renderTool(client);
  await loadCsv(mount, 'clienti.csv', csv);
  mount.findAll('button').find((node) => node.getAttribute('data-action') === 'apply-customer-import').dispatch('click');
  await tick();

  const posts = client.calls.filter((call) => call.method === 'POST'
    && call.path === '/api/customer-data/import/apply');
  assert.equal(posts.length, 1, 'the phone batch is skipped when nothing was accepted');
  assert.ok(mount.textContent.includes('Nessun telefono collegato: le righe con telefono sono state scartate.'));
});

test('a changed column clears a preview that belongs to another mapping', async () => {
  const { mount } = await renderTool(stubClient());
  await loadCsv(mount);
  mount.findAll('button').find((node) => node.getAttribute('data-action') === 'preview-customer-import').dispatch('click');
  await tick();
  assert.ok(mount.textContent.includes('accettata · scheda creata'));

  const select = mount.findAll('select').find((node) => node.getAttribute('name') === 'mapping-1');
  select.value = 'ignore';
  select.dispatch('change');
  await tick();
  assert.ok(!mount.textContent.includes('accettata · scheda creata'), 'the stale outcomes are gone');
});

test('a workbook is refused with the honest line', async () => {
  const { mount } = await renderTool(stubClient());
  await loadCsv(mount, 'clienti.xlsx', 'finto');
  const error = mount.findAll('small').find((node) => (node.getAttribute('class') ?? '').includes('customer-data-error'));
  assert.equal(error?.textContent, WORKBOOK_REFUSAL);
});

test('no English or technical sentence reaches the screen', async () => {
  const client = stubClient();
  const { mount } = await renderTool(client);
  await loadCsv(mount);
  mount.findAll('button').find((node) => node.getAttribute('data-action') === 'preview-customer-import').dispatch('click');
  await tick();
  const text = mount.textContent;
  for (const banned of [
    'customer-rows', 'JSON', 'mapping', 'fingerprint', 'CDP', 'customer data platform',
    'Customer Data Operations', 'global search', 'physical merge',
    'INVALID_', 'MISSING_', 'UNSAFE_', 'DUPLICATE_', 'AMBIGUOUS_', 'MATCHED_', 'CREATED_',
    'accepted', 'rejected', 'skipped', 'preview writes', 'the mapping', 'keep the good',
    'the email is not', 'no existing record', 'the free-text', 'row carries',
  ]) {
    assert.ok(!text.includes(banned), `no technical or English on screen, found: ${banned}`);
  }
});
