import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  approvedQuote, boot, characterizationProject, loadFixture,
} from './characterization/signature-harness.mjs';

/**
 * Signer input integrity: control characters in signer fields.
 *
 * **This commit is the reproducer.** The assertions below prove the CURRENT
 * defective behaviour — found and recorded as the one `defect_candidate` of the
 * Signature LA0 baseline (`hostile-input.signer-newline-and-null-byte`): the
 * signer `name`, `email` and `role` fields accept C0/C1 control characters,
 * a NUL byte survives validation and is then silently mutated in storage, and
 * the polluted signer list flows into the canonical document package the
 * provider signs. The fix commit inverts every "accepted" assertion here into
 * the refusal contract, using the same rule `record-signal` adopted in
 * 1e40d1e. Committing the proof first is what makes the fix's diff readable:
 * red is this file's assertions, green is the inversion.
 */

const signers = (overrides) => [{ name: 'Maria Bianchi', email: 'signer@example.com', role: 'customer', order: 1, ...overrides }];

test('CURRENT BEHAVIOUR (the defect): control characters in signer fields are accepted', async (t) => {
  const root = characterizationProject(t, { name: 'accordo-signer-red-' });
  const instance = await boot(root, join(root, 'data', 'signer-red.sqlite'));
  t.after(() => instance.close().catch(() => {}));
  const { app, client } = instance;
  const { signatureFixture } = await loadFixture(root);
  signatureFixture.reset();
  const modules = (name) => app.modules.get(name).service;

  const request = async (deal, list) => client.module('quote').action(deal.quote.id, 'request-signature', {
    quoteVersionId: deal.versionId, provider: 'fixture-signature', providerVersion: 1, signers: list,
  }).then(() => ({ accepted: true }), (error) => ({ accepted: false, code: error.code, status: error.status }));

  // 1. A newline inside the signer name is accepted, an envelope is created,
  //    the provider is called, and the value is stored verbatim — multi-line
  //    text in a single-line identity label of a signed document.
  const newlineDeal = await approvedQuote(app, { name: 'Red Newline Deal' });
  const newline = await request(newlineDeal, signers({ name: 'a\nb', email: 'nl@example.com' }));
  assert.equal(newline.accepted, true, 'DEFECT: a newline name is accepted');
  const newlineEnvelope = modules('signature-envelope').listWhere({ quoteVersionId: newlineDeal.versionId })[0];
  assert.ok(newlineEnvelope, 'DEFECT: the envelope was created');
  assert.equal(modules('signature-signer').listWhere({ envelopeId: newlineEnvelope.id })[0].name, 'a\nb',
    'DEFECT: stored verbatim, and already inside the signed document package');

  // 2. A NUL byte in the role is accepted and then SILENTLY MUTATED in
  //    storage — the stored evidence is not the input that was validated.
  const nulDeal = await approvedQuote(app, { name: 'Red Nul Deal' });
  const nul = await request(nulDeal, signers({ email: 'nul@example.com', role: 'r\u0000oot' }));
  assert.equal(nul.accepted, true, 'DEFECT: a NUL-byte role is accepted');
  const nulEnvelope = modules('signature-envelope').listWhere({ quoteVersionId: nulDeal.versionId })[0];
  const nulRow = modules('signature-signer').listWhere({ envelopeId: nulEnvelope.id })[0];
  assert.notEqual(nulRow.role, 'r\u0000oot', 'DEFECT: what was stored is not what was validated');

  // 3. A NUL byte in the email LOCAL PART passes the email regex — \\u0000 is
  //    not JavaScript whitespace, so [^\\s@] matches it.
  const emailDeal = await approvedQuote(app, { name: 'Red Email Deal' });
  const email = await request(emailDeal, signers({ email: 'x\u0000y@example.com' }));
  assert.equal(email.accepted, true, 'DEFECT: a NUL-byte email is accepted');

  // 4. C1 controls (U+0085) and the Unicode line separators pass too.
  const c1Deal = await approvedQuote(app, { name: 'Red C1 Deal' });
  assert.equal((await request(c1Deal, signers({ name: 'a\u0085b', email: 'c1@example.com' }))).accepted, true,
    'DEFECT: a C1 control in the name is accepted');
  const lsDeal = await approvedQuote(app, { name: 'Red LS Deal' });
  assert.equal((await request(lsDeal, signers({ email: 'ls@example.com', role: 'a\u2028b' }))).accepted, true,
    'DEFECT: U+2028 in the role is accepted');

  // 5. And because the envelope was created, the quote version is now BURNT:
  //    the retry with corrected input is refused forever (one envelope per
  //    version, no resend path). The defect is not cosmetic — it strands the
  //    deal behind evidence built from polluted input.
  const retry = await request(newlineDeal, signers({ name: 'a b', email: 'nl@example.com' }));
  assert.equal(retry.accepted, false);
  assert.equal(retry.code, 'ENVELOPE_EXISTS', 'DEFECT CONSEQUENCE: the corrected retry is stranded');

  // What already holds, and must keep holding after the fix: legitimate
  // international names are accepted and stored byte-identically.
  for (const [label, name] of [
    ['accents', 'José García-Müller'],
    ['cjk', '田中花子'],
    ['rtl-arabic', 'محمد الأمين'],
    ['combining-marks', 'Zoë Nuñez'],
    ['cyrillic', 'Дмитрий Ковалёв'],
  ]) {
    const deal = await approvedQuote(app, { name: `Red Intl ${label} Deal` });
    const result = await request(deal, signers({ name, email: `${label}@example.com` }));
    assert.equal(result.accepted, true, `${label}: a legitimate international name must be accepted`);
    const envelope = modules('signature-envelope').listWhere({ quoteVersionId: deal.versionId })[0];
    assert.equal(modules('signature-signer').listWhere({ envelopeId: envelope.id })[0].name, name,
      `${label}: stored byte-identical`);
  }
});
