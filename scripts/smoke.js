// @ts-check

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAccordoApp } from '../packages/app/src/index.js';

const directory = mkdtempSync(join(tmpdir(), 'accordo-smoke-'));
const app = createAccordoApp({ dbPath: join(directory, 'smoke.sqlite') });

try {
  const demo = await app.runDemo();
  assert.equal(demo.opportunities.length, 2);
  assert.equal(demo.opportunities.find((item) => item.valueCents === 2_000_000)?.stage, 'proposal');
  assert.equal(demo.opportunities.find((item) => item.valueCents === 8_000_000)?.stage, 'approval_pending');
  assert.equal(demo.approvals.filter((item) => item.status === 'pending').length, 1);
  assert.equal(app.workflows.listRuns().length, 2);
  console.log(JSON.stringify({
    ok: true,
    summary: '€20k renewal moved to Proposal; €80k renewal requires approval.',
    counts: app.doctor().counts,
  }, null, 2));
} finally {
  app.close();
  rmSync(directory, { recursive: true, force: true });
}
