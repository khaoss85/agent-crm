import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { assertPackageConforms } from './helpers/package-conformance.js';
import { RATE_READ_CAP } from '../packages/site-forms/src/rules.js';
import { createSiteFormsPackage } from '../packages/site-forms/src/index.js';

/**
 * **Site-form intake end to end (backlog:9d42035eca26).**
 *
 * The pilot's three calls against one composed app — resolve the sender
 * (`customer-data`), open the submission, run its `submit` action — turn a
 * website-form request into an updated customer card in one synchronous
 * pass: the contact (created or matched, with channel-identity provenance),
 * its `website-form` conversation, the inbound message, and the reply
 * channels. Spam stays a rejected receipt: no contact, no message.
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

const ACTOR = { type: 'user', id: 'site-forms-e2e' };
const SPACE = 'presti';

const CUSTOMER_DATA_MANIFESTS = [
  'customer-import-run.module.json',
  'customer-import-row.module.json',
  'external-identity.module.json',
  'duplicate-candidate.module.json',
  'canonical-link.module.json',
  'data-quality-issue.module.json',
  'customer-bulk-run.module.json',
  'customer-bulk-item.module.json',
];
const INTERACTION_MANIFESTS = ['conversation.module.json', 'interaction-message.module.json', 'interaction-call.module.json'];
const SITE_FORMS_MANIFESTS = ['site-form-submission.module.json'];

function cli(root, args) {
  return spawnSync(process.execPath,
    ['--no-warnings', join(root, 'packages/cli/bin/accordo.js'), ...args, '--root', root],
    { encoding: 'utf8', cwd: root });
}

function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'accordo-site-forms-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const entry of ['packages', 'apps', 'examples', 'package.json']) {
    cpSync(join(repoRoot, entry), join(root, entry), { recursive: true });
  }
  for (const manifest of CUSTOMER_DATA_MANIFESTS) {
    const applied = cli(root, ['module', 'create', join(root, 'packages/customer-data/modules', manifest), '--apply']);
    assert.equal(applied.status, 0, `apply ${manifest}: ${applied.stderr}`);
  }
  for (const manifest of INTERACTION_MANIFESTS) {
    const applied = cli(root, ['module', 'create', join(root, 'packages/interactions/modules', manifest), '--apply']);
    assert.equal(applied.status, 0, `apply ${manifest}: ${applied.stderr}`);
  }
  for (const manifest of SITE_FORMS_MANIFESTS) {
    const applied = cli(root, ['module', 'create', join(root, 'packages/site-forms/modules', manifest), '--apply']);
    assert.equal(applied.status, 0, `apply ${manifest}: ${applied.stderr}`);
  }
  writeFileSync(join(root, 'packages/actions/generated/index.js'), 'export const generatedActions = [];\n');
  writeFileSync(join(root, 'packages/domains/generated/index.js'), [
    "import { createCustomerDataPackage } from '../../customer-data/src/index.js';",
    "import { createInteractionsPackage } from '../../interactions/src/index.js';",
    "import { createSiteFormsPackage } from '../../site-forms/src/index.js';",
    "import { definePackage } from '../../core/index.js';",
    'const cardProbe = definePackage({',
    "  packageContract: 1, name: 'card-probe', version: 1, label: 'Card probe',",
    "  description: 'A do-nothing consumer that declares the timeline capability so a test reads the card through the registry.',",
    '  resources: [], actions: [], policies: [], capabilities: [],',
    '  requires: [',
    "    { package: 'interactions', capability: 'interaction-timeline', version: 1 },",
    '  ],',
    '});',
    'export const generatedDomains = [',
    '  createCustomerDataPackage(),',
    '  createInteractionsPackage(),',
    '  createSiteFormsPackage(),',
    '  cardProbe,',
    '];',
    '',
  ].join('\n'));
  return root;
}

async function scene(t, tag) {
  const root = project(t);
  const { createAccordoApp } = await import(pathToFileURL(join(root, 'packages/app/src/index.js')).href);
  const app = createAccordoApp({ dbPath: join(root, 'data', `${tag}.sqlite`) });
  t.after(() => app.close());
  return { root, app };
}

let keySeq = 0;
const nextKey = (tag) => `${tag}-${Date.now()}-${(keySeq += 1)}`;

const FORM = Object.freeze({
  spaceId: SPACE,
  firstName: 'Luca',
  lastName: 'Rossi',
  email: 'luca@prestigroup.example',
  phone: '+39 333 123 4567',
  companyName: 'Presti Group',
  body: 'Vorrei informazioni sui pacchetti in palestra.',
  ipHash: 's'.repeat(64),
  honeypotFilled: false,
  dwellMs: 8000,
});

/** The pilot's intake order: pre-check, open (mandatory gate), resolve, submit. */
async function intake(app, fields, resolution) {
  try {
    await app.checkSiteForm({
      spaceId: fields.spaceId,
      ipHash: fields.ipHash,
      honeypotFilled: fields.honeypotFilled === true,
      dwellMs: fields.dwellMs,
    });
  } catch (error) {
    if (error.code === 'SPAM_HONEYPOT' || error.code === 'SPAM_TOO_FAST' || error.code === 'SPAM_RATE_LIMITED') {
      return { resolved: null, submission: null, outcome: null, replayed: false, refused: error.code };
    }
    throw error;
  }
  // Open gates mandatorily before the sender is resolved: a refused request
  // resolves nobody, so no contact or identity can leak from spam.
  const { submission, replayed } = await app.openSiteFormSubmission({
    ...fields, idempotencyKey: nextKey('form'),
  });
  const resolved = resolution ?? await app.resolveChannelSender({
    channel: fields.phone ? 'phone' : 'email',
    handle: fields.phone ?? fields.email,
    email: fields.email ?? undefined,
    firstName: fields.firstName ?? undefined,
    lastName: fields.lastName ?? undefined,
    companyName: fields.companyName ?? undefined,
    actor: ACTOR,
  });
  let outcome = null;
  if (!replayed && submission.status === 'pending') {
    const run = await app.runAction({
      module: 'site-form-submission',
      action: 'submit',
      recordId: submission.id,
      input: resolved.contact === null
        ? { senderOutcome: 'unresolved', senderRule: resolved.rule }
        : {
          subjectResource: resolved.contact.resource,
          subjectId: resolved.contact.id,
          senderOutcome: resolved.outcome,
          senderRule: resolved.rule,
        },
      actor: ACTOR,
    });
    outcome = run.result.submission;
  }
  return { resolved, submission, outcome, replayed };
}

