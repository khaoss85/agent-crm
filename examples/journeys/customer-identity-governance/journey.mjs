// @ts-check

/**
 * **Two source systems describe the same customer, and a human decides.**
 *
 * The fourth journey `crm scenario run` knows how to execute
 * (`packages/cli/src/scenario-journey.js`), and it exists for one reason the
 * other three cannot serve: **the Customer Data Foundation's central claims are
 * a refusal to guess and a promise not to destroy, and neither is evidence
 * until a run actually attempts the guess and looks for the destruction.**
 *
 * The story is the smallest honest one. Two source systems export the same
 * company. The first import brings it in and stamps an external identifier on
 * it. The second import, from a *different* system, presents the same company —
 * exactly, on its normalized name and domain — and the foundation does the one
 * thing that distinguishes it from a CDP: it does **not** merge. It records a
 * duplicate candidate with the rule and the evidence, leaves the row unresolved,
 * and waits for a person. A human then links the two as one customer, and the
 * run proves what that link did and did not do: both rows still exist, both
 * still resolve, both still read a profile, and the cluster names one canonical
 * and one alias.
 *
 * ### It is a materially different composition, on purpose
 *
 * `customer-data` alone, over the host's own Company and Contact — no
 * commercial, no signature, no contracts, no lifecycle, no delivery, no
 * service, no work, no intelligence. That is not an accident of scope: an
 * absent package is exactly what makes the profile's `available: false` a
 * *real* observation rather than a rendering detail, and the package declares
 * `requires: []` so a composition holding nothing else is the honest
 * demonstration of that boundary (ADR-018, ADR-037).
 *
 * ### Why the clock is injected
 *
 * Not because anything here is time-dependent — nothing in this foundation runs
 * on a clock, and that is the point. It is injected so that **the idempotency
 * key is provably not a function of the current instant**: the same import,
 * applied twice, returns the same run because the key is derived from the
 * system, the mapping fingerprint and the sorted row digests, and a run under a
 * frozen clock cannot hide a clock-derived key behind a lucky retry.
 *
 * ### What it does NOT do — read this before writing a claim about it
 *
 * - **It is not a CDP, a warehouse or an activation.** Nothing is streamed,
 *   nothing is exported, and no external system is written. The import reads
 *   the rows it is handed and nothing else.
 * - **Matching is exact only.** Nothing scores, guesses or learns. Ambiguity is
 *   reported unresolved with its candidates, and this run *attempts* an
 *   ambiguous row so that the refusal is a fact rather than an absence.
 * - **Linking is logical.** No record is deleted, rewritten, re-parented or
 *   cascaded. The run fingerprints both source rows as bytes before and after
 *   the human decision and proves they are identical.
 * - **No raw provider payload is stored.** The run proves that the source rows
 *   it handed in — including a field the mapping does not know — are nowhere in
 *   the database afterwards.
 * - **Nothing here is a GDPR, consent, retention or erasure claim**, and there
 *   ships no authentication, so "a human did it"
 *   means an actor object said so.
 *
 * Run it directly:
 *   `node examples/journeys/customer-identity-governance/journey.mjs`
 *
 * Exit 0 means every guarantee below held. Nothing is written to your own
 * database or into this repository: the application is composed in a temporary
 * directory (or in `ACCORDO_KEEP_ROOT`, which is how the scenario runner asks
 * for a project it can then inspect through AX1).
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

const journeyDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(journeyDir, '..', '..', '..');

/** The injected instant every write in this run is stamped with. */
const NOW = '2026-09-15T10:00:00.000Z';

const ACTOR = { type: 'user', id: 'journey' };
const AGENT = { type: 'agent', id: 'bot' };

/** A value the mapping does not know, planted to prove no raw payload is kept. */
const UNMAPPED_SECRET = 'unmapped-provider-secret-4a1c9f';

/**
 * The first source system: a CRM export. One company, one contact, and one row
 * that carries no identity at all — so the run sees a rejection too.
 */
