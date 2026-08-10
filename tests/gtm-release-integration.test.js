// @ts-check

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (/** @type {string} */ path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('the integrated ADR sequence is unique and owns both release decisions', () => {
  const decisions = read('DECISIONS.md');
  const headings = [...decisions.matchAll(/^## (ADR-\d+) — (.+)$/gm)];
  const ids = headings.map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'two independently reviewed branches must not reuse one ADR id');
  assert.match(decisions, /^## ADR-025 — Host the existing Docs MCP/m);
  assert.match(decisions, /^## ADR-026 — The npm bootstrap is assembled/m);
});

test('release instructions point at the integration outcome, not superseded branch merges', () => {
  const pending = read('docs/marketing/PENDING_HUMAN_SUBMISSION.md');
  const submissions = read('docs/strategy/DISTRIBUTION_SUBMISSIONS.md');
  const recommendation = read('docs/strategy/RECOMMENDATION_MAP.md');
  const currentInstructions = `${pending}\n${submissions}\n${recommendation}`;

  assert.doesNotMatch(currentInstructions, /After PR #51 merges|PR #51 prepares|prepared in PR #52/i);
  assert.match(pending, /After the reviewed GTM release integration reaches `main`/);
  assert.match(submissions, /After that integration reaches `main` through regular merges/);
  assert.match(recommendation, /Promote the integrated Docs MCP/);
});

test('the volatile project snapshot names the live base and the stacked release', () => {
  const status = read('docs/PROJECT_STATUS.md');
  assert.match(status, /Generated: \*\*2026-08-10\*\*/);
  assert.match(status, /Main SHA at generation \| `77d7719`/);
  assert.match(status, /Tests on clean main \| \*\*772 passing, 0 failing\*\*/);
  assert.match(status, /#44 → #53 → #54 → #55 → #56 → #57 → #58/);
  assert.doesNotMatch(status, /`845cd3d`|555 passing|Legacy Characterization Harness.+open PR/s);
});
