// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { boot, project, signedOrder } from './helpers/contracts-project.js';

/**
 * The one capability Signature & Order OFFERS — `signature-orders@1` — exists
 * because Contract Activation's actions target the `order` record this package
 * now owns, and the package contract requires that record-level dependency to
 * be declared through a capability of the owner (DX4). The declaration is what
 * contracts consumes at runtime today; the read surface behind it still has to
 * be behaviourally true, because it is the shape the NEXT consumer builds
 * against — `crm package test` exercises what a package requires, never what
 * it offers, so without this test the offered read authority ships untested
 * (the `commercial-capabilities` argument, third application).
 *
 * The fixture is a REAL signed order: catalog → quote → approval → signature
 * envelope → verified completion, produced by the same helper every contracts
 * test uses — nothing here is hand-built rows.
 */

test('signature-orders@1 returns the signed-Order evidence shape, fail-closed and frozen', async (t) => {
  const root = project(t);
  const context = await boot(root, join(root, 'data', 'sig-orders-cap.sqlite'));
  t.after(() => context.close());
  const { app } = context;

  const { order } = await signedOrder(root, app, { name: 'Orders Capability Deal' });

  // Opened the way a consumer opens it: through the registry, as the one
  // composed package that declared the requirement.
  const cap = app.domains.capability({
    consumer: 'contracts', capability: 'signature-orders', version: 1,
    context: { modules: app.modules },
  });
  assert.deepEqual(Object.keys(cap).sort(),
    ['capabilityContract', 'envelope', 'order', 'orderComponents', 'orderLines', 'orderTerm', 'orderTotals', 'signedArtifact']);
  assert.equal(cap.capabilityContract, 1);

  // 2 · provenance — the order names its evidence and all three rows agree on
  // the hash of the document that was actually signed.
  const row = cap.order(order.id);
  assert.equal(row.status, 'accepted');
  assert.ok(row.envelopeId && row.signedArtifactId, 'the order carries its signature provenance');
  const envelope = cap.envelope(row.envelopeId);
  const artifact = cap.signedArtifact(row.signedArtifactId);
  assert.equal(envelope.status, 'completed');
  assert.equal(artifact.envelopeId, envelope.id);
  assert.equal(row.documentHash, envelope.documentHash);
  assert.equal(artifact.documentHash, envelope.documentHash);

  // 3 · completeness — the counts on the row state exactly what the snapshot
  // holds, and the reads are ordered the way the consumer copies them.
  const lines = cap.orderLines(order.id);
  assert.equal(lines.length, row.lineCount, 'lineCount states exactly how many lines the snapshot holds');
  assert.ok(lines.every((line, i) => i === 0 || lines[i - 1].position <= line.position), 'lines are position-ordered');
  assert.ok(lines.every((line) => Number.isSafeInteger(line.netAmountCents)), 'every line carries integer cents');
  for (const line of lines) {
    const components = cap.orderComponents(line.id);
    assert.equal(components.length, line.componentCount, `componentCount is exact for ${line.id}`);
    assert.ok(components.every((c, i) => i === 0 || components[i - 1].componentKey <= c.componentKey), 'components are componentKey-ordered');
  }
  const totals = cap.orderTotals(order.id);
  assert.ok(totals.length >= 1, 'a signed order carries at least one grouped total');

  // 1 · immutability — frozen rows, and a mutation attempt never reaches storage.
  assert.equal(Object.isFrozen(row), true);
  assert.equal(Object.isFrozen(lines), true);
  const netBefore = lines[0].netAmountCents;
  let threw = false;
  try { lines[0].netAmountCents = -1; } catch { threw = true; }
  assert.equal(threw || lines[0].netAmountCents !== -1, true, 'the handed evidence cannot be mutated');
  assert.equal(cap.orderLines(order.id)[0].netAmountCents, netBefore, 'and storage never moved');

  // An order whose signed document carried no term answers null for its
  // term — the ordinary historical case, presented as absent-unknown and
  // never as a decided term. (The signed-term positive path is proven by
  // tests/signed-terms-e2e.test.js.)
  assert.equal(cap.orderTerm(order.id), null);

  // Absent ids answer null, never a throw and never someone else's row.
  assert.equal(cap.order('no-such-order'), null);
  assert.equal(cap.envelope(''), null);
  assert.equal(cap.signedArtifact(null), null);
  assert.deepEqual([...cap.orderLines('no-such-order')], []);

  // Fail-closed both ways: a composed package that did NOT declare the
  // requirement is refused, and a consumer the registry never composed is not
  // a package at all.
  assert.throws(
    () => app.domains.capability({ consumer: 'commercial', capability: 'signature-orders', version: 1, context: { modules: app.modules } }),
    (error) => error.code === 'CAPABILITY_NOT_DECLARED',
    'an undeclared reach across the boundary is refused even though the capability exists',
  );
  assert.throws(
    () => app.domains.capability({ consumer: 'not-a-package', capability: 'signature-orders', version: 1, context: { modules: app.modules } }),
    (error) => error.status === 404,
  );

  // And the capability grants no write: the interface carries only reads, and
  // the frozen rows above are the proof the reads cannot become writes.
  assert.ok(!('create' in cap) && !('update' in cap) && !('applyManaged' in cap));
});
