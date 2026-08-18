import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  approvedQuote, boot, characterizationProject, loadFixture,
} from './characterization/signature-harness.mjs';

/**
 * Signer input integrity: control characters in signer fields are refused.
 *
 * The previous commit is the reproducer: it proved, red-first, that signer
 * `name`, `email` and `role` accepted C0/C1 control characters, that a NUL
 * byte was silently mutated in storage, that a NUL in the email local part
 * passed the email regex, and that the polluted envelope stranded the
 * corrected retry behind ENVELOPE_EXISTS. This commit inverts every one of
 * those assertions into the contract: the same single-line rule
 * `record-signal` adopted in 1e40d1e (C0, C1, DEL, U+2028/U+2029 — tested on
 * the raw input, no ASCII allowlist, no Unicode normalization), applied to
 * every signer text field, refused in the intent phase BEFORE any write and
 * BEFORE any provider call.
 */

const signers = (overrides) => [{ name: 'Maria Bianchi', email: 'signer@example.com', role: 'customer', order: 1, ...overrides }];

test('control characters in signer fields are refused, atomically and before the provider', async (t) => {
  const root = characterizationProject(t, { name: 'accordo-signer-fix-' });
  const instance = await boot(root, join(root, 'data', 'signer-fix.sqlite'));
  t.after(() => instance.close().catch(() => {}));
  const { app, client } = instance;
  const { signatureFixture } = await loadFixture(root);
  signatureFixture.reset();
  const modules = (name) => app.modules.get(name).service;

  const request = async (deal, list) => client.module('quote').action(deal.quote.id, 'request-signature', {
    quoteVersionId: deal.versionId, provider: 'fixture-signature', providerVersion: 1, signers: list,
  }).then(
    (body) => ({ accepted: true, body }),
    (error) => ({ accepted: false, code: error.code, status: error.status, message: String(error.message) }),
  );

  const deal = await approvedQuote(app, { name: 'Signer Fix Deal' });
  const auditCounts = () => ({
    envelope: app.audit.list({ entityType: 'signature-envelope', limit: 500 }).length,
    signer: app.audit.list({ entityType: 'signature-signer', limit: 500 }).length,
  });
  const before = auditCounts();
  const eventsSeen = [];
  app.events.subscribe('*', ({ event }) => eventsSeen.push(event));

  // Every prohibited class, on every signer text field, on the one path signer
  // data enters (the request-signature intent — which is also the retry path).
  const PROHIBITED = [
    ['newline-in-name', { name: 'a\nb', email: 'p1@example.com' }],
    ['carriage-return-in-name', { name: 'a\rb', email: 'p2@example.com' }],
    ['tab-in-name', { name: 'a\tb', email: 'p3@example.com' }],
    ['nul-in-name', { name: 'a\u0000b', email: 'p4@example.com' }],
    ['nul-in-role', { email: 'p5@example.com', role: 'r\u0000oot' }],
    ['nul-in-email-local-part', { email: 'x\u0000y@example.com' }],
    ['c1-control-in-name', { name: 'a\u0085b', email: 'p6@example.com' }],
    ['delete-in-role', { email: 'p7@example.com', role: 'a\u007fb' }],
    ['line-separator-in-role', { email: 'p8@example.com', role: 'a\u2028b' }],
    ['paragraph-separator-in-name', { name: 'a\u2029b', email: 'p9@example.com' }],
    ['escape-in-name', { name: 'a\u001bb', email: 'p10@example.com' }],
  ];
  for (const [label, override] of PROHIBITED) {
    const result = await request(deal, signers(override));
    assert.equal(result.accepted, false, `${label} must be refused`);
    assert.equal(result.status, 400, `${label}: a validation refusal, not a server error`);
    assert.match(result.message, /must not contain control characters or line breaks/, label);
    // The refused value is never echoed back in the message.
    assert.doesNotMatch(result.message, /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/, `${label}: no control byte echoed`);
  }

  // No partial write of any kind: no envelope, no signer rows, no audit rows,
  // no dispatched domain events — refusal-shaped evidence only.
  assert.equal(modules('signature-envelope').countWhere({ quoteVersionId: deal.versionId }), 0,
    'no envelope intent survives a refusal');
  assert.equal(app.database.raw.prepare('SELECT COUNT(*) AS n FROM signature_signers').get().n, 0,
    'no signer row survives a refusal');
  assert.deepEqual(auditCounts(), before, 'a refusal creates no successful audit evidence');
  assert.deepEqual(eventsSeen, [], 'a refusal dispatches no domain event');

  // No provider call happened: the fixture holds no envelope for this version.
  assert.throws(() => signatureFixture.envelope(`env:quote-version:${deal.versionId}`), /not found/,
    'the provider was never called for the refused requests');

  // The trace records the refusal as a FAILED run — visible evidence of the
  // refusal, never a successful run to mistake for progress.
  const runs = app.workflows.listRuns({ workflowName: 'quote.request-signature', limit: 100 });
  assert.ok(runs.length >= PROHIBITED.length, 'every refusal leaves a failed trace run');
  assert.ok(runs.every((run) => run.status === 'failed'), 'and none of them claims success');

  // The version is NOT burnt: the corrected retry on the SAME quote version
  // succeeds — the reproducer proved the old behaviour stranded it forever.
  const corrected = await request(deal, signers({ name: 'Maria Bianchi', email: 'corrected@example.com' }));
  assert.equal(corrected.accepted, true, 'the corrected retry succeeds on the same version');
  const envelope = modules('signature-envelope').listWhere({ quoteVersionId: deal.versionId })[0];
  assert.equal(envelope.status, 'sent');

  // Legitimate international names still pass and are stored byte-identically:
  // no ASCII allowlist, no Unicode normalization.
  for (const [label, name] of [
    ['accents', 'José García-Müller'],
    ['cjk', '田中花子'],
    ['rtl-arabic', 'محمد الأمين'],
    ['combining-marks', 'Zoë Nuñez'], // n + combining tilde, deliberately unnormalized
    ['cyrillic', 'Дмитрий Ковалёв'],
  ]) {
    const intlDeal = await approvedQuote(app, { name: `Intl ${label} Deal` });
    const result = await request(intlDeal, signers({ name, email: `${label}@example.com` }));
    assert.equal(result.accepted, true, `${label}: a legitimate international name must be accepted`);
    const intlEnvelope = modules('signature-envelope').listWhere({ quoteVersionId: intlDeal.versionId })[0];
    assert.equal(modules('signature-signer').listWhere({ envelopeId: intlEnvelope.id })[0].name, name,
      `${label}: stored byte-identical, no normalization applied`);
  }

  // Interior spaces and ordinary trimming are untouched pre-existing
  // behaviour: '  name  ' still trims, 'Mary Jane' still passes.
  const trimDeal = await approvedQuote(app, { name: 'Trim Deal' });
  const trimmed = await request(trimDeal, signers({ name: '  Mary Jane  ', email: 'trim@example.com' }));
  assert.equal(trimmed.accepted, true);
  const trimEnvelope = modules('signature-envelope').listWhere({ quoteVersionId: trimDeal.versionId })[0];
  assert.equal(modules('signature-signer').listWhere({ envelopeId: trimEnvelope.id })[0].name, 'Mary Jane');
});
