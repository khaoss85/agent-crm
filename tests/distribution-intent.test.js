// @ts-check

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { collectDiscoverySurfaces, validateDiscoverySurfaces } from '../scripts/distribution-intent.js';

const root = process.cwd();

/** @param {string} path */
function json(path) {
  return JSON.parse(readFileSync(join(root, path), 'utf8'));
}

const manifests = {
  readme: readFileSync(join(root, 'README.md'), 'utf8'),
  claudePlugin: json('.claude-plugin/plugin.json'),
  claudeMarketplace: json('.claude-plugin/marketplace.json'),
  codexPlugin: json('.codex-plugin/plugin.json'),
  geminiExtension: json('gemini-extension.json'),
  rootPackage: json('package.json'),
  createPackage: json('packages/create-accordo/package.json'),
  serverJson: json('server.json'),
};
const surfaces = new Map(collectDiscoverySurfaces(manifests));

const signals = new Map([
  ['custom CRM', /custom[- ]crms?\b/i],
  ['Customer Hub', /customer[- ]hubs?\b/i],
  ['Smart CRM', /smart[- ]crm\b/i],
  ['CDP + CRM', /cdp(?:\s*\+\s*|-plus-)crm\b/i],
]);

test('every first-contact distribution surface carries the checked intent vocabulary', () => {
  for (const [surface, copy] of surfaces) {
    for (const [signal, pattern] of signals) {
      assert.match(copy, pattern, `${surface} is missing ${signal}`);
    }
  }
});

test('every CDP-adjacent discovery surface keeps the non-CDP boundary in the same artifact', () => {
  const boundary = /not ingestion,\s*identity resolution or segmentation|external cdp owns\s+ingestion,\s*identity resolution and audiences/i;
  for (const [surface, copy] of surfaces) {
    assert.match(copy, boundary, `${surface} mentions CDP + CRM without its ownership boundary`);
  }
});

test('negating ingestion alone cannot hide an identity-resolution or segmentation claim', () => {
  const contradictory = [
    ['attacked surface', 'custom CRM Customer Hub Smart CRM CDP + CRM: not ingestion, but Accordo owns identity resolution and segmentation'],
  ];
  assert.deepEqual(validateDiscoverySurfaces(contradictory), [
    'attacked surface: CDP + CRM appears without the CDP boundary (not ingestion, identity resolution or segmentation)',
  ]);
});

test('ignored and prototype-shaped manifest fields cannot smuggle intent past public copy', () => {
  const hiddenProof = 'custom CRM Customer Hub Smart CRM CDP + CRM not ingestion identity resolution segmentation';
  const rootPackage = {
    ...manifests.rootPackage,
    description: 'Agent-native CRM framework.',
    keywords: ['crm'],
    ignoredMetadata: hiddenProof,
  };
  Object.defineProperty(rootPackage, '__proto__', { value: hiddenProof, enumerable: true });

  const attacked = collectDiscoverySurfaces({ ...manifests, rootPackage });
  assert.deepEqual(validateDiscoverySurfaces(attacked), [
    'root package: missing the checked custom CRM discovery signal',
    'root package: missing the checked Customer Hub discovery signal',
    'root package: missing the checked Smart CRM discovery signal',
    'root package: missing the checked CDP + CRM discovery signal',
    'root package: CDP + CRM appears without the CDP boundary (not ingestion, identity resolution or segmentation)',
  ]);
});