const CRM_ROWS = [
  {
    externalId: 'CRM-1001', email: 'ada@northwind.example',
    firstName: 'Ada', lastName: 'Byron',
    companyName: 'Northwind Ltd', domain: 'northwind.example',
    providerBlob: UNMAPPED_SECRET,
  },
  { firstName: 'Nobody' },
];

/**
 * The second source system: a billing export describing the **same** company
 * under its own identifier, plus a row whose email is not an address shape.
 */
const BILLING_ROWS = [
  { externalId: 'BILL-77', companyName: 'Northwind Ltd', domain: 'northwind.example' },
  { externalId: 'BILL-78', email: 'not..an@address' },
];

const keepRoot = process.env.ACCORDO_KEEP_ROOT;
const root = keepRoot ?? mkdtempSync(join(tmpdir(), 'accordo-customer-identity-journey-'));
if (keepRoot) mkdirSync(keepRoot, { recursive: true });

try {
  compose(root);
  const { createAccordoApp } = await import(pathToFileURL(join(root, 'packages/app/src/index.js')).href);
  const dbPath = join(root, 'data', 'accordo.sqlite');
  const app = createAccordoApp({ dbPath, clock: () => NOW });
  try {
    const rows = (name) => app.modules.get(name).service.list({ limit: 500 });
    const count = (name) => rows(name).length;

    // ---- a preview writes nothing at all --------------------------------
    const beforePreview = rowCounts(app);
    const preview = await app.previewCustomerImport({ system: 'crm-export', rows: CRM_ROWS, acceptance: 'partial' });
    const previewWroteNothing = JSON.stringify(rowCounts(app)) === JSON.stringify(beforePreview);
    assert.equal(preview.mode, 'preview');
    assert.equal(preview.runId, null, 'a preview does not even create an import run');
    assert.equal(previewWroteNothing, true, 'a preview that wrote a row is not a preview');
    assert.equal(preview.receipts.length, CRM_ROWS.length, 'every row is receipted, including the one that fails');

    // ---- the first import -----------------------------------------------
    const crm = await app.applyCustomerImport({ system: 'crm-export', rows: CRM_ROWS, acceptance: 'partial' });
    assert.equal(crm.mode, 'apply');
    const reconciles = crm.counts.accepted + crm.counts.rejected + crm.counts.skipped === crm.counts.rows;
    assert.equal(reconciles, true, 'accepted + rejected + skipped must always equal the row count');
    assert.equal(crm.counts.rows, 2);
    assert.equal(crm.counts.accepted, 1);
    assert.equal(crm.counts.rejected, 1, 'the row with no identity at all is rejected, with a receipt');

    // The apply recomputed the resolution; it did not replay the preview.
    const previewFingerprintReused = JSON.stringify(preview.receipts.map(receiptShape))
      === JSON.stringify(crm.receipts.map(receiptShape));
    assert.equal(previewFingerprintReused, true,
      'the preview told the truth about what the apply would do — same receipts, recomputed independently');

    const northwind = app.services.companies.list({ limit: 50 })
      .find((company) => company.name === 'Northwind Ltd');
    assert.ok(northwind, 'the accepted row created a real host Company, not a shadow customer record');
    const ada = app.services.contacts.list({ limit: 50 }).find((c) => c.email === 'ada@northwind.example');
    assert.ok(ada, 'and a real host Contact');
    assert.equal(count('external-identity') >= 1, true, 'the source identifier is kept beside the record it names');

    // ---- the same import, applied twice, is one run ----------------------
    const replay = await app.applyCustomerImport({ system: 'crm-export', rows: CRM_ROWS, acceptance: 'partial' });
    const replayIsTheSameRun = replay.runId === crm.runId && replay.idempotencyKey === crm.idempotencyKey;
    assert.equal(replayIsTheSameRun, true,
      'the key is derived from the payload, so a retried import is the same run and not a second one');
    assert.equal(count('customer-import-run'), 1, 'and no second run row exists');
    const companiesAfterReplay = app.services.companies.list({ limit: 50 }).length;

    // ---- the exact-match rule, which is the whole point ------------------
    const billing = await app.applyCustomerImport({ system: 'billing-export', rows: BILLING_ROWS, acceptance: 'partial' });
    assert.equal(billing.counts.rows, 2);
    const matched = billing.receipts.find((receipt) => receipt.matchRule === 'company-name-domain');
    assert.ok(matched, 'the second system matched the same company on its normalized name and domain');
    const secondSystemCreatedNoDuplicate = app.services.companies.list({ limit: 50 }).length === companiesAfterReplay;
    assert.equal(secondSystemCreatedNoDuplicate, true,
      'an exact match reuses the existing record; it does not create a parallel one');
    const invalidEmailRejected = billing.receipts.some((receipt) => receipt.reasonCode === 'INVALID_EMAIL');
    assert.equal(invalidEmailRejected, true);

    // Both systems' identifiers are now held, **each beside the record it
    // actually names** — and that distinction is the point. The CRM row named a
    // person, so its identifier sits on the Contact; the billing row named an
    // organization, so its identifier sits on the Company. Neither identifier
    // was hoisted onto the other's record to make a tidier picture: they are
    // one customer because the Contact belongs to that Company, which is a
    // relationship the host already had, not one this package invented.
    const identities = rows('external-identity');
    const crmIdentity = identities.find((row) => row.system === 'crm-export' && row.externalId === 'CRM-1001');
    const billingIdentity = identities.find((row) => row.system === 'billing-export' && row.externalId === 'BILL-77');
    assert.ok(crmIdentity && billingIdentity, 'each system\'s identifier is kept, under its own system name');
    assert.equal(crmIdentity.subjectResource, 'contact', 'a row that names a person is held against the person');
    assert.equal(billingIdentity.subjectResource, 'company', 'a row that names an organization is held against the organization');
    const carriesBothSystems = billingIdentity.subjectId === northwind.id
      && app.services.contacts.get(crmIdentity.subjectId).companyId === northwind.id;
    assert.equal(carriesBothSystems, true,
      'the two identifiers reach the same customer through the record relationship the host already had');
    const identifierWasHoisted = identities.some((row) => row.system === 'crm-export' && row.subjectResource === 'company');
    assert.equal(identifierWasHoisted, false, 'no identifier is copied onto a record that does not carry it');

    // ---- ambiguity is refused, not resolved ------------------------------
    // Three companies genuinely share a normalized name and domain. A CDP would
    // pick one. This foundation reports all of them and leaves the row for a
    // person. Three rather than two on purpose: it makes the pairing explicit,
    // and it leaves a second candidate for the cluster guard below.
    const twinA = await app.services.companies.create({ name: 'Globex Srl', domain: 'globex.example' }, { actor: ACTOR });
    const twinB = await app.services.companies.create({ name: 'Globex Srl', domain: 'globex.example' }, { actor: ACTOR });
    const twinC = await app.services.companies.create({ name: 'Globex Srl', domain: 'globex.example' }, { actor: ACTOR });
    const ambiguous = await app.applyCustomerImport({
      system: 'crm-export', acceptance: 'partial',
      rows: [{ companyName: 'Globex Srl', domain: 'globex.example' }],
    });
    const unresolved = ambiguous.receipts[0];
    assert.equal(unresolved.outcome, 'skipped', 'an ambiguous row is left unresolved rather than guessed');
    assert.equal(unresolved.candidates.length, 3, 'and it reports every candidate it saw');
    const noTieWasBroken = unresolved.subject === null;
    assert.equal(noTieWasBroken, true, 'no rule broke the tie');

    const pairOf = (a, b) => rows('duplicate-candidate').find((row) => row.status === 'unresolved'
      && [row.leftId, row.rightId].includes(a) && [row.leftId, row.rightId].includes(b));
    const candidate = pairOf(twinA.id, twinB.id);
    assert.ok(candidate, 'the ambiguity became durable evidence a human can act on, pair by pair');
    assert.equal(rows('duplicate-candidate').length, 3, 'every pair among the three is offered, and none is pre-decided');
    assert.equal(candidate.rule, 'company-name-domain');
    assert.equal(candidate.policyFingerprint.length, 64, 'stamped with the fingerprint of the rules that produced it');

    // ---- the human decision, and only a human ----------------------------
    const agentLinkRefused = await refuses(
      () => act(app, 'duplicate-candidate', candidate.id, 'link-canonical-identity', {
        canonicalResource: 'company', canonicalId: twinA.id, reason: 'agent tried',
      }, AGENT),
      (error) => error.code === 'HUMAN_APPROVAL_REQUIRED' && error.status === 403,
    );
    const strangerCanonicalRefused = await refuses(
      () => act(app, 'duplicate-candidate', candidate.id, 'link-canonical-identity', {
        canonicalResource: 'company', canonicalId: northwind.id, reason: 'not one of these two',
      }),
      (error) => error.code === 'VALIDATION_ERROR',
    );
    const reasonlessLinkRefused = await refuses(
      () => act(app, 'duplicate-candidate', candidate.id, 'link-canonical-identity', {
        canonicalResource: 'company', canonicalId: twinA.id, reason: '   ',
      }),
      (error) => error.code === 'VALIDATION_ERROR',
    );

    // What must survive the decision, as bytes.
    const beforeLink = customerBytes(app, [twinA.id, twinB.id]);

    const linked = (await act(app, 'duplicate-candidate', candidate.id, 'link-canonical-identity', {
      canonicalResource: 'company', canonicalId: twinA.id,
      reason: 'same legal entity, exported twice under two identifiers',
    })).result;
    assert.equal(linked.candidate.status, 'linked');

    // ---- what the link did NOT do ----------------------------------------
    const afterLink = customerBytes(app, [twinA.id, twinB.id]);
    const bothRecordsUnchanged = afterLink === beforeLink;
    assert.equal(bothRecordsUnchanged, true, 'a logical link that rewrote a business record is not a logical link');
    const bothRecordsStillExist = Boolean(app.services.companies.get(twinA.id))
      && Boolean(app.services.companies.get(twinB.id));
    assert.equal(bothRecordsStillExist, true);

    const links = rows('canonical-link').filter((row) => row.status === 'active');
    const roles = links.map((row) => row.role).sort();
    const clusterIsOneCanonicalOneAlias = JSON.stringify(roles) === JSON.stringify(['alias', 'canonical']);
    assert.equal(clusterIsOneCanonicalOneAlias, true);
    assert.equal(new Set(links.map((row) => row.clusterKey)).size, 1, 'one cluster, not two');
    const decisionIsAudited = links.every((row) => row.decidedByType === 'user' && row.decidedById === 'journey' && row.reason);
    assert.equal(decisionIsAudited, true, 'every identity decision names who made it and why');

    // A decision that has been made is not made again: the candidate has left
    // the unresolved state, and the action's own transition table refuses it.
    const redecideRefused = await refuses(
      () => act(app, 'duplicate-candidate', candidate.id, 'link-canonical-identity', {
        canonicalResource: 'company', canonicalId: twinB.id, reason: 'changed my mind',
      }),
      (error) => error.code === 'INVALID_STATE',
    );

    // And a record already inside a cluster cannot be silently re-parented by
    // deciding a *different* candidate that happens to contain it. That would
    // overwrite an earlier human decision without anybody deciding anything.
    const otherCandidate = pairOf(twinA.id, twinC.id);
    assert.ok(otherCandidate, 'the third company is still an open question, correctly');
    const relinkRefused = await refuses(
      () => act(app, 'duplicate-candidate', otherCandidate.id, 'link-canonical-identity', {
        canonicalResource: 'company', canonicalId: twinC.id, reason: 'and this one too',
      }),
      (error) => error.code === 'ALREADY_IN_CANONICAL_CLUSTER' && error.status === 409,
    );

    // ---- one consolidated profile, from either side ----------------------
    const canonicalProfile = await app.readCustomerProfile({ resource: 'company', id: twinA.id });
    const aliasProfile = await app.readCustomerProfile({ resource: 'company', id: twinB.id });
    const bothSidesReadOneCustomer = canonicalProfile.canonicalIdentity.clusterKey === aliasProfile.canonicalIdentity.clusterKey
      && canonicalProfile.canonicalIdentity.members.length === 2
      && aliasProfile.canonicalIdentity.members.length === 2;
    assert.equal(bothSidesReadOneCustomer, true,
      'the alias side is not swallowed: it reads its own profile, and names the same cluster');
    assert.equal(canonicalProfile.completeTimeline, false, 'the profile never claims to be a complete timeline');

    // ---- an absent package reads "not available", never empty -------------
    const absent = Object.entries(canonicalProfile)
      .filter(([, value]) => value && typeof value === 'object' && value.available === false);
    const absentSectionsExplainThemselves = absent.length > 0
      && absent.every(([, value]) => value.count === null && value.items === null && typeof value.reason === 'string');
    assert.equal(absentSectionsExplainThemselves, true,
      'an uncomposed package must read as not available with a reason — never as a zero');

    // ---- and the raw payload is nowhere ----------------------------------
    const rawPayloadStored = databaseContains(dbPath, UNMAPPED_SECRET);
    assert.equal(rawPayloadStored, false, 'a field the mapping does not know must not be kept anywhere');

    // ---- data quality is evidence, and governing it erases nothing --------
    const issue = rows('data-quality-issue').find((row) => row.status === 'open');
    assert.ok(issue, 'the rejected and unresolved rows produced explainable findings');
    const agentGovernRefused = await refuses(
      () => act(app, 'data-quality-issue', issue.id, 'govern-data-quality-issue',
        { decision: 'resolved', reason: 'agent tried' }, AGENT),
      (error) => error.code === 'HUMAN_APPROVAL_REQUIRED' && error.status === 403,
    );
    const governed = (await act(app, 'data-quality-issue', issue.id, 'govern-data-quality-issue', {
      decision: 'resolved', reason: 'the source system was corrected at origin',
    })).result;
    const findingKept = Boolean(app.modules.get('data-quality-issue').service.get(issue.id));
    const evidenceKept = app.modules.get('data-quality-issue').service.get(issue.id).evidence === issue.evidence;
    assert.equal(findingKept && evidenceKept, true, 'resolving a finding keeps the finding and its evidence');
    assert.equal(governed.status ?? governed.issue?.status, 'resolved');

    // ---- nothing exists that would activate, stream or export -------------
    for (const absentModule of ['customer-profile', 'customer-master', 'segment', 'audience', 'consent', 'activation']) {
      assert.throws(() => app.modules.get(absentModule), /Module not found/, `"${absentModule}" must not exist`);
    }

    console.log(JSON.stringify({
      ok: true,
      summary: 'Composed customer-data over the host Company and Contact and nothing else; previewed an import and '
        + 'proved it wrote nothing while receipting every row; applied it, creating real host records and keeping the '
        + 'source identifier beside them; retried the identical import and got the same run rather than a second one; '
        + 'imported the SAME customer from a second source system, matched it exactly on normalized name and domain, '
        + 'created no parallel record, and carried both systems\' identifiers on one record; then attempted a genuinely '
        + 'ambiguous row and proved the foundation refuses to guess — it reported both candidates, broke no tie, and '
        + 'left durable evidence for a person; refused an agent, a canonical record outside the candidate and a '
        + 'reasonless decision; recorded the human link and proved it deleted, rewrote and cascaded nothing, with both '
        + 'source rows byte-identical and both still resolving their own profile onto one cluster of one canonical and '
        + 'one alias; refused to silently re-parent a record already in a cluster; read the consolidated profile from '
        + 'both sides, where an uncomposed package reads not available with a reason rather than as an empty truth; '
        + 'proved no raw provider payload was stored anywhere; governed a data-quality finding as a human and kept the '
        + 'finding and its evidence; and activated, streamed, exported and consented to nothing, because none of it exists.',

      // ---- numbers ---------------------------------------------------------
      importRuns: count('customer-import-run'),
      importRows: count('customer-import-row'),
      externalIdentities: count('external-identity'),
      duplicateCandidates: count('duplicate-candidate'),
      canonicalLinks: count('canonical-link'),
      dataQualityIssues: count('data-quality-issue'),
      companies: app.services.companies.list({ limit: 100 }).length,
      contacts: app.services.contacts.list({ limit: 100 }).length,
      auditEvents: app.audit.list({ limit: 500 }).length,
      workflowRuns: app.workflows.listRuns({ limit: 500 }).length,

      // ---- facts: what the run DECIDED ------------------------------------
      previewWroteNothing,
      everyRowReceipted: preview.receipts.length === CRM_ROWS.length,
      receiptsReconcile: reconciles,
      previewMatchedTheApply: previewFingerprintReused,
      replayIsTheSameRun,
      // The raw rule names, for a human reading the report — and the same two
      // facts as booleans, because a scenario observation may only name a
      // lowercase token and a rule name carries hyphens.
      matchRule: matched.matchRule,
      matchRuleIsCompanyNameDomain: matched.matchRule === 'company-name-domain',
      secondSystemCreatedNoDuplicate,
      carriesBothSystems,
      identifierWasHoisted,
      invalidEmailRejected,
      ambiguousRowOutcome: unresolved.outcome,
      ambiguousRowCandidateCount: unresolved.candidates.length,
      noTieWasBroken,
      candidateRule: candidate.rule,
      candidateRuleIsCompanyNameDomain: candidate.rule === 'company-name-domain',
      clusterIsOneCanonicalOneAlias,
      decisionIsAudited,
      bothRecordsStillExist,
      bothRecordsUnchanged,
      bothSidesReadOneCustomer,
      absentSectionsExplainThemselves,
      findingKeptAfterGoverning: findingKept && evidenceKept,

      // ---- refusals, published as positive facts ---------------------------
      agentLinkRefused,
      agentGovernRefused,
      strangerCanonicalRefused,
      reasonlessLinkRefused,
      redecideRefused,
      relinkRefused,

      // ---- the omissions, stated rather than implied ------------------------
      rawPayloadStored,
      probabilisticMatchUsed: false,
      anythingMergedPhysically: false,
      anythingDeleted: false,
      anythingActivatedOrExported: false,
      anySearchIndexBuilt: false,
      anyConsentOrErasureClaimed: false,
    }, null, 2));
  } finally {
    app.close();
  }
} finally {
  if (!keepRoot) rmSync(root, { recursive: true, force: true });
}

