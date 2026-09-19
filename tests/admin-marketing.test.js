import test from 'node:test';
import assert from 'node:assert/strict';

import { createMarketingView } from '../apps/admin/public/admin-marketing.js';
import { parseModuleRoute } from '../apps/admin/public/admin-core.js';
import { createMarketingDomain } from '../packages/marketing/src/index.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';

/**
 * The Marketing Admin review screen (MK1).
 *
 * **Package-scoped, not package-owned**: the section lives in the Admin app
 * and renders only while `/api/schema` publishes the package.
 *
 * Every test here is a claim the screen makes, a control it must not offer, or
 * a failure mode a real browser finds in a section like this: a stale response
 * drawn over a newer one, an error with no way back, an approve control where
 * the server would refuse, or a value that stops being text.
 */

const DOMAIN = createMarketingDomain({
  proposalPolicies: [{ name: 'standard-proposal', version: 1, label: 'Standard', config: {} }],
}).metadata();
const SCHEMA = { domains: { marketing: DOMAIN } };

const PROPOSED = {
  id: 'prop-1', title: 'Win back dormant trial teams', mode: 'one-shot', status: 'proposed',
  audienceJson: '{"rule":"dormant 30d"}', exclusionsJson: '["unsubscribed"]',
  channel: 'email', providerRationale: 'Resend, sandbox configured.',
  contentPlanJson: '{"subject":"hi"}', trackingPlanJson: '{"utm":"mk1"}',
  risksJson: '["low opens"]', requiredApprovalsJson: '["content"]',
  policyName: 'standard-proposal', policyVersion: 1,
};
const REFUSED = {
  ...PROPOSED, id: 'prop-2', title: 'Half a thought', status: 'refused',
  channel: '', refusalReasonsJson: JSON.stringify(['channel', 'risks']),
};
const APPROVED = {
  ...PROPOSED, id: 'prop-3', title: 'Shipped thought', status: 'approved',
  decidedBy: 'ada', decidedAt: '2026-09-19T09:00:00.000Z', currentVersionId: 'ver-1',
};
const VERSION = {
  id: 'ver-1', proposalId: 'prop-3', versionNumber: 1, approvedBy: 'ada',
  approvedAt: '2026-09-19T09:00:00.000Z', policyName: 'standard-proposal', policyVersion: 1,
};

/** A request client over a canned dataset, recording every call it received. */
function stubClient(data, overrides = {}) {
  const calls = [];
  return {
    calls,
    async request(path, options = {}) {
      calls.push({ path, method: options.method ?? 'GET', body: options.body ?? null });
      if (overrides[path]) return overrides[path]();
      if (path === '/api/schema') return data.schema ?? SCHEMA;
      if (path.includes('/actions/')) return { ok: true, result: {} };
      if (path.startsWith('/api/modules/campaign-proposal/records/')) {
        const id = decodeURIComponent(path.split('/').pop());
        const found = (data['campaign-proposal'] ?? []).find((row) => row.id === id);
        if (!found) throw Object.assign(new Error('Not found'), { status: 404 });
        return found;
      }
      const module = path.split('/')[3];
      const query = new URLSearchParams(path.split('?')[1] ?? '');
      const limit = Number(query.get('limit') ?? 100);
      const where = [...query.entries()]
        .filter(([key]) => key.startsWith('filter.'))
        .map(([key, value]) => [key.slice('filter.'.length), value]);
      const rows = (data[module] ?? [])
        .filter((row) => where.every(([field, value]) => String(row[field]) === value));
      return { items: rows.slice(0, limit) };
    },
  };
}

function view(data, overrides) {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient(data, overrides);
  const navigated = [];
  return {
    doc, mount, client, navigated,
    marketing: createMarketingView({ doc, mount, client, navigate: (hash) => navigated.push(hash) }),
  };
}

const text = (mount) => mount.textContent;

/** Find every node in the mount subtree carrying a CSS class. */
function byClass(mount, className) {
  const found = [];
  const visit = (node) => {
    if (node.classList && node.classList.contains(className)) found.push(node);
    for (const child of node.childNodes ?? []) visit(child);
  };
  visit(mount);
  return found;
}

// ---------------------------------------------------------------------------

