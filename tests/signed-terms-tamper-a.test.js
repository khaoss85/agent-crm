import test from 'node:test';
import assert from 'node:assert/strict';
import { activate, refusal, scene, FIELD_TAMPERS } from './helpers/signed-terms-scene.js';

/**
 * Signed-term integrity, shard 1 of 4: single-field tampers, first half.
 * Split from `tests/signed-terms-integrity.test.js` (backlog:d549f58bfcf8):
 * the whole file exceeded the 600 s per-file ceiling of the scheduled full,
 * so the 16 unchanged cases now live in four files of four. No case removed,
 * no assertion changed — only the import moved to the shared scene helper.
 */

for (const [label, sql] of FIELD_TAMPERS.slice(0, 4)) {
  test(`a tampered signed term fails closed at activation: ${label}`, async (t) => {
    const s = await scene(t, `tamper-${label.replace(/[^a-z]+/gi, '-').toLowerCase()}`);
    s.db.prepare(sql).run(s.order.id);

    const refused = await refusal(activate(s.app, s.order.id));
    assert.equal(refused.ok, false, `${label} must not activate`);
    assert.equal(refused.code, 'TERMS_FINGERPRINT_MISMATCH');
    assert.equal(refused.status, 409);

    // Nothing was written, and the refusal never echoes the hostile value.
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM commercial_contracts').get().n, 0);
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM contract_activations').get().n, 0);
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM subscriptions').get().n, 0);
    assert.doesNotMatch(refused.message, /2099|99999|2026-01-01|2026-10-01/,
      'a refusal states what failed, never the value somebody planted');
    // The failed attempt leaves an honest failed trace and no success audit.
    const runs = s.app.workflows.listRuns({ workflowName: 'order.activate-contract', limit: 5 });
    assert.ok(runs.every((entry) => entry.status === 'failed'), 'no run claims success');
  });
}