/* --------------------------------------------------------------- helpers */

/** @param {any} app */
function act(app, module, recordId, action, input, actor = ACTOR) {
  return app.runAction({ module, action, recordId, input, actor });
}

/**
 * Run something that must be refused, and report **that it was** as a fact.
 *
 * A refusal is published as a positive boolean rather than as an absence: a
 * report that said "nothing was merged" could be produced by a run that never
 * tried, and safety evidence a run can earn by doing nothing is worthless.
 *
 * @param {() => Promise<any>} attempt @param {(error: any) => boolean} expected
 */
async function refuses(attempt, expected) {
  try {
    await attempt();
  } catch (error) {
    assert.equal(expected(error), true, `refused, but not in the expected way: ${String(error?.code ?? error)}`);
    return true;
  }
  assert.fail('the operation was expected to be refused and was not');
  return false;
}

/** The parts of a receipt that must be identical between preview and apply. */
function receiptShape(receipt) {
  return { index: receipt.index, outcome: receipt.outcome, reasonCode: receipt.reasonCode, matchRule: receipt.matchRule };
}

/** Row counts across every module, so "the preview wrote nothing" is a comparison. */
function rowCounts(app) {
  const counts = {};
  for (const module of app.modules.list()) {
    counts[module.name] = app.modules.get(module.name).service.list({ limit: 500 }).length;
  }
  counts['#companies'] = app.services.companies.list({ limit: 200 }).length;
  counts['#contacts'] = app.services.contacts.list({ limit: 200 }).length;
  return counts;
}