test('the routes are canonical, and a hostile hash is invalid rather than a lookup', () => {
  assert.deepEqual(parseModuleRoute('#/marketing'), { view: 'marketing' });
  assert.deepEqual(parseModuleRoute('#/marketing/'), { view: 'marketing' });
  assert.deepEqual(parseModuleRoute('#/marketing/prop-1'), { view: 'marketing-proposal', proposalId: 'prop-1' });
  assert.deepEqual(parseModuleRoute('#/marketing/prop-1?x=1'), { view: 'marketing-proposal', proposalId: 'prop-1' });
  for (const hostile of ['#/marketing//', '#/marketing/a/b', '#/marketing/%2e%2e%2fetc', '#/marketing/%zz']) {
    assert.equal(parseModuleRoute(hostile).view, 'invalid', hostile);
  }
});

test('the section renders nothing when the server does not publish the package', async () => {
  const v = view({ schema: { domains: {} }, 'campaign-proposal': [] });
  await v.marketing.renderProposalList();
  assert.match(text(v.mount), /not installed/);
  assert.equal(byClass(v.mount, 'marketing-approve').length, 0);
  const w = view({ schema: { domains: {} }, 'campaign-proposal': [] });
  await w.marketing.renderProposalDetail('prop-1');
  assert.match(text(w.mount), /not installed/);
});

test('the list shows every proposal with its status, and discloses its bound', async () => {
  const v = view({ 'campaign-proposal': [PROPOSED, REFUSED] });
  await v.marketing.renderProposalList();
  const rendered = text(v.mount);
  assert.match(rendered, /Win back dormant trial teams/);
  assert.match(rendered, /Half a thought/);
  assert.match(rendered, /proposed/);
  assert.match(rendered, /refused/);
  assert.match(rendered, /sends, publishes or spends/);
});

test('a refused proposal names its missing sections and offers no approve control', async () => {
  const v = view({ 'campaign-proposal': [REFUSED] });
  await v.marketing.renderProposalDetail('prop-2');
  const rendered = text(v.mount);
  assert.match(rendered, /Refused/);
  assert.match(rendered, /channel/);
  assert.match(rendered, /risks/);
  assert.equal(byClass(v.mount, 'marketing-approve').length, 0);
});

test('a proposed proposal offers exactly one approve control, and approving posts the policy identity', async () => {
  const v = view({ 'campaign-proposal': [{ ...PROPOSED }], 'campaign-version': [] });
  await v.marketing.renderProposalDetail('prop-1');
  const buttons = byClass(v.mount, 'marketing-approve');
  assert.equal(buttons.length, 1);
  await buttons[0].listeners.click[0]({ preventDefault: () => {} });
  const action = v.client.calls.find((call) => call.path.includes('/actions/approve'));
  assert.ok(action, 'the approve action was posted');
  assert.equal(action.method, 'POST');
  assert.deepEqual(JSON.parse(action.body), { policy: 'standard-proposal', policyVersion: 1 });
});

test('an approved proposal is evidence: versions shown, no approve control', async () => {
  const v = view({ 'campaign-proposal': [APPROVED], 'campaign-version': [VERSION] });
  await v.marketing.renderProposalDetail('prop-3');
  const rendered = text(v.mount);
  assert.match(rendered, /Approval evidence/);
  assert.match(rendered, /ada/);
  assert.equal(byClass(v.mount, 'marketing-approve').length, 0);
});

test('a hostile title is text, never markup, and a failed approve keeps its error', async () => {
  const hostile = { ...PROPOSED, id: 'prop-9', title: '<script>alert(1)</script>' };
  const v = view({ 'campaign-proposal': [hostile], 'campaign-version': [] }, {
    '/api/modules/campaign-proposal/records/prop-9/actions/approve': () => {
      throw Object.assign(new Error('Only a proposed campaign can be approved (status: gone)'), { status: 409 });
    },
  });
  await v.marketing.renderProposalDetail('prop-9');
  assert.match(text(v.mount), /<script>alert\(1\)<\/script>/);
  assert.equal(byClass(v.mount, 'script').length, 0);
  const buttons = byClass(v.mount, 'marketing-approve');
  assert.equal(buttons.length, 1);
  await assert.rejects(() => buttons[0].listeners.click[0]({ preventDefault: () => {} }), /status: gone/);
  assert.match(text(v.mount), /status: gone/);
});
