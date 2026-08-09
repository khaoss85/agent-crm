// @ts-check

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = process.cwd();

/** @param {string} path */
function json(path) {
  return JSON.parse(readFileSync(join(root, path), 'utf8'));
}

const claudeMarketplace = json('.claude-plugin/marketplace.json');
const surfaces = new Map([
  ['README.md', readFileSync(join(root, 'README.md'), 'utf8')],
  ['Claude plugin', JSON.stringify(json('.claude-plugin/plugin.json'))],
  ['Claude marketplace', JSON.stringify(claudeMarketplace.plugins[0])],
  ['Codex plugin', JSON.stringify(json('.codex-plugin/plugin.json'))],
  ['Gemini extension', JSON.stringify(json('gemini-extension.json'))],
  ['root package', JSON.stringify(json('package.json'))],
  ['create-accordo package', JSON.stringify(json('packages/create-accordo/package.json'))],
  ['MCP Registry server', JSON.stringify(json('server.json'))],
]);

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
  const boundary = /not ingestion|does not ingest|no cdp|not (?:a |the )?cdp/i;
  for (const [surface, copy] of surfaces) {
    assert.match(copy, boundary, `${surface} mentions CDP + CRM without its ownership boundary`);
    assert.match(copy, /identity resolution/i, `${surface} does not assign identity resolution away from Accordo`);
    assert.match(copy, /segmentation|audiences/i, `${surface} does not assign segmentation or audiences away from Accordo`);
  }
});