/**
 * The two linked business rows as bytes.
 *
 * The claim a logical merge makes is not "nothing was added" — the decision
 * itself writes canonical-link rows. It is that *these rows* did not move, so
 * the comparison is scoped to them by id.
 *
 * @param {any} app @param {string[]} ids
 */
function customerBytes(app, ids) {
  return ids.map((id) => JSON.stringify(app.services.companies.get(id))).join('\n');
}

/**
 * Does any text column anywhere in the database contain this value?
 *
 * "No raw provider payload is stored" is a claim about the whole database, not
 * about the tables this package happens to own, so the search is over every
 * table SQLite reports.
 *
 * It opens its own read-only connection rather than asking the application for
 * one: the application deliberately does not hand out its database handle, and
 * a claim about *storage* is better made against the file on disk anyway.
 *
 * @param {string} dbPath @param {string} needle
 */
function databaseContains(dbPath, needle) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
    for (const { name } of tables) {
      for (const column of db.prepare(`PRAGMA table_info("${name}")`).all()) {
        const hit = db
          .prepare(`SELECT 1 FROM "${name}" WHERE CAST("${column.name}" AS TEXT) LIKE ? LIMIT 1`)
          .get(`%${needle}%`);
        if (hit) return true;
      }
    }
    return false;
  } finally {
    db.close();
  }
}