function rows(app, module, where) {
  return app.modules.get(module).service.listWhere(where ?? {});
}

test('site-forms conforms to the domain-package contract it ships', () => {
  assertPackageConforms({
    definition: createSiteFormsPackage(),
    dir: join(repoRoot, 'packages/site-forms'),
    expected: {
      name: 'site-forms',
      version: 1,
      resources: ['site-form-submission'],
      actions: ['site-form-submission.submit'],
      requires: ['interactions/interaction-log@1'],
      provides: [],
    },
    forbiddenImports: [/customer-data\/src/, /interactions\/src/],
  });
  const metadata = createSiteFormsPackage().metadata();
  assert.ok(metadata.replyRule.includes('WhatsApp'), 'the reply rule is stated');
  assert.ok(metadata.notModeled.includes('paid or third-party anti-spam (captcha, scoring)'));
});

test('a form request creates the contact and lands on the card in one pass', async (t) => {
  const startedAt = Date.now();
  const { app } = await scene(t, 'site-form-happy');

  const { resolved, outcome } = await intake(app, { ...FORM });
  assert.equal(resolved.outcome, 'created');
  assert.equal(resolved.contact.resource, 'contact');
  assert.equal(outcome.status, 'accepted');
  assert.equal(outcome.replyWhatsapp, true, 'phone present: the team answers on WhatsApp');
  assert.equal(outcome.replyEmail, true, 'email present: and by email');

  // The contact the request created, with channel-identity provenance.
  const contact = app.modules.get('contact').service.get(resolved.contact.id);
  assert.equal(contact.email, 'luca@prestigroup.example');
  const identities = rows(app, 'external-identity', { subjectId: resolved.contact.id, status: 'active' });
  assert.ok(identities.length >= 1, 'the sender handle is recorded as external identity');
  assert.ok(identities.every((row) => row.lastObservedRunId === 'channel-sender'));

  // One conversation thread, one inbound website-form message.
  const messages = rows(app, 'interaction-message', { subjectId: resolved.contact.id });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].direction, 'inbound');
  assert.equal(messages[0].channel, 'website-form');
  assert.equal(messages[0].body, FORM.body);
  assert.equal(messages[0].id, outcome.messageId);
  assert.equal(messages[0].conversationId, outcome.conversationId);

  // The card reads it: the timeline carries the visitor's words.
  const timeline = app.domains.capability({
    consumer: 'card-probe', capability: 'interaction-timeline', version: 1, context: { modules: app.modules },
  });
  const history = await timeline.timeline({ resource: 'contact', id: resolved.contact.id, owner: 'host' });
  assert.ok(history.entries.some((entry) => entry.body === FORM.body), 'the card shows the form message');

  assert.ok(Date.now() - startedAt < 60_000, 'submit to card in under a minute');
});

