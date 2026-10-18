import test from 'node:test';
import assert from 'node:assert/strict';

import { resolvePackageComposition } from '../packages/core/src/package-composition.js';
import { createChannelsPackage } from '../packages/channels/src/index.js';
import { createCustomerDataPackage } from '../packages/customer-data/src/index.js';

/**
 * The declared channels → customer-data edge (backlog:66282d13d81c).
 *
 * The initial history import reconciles senders through the composed
 * `channel-sender@1` capability, taken from the customer-data definition
 * the composition lists beside channels — the same handover shape
 * appointments uses for work's `follow-up@1`. A composition that omits
 * the provider package refuses at boot naming the edge, never with a
 * missing-module stack trace on the first import.
 */

function channels(options = {}) {
  return createChannelsPackage({
    channelAdapters: [],
    resolveSecret: async () => 'edge-secret',
    tenantId: 'channel-edge',
    ...options,
  });
}

test('channels alone refuses, naming the customer-data edge', () => {
  const { problems } = resolvePackageComposition([channels()]);
  const missing = problems.filter((problem) => problem.code === 'DEPENDENCY_MISSING_PACKAGE');
  assert.equal(missing.length, 1, `one missing-package refusal, got ${JSON.stringify(problems)}`);
  assert.match(missing[0].message, /customer-data/);
  assert.match(String(missing[0].capability), /channel-sender@1/);
});

test('channels beside customer-data resolves the channel-sender edge', () => {
  const customerData = createCustomerDataPackage();
  const { problems } = resolvePackageComposition([customerData, channels({ customerData })]);
  const dependency = problems.filter((problem) => problem.code === 'DEPENDENCY_MISSING_PACKAGE'
    || problem.code === 'DEPENDENCY_UNSATISFIED'
    || problem.code === 'PACKAGE_ASYNC_CONTRACT_REQUIRED');
  assert.deepEqual(dependency, []);
});