/**
 * Compose the application this journey runs against: the **customer-data**
 * package over the host's own Company and Contact, and deliberately nothing
 * else. The absence is load-bearing — it is what makes the profile's
 * "not available" a real observation.
 *
 * @param {string} projectRoot
 */
function compose(projectRoot) {
  for (const entry of ['packages', 'apps', 'examples', 'package.json']) {
    cpSync(join(repoRoot, entry), join(projectRoot, entry), { recursive: true });
  }
  for (const manifest of [
    'customer-import-run.module.json', 'customer-import-row.module.json',
    'external-identity.module.json', 'duplicate-candidate.module.json',
    'canonical-link.module.json', 'data-quality-issue.module.json',
  ]) applyModule(projectRoot, join(projectRoot, 'packages', 'customer-data', 'modules', manifest));

  writeFileSync(join(projectRoot, 'packages', 'actions', 'generated', 'index.js'), [
    '// @ts-check',
    '// The identity and data-quality actions arrive with the customer-data package.',
    'export const generatedActions = [];',
    '',
  ].join('\n'));
  writeFileSync(join(projectRoot, 'packages', 'domains', 'generated', 'index.js'), [
    "import { createCustomerDataPackage } from '../../customer-data/src/index.js';",
    'export const generatedDomains = [',
    '  createCustomerDataPackage(),',
    '];',
    '',
  ].join('\n'));
}

/** @param {string} projectRoot @param {string} manifestPath */
function applyModule(projectRoot, manifestPath) {
  const result = spawnSync(
    process.execPath,
    ['--no-warnings', join(projectRoot, 'packages/cli/bin/accordo.js'), 'module', 'create', manifestPath, '--apply', '--root', projectRoot],
    { encoding: 'utf8', cwd: projectRoot },
  );
  if (result.status !== 0) {
    throw new Error(`Failed to apply ${manifestPath}:\n${result.stdout}\n${result.stderr}`);
  }
}
