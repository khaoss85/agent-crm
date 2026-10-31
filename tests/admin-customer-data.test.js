import test from 'node:test';
import assert from 'node:assert/strict';
import { CUSTOMER_DATA_DISCLAIMERS, createCustomerDataView } from '../apps/admin/public/admin-customer-data.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';

/**
 * The Customer Data Foundation Admin section, against a stub server.
 *
 * What it must prove: the section disappears entirely without the package, the
 * limits render as content in every state, a preview says plainly that it wrote
 * nothing, a human decision cannot be made without a reason, and the profile
 * renders an absent package as **not available** rather than as zero.
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

const CANDIDATE = {
  id: 'cand1', status: 'unresolved',
  leftResource: 'company', leftId: 'co1', leftLabel: 'Globex Srl',
  rightResource: 'company', rightId: 'co2', rightLabel: 'Globex Srl',
  rule: 'company-name-domain', evidence: '2 existing companies share this normalized name and domain',
};
const ISSUE = { id: 'iss1', status: 'open', kind: 'invalid_email', evidence: 'import row 3 carried an email that is not a valid address shape' };
const RUN = { id: 'run1', system: 'crm-export', rowCount: 5, acceptedCount: 3, rejectedCount: 1, skippedCount: 1, acceptance: 'partial' };

function stubClient({ withPackage = true, rows = {}, profile = null, onPost = () => {}, unreadableModules = false } = {}) {
  const calls = [];
  return {
    calls,
    async request(path, options = {}) {
      calls.push({ path, method: options.method ?? 'GET', body: options.body });
      if (path === '/api/schema') {
        return withPackage ? { domains: { 'customer-data': { metadata: META } } } : { domains: {} };
      }
      if (path.startsWith('/api/customer-data/profile/')) {
        if (!profile) throw Object.assign(new Error('no profile'), { status: 404 });
        return profile;
      }
      if (options.method === 'POST' && path === '/api/customer-data/import/preview') {
        onPost(path, options);
        return {
          mode: 'preview', runId: null,
          writes: 'nothing — this is a preview, and it records neither business data nor an import run',
          counts: { rows: 2, accepted: 1, rejected: 1, skipped: 0 },
          receipts: [
            { index: 0, outcome: 'accepted', reasonCode: 'CREATED_RECORD', reason: 'no existing record matched', matchRule: 'none' },
            { index: 1, outcome: 'rejected', reasonCode: 'INVALID_EMAIL', reason: 'the email is not a valid address shape', matchRule: 'none' },
          ],
        };
      }
      if (options.method === 'POST') { onPost(path, options); return { ok: true, result: {} }; }
      const module = /\/api\/modules\/([^/]+)\/records/.exec(path)?.[1];
      if (unreadableModules) throw new Error('the server is unreachable');
      const table = { 'customer-import-run': [RUN], 'duplicate-candidate': [CANDIDATE], 'data-quality-issue': [ISSUE], ...rows };
      return { items: table[module] ?? [] };
    },
  };
}

const render = async (client) => {
  const doc = createFakeDocument();
  const mount = createMount();
  await createCustomerDataView({ doc, mount, client }).render();
  return mount;
};

const byClass = (mount, className) =>
  ['div', 'p', 'input', 'button', 'select', 'small', 'textarea', 'a', 'h4']
    .flatMap((tag) => mount.findAll(tag))
    .find((node) => (node.getAttribute('class') ?? '') === className) ?? null;

test('an absent package says so in human words instead of a blank screen', async () => {
  const mount = await render(stubClient({ withPackage: false }));
  assert.ok(mount.textContent.includes('non composto'), 'the view says the package is not composed');
  // backlog:9da124e5 — no package name reaches the customer.
  assert.ok(!mount.textContent.includes('customer-data'), 'the view never names the missing package');
  assert.equal(byClass(mount, 'customer-data-section'), null);
});

test('every limit renders as content, in the ordinary state', async () => {
  const mount = await render(stubClient());
  const text = mount.textContent;
  for (const sentence of CUSTOMER_DATA_DISCLAIMERS) {
    assert.ok(text.includes(sentence), `missing verbatim limit: ${sentence.slice(0, 50)}…`);
  }
  // The deferred track has one home, and it reads in Italian: the import is
  // an operator tool, not a developer surface (backlog:273de560).
  assert.ok(text.includes('Altri strumenti in arrivo: ricerca globale, viste salvate, unione delle schede.'));
  assert.ok(text.includes('ricerca globale'));
  assert.ok(!text.includes('Customer Data Operations v2'), 'no English program name on the surface');
  assert.ok(!text.includes('global search'), 'no English roadmap item on the surface');
  // The server still describes the import in English (META.import): the
  // view renders its own Italian copy and never the raw server text.
  assert.ok(!text.includes(META.import.preview), 'the raw server preview text never renders');
  assert.ok(!text.includes('the mapping fingerprint'), 'the raw server mapping text never renders');
  assert.ok(!text.includes('keep the good rows'), 'the raw server acceptance text never renders');
  // No CDP claim anywhere on the surface.
  assert.doesNotMatch(text, /\bCDP\b/i, 'the Admin must never call this a CDP');
  assert.doesNotMatch(text, /customer data platform/i);
});

test('the import tool flow lives in its own suite now', async () => {
  // backlog:5b164ab5: the JSON textarea is gone — loading, mapping and the
  // table preview are covered by tests/admin-import-clienti.test.js.
  const mount = await render(stubClient());
  assert.equal(mount.findAll('textarea').length, 0, 'no JSON textarea on the import screen');
  assert.ok(mount.findAll('input').some((node) => node.getAttribute('name') === 'file'), 'the file control renders');
});

test('a list that could not be read says so, and never renders as zero', async () => {
  const client = stubClient({ unreadableModules: true });
  const doc = createFakeDocument();
  const mount = createMount();
  await createCustomerDataView({ doc, mount, client }).render();
  const text = mount.textContent;

  for (const label of ['Importazioni', 'Possibili doppioni', 'Qualità dei dati']) {
    assert.ok(text.includes(`${label} (non leggibile)`), `${label} must not claim a count it does not have`);
  }
  assert.ok(text.includes('Non è detto che sia vuota.'));
  assert.doesNotMatch(text, /Importazioni \(0\)/);
  assert.doesNotMatch(text, /\(0 da decidere\)/);
  assert.doesNotMatch(text, /\(0 aperte\)/);
  // A full human sentence in the view's language, never a parenthesized
  // fragment: the technical detail stays in the console.
  assert.doesNotMatch(text, /\(la lettura non è riuscita\)/);
  assert.ok(text.includes('Questa lista non si è potuta leggere e non viene mostrata.'));
  assert.ok(text.includes('Riprova più tardi.'));

  // Each unreadable list offers its own retry, and the retry re-reads.
  const retries = mount.findAll('button')
    .filter((node) => node.getAttribute('data-action') === 'retry-customer-data-list');
  assert.equal(retries.length, 3, 'one retry per unreadable list');
  const readsBefore = client.calls.filter((call) => String(call.path).includes('/records?limit=100')).length;
  retries[0].dispatch('click');
  await new Promise((resolve) => setTimeout(resolve, 20));
  const readsAfter = client.calls.filter((call) => String(call.path).includes('/records?limit=100')).length;
  assert.ok(readsAfter > readsBefore, 'the retry re-reads the lists');

  // The limits still render: the surface stays honest in its failure state too.
  for (const sentence of CUSTOMER_DATA_DISCLAIMERS) assert.ok(mount.textContent.includes(sentence));
});

test('a run without a stored acceptance names it, never blanks it', async () => {
  const runs = [
    { id: 'run-null', system: 'crm-export', rowCount: 5, acceptedCount: 3, rejectedCount: 1, skippedCount: 1, acceptance: null },
    { id: 'run-undef', system: 'crm-export', rowCount: 2, acceptedCount: 2, rejectedCount: 0, skippedCount: 0 },
  ];
  const mount = await render(stubClient({ rows: { 'customer-import-run': runs } }));
  for (const run of runs) {
    const row = mount.findAll('p').find((node) => node.getAttribute('data-run') === run.id);
    assert.ok(row, `run ${run.id} renders`);
    assert.ok(row.textContent.endsWith('non specificata'), `unknown acceptance renders named, got: ${JSON.stringify(row.textContent)}`);
    assert.ok(!row.textContent.endsWith('· '), 'no trailing blank after the separator');
  }
});

test('a duplicate candidate offers a human decision, never an automatic one', async () => {
  const client = stubClient();
  const mount = await render(client);
  const text = mount.textContent;

  assert.ok(text.includes('Globex Srl'), 'both sides of the candidate are named');
  assert.ok(text.includes('company-name-domain'), 'with the rule that produced it');
  assert.ok(text.includes('collegare non cancella nulla'), 'and what linking actually means');

  const link = mount.findAll('button').find((node) => node.getAttribute('data-action') === 'link-canonical-identity');
  const dismiss = mount.findAll('button').find((node) => node.getAttribute('data-action') === 'dismiss-duplicate-candidate');
  assert.ok(link && dismiss, 'both human decisions are offered');

  // Nothing on the screen decides for the operator.
  const autoControls = mount.findAll('button').filter((node) => /auto|merge all|resolve all/i.test(node.textContent ?? ''));
  assert.deepEqual(autoControls, [], 'no control resolves candidates automatically');

  link.dispatch('click');
  await new Promise((resolve) => setTimeout(resolve, 20));
  const posted = client.calls.filter((call) => call.method === 'POST').at(-1);
  assert.match(posted.path, /\/actions\/link-canonical-identity$/);
  const body = JSON.parse(posted.body);
  assert.equal(body.canonicalResource, 'company');
  assert.ok(['co1', 'co2'].includes(body.canonicalId), 'the canonical side comes from the candidate itself');
});

test('the data-quality queue records a decision and says the finding is kept', async () => {
  const client = stubClient();
  const mount = await render(client);
  assert.ok(mount.textContent.includes('email non valida'), 'the kind reads in Italian');
  assert.ok(!mount.textContent.includes('invalid_email'), 'no raw kind code on the surface');
  assert.ok(mount.textContent.includes('La segnalazione e le sue prove restano.'));

  const govern = mount.findAll('button').find((node) => node.getAttribute('data-action') === 'govern-data-quality-issue');
  govern.dispatch('click');
  await new Promise((resolve) => setTimeout(resolve, 20));
  const posted = client.calls.filter((call) => call.method === 'POST').at(-1);
  assert.match(posted.path, /\/actions\/govern-data-quality-issue$/);
  assert.equal(JSON.parse(posted.body).decision, 'resolved');
});

test('the profile renders an absent package as "not available", never as zero', async () => {
  const profile = {
    customerProfileContract: 1,
    subject: { resource: 'contact', id: 'c1' },
    identity: { company: { id: 'co1', name: 'Northwind Ltd' }, contact: { id: 'c1', email: 'ada@northwind.example' } },
    canonicalIdentity: { linked: false, members: [{ resource: 'contact', id: 'c1', role: 'canonical' }], note: 'no canonical identity decision has been recorded' },
    externalIdentities: [{ system: 'crm-export', externalId: 'CRM-1' }],
    opportunities: { available: true, count: 2, items: [] },
    quotes: { available: false, count: null, items: null, reason: 'the commercial package is not composed in this application, so quotes are not available — this is not a claim that there are none' },
    dataQualityIssues: [],
    completeTimeline: false,
    timelineNote: 'This profile spans Accordo-managed records only. It is not a cross-channel customer timeline.',
    limitations: ['A section marked available: false means the owning package is not composed.'],
  };
  const doc = createFakeDocument();
  const mount = createMount();
  await createCustomerDataView({ doc, mount, client: stubClient({ profile }) }).renderProfile('contact', 'c1');

  const text = mount.textContent;
  assert.ok(text.includes('ada@northwind.example'));
  assert.ok(text.includes('crm-export'));

  // The composed package shows a real number; the absent one does not show 0.
  const opportunities = mount.findAll('p').find((node) => node.getAttribute('data-section') === 'opportunities');
  assert.equal(opportunities.getAttribute('data-available'), 'true');
  assert.ok(opportunities.textContent.includes('2'));

  const quotes = mount.findAll('p').find((node) => node.getAttribute('data-section') === 'quotes');
  assert.equal(quotes.getAttribute('data-available'), 'false');
  assert.ok(quotes.textContent.includes('non disponibile'), quotes.textContent);
  assert.ok(!/:\s*0\b/.test(quotes.textContent), 'an absent package must never render as a zero count');
  assert.ok(quotes.textContent.includes('not a claim that there are none'));

  // And it does not claim to be a timeline.
  assert.ok(text.includes('not a cross-channel customer timeline'));

  // BO-F1-06: the profile links to the three-column scheda, same subject.
  const schedaLink = mount.findAll('a').find((node) => node.getAttribute('data-action') === 'open-customer-card');
  assert.ok(schedaLink, 'the profile links to the scheda cliente');
  assert.equal(schedaLink.getAttribute('href'), '#/customer-card/contact/c1');
});

test('hostile server text renders as text, never as markup', async () => {
  const nasty = '<img src=x onerror=alert(1)>';
  const client = stubClient({
    rows: { 'duplicate-candidate': [{ ...CANDIDATE, leftLabel: nasty, evidence: nasty }] },
  });
  const mount = await render(client);
  assert.ok(mount.textContent.includes(nasty), 'the value is shown as text');
  assert.deepEqual(mount.findAll('img'), [], 'and no element was created from it');
  assert.deepEqual(mount.findAll('script'), []);
});

test('the import tool renders alone, without the customer list', async () => {
  // backlog:80b25fb0: the tool left the Clienti screen for #/import-clienti,
  // so it renders its file field without fetching or embedding the list.
  const client = stubClient();
  const doc = createFakeDocument();
  const mount = createMount();
  await createCustomerDataView({ doc, mount, client }).render();
  for (let i = 0; i < 12; i += 1) await new Promise((resolve) => { setImmediate(resolve); });
  const fileBox = mount.findAll('input').find((node) => node.getAttribute('name') === 'file');
  assert.ok(fileBox, 'the import file field renders');
  assert.ok(!client.calls.some((call) => String(call.path).includes('/api/customer-data/customers')),
    'the tool never fetches the customer list');
  assert.deepEqual(mount.findAll('article').filter((node) =>
    (node.getAttribute('class') ?? '').split(/\s+/).includes('bo-clienti-row')), [],
  'no customer row renders on the import screen');
});