test('a second request updates the same contact on the same thread', async (t) => {
  const { app } = await scene(t, 'site-form-update');

  const first = await intake(app, { ...FORM });
  const second = await intake(app, { ...FORM, body: 'Aggiungo una domanda sugli orari.' });
  assert.equal(second.resolved.outcome, 'matched');
  assert.equal(second.resolved.contact.id, first.resolved.contact.id, 'no second contact');
  assert.equal(second.outcome.status, 'accepted');
  assert.equal(
    second.outcome.conversationId, first.outcome.conversationId, 'one thread per customer per channel',
  );
  assert.equal(rows(app, 'interaction-message', { subjectId: first.resolved.contact.id }).length, 2);
});

test('email-only answers by email, never WhatsApp', async (t) => {
  const { app } = await scene(t, 'site-form-email');
  const fields = { ...FORM, phone: null, body: 'Solo email, grazie.' };

  const { resolved, outcome } = await intake(app, fields);
  assert.equal(resolved.outcome, 'created');
  assert.equal(outcome.status, 'accepted');
  assert.equal(outcome.replyWhatsapp, false);
  assert.equal(outcome.replyEmail, true);
});

test('phone-only on a known contact answers on WhatsApp', async (t) => {
  const { app } = await scene(t, 'site-form-phone');
  const created = await app.resolveChannelSender({
    channel: 'email', handle: 'anna@prestigroup.example',
    firstName: 'Anna', lastName: 'Bianchi', companyName: 'Presti Group', actor: ACTOR,
  });
  assert.equal(created.outcome, 'created');
  const linked = await app.resolveChannelSender({
    channel: 'phone', handle: '+393330000001', email: 'anna@prestigroup.example', actor: ACTOR,
  });
  assert.equal(linked.outcome, 'matched');
  assert.equal(linked.contact.id, created.contact.id);

  const { outcome } = await intake(app, {
    ...FORM,
    email: null,
    phone: '+393330000001',
    firstName: 'Anna',
    lastName: 'Bianchi',
    body: 'Chiamatemi su WhatsApp.',
    ipHash: 'p'.repeat(64),
  }, linked);
  assert.equal(outcome.status, 'accepted');
  assert.equal(outcome.replyWhatsapp, true);
  assert.equal(outcome.replyEmail, false);
});

test('an unknown phone-only sender stays needs-review with no message', async (t) => {
  const { app } = await scene(t, 'site-form-triage');
  const { resolved, outcome } = await intake(app, {
    ...FORM,
    email: null,
    phone: '+393339999999',
    body: 'Numero mai visto.',
    ipHash: 'q'.repeat(64),
  });
  assert.equal(resolved.outcome, 'unresolved');
  assert.equal(resolved.contact, null);
  assert.equal(outcome.status, 'needs-review');
  assert.equal(outcome.reasonCode, 'SENDER_UNRESOLVED');
  assert.equal(rows(app, 'interaction-message', {}).length, 0, 'no message from nobody');
});

test('the pre-check refuses spam before anything is written', async (t) => {
  const { app } = await scene(t, 'site-form-spam');

  const trapped = await intake(app, { ...FORM, honeypotFilled: true, body: 'Bot trap.' });
  assert.equal(trapped.refused, 'SPAM_HONEYPOT');

  const fast = await intake(app, {
    ...FORM, dwellMs: 50, body: 'Too fast.', ipHash: 'f'.repeat(64),
  });
  assert.equal(fast.refused, 'SPAM_TOO_FAST');

  assert.equal(rows(app, 'site-form-submission', {}).length, 0, 'the pre-check writes nothing');
  assert.equal(rows(app, 'interaction-message', {}).length, 0);
  assert.equal(rows(app, 'external-identity', {}).length, 0, 'no contact, no identity');
});

