import test from 'node:test';
import assert from 'node:assert/strict';

import { resolvePackageComposition } from '../packages/core/src/package-composition.js';
import { createChannelsPackage } from '../packages/channels/src/index.js';
import { createCustomerDataPackage } from '../packages/customer-data/src/index.js';

/**
 * The optional channels → customer-data edge (backlog:66282d13d81c).
 *
 * The initial history import reconciles senders through the composed
 * `channel-sender@1` capability, taken from the customer-data definition
 * the composition lists beside channels — the same handover shape
 * appointments uses for work's `follow-up@1`. But the edge is optional:
 * a composition that omits the provider package still boots, receives
 * webhooks, sends, and imports — the import stores conversations and
 * messages and leaves sender reconciliation pending instead of refusing.
 */

function channels(options = {}) {
  return createChannelsPackage({
    channelAdapters: [],
    resolveSecret: async () => 'edge-secret',
    tenantId: 'channel-edge',
    ...options,
  });
}

test('channels alone boots: customer-data is optional, never a boot refusal', () => {
  const { problems } = resolvePackageComposition([channels()]);
  const missing = problems.filter((problem) => problem.code === 'DEPENDENCY_MISSING_PACKAGE');
  assert.deepEqual(missing, [], `no missing-package refusal, got ${JSON.stringify(problems)}`);
});

test('channels beside customer-data resolves the channel-sender edge', () => {
  const customerData = createCustomerDataPackage();
  const { problems } = resolvePackageComposition([customerData, channels({ customerData })]);
  const dependency = problems.filter((problem) => problem.code === 'DEPENDENCY_MISSING_PACKAGE'
    || problem.code === 'DEPENDENCY_UNSATISFIED'
    || problem.code === 'PACKAGE_ASYNC_CONTRACT_REQUIRED');
  assert.deepEqual(dependency, []);
});

test('the standalone package declares no requires and owns its import records', () => {
  const standalone = channels();
  assert.equal(standalone.requires ?? null, null, 'no hard edge: standalone boots');
  for (const resource of ['channel-import-state', 'channel-import-outcome']) {
    assert.ok(
      standalone.resources.includes(resource),
      `the package owns ${resource}: progress counts its own rows`,
    );
  }
});
