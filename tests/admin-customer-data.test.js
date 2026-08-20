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

test('the section disappears entirely when the package is not composed', async () => {
  const mount = await render(stubClient({ withPackage: false }));
  assert.equal(mount.textContent, '', 'an optional package that is absent renders nothing at all');
  assert.equal(byClass(mount, 'customer-data-section'), null);
});

test('every limit renders as content, in the ordinary state', async () => {
  const mount = await render(stubClient());
  const text = mount.textContent;
  for (const sentence of CUSTOMER_DATA_DISCLAIMERS) {
    assert.ok(text.includes(sentence), `missing verbatim limit: ${sentence.slice(0, 50)}…`);
  }
  // The deferred track has one home, and it is named.
  assert.ok(text.includes('Customer Data Operations v2'));
  assert.ok(text.includes('global search'));
  // No CDP claim anywhere on the surface.
  assert.doesNotMatch(text, /\bCDP\b/i, 'the Admin must never call this a CDP');
  assert.doesNotMatch(text, /customer data platform/i);
});

test('a preview states plainly that it wrote nothing, and shows every receipt', async () => {
  const client = stubClient();
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createCustomerDataView({ doc, mount, client });
  await view.render();

  const rowsInput = mount.findAll('textarea').find((node) => node.getAttribute('name') === 'rows');
  const systemInput = mount.findAll('input').find((node) => node.getAttribute('name') === 'system');
  systemInput.value = 'crm-export';
  rowsInput.value = JSON.stringify([{ email: 'a@b.example' }, { email: 'bad' }]);

  const preview = mount.findAll('button').find((node) => node.getAttribute('data-action') === 'preview-customer-import');
  preview.dispatch('click');
  await new Promise((resolve) => setTimeout(resolve, 20));

  const text = mount.textContent;
  assert.ok(text.includes('nothing — this is a preview'), text.slice(0, 200));
  assert.ok(text.includes('row 0'), 'each receipt is rendered');
  assert.ok(text.includes('INVALID_EMAIL'), 'including the rejected one');
  assert.ok(text.includes('rejected'), 'and its outcome');

  const posted = client.calls.filter((call) => call.method === 'POST');
  assert.equal(posted.length, 1);
  assert.equal(posted[0].path, '/api/customer-data/import/preview');
  assert.deepEqual(JSON.parse(posted[0].body).rows.length, 2);
});

test('applying after a preview reuses the rows the operator typed once', async () => {
  // The primary flow is *preview, read the receipts, then apply the same rows*.
  // A preview re-renders the panel; if the draft did not survive that render the
  // operator's own import would come back as "paste the rows to import".
  const client = stubClient();
  const doc = createFakeDocument();
  const mount = createMount();
  await createCustomerDataView({ doc, mount, client }).render();

  const control = (tag, name) => mount.findAll(tag).find((node) => node.getAttribute('name') === name);
  const button = (action) => mount.findAll('button').find((node) => node.getAttribute('data-action') === action);
  const ROWS_JSON = JSON.stringify([{ email: 'a@b.example' }, { email: 'bad' }]);

  control('input', 'system').value = 'crm-export';
  control('textarea', 'rows').value = ROWS_JSON;
  control('select', 'acceptance').value = 'all_or_nothing';

  button('preview-customer-import').dispatch('click');
  await new Promise((resolve) => setTimeout(resolve, 20));

  // The re-rendered form still carries the draft, visibly.
  assert.equal(control('input', 'system').value, 'crm-export');
  assert.equal(control('textarea', 'rows').value, ROWS_JSON);
  assert.equal(control('select', 'acceptance').value, 'all_or_nothing');

  // And Apply — on the freshly rendered button — sends exactly those rows.
  button('apply-customer-import').dispatch('click');
  await new Promise((resolve) => setTimeout(resolve, 20));

  const applied = client.calls.filter((call) => call.path === '/api/customer-data/import/apply').at(-1);
  assert.ok(applied, 'the apply was actually sent');
  const body = JSON.parse(applied.body);
  assert.equal(body.system, 'crm-export');
  assert.equal(body.acceptance, 'all_or_nothing');
  assert.deepEqual(body.rows, JSON.parse(ROWS_JSON), 'apply carries the same rows the preview did');
});

test('a list that could not be read says so, and never renders as zero', async () => {
  const mount = await render(stubClient({ unreadableModules: true }));
  const text = mount.textContent;

  for (const label of ['Import runs', 'Duplicate candidates', 'Data quality']) {
    assert.ok(text.includes(`${label} (could not be read)`), `${label} must not claim a count it does not have`);
  }
  assert.ok(text.includes('That is not a claim that there are none.'));
  assert.doesNotMatch(text, /Import runs \(0\)/);
  assert.doesNotMatch(text, /\(0 unresolved\)/);
  assert.doesNotMatch(text, /\(0 open\)/);

  // The limits still render: the surface stays honest in its failure state too.
  for (const sentence of CUSTOMER_DATA_DISCLAIMERS) assert.ok(text.includes(sentence));
});

test('a duplicate candidate offers a human decision, never an automatic one', async () => {
  const client = stubClient();
  const mount = await render(client);
  const text = mount.textContent;

  assert.ok(text.includes('Globex Srl'), 'both sides of the candidate are named');
  assert.ok(text.includes('company-name-domain'), 'with the rule that produced it');
  assert.ok(text.includes('logical canonical merge'), 'and what linking actually means');

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
  assert.ok(mount.textContent.includes('invalid_email'));
  assert.ok(mount.textContent.includes('The finding and its evidence are kept.'));

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
  assert.ok(quotes.textContent.includes('not available'), quotes.textContent);
  assert.ok(!/:\s*0\b/.test(quotes.textContent), 'an absent package must never render as a zero count');
  assert.ok(quotes.textContent.includes('not a claim that there are none'));

  // And it does not claim to be a timeline.
  assert.ok(text.includes('not a cross-channel customer timeline'));
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