test('open refuses emailable spam when the pilot skips the pre-check', async (t) => {
  const { app } = await scene(t, 'site-form-regate');
  // Honeypot spam that carries an email would resolve to a contact — but the
  // pilot opens before resolving, so the mandatory gate stops it first.
  await assert.rejects(
    app.openSiteFormSubmission({
      ...FORM, honeypotFilled: true, body: 'Bot with an email.', idempotencyKey: nextKey('regate'),
    }),
    (error) => error.code === 'SPAM_HONEYPOT' && error.status === 422,
  );
  assert.equal(rows(app, 'site-form-submission', {}).length, 0, 'no row for spam');
  assert.equal(app.modules.get('contact').service.list().length, 0, 'no contact: open refused before any resolution');
  assert.equal(rows(app, 'external-identity', {}).length, 0, 'no identity');
  assert.equal(rows(app, 'interaction-message', {}).length, 0, 'no message');
});

test('the submit action re-gates a row stored outside the open gate', async (t) => {
  const { app } = await scene(t, 'site-form-regate-submit');
  const stored = await app.modules.get('site-form-submission').service.createManaged({
    sourceKey: `site-form:${SPACE}:direct-${Date.now()}`,
    spaceId: SPACE,
    status: 'pending',
    firstName: 'Luca',
    lastName: 'Rossi',
    email: 'luca@prestigroup.example',
    phone: '+393331234567',
    companyName: 'Presti Group',
    body: 'Bot trap.',
    ipHash: 'h'.repeat(64),
    honeypotFilled: true,
    dwellMs: 8000,
    subjectResource: null,
    subjectId: null,
    conversationId: null,
    messageId: null,
    replyWhatsapp: false,
    replyEmail: false,
    reasonCode: null,
    occurredAt: new Date().toISOString(),
    decidedAt: null,
  }, { actor: ACTOR });
  const run = await app.runAction({
    module: 'site-form-submission', action: 'submit', recordId: stored.id,
    input: { senderOutcome: 'unresolved', senderRule: 'none' },
    actor: ACTOR,
  });
  assert.equal(run.result.submission.status, 'rejected');
  assert.equal(run.result.submission.reasonCode, 'SPAM_HONEYPOT');
  assert.equal(rows(app, 'interaction-message', {}).length, 0);
});

test('the pre-check and open fail closed past the read cap', async (t) => {
  const { app } = await scene(t, 'site-form-cap');
  const service = app.modules.get('site-form-submission').service;
  const ipHash = 'z'.repeat(64);
  for (let index = 0; index < RATE_READ_CAP; index += 1) {
    await service.createManaged({
      sourceKey: `site-form:${SPACE}:cap-${index}`,
      spaceId: SPACE,
      status: 'pending',
      firstName: 'Luca',
      lastName: 'Rossi',
      email: 'luca@prestigroup.example',
      phone: '+393331234567',
      companyName: 'Presti Group',
      body: `Flood ${index}.`,
      ipHash,
      honeypotFilled: false,
      dwellMs: 8000,
      subjectResource: null,
      subjectId: null,
      conversationId: null,
      messageId: null,
      replyWhatsapp: false,
      replyEmail: false,
      reasonCode: null,
      occurredAt: new Date().toISOString(),
      decidedAt: null,
    }, { actor: ACTOR });
  }
  // The capped window read is itself the flood: both gates refuse it.
  await assert.rejects(
    app.checkSiteForm({ spaceId: SPACE, ipHash, honeypotFilled: false, dwellMs: 9000 }),
    (error) => error.code === 'SPAM_RATE_LIMITED' && error.status === 422,
  );
  await assert.rejects(
    app.openSiteFormSubmission({
      ...FORM, ipHash, body: 'Flood.', idempotencyKey: nextKey('cap'),
    }),
    (error) => error.code === 'SPAM_RATE_LIMITED' && error.status === 422,
  );
  assert.equal(app.modules.get('contact').service.list().length, 0, 'no contact from the flood');
});

