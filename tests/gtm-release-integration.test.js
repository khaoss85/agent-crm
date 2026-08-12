// @ts-check

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { inspectStatusMeasurement, findLooseTestCounts } from '../scripts/measurement.js';

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

test('the volatile project snapshot cites the ledger rather than measuring again', () => {
  // This test used to pin `Generated: **2026-08-10**`, `Main SHA at generation | \`ef8487a\`` and
  // `808 passing, 0 failing` as literals. That is a large part of why the snapshot went stale and
  // stayed stale: the assertions froze a measurement a later wave had already moved, so the only
  // way to update the document was to update the test, and nobody did. What is durable about this
  // file is not its numbers — it is that it owns none of them.
  const status = read('docs/PROJECT_STATUS.md');
  const ledger = JSON.parse(read('site/claims.json'));

  assert.deepEqual(
    inspectStatusMeasurement(status, ledger.measuredAgainst),
    [],
    'the status file must cite site/claims.json measuredAgainst, not a commit of its own',
  );
  assert.deepEqual(
    findLooseTestCounts(status),
    [],
    'the status file must state no test count — it cites the measurement record (ADR-027)',
  );
  assert.doesNotMatch(
    status,
    /Main SHA at generation|Tests on clean main/,
    'the two rows that owned a second measurement are gone; "Measured at" cites the ledger instead',
  );
  assert.match(status, /GTM stack and production promotion are complete/);
  assert.doesNotMatch(status, /Legacy Characterization Harness.+open PR/s);
});