test('the sixth rapid request from one submitter is rate-limited', async (t) => {
  const { app } = await scene(t, 'site-form-rate');
  const accepted = [];
  for (let index = 0; index < 5; index += 1) {
    const { outcome } = await intake(app, { ...FORM, body: `Richiesta ${index}.` });
    accepted.push(outcome.status);
  }
  assert.deepEqual(accepted, ['accepted', 'accepted', 'accepted', 'accepted', 'accepted']);
  // The pre-check refuses the sixth before anything is written.
  const refused = await intake(app, { ...FORM, body: 'La sesta.' });
  assert.equal(refused.refused, 'SPAM_RATE_LIMITED');
  // And open refuses the same way when the pilot skips the check: no row.
  await assert.rejects(
    app.openSiteFormSubmission({
      ...FORM, body: 'La sesta bis.', idempotencyKey: nextKey('sesta'),
    }),
    (error) => error.code === 'SPAM_RATE_LIMITED' && error.status === 422,
  );
  assert.equal(rows(app, 'site-form-submission', {}).length, 5, 'the refused open stores nothing');
});

test('the same idempotency key replays the stored row', async (t) => {
  const { app } = await scene(t, 'site-form-replay');
  const key = nextKey('once');
  const fields = { ...FORM, idempotencyKey: key };
  const first = await app.openSiteFormSubmission(fields);
  assert.equal(first.replayed, false);
  const second = await app.openSiteFormSubmission(fields);
  assert.equal(second.replayed, true);
  assert.equal(second.submission.id, first.submission.id);
  assert.equal(rows(app, 'site-form-submission', { sourceKey: first.submission.sourceKey }).length, 1);

  const resolved = await app.resolveChannelSender({
    channel: 'phone', handle: fields.phone, email: fields.email,
    firstName: fields.firstName, lastName: fields.lastName, companyName: fields.companyName, actor: ACTOR,
  });
  const run = await app.runAction({
    module: 'site-form-submission', action: 'submit', recordId: first.submission.id,
    input: {
      subjectResource: resolved.contact.resource, subjectId: resolved.contact.id,
      senderOutcome: resolved.outcome, senderRule: resolved.rule,
    },
    actor: ACTOR,
  });
  assert.equal(run.result.submission.status, 'accepted');
  await assert.rejects(
    app.runAction({
      module: 'site-form-submission', action: 'submit', recordId: first.submission.id,
      input: {
        subjectResource: resolved.contact.resource, subjectId: resolved.contact.id,
        senderOutcome: resolved.outcome, senderRule: resolved.rule,
      },
      actor: ACTOR,
    }),
    (error) => error.code === 'INVALID_STATE' && error.status === 409,
  );
});

test('two parallel opens behind one key leave one row', async (t) => {
  const { app } = await scene(t, 'site-form-race');
  const key = nextKey('race');
  const fields = { ...FORM, idempotencyKey: key };
  const [left, right] = await Promise.all([
    app.openSiteFormSubmission(fields),
    app.openSiteFormSubmission(fields),
  ]);
  assert.equal(left.submission.id, right.submission.id, 'one winner, the loser replays');
  assert.equal(left.replayed !== right.replayed, true, 'exactly one side replays');
  assert.equal(rows(app, 'site-form-submission', { sourceKey: left.submission.sourceKey }).length, 1);
});

test('checkSiteForm pre-checks spam without writing', async (t) => {
  const { app } = await scene(t, 'site-form-check');
  const clean = await app.checkSiteForm({
    spaceId: SPACE, ipHash: 'c'.repeat(64), honeypotFilled: false, dwellMs: 9000,
  });
  assert.deepEqual(clean, { ok: true });
  await assert.rejects(
    app.checkSiteForm({ spaceId: SPACE, ipHash: 'c'.repeat(64), honeypotFilled: true, dwellMs: 9000 }),
    (error) => error.code === 'SPAM_HONEYPOT' && error.status === 422,
  );
  assert.equal(rows(app, 'site-form-submission', {}).length, 0, 'the pre-check writes nothing');
});

test('the snippet endpoint serves one space only', async (t) => {
  const { app } = await scene(t, 'site-form-snippet');
  const snippet = await app.siteFormSnippet({ spaceId: SPACE, endpoint: 'https://app.accordo.dev' });
  assert.equal(snippet.spaceId, SPACE);
  assert.equal(snippet.action, 'https://app.accordo.dev/site/presti/submit');
  assert.ok(snippet.html.includes('data-accordo-space="presti"'));
});
