// @ts-check

/**
 * **The Repository Truth Contract** (ADR-039).
 *
 *   node scripts/repo-truth.js              regenerate docs/repository-truth.json
 *   node scripts/repo-truth.js --check      fail when the repository and the facts disagree
 *   node scripts/repo-truth.js --json       print the report rather than a human summary
 *
 * ## The failure this exists to close
 *
 * Existing gates check consistency **between** documents. `scripts/measurement.js`
 * compares `docs/PROJECT_STATUS.md`'s `Measured at` row to `site/claims.json`;
 * `scripts/site-check.js` matches a numeric pattern; `scripts/generate-jobs.js`
 * regenerates one index from one Markdown source. None of them has any tie to
 * what the code does.
 *
 * So when Production Spine v1 changed the runtime, the status file, the JTBD
 * matrix, the claims ledger and the scenario limitation metadata stayed
 * mutually consistent **and stale together**, and every gate passed. Twice,
 * measurably: `app inspect` published "no authentication, tenancy or RBAC
 * exists" in the same report whose `PRODUCTION_SPINE_ABSENT` message described
 * all three (PR #101), and the tenant-isolation scenario published
 * `TENANT_ISOLATION_NOT_ENFORCED` after the amendment that closed it (PR #102).
 * Both were found by a person, not by a gate.
 *
 * This script generates the facts from the authorities that *are* the code, and
 * then checks the repository's current claims against them.
 *
 * ## What it is not
 *
 * Not an Accordo rail, not a product command, not part of the surface budget.
 * It never leaves this repository — a generated project has no claims ledger,
 * no JTBD matrix and no status file. It rewrites no prose, calls no model,
 * publishes nothing, deploys nothing and changes no product code.
 */

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPOSITORY_TRUTH_CONTRACT = 1;

/** Where the generated document lives, beside the documents it binds. */
export const TRUTH_DOCUMENT = 'docs/repository-truth.json';

// ─────────────────────────────────────────────────────────────── vocabularies

/**
 * The closed value vocabulary.
 *
 * A fact whose value could only ever be one token proves nothing, so several of
 * these exist precisely to let a fact come out *wrong*: `declared_not_enforced`
 * is what `spine.tenant.crm_data_plane_enforced` published before ADR-038
 * Amendment 2, and the generator can still produce it.
 */
export const FACT_VALUES = Object.freeze([
  'implemented',
  'absent',
  'enforced',
  'enforced_by_binding',
  'declared_not_enforced',
  'refused_at_startup',
  'one_tenant_per_instance',
  'shared_database_row_level',
  'package_native',
  'core_native',
  'not_measured',
  'not_applicable',
  'true',
  'false',
  'unknown',
]);

/** How current a fact's own authority is. */
export const FACT_STATUSES = Object.freeze(['current', 'stale', 'unknown']);

/** What a fact is about. */
export const FACT_SCOPES = Object.freeze(['framework', 'package', 'repository', 'measurement']);

/** The three kinds of authority, kept apart and labelled. */
export const AUTHORITY_KINDS = Object.freeze(['source', 'receipt', 'measurement']);

/** Every problem this script can report. Closed, so a caller can switch on it. */
export const TRUTH_PROBLEMS = Object.freeze([
  'TRUTH_AUTHORITY_UNAVAILABLE',
  'TRUTH_AUTHORITIES_CONTRADICT',
  'TRUTH_DOCUMENT_STALE',
  'TRUTH_DOCUMENT_UNREADABLE',
  'TRUTH_FACT_UNKNOWN',
  'TRUTH_FACT_VALUE_STALE',
  'TRUTH_CITATION_MALFORMED',
  'TRUTH_CLAIM_RETIRED',
  'TRUTH_CODE_UNKNOWN',
  'TRUTH_MEASUREMENT_NOT_ANCESTOR',
  'TRUTH_MEASUREMENT_UNPROVABLE',
  'TRUTH_SURFACE_UNSAFE',
]);

/**
 * What this contract does **not** know, published on every document so a reader
 * acts on the boundary rather than discovering it.
 */
export const TRUTH_LIMITATIONS = Object.freeze([
  ['STORAGE_FACT_IS_BOUNDED_PROBE',
    'storage runtime facts come from bounded executable probes over named Company, generated-service and Work '
    + 'legacy operations and field shapes. They do not prove every checked-in service, schema shape or storage path'],
  ['TRUTH_IS_SOURCE_AND_RECEIPTS_NOT_RUNTIME',
    'every fact is read from checked-in source or from a recorded receipt. Nothing here reports what a '
    + 'deployed instance is doing: which mode it chose, which tenant it is bound to, whether a verifier is '
    + 'configured and who holds which membership remain runtime facts'],
  ['REFERENCE_COMPOSITION_NOT_THE_PROJECT',
    'packages/domains/generated/index.js is empty in this repository, so package facts are read from a named '
    + 'REFERENCE composition of the nine checked-in domain packages. That is what the framework can compose, '
    + 'not what this checkout composes'],
  ['JTBD_ROWS_NOT_ENCODED',
    'no JTBD row is a fact here. Job status is maintained by people and promoted only by a person '
    + '(docs/QUALITY_GATES.md §3); a generator that owned it would be promoting rows'],
  ['NO_SCENARIO_RECEIPT_AVAILABLE',
    'accordo scenario run writes nothing into the project, so this repository checks in no scenario receipt. '
    + 'Scenario evidence is therefore NOT an authority in v1, and scenario limitation metadata is bound only '
    + 'by the machine-code vocabulary rule'],
  ['IMPLEMENTATION_EVIDENCE_NOT_AN_AUTHORITY',
    'the checked-in evidence documents under examples/ describe other applications compositions, so their '
    + 'applicationInspectionFingerprint cannot be checked against this repository and they are not read'],
  ['MEASUREMENT_DESCRIBES_COMMITTED_TREE',
    'the measurement facts compare git trees at HEAD and at the recorded commit, so an uncommitted change to '
    + 'tests/ does not move them until it is committed'],
  ['MEASUREMENT_FACTS_ARE_GENERATED_BUT_NOT_CITED',
    'the measurement facts are generated and their provenance is checked, but no document cites one. A citation '
    + 'would resolve differently in a shallow clone — where ancestry cannot be proven at all — so a document '
    + 'citing it would fail for a reason that has nothing to do with what the document says'],
  ['CITATIONS_ARE_OPT_IN',
    'a document is checked for the citations it carries. A sentence with no citation is not checked at all, '
    + 'and this contract cannot discover which sentences ought to have one'],
  ['WORDING_IS_NOT_GENERATED',
    'no prose is written or rewritten here. A fact id constrains what a bound sentence may assert; it does not '
    + 'produce the sentence'],
  ['EDITIONS_NOT_BOUND',
    'docs/editions/** is deliberately outside the bound surface set in v1'],
  ['NUMERIC_CLAIMS_NOT_BOUND',
    'this contract requires no number to be bound and can discover none that ought to be. A citation standing '
    + 'next to a number binds the sentence, never the number. Two precisions, because the shorter statement '
    + 'read as more than it was: (1) ONE cited fact does carry an integer — spine.identity.contract, a contract '
    + 'version, checked in site/claims.json exactly like any other value — so "no number is checked here" is '
    + 'false; what holds is that no COUNT is, the count-shaped facts being the measurement ones that '
    + 'MEASUREMENT_FACTS_ARE_GENERATED_BUT_NOT_CITED keeps out of every document. (2) Typed TEST counts are not '
    + 'unchecked, they are checked by a different gate — findLooseTestCounts in scripts/measurement.js, run by '
    + 'scripts/site-check.js inside gtm:check across README.md, site/ and every docs/ document outside '
    + 'DATED_HISTORY. What no gate holds is every other current count: module, package, resource, action, '
    + 'policy, provider, rail, skill, scenario and JTBD-row counts, in this document set and in others'],
  ['POSTURE_PROSE_NOT_GENERATED',
    'productionPosture in packages/cli/src/app-inspect.js is hand-written English bound to explicit fact ids. '
    + 'The citations hold its VALUES; they do not derive its wording, so a reworded falsehood is caught only '
    + 'where RETIRED_CLAIMS names the exact retired claim. Generating the sentence from its own facts is v2'],
  ['CODE_VOCABULARY_INCLUDES_COMMENTS',
    'the machine-code vocabulary is harvested lexically, so a code named only in a source comment counts as '
    + 'declared. Narrowing it to executable identifiers would need a parser per file type and would refuse '
    + 'codes that legitimately live in JSON receipts. RETIRED_CODES closes the case that matters — a code this '
    + 'repository deliberately removed is subtracted wherever it is mentioned'],
]);

// ───────────────────────────────────────────────────── the authority source set

/**
 * The checked-in files the source-derived facts are read from.
 *
 * Explicit rather than globbed: `sourceSha` is a fingerprint of *what was read*,
 * and a glob would make it move when an unrelated file arrived. A missing entry
 * is `TRUTH_AUTHORITY_UNAVAILABLE`, never a defaulted fact.
 */
/**
 * The JTBD portfolio's four files, named once and used twice: as the authority's `reads` and
 * as members of {@link AUTHORITY_SOURCES}, so a change to any of them moves `sourceSha`.
 */
export const JTBD_PORTFOLIO_SOURCES = Object.freeze([
  'docs/jtbd/catalog/jtbd.jsonl',
  'docs/jtbd/coverage/coverage.overlay.jsonl',
  'docs/jtbd/coverage/matrix_crosswalk.json',
  'docs/jtbd/roadmap/roadmap.overlay.jsonl',
]);

export const AUTHORITY_SOURCES = Object.freeze([
  'scripts/repo-truth.js',
  'packages/core/src/identity.js',
  'packages/core/src/authorization.js',
  'packages/core/src/runtime-mode.js',
  'packages/core/src/tenant-storage.js',
  'packages/core/src/tenant-binding.js',
  'packages/core/src/storage-contract.js',
  'packages/core/src/database.js',
  'packages/core/src/errors.js',
  'packages/core/src/validation.js',
  'packages/core/src/time.js',
  'packages/core/src/actor.js',
  'packages/core/src/module-manifest.js',
  'packages/core/src/module-evolution.js',
  'packages/core/src/timeout.js',
  'packages/core/src/action-runtime.js',
  'packages/core/src/external-operation.js',
  'packages/core/src/core-adapters.js',
  'packages/core/src/definition-fingerprint.js',
  'packages/core/src/money.js',
  'packages/core/src/solution-plan.js',
  'packages/core/src/implementation-evidence.js',
  'packages/core/src/spine-store.js',
  'packages/modules/company/src/company-service.js',
  'packages/cli/src/module-factory.js',
  'packages/work/src/legacy-tasks.js',
  'packages/work/src/follow-up.js',
  'packages/core/index.js',
  'packages/core/src/package-composition.js',
  'packages/core/src/package-registry.js',
  'packages/app/src/spine.js',
  'packages/cli/src/commands.js',
  'packages/cli/src/scenario-journey.js',
  'package.json',
  'packages/commercial/src/index.js',
  'packages/contracts/src/index.js',
  'packages/customer-data/src/index.js',
  'packages/delivery/src/index.js',
  'packages/intelligence/src/index.js',
  'packages/lifecycle/src/index.js',
  'packages/service/src/index.js',
  'packages/signature/src/index.js',
  'packages/work/src/index.js',
  ...JTBD_PORTFOLIO_SOURCES,
]);

/** The nine checked-in domain packages, and the factory each one exports. */
export const REFERENCE_PACKAGES = Object.freeze([
  ['commercial', 'packages/commercial/src/index.js', 'createCommercialDomain'],
  ['contracts', 'packages/contracts/src/index.js', 'createContractsDomain'],
  ['customer-data', 'packages/customer-data/src/index.js', 'createCustomerDataPackage'],
  ['delivery', 'packages/delivery/src/index.js', 'createDeliveryPackage'],
  ['intelligence', 'packages/intelligence/src/index.js', 'createIntelligenceDomain'],
  ['lifecycle', 'packages/lifecycle/src/index.js', 'createLifecyclePackage'],
  ['service', 'packages/service/src/index.js', 'createServicePackage'],
  ['signature', 'packages/signature/src/index.js', 'createSignatureDomain'],
  ['work', 'packages/work/src/index.js', 'createWorkPackage'],
]);

/**
 * The eight rails, each with the CLI verb the dispatcher matches and the handler
 * module that must export it.
 *
 * Two independent readings of the same fact, on purpose. If the dispatcher
 * names a verb whose handler is gone — or a handler exists that nothing
 * dispatches — that is `TRUTH_AUTHORITIES_CONTRADICT`, not a quiet `absent`.
 */
export const RAILS = Object.freeze([
  ['rail.app_inspect.implemented', 'app:inspect', 'packages/cli/src/app-inspect-command.js', 'inspectApplicationCommand'],
  ['rail.solution_check.implemented', 'solution:check', 'packages/cli/src/solution-command.js', 'solutionCommand'],
  ['rail.project_doctor.implemented', 'project:doctor', 'packages/cli/src/project-doctor-command.js', 'projectDoctorCommand'],
  ['rail.package_scaffold.implemented', 'package:scaffold', 'packages/cli/src/package-scaffold.js', 'packageScaffoldCommand'],
  ['rail.package_test.implemented', 'package:test', 'packages/cli/src/package-test-command.js', 'packageTestCommand'],
  ['rail.project_verify.implemented', 'project:verify', 'packages/cli/src/project-verify-command.js', 'projectVerifyCommand'],
  ['rail.scenario_run.implemented', 'scenario:run', 'packages/cli/src/scenario-run-command.js', 'scenarioRunCommand'],
  ['rail.solution_verify.implemented', 'solution:verify', 'packages/cli/src/solution-verify-command.js', 'solutionVerifyCommand'],
]);

/**
 * The **namespace probe**, and the only place absence is allowed to mean `absent`
 * for a product area.
 *
 * ADR-039 §7.1: a fact is never inferred `false` from silence *unless the
 * contract defines that meaning*. Here it does, precisely: a product area is
 * `absent` when **no** resource, action, capability or policy in the reference
 * composition carries any of the declared prefixes. The composition must have
 * resolved with zero problems first, or the probe is refused — a probe over a
 * broken composition would report every area absent.
 *
 * Prefixes match on the hyphen-segment boundary, so `tax` does not match
 * `taxonomy` and `cloud` does not match `cloudy-anything`.
 */
export const NAMESPACE_PROBES = Object.freeze({
  'billing.implemented': ['invoice', 'invoicing', 'billing', 'payment', 'usage-rating', 'proration', 'tax', 'revenue-recognition'],
  'marketing_runtime.implemented': ['campaign', 'marketing', 'audience', 'nurture', 'newsletter', 'broadcast'],
  'cloud_control_plane.implemented': ['cloud', 'deployment', 'provisioning', 'workspace-provisioning', 'billing-account'],
});

/**
 * Declared-absence facts, and the declaration each one reads.
 *
 * `SPINE_NOT_MODELED` and the frozen journey registry's limitation codes are
 * *declarations in source*, not silence. A keyword that matches nothing is a
 * failure (`TRUTH_AUTHORITY_UNAVAILABLE`), never a default.
 *
 * **Every one of them carries a second authority, derived from the code rather
 * than from the sentence.** `SPINE_NOT_MODELED` is still a hand-maintained list
 * of English strings, and a regex over it can only ever answer "does the list
 * still say this". Deleting the sentence refuses the fact — that half was
 * always safe — but *implementing* the thing and leaving the sentence standing
 * moved nothing at all, which is a claim surviving the code it describes: the
 * exact failure this contract exists to close, inside the contract. So
 * PostgreSQL is checked against the manifest's production dependencies, and
 * durable jobs and secrets/backups against a namespace probe over the reference
 * composition, on the same rule as `billing.implemented`: two authorities must
 * agree, or neither answer is published.
 */
const DECLARED_ABSENCE = Object.freeze({
  'spine.postgresql.implemented': { in: 'SPINE_NOT_MODELED', match: /postgresql/i },
  'spine.durable_jobs.implemented': {
    in: 'SPINE_NOT_MODELED',
    match: /durable jobs|outbox|scheduler/i,
    // Not `follow-up` or `work-task`: those records exist and a person moves
    // every one of them, which is precisely the boundary this fact states.
    absentPrefixes: ['scheduler', 'job', 'jobs', 'outbox', 'cron', 'timer', 'reminder', 'queue', 'worker', 'dispatcher'],
  },
  'spine.secrets_backups.implemented': {
    in: 'SPINE_NOT_MODELED',
    match: /secret manager|backups/i,
    absentPrefixes: ['secret', 'secrets', 'backup', 'backups', 'restore', 'vault', 'credential', 'key-rotation'],
  },
});

/** Journey limitation codes that declare a product boundary. */
const DECLARED_JOURNEY_CODES = Object.freeze({
  'cdf.full_cdp.implemented': 'THIS_IS_NOT_A_CDP_OR_A_WAREHOUSE',
  'customer_timeline.complete': 'THE_PROFILE_IS_A_PROJECTION_NOT_A_TIMELINE',
  'billing.implemented': 'NOTHING_WAS_BILLED_OR_NOTIFIED',
});

/**
 * The frozen benchmark panel whose aggregate is read as a receipt, and the
 * protocol its fingerprints must match.
 */
export const BENCHMARK_PANEL = Object.freeze({
  aggregate: 'benchmarks/tool-selection/panel-v2-2026-08-18/aggregate.json',
  protocol: 'benchmarks/tool-selection/panel-v2-2026-08-18/frozen-protocol.json',
});

// ───────────────────────────────────────────────────────────── bound documents

/**
 * The **current**, public or machine-facing surfaces this contract binds.
 *
 * Historical material is excluded by **path rule**, never by heuristic: a dated
 * ADR, an ExecPlan, a benchmark receipt, a transcript and a blog post preserve
 * what was true when they were written, and rewriting them to satisfy a checker
 * would be falsifying history. `docs/editions/**` is excluded in v1 by
 * ownership rather than by principle.
 */
export const BOUND_SURFACES = Object.freeze([
  'README.md',
  'PRODUCT.md',
  'AGENTS.md',
  'CLAUDE.md',
  'TASKS.md',
  'docs/PROJECT_STATUS.md',
  'docs/CODER_TOOLING_ROADMAP.md',
  'docs/QUALITY_GATES.md',
  'docs/REPOSITORY_TRUTH.md',
  'docs/strategy/EXECUTION_ROADMAP.md',
  'docs/benchmarks/CRM_JTBD_MATRIX.md',
  'docs/benchmarks/jobs.json',
  'site/claims.json',
  'site/assets/llms.txt',
  'site/assets/llms-full.txt',
  'examples/scenarios/contract-renewal-execution.scenario.json',
  'examples/scenarios/customer-identity-governance.scenario.json',
  'examples/scenarios/lead-to-won.scenario.json',
  'examples/scenarios/service-sla-escalation.scenario.json',
  'examples/scenarios/tenant-isolation-and-authorization.scenario.json',
  // **A product claim that happens to live in source.**
  //
  // `productionPosture` is a hand-written English sentence that `app inspect`
  // publishes to every agent that asks what this framework is. It is the first
  // of the two failures in the record: it read "no authentication, tenancy or
  // RBAC exists" in the same report whose `PRODUCTION_SPINE_ABSENT` message
  // described identity, tenancy and authorization, and a person found it
  // (PR #101). A contract that binds twenty documents and leaves *that*
  // sentence unbound closes one of the two failures it names.
  //
  // Being a `.js` file changes only the comment character. Its machine codes
  // are in the harvested vocabulary already, because the vocabulary is
  // harvested from `packages/`; what the binding adds is the citation.
  'packages/cli/src/app-inspect.js',
]);

/** Where the machine-code vocabulary is harvested from. */
export const VOCABULARY_ROOTS = Object.freeze(['packages', 'scripts', 'apps', 'examples', 'benchmarks']);

/**
 * Codes this repository has **deliberately retired**, subtracted from the
 * harvested vocabulary however they got into it.
 *
 * The automatic half of the rule needs no list: a code deleted from the source
 * simply stops being in the vocabulary, and every bound document still naming it
 * fails. This list closes the other half. A retired code goes on being *discussed*
 * — in this file's own failure messages, in an ADR, in a review note — and a
 * lexical harvest cannot tell discussion from declaration, so a mention in any
 * comment would quietly re-admit it and disarm the rule written because of it.
 *
 * Subtracting is stronger than excluding one file: it holds wherever the mention
 * appears. Shaped like `DATED_HISTORY` in `scripts/measurement.js` — short on
 * purpose, and each entry a reviewable edit with an argument attached.
 */
export const RETIRED_CODES = Object.freeze([
  // ADR-038 Amendment 2 closed F-2 by binding, and PR #102 deleted this code from
  // the scenario. It survived its own fix once; it never gets to again.
  'TENANT_ISOLATION_NOT_ENFORCED',
]);

/** A machine code: SCREAMING_SNAKE with at least one underscore. */
export const CODE_TOKEN = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;

/** A fact citation, in a Markdown comment or a JSON `facts` entry. */
export const CITATION = /<!--\s*truth:\s*([a-z][a-z0-9_.]*)\s*=\s*([A-Za-z0-9_.-]+)\s*-->/g;

/**
 * The same citation in a JavaScript line comment, for a bound `.js` surface.
 *
 * One grammar, three comment characters. It is applied **only** to a source file
 * in {@link BOUND_SURFACES} — never to Markdown, where `// truth: …` inside a
 * fenced example would become a citation nobody wrote.
 */
export const CITATION_JS = /\/\/\s*truth:\s*([a-z][a-z0-9_.]*)\s*=\s*([A-Za-z0-9_.-]+)/g;

/**
 * How a *bound* document names a code that no longer exists without asserting it.
 *
 *   <!-- truth: retired-code CODE — why this document names it -->
 *
 * Deliberately shaped like `DATED_HISTORY` in `scripts/measurement.js`: an escape
 * that costs a reviewable edit with an argument attached. It is scoped to the one
 * file that declares it, and declaring it puts the retired code in front of the
 * reviewer rather than hiding it.
 */
export const RETIRED_CODE = /<!--\s*truth:\s*retired-code\s+([A-Z][A-Z0-9_]+)\b/g;

/** A citation as it appears inside a JSON `facts` array. */
export const CITATION_LITERAL = /^([a-z][a-z0-9_.]*)=([A-Za-z0-9_.-]+)$/;

/**
 * A **claim** this repository deliberately retired, subtracted from every bound
 * surface however it is worded back in.
 *
 * The exact counterpart of {@link RETIRED_CODES}, and it exists because the
 * citation half of this contract cannot reach the case that opens ADR-039.
 * Citations bind **values**: reversing `spine.authorization.enforced=enforced`
 * to `=absent` fails, and that is what the seven `// truth:` lines above
 * `productionPosture` actually prove. They say nothing at all about the
 * *sentence* underneath them, so pasting the historical falsehood back into
 * `productionPosture` and leaving the citations untouched left
 * `repo:truth -- --check` **green** — measured on this branch, and exactly the
 * failure ADR-039's first recorded instance is.
 *
 * Generating the sentence from its facts is the real answer and is named as v2.
 * Until then this closes the one case the record actually contains: the specific
 * retired claim, held verbatim wherever a bound surface words it back in, on the
 * same terms as a retired code — a short list, each entry a reviewable edit with
 * an argument attached, and an escape (`truth: retired-claim …`) for the bound
 * document that needs to name it as history.
 *
 * **Its boundary, stated rather than implied:** this holds the recorded
 * falsehood, not the set of all falsehoods. A *newly invented* false posture is
 * still outside the contract, which is what `WORDING_IS_NOT_GENERATED` and
 * `POSTURE_PROSE_NOT_GENERATED` say.
 */
export const RETIRED_CLAIMS = Object.freeze([
  // PR #101. `app inspect` published this in the same report whose
  // PRODUCTION_SPINE_ABSENT message described identity, tenancy and
  // authorization — and ADR-038 had already made all three true. A person found
  // it. It is the first of the two failures ADR-039 opens by naming.
  'no authentication, tenancy or RBAC exists',
]);

/**
 * A retired claim, compared on collapsed whitespace and folded case.
 *
 * Not a general prose rule: it normalises the two ways the same sentence gets
 * re-typed (a re-wrap, a capitalised sentence start) and nothing else.
 *
 * @param {string} text
 */
export function normalizeClaimText(text) {
  return String(text).toLowerCase().replace(/\s+/g, ' ');
}

/**
 * How a *bound* surface names a retired claim as history rather than asserting it.
 *
 *   <!-- truth: retired-claim no authentication, tenancy or RBAC exists — why -->
 */
export const RETIRED_CLAIM = /(?:<!--|\/\/)\s*truth:\s*retired-claim\s+(.+?)\s+—/g;

/**
 * One `truth:` directive, read from a line that is **nothing but** that directive.
 *
 * Two holes close here, and both were measured on this branch:
 *
 * 1. **A string literal was a citation.** {@link CITATION_JS} matched anywhere on
 *    a line, so `const example = '// truth: made.up.fact=nonsense';` inside the
 *    one bound `.js` surface produced a citation nobody wrote. Requiring the
 *    comment to *start* the line is the whole fix, and every real citation in
 *    `packages/cli/src/app-inspect.js` already sits on its own line.
 * 2. **A malformed directive was silent.** `// truth: spine.authorization.enforced
 *    -> enforced` matched no pattern, so it was neither a citation nor an error:
 *    a typo turned a load-bearing citation off with no signal at all. A grammar
 *    that fails open is not a grammar.
 *
 * Markdown citations are deliberately still read anywhere on the line — an HTML
 * comment cannot be a string literal, `AGENTS.md` already carries one mid-line,
 * and the *malformed* rule below is the part scoped to own-line directives so
 * that a document quoting the grammar inside a table cell stays a document.
 *
 * @param {string} line
 * @param {{javascript?: boolean}} [options]
 * @returns {string | null} the directive body, or `null` when the line is not one
 */
export function readTruthDirective(line, { javascript = false } = {}) {
  const trimmed = String(line).trim();
  let body = null;
  if (trimmed.startsWith('<!--') && trimmed.endsWith('-->')) body = trimmed.slice(4, -3).trim();
  else if (javascript && trimmed.startsWith('//')) body = trimmed.slice(2).trim();
  if (body === null || !/^truth:/i.test(body)) return null;
  return body.slice(body.indexOf(':') + 1).trim();
}

/**
 * Every `truth:` directive in a surface that is not one of the three legal forms.
 *
 * The legal forms are a citation (`id=value`), a retired-code declaration and a
 * retired-claim declaration. Anything else is a directive the author meant to be
 * load-bearing and that no rule reads — which is the failure mode this contract
 * exists to stop, committed inside its own grammar.
 *
 * @param {string} source
 * @param {{javascript?: boolean}} [options]
 * @returns {Array<{line: number, body: string}>}
 */
export function findMalformedDirectives(source, { javascript = false } = {}) {
  /** @type {Array<{line: number, body: string}>} */
  const found = [];
  const lines = String(source).split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const body = readTruthDirective(lines[index], { javascript });
    if (body === null) continue;
    if (CITATION_LITERAL.test(body.replace(/\s*=\s*/, '='))) continue;
    if (/^retired-code\s+[A-Z][A-Z0-9_]+\b/.test(body)) continue;
    if (/^retired-claim\s+.+\s+—/.test(body)) continue;
    found.push({ line: index + 1, body });
  }
  return found;
}

/**
 * Whether a declared surface path is safe to read as itself.
 *
 * {@link BOUND_SURFACES} and {@link AUTHORITY_SOURCES} are frozen literal lists,
 * so nothing *inside* this file can traverse. The filesystem can: replacing
 * `packages/cli/src/app-inspect.js` with a symlink was measured on this branch,
 * and it does two things, both silent —
 *
 * - pointing it at a file **outside the repository** made that file's `// truth:`
 *   lines the ones the gate read; and
 * - pointing it at a citation-free file dropped the posture sentence's seven
 *   citations from 95 to 88 and left `--check` **green**, with the false posture
 *   sitting in the symlink's target.
 *
 * A path-allowlisted grammar that a symlink can redirect is not path-allowlisted,
 * so every declared path is checked to be repository-relative, free of any `..`
 * segment, and reachable without traversing a symlink at any component. The
 * answer is a refusal, never a quiet skip: a surface that cannot be read *as
 * itself* is `TRUTH_SURFACE_UNSAFE`, on the same rule as every other authority
 * here — a fact never silently defaults from something that could not be read.
 *
 * @param {string} rootDir
 * @param {string} declared repository-relative, POSIX separators
 * @returns {{ok: true, full: string} | {ok: false, reason: string}}
 */
export function resolveSurfacePath(rootDir, declared) {
  if (isAbsolute(declared) || declared.split('/').includes('..')) {
    return { ok: false, reason: `"${declared}" is not a repository-relative path without a ".." segment` };
  }
  const root = realpathSync(resolve(rootDir));
  const full = join(root, declared);
  let walked = root;
  for (const segment of declared.split('/')) {
    walked = join(walked, segment);
    let stat;
    try {
      stat = lstatSync(walked);
    } catch {
      // A path that does not exist is the caller's `existsSync` case, not a
      // traversal: it is skipped, exactly as it was before this check existed.
      return { ok: true, full };
    }
    if (stat.isSymbolicLink()) {
      return { ok: false, reason: `"${relative(root, walked).split(sep).join('/')}" is a symbolic link, so the gate `
        + 'would read whatever it points at rather than the file this contract names' };
    }
  }
  const real = realpathSync(full);
  if (real !== full && relative(root, real).startsWith('..')) {
    return { ok: false, reason: `"${declared}" resolves outside the repository` };
  }
  return { ok: true, full };
}

// ────────────────────────────────────────────────────────────────── utilities

/** Deterministic string order, independent of locale. */
function compare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** SHA-256 of a string, hex. */
function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

/** Canonical JSON: object keys sorted at every depth, so a hash is stable. */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort(compare).map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * Every file under a directory, excluding the noise no authority lives in.
 *
 * `coverage` is excluded **only at the repository root**, where it is a test-coverage report
 * directory. Excluding it by name at any depth also hid `docs/jtbd/coverage/`, so a document
 * naming `MATRIX_CROSSWALK.md` was told the filename was an undeclared machine code — the
 * basename exemption is derived from the filesystem precisely so that cannot happen.
 *
 * @param {string} directory
 * @param {string[]} out
 * @param {string} [rootDir]
 */
function walk(directory, out = [], rootDir = directory) {
  let entries;
  try {
    entries = readdirSync(directory);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === '.git' || name === 'dist') continue;
    if (name === 'coverage' && resolve(directory) === resolve(rootDir)) continue;
    const path = join(directory, name);
    let stat;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    if (stat.isDirectory()) walk(path, out, rootDir);
    else out.push(path);
  }
  return out;
}

/** Runs git in a directory; exposed so a test can drive the rules with a stub. */
export function gitIn(cwd) {
  return (args) => {
    const run = spawnSync('git', args, { cwd, encoding: 'utf8' });
    return { status: run.status ?? 1, stdout: String(run.stdout ?? '').trim() };
  };
}

// ──────────────────────────────────────────────────────── reading authorities

/**
 * Read every authority.
 *
 * Returns a plain **bundle** of what the authorities say — no facts yet. The
 * split matters for the negative tests: `buildFacts` is pure over this bundle,
 * so a test can flip one authority value and watch the whole document move,
 * which is the "a runtime fact changed and the generated facts are stale" case.
 *
 * @param {{rootDir: string, generatedProbeClock?: 'advancing' | 'stalled'}} options
 */
export async function readAuthorities({ rootDir, generatedProbeClock = 'advancing' }) {
  /**
   * A **fatal** problem: a source authority could not be read, so no fact may be
   * derived at all and the document is refused whole.
   *
   * @type {Array<{code: string, message: string}>}
   */
  const problems = [];
  const unavailable = (message) => problems.push({ code: 'TRUTH_AUTHORITY_UNAVAILABLE', message });

  /**
   * A **deferred** problem: a receipt or a measurement could not be verified.
   *
   * Kept apart from the fatal set on purpose. A shallow clone cannot prove the
   * ancestry of the measured commit, and collapsing the whole document over that
   * would mean the citation and machine-code rules — the half that needs no git
   * at all — stopped running in exactly the job that runs on every push. The run
   * still fails; the source facts still stand, and the measurement facts read
   * `unknown` rather than a number nothing can trace.
   *
   * @type {Array<{code: string, message: string}>}
   */
  const deferred = [];

  // ── the authority source set, and its fingerprint ────────────────────────
  /** @type {Array<[string, string]>} */
  const digests = [];
  for (const path of AUTHORITY_SOURCES) {
    // An authority is read *and imported*, so a symlink here does not merely
    // redirect a digest — it changes which code the facts are derived from.
    // Refused whole, on the same rule as an unreadable authority: nothing is
    // defaulted from something that could not be read as itself.
    const safe = resolveSurfacePath(rootDir, path);
    if (!safe.ok) {
      problems.push({
        code: 'TRUTH_SURFACE_UNSAFE',
        message: `authority source ${path} cannot be read as itself: ${safe.reason}. No fact is derived from a `
          + 'path the filesystem can redirect.',
      });
      continue;
    }
    const full = safe.full;
    if (!existsSync(full)) {
      unavailable(`authority source ${path} does not exist, so the facts it carries cannot be read at all`);
      continue;
    }
    let regularFile = false;
    try {
      regularFile = lstatSync(full).isFile();
    } catch (error) {
      problems.push({
        code: 'TRUTH_SURFACE_UNSAFE',
        message: `authority source ${path} could not be verified as a regular file: ${/** @type {any} */ (error)?.code ?? 'filesystem refusal'}`,
      });
      continue;
    }
    if (!regularFile) {
      problems.push({
        code: 'TRUTH_SURFACE_UNSAFE',
        message: `authority source ${path} is not a regular file. No fact is derived from a directory, device, socket or pipe.`,
      });
      continue;
    }
    digests.push([path, sha256(readFileSync(full, 'utf8'))]);
  }
  const executingGenerator = fileURLToPath(import.meta.url);
  const targetGeneratorDigest = digests.find(([path]) => path === 'scripts/repo-truth.js')?.[1];
  if (targetGeneratorDigest
    && targetGeneratorDigest !== sha256(readFileSync(executingGenerator, 'utf8'))) {
    unavailable('the target checkout has a different scripts/repo-truth.js than the generator executing this authority read');
  }
  const sourceSha = sha256(canonical(digests.slice().sort((a, b) => compare(a[0], b[0]))));

  const bundle = /** @type {any} */ ({ sourceSha, problems });
  if (problems.length) return bundle;

  const url = (path) => pathToFileURL(join(rootDir, path)).href;

  // ── spine, identity, authorization, mode, tenancy ────────────────────────
  try {
    const identity = await import(url('packages/core/src/identity.js'));
    const authorization = await import(url('packages/core/src/authorization.js'));
    const runtimeMode = await import(url('packages/core/src/runtime-mode.js'));
    const tenantStorage = await import(url('packages/core/src/tenant-storage.js'));
    const spine = await import(url('packages/app/src/spine.js'));

    bundle.identityContract = identity.IDENTITY_CONTRACT;
    bundle.identityKinds = [...identity.IDENTITY_KINDS];
    bundle.spineContract = spine.SPINE_CONTRACT;
    bundle.spineNotModeled = [...(spine.SPINE_NOT_MODELED ?? [])];
    bundle.permissions = [...authorization.PERMISSIONS];
    bundle.roles = Object.keys(authorization.ROLE_BUNDLES);
    bundle.modeEnv = runtimeMode.MODE_ENV;
    bundle.runtimeModes = [...runtimeMode.RUNTIME_MODES];
    bundle.tenantStrategy = tenantStorage.TENANT_STRATEGY;
    bundle.tenantStorageContract = tenantStorage.TENANT_STORAGE_CONTRACT;
    // A limitation string is `CODE — prose`; the code is the structural half.
    bundle.tenantLimitationCodes = [...tenantStorage.TENANT_LIMITATIONS]
      .map((entry) => /^([A-Z][A-Z0-9_]+)/.exec(String(entry))?.[1] ?? '')
      .filter(Boolean);

    // **A structural probe, not a reading of prose.** ADR-038 Amendment 2 says
    // a second tenant is unreachable "through the handle the application
    // holds". That is a property of an object, so it is asked of the object:
    // the provisioning-side storage has `databasePathFor`, the bound handle
    // does not, and the two planes resolve to different files. No filesystem
    // write happens — the root is a path that need not exist.
    const probeRoot = join(tmpdir(), 'accordo-repo-truth-probe');
    const storage = tenantStorage.createTenantStorage({ root: probeRoot });
    const binding = tenantStorage.bindTenantStorage({ root: probeRoot, tenantId: 'probe' });
    bundle.tenantProbe = {
      provisioningCanNameAnyTenant: typeof storage.databasePathFor === 'function',
      boundHandleCanNameASecondTenant: typeof (/** @type {any} */ (binding).databasePathFor) === 'function',
      planesSeparate: binding.dataPlanePath !== binding.controlPlanePath,
    };

    // Production refuses to start without a verifier the deployment supplies —
    // which is the executable form of "the framework authenticates nobody".
    let verifierRefusal = null;
    try {
      runtimeMode.resolveRuntimeMode({ mode: 'production', identityVerifier: undefined, tenantStrategy: 'probe' });
    } catch (error) {
      verifierRefusal = /** @type {any} */ (error)?.code ?? null;
    }
    bundle.verifierRefusal = verifierRefusal;

    // An anonymous identity authorizes nothing. Asked of the authorizer rather
    // than read off a sentence about it.
    const decision = authorization.decideAuthorization({
      identity: identity.ANONYMOUS_IDENTITY,
      organizationId: null,
      permission: 'records.write',
      membership: null,
      mode: { allowsAssertedActors: false },
    });
    bundle.anonymousAllowed = decision.allowed === true;

    const storageContract = await import(url('packages/core/src/storage-contract.js'));
    const { nowIso: realNowIso } = await import(url('packages/core/src/time.js'));
    const { trustedSystemActor } = await import(url('packages/core/src/actor.js'));
    const { CORE_MIGRATIONS_FOR_CHARACTERIZATION } = await import(url('packages/core/src/database.js'));
    const { CompanyService } = await import(url('packages/modules/company/src/company-service.js'));
    const { planModule } = await import(url('packages/cli/src/module-factory.js'));
    const { migrateLegacyTasks } = await import(url('packages/work/src/legacy-tasks.js'));
    bundle.storageContract = storageContract.STORAGE_CONTRACT;
    const probeActor = trustedSystemActor('execute the repository-truth storage authority');

    // The generated-service probe substitutes a deterministic clock so it can
    // prove exact timestamp ordering without a wall-clock spin. Prove the real
    // runtime clock separately, with a small hard bound: a regressed/constant
    // clock refuses the authority instead of being masked by the substitute.
    const canonicalUtcTimestamp = (value) => typeof value === 'string'
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
      && Number.isFinite(Date.parse(value))
      && new Date(Date.parse(value)).toISOString() === value;
    const realClockStart = realNowIso();
    if (!canonicalUtcTimestamp(realClockStart)) {
      throw new Error('generated runtime clock did not return canonical ISO-8601 UTC');
    }
    let realClockAdvanced = false;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
      const candidate = realNowIso();
      if (canonicalUtcTimestamp(candidate) && Date.parse(candidate) > Date.parse(realClockStart)) {
        realClockAdvanced = true;
        break;
      }
    }
    if (!realClockAdvanced) throw new Error('generated runtime clock did not advance within the bounded probe');

    // Behavior probe: Company statements must render and execute through the
    // real M1 SQLite adapter. The isolated schema makes a bad table, column,
    // predicate or statement shape fail instead of being accepted by a fake.
    const companyCalls = [];
    const { DatabaseSync } = await import('node:sqlite');
    const companyRaw = new DatabaseSync(':memory:');
    try {
      for (const migration of CORE_MIGRATIONS_FOR_CHARACTERIZATION) {
        if (migration.plane === 'data') companyRaw.exec(migration.sql);
      }
      const companyActual = storageContract.createSqliteStorage(
        companyRaw, (fn) => fn(), async (fn) => fn(),
      ).sync;
      const companySync = {
        savepoint(name, fn) { companyCalls.push(['savepoint', name]); return companyActual.savepoint(name, fn); },
        execute(statement) { companyCalls.push(['execute', statement.kind]); return companyActual.execute(statement); },
        maybeOne(statement) { companyCalls.push(['maybeOne', statement.kind]); return companyActual.maybeOne(statement); },
        many(statement) { companyCalls.push(['many', statement.kind]); return companyActual.many(statement); },
      };
      const companyAudits = [];
      const companyService = new CompanyService({
        database: { storage: { sync: companySync } },
        audit: { record(entry) { companyAudits.push(entry); } }, events: { async emit() {} },
      });
      const companyCreated = await companyService.create(
        { name: 'Truth Company', domain: 'EXAMPLE.COM' }, { actor: probeActor },
      );
      const companyOther = await companyService.create(
        { name: 'Other Company', domain: 'OTHER.EXAMPLE' }, { actor: probeActor },
      );
      const companyRead = companyService.get(companyCreated.id);
      const companyList = companyService.list();
      let missingCompanyCode = null;
      try {
        companyService.get('truth-company-missing');
      } catch (error) {
        missingCompanyCode = /** @type {any} */ (error)?.code ?? null;
      }
      bundle.companyUsesStorage = isDeepStrictEqual(companyCreated, companyRead)
        && companyCreated.name === 'Truth Company'
        && companyCreated.domain === 'example.com'
        && companyOther.name === 'Other Company'
        && companyOther.domain === 'other.example'
        && companyList.length === 2
        && companyList.some((company) => isDeepStrictEqual(company, companyCreated))
        && companyList.some((company) => isDeepStrictEqual(company, companyOther))
        && missingCompanyCode === 'NOT_FOUND'
        && companyAudits.length === 2
        && companyAudits.every((entry) => isDeepStrictEqual(entry.actor, probeActor))
        && canonical(companyCalls) === canonical([
          ['savepoint', 'company_create'], ['execute', 'insert'],
          ['savepoint', 'company_create'], ['execute', 'insert'],
          ['maybeOne', 'select'], ['many', 'select'], ['maybeOne', 'select'],
        ]);
      if (!bundle.companyUsesStorage) {
        throw new Error('the Company storage behavior probe was inconclusive or regressed');
      }
    } finally {
      companyRaw.close();
    }

    // Execute the artifact the generator actually emits against a fake handle
    // that exposes storage and deliberately has no raw driver. Every generated
    // operation is driven; an alias/bracket/raw bypass therefore throws rather
    // than being hidden by a token scan.
    const generatedRoot = mkdtempSync(join(tmpdir(), 'accordo-truth-generated-'));
    try {
      // Give planning an isolated, empty module registry. The authority must
      // not read an un-fingerprinted project module tree merely to generate a
      // synthetic conformance artifact.
      mkdirSync(join(generatedRoot, 'packages/modules'), { recursive: true });
      const generatedPlan = planModule({
        rootDir: generatedRoot,
        manifest: {
          manifestVersion: 1, name: 'truth-storage-probe',
          fields: [
            { name: 'name', type: 'string', required: true },
            { name: 'note', type: 'string', required: false },
            { name: 'kind', type: 'enum', values: ['primary', 'secondary'], required: true },
            { name: 'enabled', type: 'boolean', required: true },
            { name: 'status', type: 'enum', values: ['open', 'closed', 'pending'], writable: 'managed', default: 'open' },
          ],
        },
      });
      const serviceFile = generatedPlan.files.find((file) => {
        const normalized = file.path.split(/[\\/]/).join('/');
        return /\/src\/[^/]+-service\.js$/.test(normalized);
      });
      if (!serviceFile) throw new Error('generated storage probe did not produce a service artifact');
      const managedPlan = planModule({
        rootDir: generatedRoot,
        manifest: {
          manifestVersion: 1, name: 'truth-managed-storage-probe',
          fields: [
            { name: 'name', type: 'string', required: true, writable: 'managed', default: 'Managed Default' },
            { name: 'note', type: 'string', required: false, writable: 'managed' },
            { name: 'status', type: 'enum', values: ['open', 'closed'], writable: 'managed', default: 'open' },
          ],
        },
      });
      const managedServiceFile = managedPlan.files.find((file) => {
        const normalized = file.path.split(/[\\/]/).join('/');
        return /\/src\/[^/]+-service\.js$/.test(normalized);
      });
      if (!managedServiceFile) throw new Error('generated managed-storage probe did not produce a service artifact');
      const migrationFile = generatedPlan.files.find((file) => /migration\.js$/.test(file.path));
      const managedMigrationFile = managedPlan.files.find((file) => /migration\.js$/.test(file.path));
      if (!migrationFile || !managedMigrationFile) throw new Error('generated storage probe did not produce migration artifacts');
      writeFileSync(join(generatedRoot, 'package.json'), '{"type":"module"}\n');
      for (const source of ['errors.js', 'validation.js']) {
        const target = join(generatedRoot, 'packages/core/src', source);
        mkdirSync(join(generatedRoot, 'packages/core/src'), { recursive: true });
        writeFileSync(target, readFileSync(join(rootDir, 'packages/core/src', source), 'utf8'));
      }
      // The authority owns its clock so timestamp ordering is deterministic and
      // cannot turn into a wall-clock spin. The stalled variant exists only to
      // prove that a clock which cannot advance is refused with a stable code.
      const probeTimePath = join(generatedRoot, 'packages/core/src/time.js');
      writeFileSync(probeTimePath, generatedProbeClock === 'stalled'
        ? `export function nowIso() { return '2026-01-01T00:00:00.000Z'; }\n`
        : `let tick = 0;\nexport function nowIso() { return new Date(Date.UTC(2026, 0, 1, 0, 0, 0, tick++)).toISOString(); }\n`);
      const generatedPath = join(generatedRoot, ...serviceFile.path.split(/[\\/]/));
      mkdirSync(dirname(generatedPath), { recursive: true });
      writeFileSync(generatedPath, serviceFile.content);
      const managedGeneratedPath = join(generatedRoot, ...managedServiceFile.path.split(/[\\/]/));
      mkdirSync(dirname(managedGeneratedPath), { recursive: true });
      writeFileSync(managedGeneratedPath, managedServiceFile.content);
      const migrationPath = join(generatedRoot, ...migrationFile.path.split(/[\\/]/));
      const managedMigrationPath = join(generatedRoot, ...managedMigrationFile.path.split(/[\\/]/));
      writeFileSync(migrationPath, migrationFile.content);
      writeFileSync(managedMigrationPath, managedMigrationFile.content);
      const generatedModule = await import(`${pathToFileURL(generatedPath).href}?truth-probe=1`);
      const managedGeneratedModule = await import(`${pathToFileURL(managedGeneratedPath).href}?truth-probe=1`);
      const migrationModule = await import(`${pathToFileURL(migrationPath).href}?truth-probe=1`);
      const managedMigrationModule = await import(`${pathToFileURL(managedMigrationPath).href}?truth-probe=1`);
      const GeneratedService = Object.values(generatedModule).find(
        (value) => typeof value === 'function' && /Service$/.test(value.name),
      );
      const ManagedGeneratedService = Object.values(managedGeneratedModule).find(
        (value) => typeof value === 'function' && /Service$/.test(value.name),
      );
      if (!GeneratedService) throw new Error('generated storage probe service export is unavailable');
      if (!ManagedGeneratedService) throw new Error('generated managed-storage probe service export is unavailable');
      const generatedCalls = [];
      const generatedUpdateTimestamps = [];
      const migration = Object.values(migrationModule).find((value) => Array.isArray(value))?.[0];
      const managedMigration = Object.values(managedMigrationModule).find((value) => Array.isArray(value))?.[0];
      if (!migration?.sql || !managedMigration?.sql) throw new Error('generated storage migration exports are unavailable');
      const { DatabaseSync } = await import('node:sqlite');
      const raw = new DatabaseSync(':memory:');
      const managedRaw = new DatabaseSync(':memory:');
      raw.exec(migration.sql);
      managedRaw.exec(managedMigration.sql);
      const realSync = storageContract.createSqliteStorage(raw, (fn) => fn(), async (fn) => fn()).sync;
      const managedRealSync = storageContract.createSqliteStorage(managedRaw, (fn) => fn(), async (fn) => fn()).sync;
      const tracked = (actual) => ({
        savepoint(name, fn) { generatedCalls.push(['savepoint', name]); return actual.savepoint(name, fn); },
        execute(statement) {
          generatedCalls.push(['execute', statement.kind]);
          if (statement.kind === 'update') {
            generatedUpdateTimestamps.push(statement.values.find((entry) => entry.column === 'updated_at')?.value);
          }
          return actual.execute(statement);
        },
        maybeOne(statement) { generatedCalls.push(['maybeOne', statement.kind]); return actual.maybeOne(statement); },
        many(statement) { generatedCalls.push(['many', statement.kind]); return actual.many(statement); },
      });
      const sync = tracked(realSync);
      const managedSync = tracked(managedRealSync);
      try {
        const generatedAudits = [];
        const audit = { record(entry) { generatedAudits.push(entry); } };
        const service = new GeneratedService({
          database: { storage: { sync } }, audit, events: { async emit() {} },
        });
        const managedService = new ManagedGeneratedService({
          database: { storage: { sync: managedSync } }, audit, events: { async emit() {} },
        });
        /** @param {() => unknown | Promise<unknown>} run */
        const drive = async (run) => {
          const start = generatedCalls.length;
          const result = await run();
          return { result, calls: generatedCalls.slice(start) };
        };
        let managedCreateRefusal = null;
        try {
          await service.create({ name: 'Refused', kind: 'primary', enabled: true, status: 'closed' }, { actor: probeActor });
        } catch (error) { managedCreateRefusal = error?.code ?? null; }
        const create = await drive(() => service.create({
          name: 'Probe', note: 'created-note', kind: 'primary', enabled: true,
        }, { actor: probeActor }));
        const created = create.result;
        realSync.execute({
          kind: 'insert', table: 'truth_storage_probes', values: [
            { column: 'id', value: 'truth-nonmatching' },
            { column: 'name', value: 'Other' },
            { column: 'note', value: null },
            { column: 'kind', value: 'secondary' },
            { column: 'enabled', value: 0 },
            { column: 'status', value: 'pending' },
            { column: 'created_at', value: '2026-01-01T00:00:00.000Z' },
            { column: 'updated_at', value: '2026-01-01T00:00:00.000Z' },
          ],
        });
        realSync.execute({
          kind: 'insert', table: 'truth_storage_probes', values: [
            { column: 'id', value: 'truth-open-disabled' },
            { column: 'name', value: 'Open Disabled' },
            { column: 'note', value: 'conjunction-target' },
            { column: 'kind', value: 'primary' },
            { column: 'enabled', value: 0 },
            { column: 'status', value: 'pending' },
            { column: 'created_at', value: '2026-01-01T00:00:00.000Z' },
            { column: 'updated_at', value: '2026-01-01T00:00:00.000Z' },
          ],
        });
        realSync.execute({
          kind: 'insert', table: 'truth_storage_probes', values: [
            { column: 'id', value: 'truth-closed' },
            { column: 'name', value: 'Closed' },
            { column: 'note', value: 'membership-target' },
            { column: 'kind', value: 'secondary' },
            { column: 'enabled', value: 0 },
            { column: 'status', value: 'closed' },
            { column: 'created_at', value: '2026-01-01T00:00:00.000Z' },
            { column: 'updated_at', value: '2026-01-01T00:00:00.000Z' },
          ],
        });
        const get = await drive(() => service.get(created.id));
        const list = await drive(() => service.list());
        const listWithMembership = await drive(() => service.list({ where: { status: ['open', 'closed'] } }));
        const listWhere = await drive(() => service.listWhere({ id: created.id }));
        const listWhereNull = await drive(() => service.listWhere({ note: null }));
        const listWhereEnabled = await drive(() => service.listWhere({ enabled: true }));
        const countWhere = await drive(() => service.countWhere({ id: created.id }));
        const countWhereMembership = await drive(() => service.countWhere({ status: ['open', 'closed'] }));
        const countWhereDisabled = await drive(() => service.countWhere({ enabled: false }));
        const listWhereConjunction = await drive(() => service.listWhere({ kind: 'primary', enabled: false }));
        const countWhereConjunction = await drive(() => service.countWhere({ kind: 'primary', enabled: false }));
        const countWhereNoMatchConjunction = await drive(() => service.countWhere({ kind: 'secondary', enabled: true }));
        const createOmitted = await drive(() => service.create({
          name: 'Omitted Note', kind: 'primary', enabled: true,
        }, { actor: probeActor }));
        const getOmitted = await drive(() => service.get(createOmitted.result.id));
        let managedUpdateRefusal = null;
        try {
          await service.update(created.id, { status: 'closed' }, { actor: probeActor });
        } catch (error) { managedUpdateRefusal = error?.code ?? null; }
        const update = await drive(() => service.update(created.id, {
          name: 'Updated Probe', note: 'updated-note', kind: 'secondary', enabled: false,
        }, { actor: probeActor }));
        const listSiblingsAfterUpdate = await drive(() => service.list());
        const getNonmatchingAfterUpdate = await drive(() => service.get('truth-nonmatching'));
        const createNull = await drive(() => service.create({
          name: 'Null Probe', note: null, kind: 'primary', enabled: true,
        }, { actor: probeActor }));
        const getNull = await drive(() => service.get(createNull.result.id));
        const partialUpdate = await drive(() => service.update(created.id, { note: null }, { actor: probeActor }));
        const listSiblingsAfterPartialUpdate = await drive(() => service.list());
        const applyManaged = await drive(() => service.applyManaged(created.id, { status: 'closed' }, { actor: probeActor }));
        const listSiblingsAfterManaged = await drive(() => service.list());
        const getNonmatchingAfterManaged = await drive(() => service.get('truth-nonmatching'));
        const createManaged = await drive(() => managedService.createManaged({
          name: 'Managed Probe', note: 'managed-note', status: 'open',
        }, { actor: probeActor }));
        const getManagedCreated = await drive(() => managedService.get(createManaged.result.id));
        const createManagedSibling = await drive(() => managedService.createManaged({
          name: 'Managed Sibling', note: 'sibling-note', status: 'open',
        }, { actor: probeActor }));
        const createManagedOmitted = await drive(() => managedService.createManaged({
          name: 'Managed Omitted', status: 'open',
        }, { actor: probeActor }));
        const getManagedOmittedCreated = await drive(() => managedService.get(createManagedOmitted.result.id));
        const createManagedDefaults = await drive(() => managedService.createManaged({}, { actor: probeActor }));
        const getManagedDefaultsCreated = await drive(() => managedService.get(createManagedDefaults.result.id));
        const updateManaged = await drive(() => managedService.applyManaged(createManaged.result.id, {
          name: 'Updated Managed Probe', note: null, status: 'closed',
        }, { actor: probeActor }));
        const getManagedUpdated = await drive(() => managedService.get(createManaged.result.id));
        const getManagedSiblingAfterUpdate = await drive(() => managedService.get(createManagedSibling.result.id));
        const getManagedOmittedAfterUpdate = await drive(() => managedService.get(createManagedOmitted.result.id));
        const getManagedDefaultsAfterUpdate = await drive(() => managedService.get(createManagedDefaults.result.id));
        const partialManagedUpdate = await drive(() => managedService.applyManaged(createManaged.result.id, { note: 'restored-note' }, { actor: probeActor }));
        const getManagedPartial = await drive(() => managedService.get(createManaged.result.id));
        const getManagedOmittedAfterPartial = await drive(() => managedService.get(createManagedOmitted.result.id));
        const getManagedDefaultsAfterPartial = await drive(() => managedService.get(createManagedDefaults.result.id));
        const getManagedSibling = await drive(() => managedService.get(createManagedSibling.result.id));
        const operations = {
          create: create.calls,
          get: get.calls,
          list: list.calls,
          listWithMembership: listWithMembership.calls,
          listWhere: listWhere.calls,
          listWhereNull: listWhereNull.calls,
          listWhereEnabled: listWhereEnabled.calls,
          countWhere: countWhere.calls,
          countWhereMembership: countWhereMembership.calls,
          countWhereDisabled: countWhereDisabled.calls,
          listWhereConjunction: listWhereConjunction.calls,
          countWhereConjunction: countWhereConjunction.calls,
          countWhereNoMatchConjunction: countWhereNoMatchConjunction.calls,
          createOmitted: createOmitted.calls,
          getOmitted: getOmitted.calls,
          update: update.calls,
          listSiblingsAfterUpdate: listSiblingsAfterUpdate.calls,
          getNonmatchingAfterUpdate: getNonmatchingAfterUpdate.calls,
          createNull: createNull.calls,
          getNull: getNull.calls,
          partialUpdate: partialUpdate.calls,
          listSiblingsAfterPartialUpdate: listSiblingsAfterPartialUpdate.calls,
          applyManaged: applyManaged.calls,
          listSiblingsAfterManaged: listSiblingsAfterManaged.calls,
          getNonmatchingAfterManaged: getNonmatchingAfterManaged.calls,
          createManaged: createManaged.calls,
          getManagedCreated: getManagedCreated.calls,
          createManagedSibling: createManagedSibling.calls,
          createManagedOmitted: createManagedOmitted.calls,
          getManagedOmittedCreated: getManagedOmittedCreated.calls,
          createManagedDefaults: createManagedDefaults.calls,
          getManagedDefaultsCreated: getManagedDefaultsCreated.calls,
          updateManaged: updateManaged.calls,
          getManagedUpdated: getManagedUpdated.calls,
          getManagedSiblingAfterUpdate: getManagedSiblingAfterUpdate.calls,
          getManagedOmittedAfterUpdate: getManagedOmittedAfterUpdate.calls,
          getManagedDefaultsAfterUpdate: getManagedDefaultsAfterUpdate.calls,
          partialManagedUpdate: partialManagedUpdate.calls,
          getManagedPartial: getManagedPartial.calls,
          getManagedOmittedAfterPartial: getManagedOmittedAfterPartial.calls,
          getManagedDefaultsAfterPartial: getManagedDefaultsAfterPartial.calls,
          getManagedSibling: getManagedSibling.calls,
        };
        const seededSiblings = [
          { id: 'truth-nonmatching', name: 'Other', note: null, kind: 'secondary', enabled: false, status: 'pending',
            createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
          { id: 'truth-open-disabled', name: 'Open Disabled', note: 'conjunction-target', kind: 'primary', enabled: false, status: 'pending',
            createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
          { id: 'truth-closed', name: 'Closed', note: 'membership-target', kind: 'secondary', enabled: false, status: 'closed',
            createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
        ];
        const seededSiblingsUnchanged = [
          listSiblingsAfterUpdate.result, listSiblingsAfterPartialUpdate.result, listSiblingsAfterManaged.result,
        ].every((rows) => seededSiblings.every((expected) => isDeepStrictEqual(
          rows.find((row) => row.id === expected.id), expected,
        ))) && [listSiblingsAfterUpdate.result, listSiblingsAfterPartialUpdate.result, listSiblingsAfterManaged.result]
          .every((rows) => isDeepStrictEqual(rows.find((row) => row.id === createOmitted.result.id), createOmitted.result))
          && [listSiblingsAfterPartialUpdate.result, listSiblingsAfterManaged.result]
            .every((rows) => isDeepStrictEqual(rows.find((row) => row.id === createNull.result.id), createNull.result));
        const priorMutationTimestamps = [
          created.updatedAt,
          update.result.updatedAt,
          partialUpdate.result.updatedAt,
          createManaged.result.updatedAt,
          updateManaged.result.updatedAt,
        ];
        const mutationTimestampsAdvance = generatedUpdateTimestamps.length === priorMutationTimestamps.length
          && generatedUpdateTimestamps.every((timestamp, index) => Number.isFinite(Date.parse(timestamp))
            && Date.parse(timestamp) > Date.parse(priorMutationTimestamps[index]));
        if (!mutationTimestampsAdvance) {
          throw new Error('generated mutation timestamps did not advance strictly');
        }
        const resultsValid = managedCreateRefusal === 'VALIDATION_ERROR'
          && managedUpdateRefusal === 'VALIDATION_ERROR'
          && generatedAudits.length === 12
          && generatedAudits.every((entry) => isDeepStrictEqual(entry.actor, probeActor))
          && seededSiblingsUnchanged
          && created.name === 'Probe'
          && created.note === 'created-note'
          && created.kind === 'primary'
          && created.enabled === true
          && created.status === 'open'
          && isDeepStrictEqual(get.result, created)
          && list.result.length === 4
          && isDeepStrictEqual(list.result.find((row) => row.id === created.id), created)
          && isDeepStrictEqual(list.result.find((row) => row.id === 'truth-nonmatching'), {
            id: 'truth-nonmatching', name: 'Other', note: null, kind: 'secondary', enabled: false, status: 'pending',
            createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
          })
          && listWithMembership.result.length === 2
          && isDeepStrictEqual(listWithMembership.result.find((row) => row.id === created.id), created)
          && isDeepStrictEqual(listWithMembership.result.find((row) => row.id === 'truth-closed'), {
            id: 'truth-closed', name: 'Closed', note: 'membership-target', kind: 'secondary',
            enabled: false, status: 'closed', createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          })
          && listWhere.result.length === 1
          && isDeepStrictEqual(listWhere.result[0], created)
          && listWhereNull.result.length === 1
          && isDeepStrictEqual(listWhereNull.result[0], {
            id: 'truth-nonmatching', name: 'Other', note: null, kind: 'secondary', enabled: false, status: 'pending',
            createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
          })
          && listWhereEnabled.result.length === 1
          && isDeepStrictEqual(listWhereEnabled.result[0], created)
          && countWhere.result === 1
          && countWhereMembership.result === 2
          && countWhereDisabled.result === 3
          && listWhereConjunction.result.length === 1
          && listWhereConjunction.result[0].id === 'truth-open-disabled'
          && countWhereConjunction.result === 1
          && countWhereNoMatchConjunction.result === 0
          && Object.hasOwn(createOmitted.result, 'note')
          && createOmitted.result.note === null
          && isDeepStrictEqual(getOmitted.result, createOmitted.result)
          && isDeepStrictEqual(update.result, {
            ...created, name: 'Updated Probe', note: 'updated-note', kind: 'secondary', enabled: false,
            updatedAt: update.result.updatedAt,
          })
          && Date.parse(update.result.updatedAt) > Date.parse(created.updatedAt)
          && isDeepStrictEqual(getNonmatchingAfterUpdate.result, {
            id: 'truth-nonmatching', name: 'Other', note: null, kind: 'secondary', enabled: false, status: 'pending',
            createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
          })
          && Object.hasOwn(createNull.result, 'note')
          && createNull.result.note === null
          && createNull.result.name === 'Null Probe'
          && createNull.result.kind === 'primary'
          && createNull.result.enabled === true
          && createNull.result.status === 'open'
          && isDeepStrictEqual(getNull.result, createNull.result)
          && isDeepStrictEqual(partialUpdate.result, {
            ...update.result, note: null, updatedAt: partialUpdate.result.updatedAt,
          })
          && isDeepStrictEqual(applyManaged.result, { ...partialUpdate.result, status: 'closed', updatedAt: applyManaged.result.updatedAt })
          && Date.parse(applyManaged.result.updatedAt) > Date.parse(partialUpdate.result.updatedAt)
          && isDeepStrictEqual(getNonmatchingAfterManaged.result, getNonmatchingAfterUpdate.result)
          && createManaged.result.name === 'Managed Probe'
          && createManaged.result.note === 'managed-note'
          && createManaged.result.status === 'open'
          && isDeepStrictEqual(getManagedCreated.result, createManaged.result)
          && isDeepStrictEqual(updateManaged.result, {
            ...createManaged.result, name: 'Updated Managed Probe', note: null, status: 'closed',
            updatedAt: updateManaged.result.updatedAt,
          })
          && Object.hasOwn(updateManaged.result, 'note')
          && Date.parse(updateManaged.result.updatedAt) > Date.parse(createManaged.result.updatedAt)
          && isDeepStrictEqual(getManagedUpdated.result, updateManaged.result)
          && Object.hasOwn(createManagedOmitted.result, 'note')
          && createManagedOmitted.result.note === null
          && isDeepStrictEqual(getManagedOmittedCreated.result, createManagedOmitted.result)
          && createManagedDefaults.result.name === 'Managed Default'
          && createManagedDefaults.result.status === 'open'
          && createManagedDefaults.result.note === null
          && isDeepStrictEqual(getManagedDefaultsCreated.result, createManagedDefaults.result)
          && isDeepStrictEqual(getManagedSiblingAfterUpdate.result, createManagedSibling.result)
          && isDeepStrictEqual(getManagedOmittedAfterUpdate.result, createManagedOmitted.result)
          && isDeepStrictEqual(getManagedDefaultsAfterUpdate.result, createManagedDefaults.result)
          && isDeepStrictEqual(partialManagedUpdate.result, {
            ...updateManaged.result, note: 'restored-note', updatedAt: partialManagedUpdate.result.updatedAt,
          })
          && isDeepStrictEqual(getManagedPartial.result, partialManagedUpdate.result)
          && isDeepStrictEqual(getManagedOmittedAfterPartial.result, createManagedOmitted.result)
          && isDeepStrictEqual(getManagedDefaultsAfterPartial.result, createManagedDefaults.result)
          && isDeepStrictEqual(getManagedSibling.result, createManagedSibling.result)
          && isDeepStrictEqual(generatedUpdateTimestamps, [
            update.result.updatedAt, partialUpdate.result.updatedAt, applyManaged.result.updatedAt,
            updateManaged.result.updatedAt, partialManagedUpdate.result.updatedAt,
          ]);
        bundle.generatedRuntimeUsesStorage = resultsValid && canonical(operations) === canonical({
          create: [['savepoint', 'truth_storage_probe_mutation'], ['execute', 'insert']],
          get: [['maybeOne', 'select']],
          list: [['many', 'select']],
          listWithMembership: [['many', 'select']],
          listWhere: [['many', 'select']],
          listWhereNull: [['many', 'select']],
          listWhereEnabled: [['many', 'select']],
          countWhere: [['maybeOne', 'count']],
          countWhereMembership: [['maybeOne', 'count']],
          countWhereDisabled: [['maybeOne', 'count']],
          listWhereConjunction: [['many', 'select']],
          countWhereConjunction: [['maybeOne', 'count']],
          countWhereNoMatchConjunction: [['maybeOne', 'count']],
          createOmitted: [['savepoint', 'truth_storage_probe_mutation'], ['execute', 'insert']],
          getOmitted: [['maybeOne', 'select']],
          update: [['maybeOne', 'select'], ['savepoint', 'truth_storage_probe_mutation'], ['execute', 'update'], ['maybeOne', 'select']],
          listSiblingsAfterUpdate: [['many', 'select']],
          getNonmatchingAfterUpdate: [['maybeOne', 'select']],
          createNull: [['savepoint', 'truth_storage_probe_mutation'], ['execute', 'insert']],
          getNull: [['maybeOne', 'select']],
          partialUpdate: [['maybeOne', 'select'], ['savepoint', 'truth_storage_probe_mutation'], ['execute', 'update'], ['maybeOne', 'select']],
          listSiblingsAfterPartialUpdate: [['many', 'select']],
          applyManaged: [['maybeOne', 'select'], ['savepoint', 'truth_storage_probe_mutation'], ['execute', 'update'], ['maybeOne', 'select']],
          listSiblingsAfterManaged: [['many', 'select']],
          getNonmatchingAfterManaged: [['maybeOne', 'select']],
          createManaged: [['savepoint', 'truth_managed_storage_probe_mutation'], ['execute', 'insert']],
          getManagedCreated: [['maybeOne', 'select']],
          createManagedSibling: [['savepoint', 'truth_managed_storage_probe_mutation'], ['execute', 'insert']],
          createManagedOmitted: [['savepoint', 'truth_managed_storage_probe_mutation'], ['execute', 'insert']],
          getManagedOmittedCreated: [['maybeOne', 'select']],
          createManagedDefaults: [['savepoint', 'truth_managed_storage_probe_mutation'], ['execute', 'insert']],
          getManagedDefaultsCreated: [['maybeOne', 'select']],
          updateManaged: [['maybeOne', 'select'], ['savepoint', 'truth_managed_storage_probe_mutation'], ['execute', 'update'], ['maybeOne', 'select']],
          getManagedUpdated: [['maybeOne', 'select']],
          getManagedSiblingAfterUpdate: [['maybeOne', 'select']],
          getManagedOmittedAfterUpdate: [['maybeOne', 'select']],
          getManagedDefaultsAfterUpdate: [['maybeOne', 'select']],
          partialManagedUpdate: [['maybeOne', 'select'], ['savepoint', 'truth_managed_storage_probe_mutation'], ['execute', 'update'], ['maybeOne', 'select']],
          getManagedPartial: [['maybeOne', 'select']],
          getManagedOmittedAfterPartial: [['maybeOne', 'select']],
          getManagedDefaultsAfterPartial: [['maybeOne', 'select']],
          getManagedSibling: [['maybeOne', 'select']],
        });
        if (!bundle.generatedRuntimeUsesStorage) {
          throw new Error('the generated storage behavior probe was inconclusive or regressed');
        }
      } finally {
        raw.close();
        managedRaw.close();
      };
    } finally {
      rmSync(generatedRoot, { recursive: true, force: true });
    }

    // Behavior probe for the deliberately retained compatibility path. The
    // fake service permits entry; the only way to answer that the table is
    // absent is to invoke the supplied raw SQLite-shaped prepare/get pair.
    let legacyPrepareCalls = 0;
    const legacyReport = await migrateLegacyTasks({
      modules: { get: () => ({ service: { createManaged() {}, listWhere() { return []; } } }) },
      database: { raw: { prepare() {
        legacyPrepareCalls += 1;
        return {
          get: () => ({ name: 'tasks' }),
          all: () => [{ id: 'legacy-1', title: 'Legacy', status: 'open', due_at: null,
            lead_id: 'lead-1', source_key: 'old-key', created_at: '2026-01-01T00:00:00.000Z' }],
        };
      } } },
    });
    bundle.workLegacyUsesRaw = legacyPrepareCalls === 2
      && legacyReport.found === 1 && legacyReport.wouldAdopt === 1;
    if (!bundle.workLegacyUsesRaw) {
      throw new Error('the Work legacy raw-read behavior probe was inconclusive or regressed');
    }
  } catch (error) {
    unavailable(`the spine authorities could not be read: ${/** @type {any} */ (error)?.message ?? error}`);
    return bundle;
  }

  // ── the reference composition ────────────────────────────────────────────
  try {
    const { resolvePackageComposition } = await import(url('packages/core/src/package-composition.js'));
    const { SUPPORTED_PACKAGE_CONTRACT } = await import(url('packages/core/src/package-registry.js'));
    /** @type {any[]} */
    const definitions = [];
    for (const [, path, factory] of REFERENCE_PACKAGES) {
      const module = await import(url(path));
      if (typeof module[factory] !== 'function') {
        unavailable(`${path} does not export ${factory}(), so the reference composition cannot be built`);
        return bundle;
      }
      definitions.push(module[factory]());
    }
    const composition = resolvePackageComposition(definitions);
    bundle.supportedPackageContract = SUPPORTED_PACKAGE_CONTRACT;
    bundle.composition = {
      problems: composition.problems.map((problem) => ({ code: problem.code, message: problem.message })),
      packages: [...composition.packages.values()].map((pkg) => ({
        name: pkg.name,
        version: pkg.version,
        packageContract: pkg.packageContract,
        resources: [...(pkg.resources ?? [])].sort(compare),
        actions: (pkg.actions ?? []).map((action) => `${action.module}.${action.name}`).sort(compare),
        provides: (pkg.capabilities ?? []).map((entry) => `${entry.name}@${entry.version}`).sort(compare),
        requires: (pkg.requires ?? []).map((entry) => `${entry.package}/${entry.capability}@${entry.version}`).sort(compare),
      })).sort((a, b) => compare(a.name, b.name)),
      resources: [...composition.resources.keys()].sort(compare),
      capabilities: [...composition.capabilities.keys()].sort(compare),
      policies: [...composition.policies.keys()].sort(compare),
    };
  } catch (error) {
    unavailable(`the reference composition could not be built: ${/** @type {any} */ (error)?.message ?? error}`);
    return bundle;
  }

  // ── the rails, read twice ────────────────────────────────────────────────
  const dispatchSource = readFileSync(join(rootDir, 'packages/cli/src/commands.js'), 'utf8');
  const dispatched = new Set(
    [...dispatchSource.matchAll(/command === '([a-z]+:[a-z]+)'/g)].map((match) => match[1]),
  );
  /** @type {Record<string, {dispatched: boolean, handler: boolean}>} */
  const rails = {};
  for (const [factId, verb, handlerPath, exportName] of RAILS) {
    let handler = false;
    if (existsSync(join(rootDir, handlerPath))) {
      try {
        const module = await import(url(handlerPath));
        handler = typeof module[exportName] === 'function';
      } catch (error) {
        unavailable(`rail handler ${handlerPath} could not be imported: ${/** @type {any} */ (error)?.message ?? error}`);
      }
    }
    rails[factId] = { dispatched: dispatched.has(verb), handler };
  }
  bundle.rails = rails;

  // ── the frozen journey registry's declared limitation codes ──────────────
  try {
    const { JOURNEYS } = await import(url('packages/cli/src/scenario-journey.js'));
    const codes = new Set();
    for (const journey of Object.values(/** @type {any} */ (JOURNEYS))) {
      for (const entry of /** @type {any} */ (journey).limitations ?? []) codes.add(entry.code);
    }
    bundle.journeyCodes = [...codes].sort(compare);
  } catch (error) {
    unavailable(`the journey registry could not be read: ${/** @type {any} */ (error)?.message ?? error}`);
    return bundle;
  }

  // ── the manifest, as the second authority on PostgreSQL ──────────────────
  try {
    const manifest = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'));
    bundle.productionDependencies = Object.keys(manifest.dependencies ?? {}).sort(compare);
  } catch (error) {
    unavailable(`package.json could not be read: ${/** @type {any} */ (error)?.message ?? error}`);
    return bundle;
  }

  // ── the JTBD portfolio, counted rather than typed ────────────────────────
  //
  // Six **summary** facts, and deliberately not six hundred. ADR-039's
  // `JTBD_ROWS_NOT_ENCODED` holds that no job status is a fact, and that still holds:
  // nothing here reads a coverage status and turns it into a value. What is counted is the
  // shape of the portfolio — how many desired jobs exist, whether the coverage overlay
  // covers all of them, how many are claimed by no milestone, how many non-default coverage
  // rows cite no canonical job, and how many positive rows carry no evidence. The last is
  // the one that matters: it must stay 0, and typing it by hand is exactly how it would stop
  // being 0 without anything failing.
  try {
    bundle.jtbd = readJtbdPortfolio(rootDir);
  } catch (error) {
    unavailable(`the JTBD portfolio could not be read: ${/** @type {any} */ (error)?.message ?? error}`);
    return bundle;
  }

  // ── the benchmark receipt, verified rather than trusted ──────────────────
  bundle.benchmark = readBenchmarkReceipt(rootDir, deferred);

  // ── the measured ledger and git ──────────────────────────────────────────
  bundle.measurement = readMeasurement(rootDir, deferred);

  bundle.deferredProblems = deferred;
  return bundle;
}

/**
 * Count the JTBD portfolio's shape, without holding it.
 *
 * The catalogue is 4.6 MB of JSONL and the overlays are one row per record. Every read here
 * splits on newlines and keeps only an id or a status, so nothing ever holds 600 records —
 * the same discipline `scripts/jtbd-gate.js` and `docs/jtbd/tools/query_catalog.py` are
 * written to. A missing file throws, and the caller turns that into
 * `TRUTH_AUTHORITY_UNAVAILABLE`: no count is defaulted from a file that was not there.
 *
 * @param {string} rootDir
 */
function readJtbdPortfolio(rootDir) {
  const lines = (rel) => readFileSync(join(rootDir, rel), 'utf8').split('\n').filter((line) => line.trim());
  const catalogIds = new Set();
  let records = 0;
  for (const line of lines('docs/jtbd/catalog/jtbd.jsonl')) {
    records += 1;
    const match = /"jtbd_id"\s*:\s*"([^"]+)"/.exec(line);
    if (match) catalogIds.add(match[1]);
  }
  const coverage = lines('docs/jtbd/coverage/coverage.overlay.jsonl').map((line) => JSON.parse(line));
  const roadmap = lines('docs/jtbd/roadmap/roadmap.overlay.jsonl').map((line) => JSON.parse(line));
  const crosswalk = JSON.parse(readFileSync(join(rootDir, 'docs/jtbd/coverage/matrix_crosswalk.json'), 'utf8'));
  const covered = new Set(coverage.map((row) => row.jtbdId));
  return {
    records,
    uniqueIds: catalogIds.size,
    overlayComplete: covered.size === catalogIds.size
      && coverage.length === records
      && roadmap.length === records
      && [...catalogIds].every((id) => covered.has(id)),
    unassigned: roadmap.filter((row) => row.ownerStatus === 'unassigned').length,
    unmapped: crosswalk.rows.filter((row) => row.matrixStatus !== 'not supported' && !row.canonicalJtbdIds.length).length,
    positiveWithoutEvidence: coverage
      .filter((row) => row.coverageStatus !== 'not supported')
      .filter((row) => !Array.isArray(row.evidence) || !row.evidence.length).length,
  };
}

/**
 * A receipt is not believed because it is present.
 *
 * The aggregate carries the protocol, instrument and base-commit fingerprints
 * it was produced under. They must equal the frozen protocol's, or the receipt
 * describes a run of a different apparatus and nothing may be read from it.
 *
 * Exported so a negative test can drive it against a mutated receipt without
 * copying the whole framework: a stale receipt must be *detectable*, and a rule
 * nothing can fail on demand is not a rule.
 *
 * @param {string} rootDir
 * @param {Array<{code: string, message: string}>} problems
 */
export function readBenchmarkReceipt(rootDir, problems) {
  const aggregatePath = join(rootDir, BENCHMARK_PANEL.aggregate);
  const protocolPath = join(rootDir, BENCHMARK_PANEL.protocol);
  if (!existsSync(aggregatePath) || !existsSync(protocolPath)) {
    problems.push({
      code: 'TRUTH_AUTHORITY_UNAVAILABLE',
      message: `the frozen benchmark panel is incomplete (${BENCHMARK_PANEL.aggregate}, ${BENCHMARK_PANEL.protocol}); `
        + 'a receipt-derived fact is refused rather than defaulted',
    });
    return null;
  }
  let aggregate;
  let protocol;
  try {
    aggregate = JSON.parse(readFileSync(aggregatePath, 'utf8'));
    protocol = JSON.parse(readFileSync(protocolPath, 'utf8'));
  } catch (error) {
    problems.push({
      code: 'TRUTH_AUTHORITY_UNAVAILABLE',
      message: `the frozen benchmark panel is not valid JSON: ${/** @type {any} */ (error)?.message ?? error}`,
    });
    return null;
  }

  const admission = aggregate.admission ?? {};
  /** @type {string[]} */
  const mismatches = [];
  for (const key of ['protocolFingerprint', 'instrumentFingerprint', 'baseSha']) {
    if (admission[key] !== protocol[key]) {
      mismatches.push(`${key} (${String(admission[key]).slice(0, 12)} vs ${String(protocol[key]).slice(0, 12)})`);
    }
  }
  if (mismatches.length) {
    problems.push({
      code: 'TRUTH_AUTHORITIES_CONTRADICT',
      message: `${BENCHMARK_PANEL.aggregate} was produced under a different apparatus than `
        + `${BENCHMARK_PANEL.protocol} froze: ${mismatches.join(', ')}. A receipt whose own fingerprints do not `
        + 'match its protocol proves nothing, so it is refused rather than read',
    });
    return null;
  }

  return {
    comparative: aggregate.comparative === true,
    protocolFingerprint: String(protocol.protocolFingerprint ?? ''),
    admitted: Number(admission.admitted ?? 0),
    supplied: Number(admission.supplied ?? 0),
    // No `rate`, `sabr` or `successRate` key exists in the record at all. That
    // absence is the absence of a measurement, which is what `not_measured`
    // means — it is not a claim that the thing measured is false.
    ratePublished: ['rate', 'sabr', 'successRate', 'buildRate'].some((key) => key in aggregate),
  };
}

/**
 * The measured ledger, and what git can prove about it.
 *
 * Exported for the same reason as {@link readBenchmarkReceipt}: the ancestry,
 * shallow-clone and moved-tree rules each need a repository shaped a particular
 * way, and a test builds one in a temporary directory in milliseconds.
 *
 * @param {string} rootDir
 * @param {Array<{code: string, message: string}>} problems
 */
export function readMeasurement(rootDir, problems) {
  const ledgerPath = join(rootDir, 'site/claims.json');
  if (!existsSync(ledgerPath)) {
    problems.push({ code: 'TRUTH_AUTHORITY_UNAVAILABLE', message: 'site/claims.json does not exist' });
    return null;
  }
  let ledger;
  try {
    ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  } catch (error) {
    problems.push({ code: 'TRUTH_AUTHORITY_UNAVAILABLE', message: `site/claims.json is not valid JSON: ${/** @type {any} */ (error)?.message ?? error}` });
    return null;
  }
  const record = ledger.measuredAgainst ?? {};
  const sha = String(record.sha ?? '');
  const git = gitIn(rootDir);

  const head = git(['rev-parse', 'HEAD']);
  const shallowProbe = git(['rev-parse', '--is-shallow-repository']);
  const shallow = shallowProbe.status === 0 && shallowProbe.stdout === 'true';

  if (head.status !== 0 || !head.stdout || shallow) {
    problems.push({
      code: 'TRUTH_MEASUREMENT_UNPROVABLE',
      message: shallow
        ? 'this is a shallow clone, so ancestry of the measured commit cannot be proven and the measurement facts '
          + 'are refused rather than guessed. Give the job full history — `git fetch --unshallow`, or '
          + '`actions/checkout` with `fetch-depth: 0`'
        : 'this tree is not a git checkout, so nothing here can confirm the measured commit. A measurement fact '
          + 'that cannot be traced is not a fact',
    });
    return { sha, tests: record.tests ?? null, testFiles: record.testFiles ?? null, ancestor: 'unknown', treeCurrent: 'unknown' };
  }

  const present = git(['cat-file', '-e', `${sha}^{commit}`]).status === 0;
  const ancestor = present && git(['merge-base', '--is-ancestor', sha, 'HEAD']).status === 0;
  if (!ancestor) {
    problems.push({
      code: 'TRUTH_MEASUREMENT_NOT_ANCESTOR',
      message: `site/claims.json measuredAgainst.sha ${sha || '(missing)'} is not an ancestor of HEAD. Object `
        + 'existence is not provenance; ancestry is (ADR-027). The published numbers were measured on a line of '
        + 'development this code does not descend from',
    });
  }

  const measuredTree = ancestor ? git(['rev-parse', `${sha}:tests`]).stdout : '';
  const headTree = git(['rev-parse', 'HEAD:tests']).stdout;

  return {
    sha,
    tests: Number.isInteger(record.tests) ? record.tests : null,
    testFiles: Number.isInteger(record.testFiles) ? record.testFiles : null,
    ancestor: ancestor ? 'true' : 'false',
    treeCurrent: !measuredTree || !headTree ? 'unknown' : measuredTree === headTree ? 'true' : 'false',
    measuredTree,
    headTree,
  };
}

// ─────────────────────────────────────────────────────────────── facts

/**
 * Turn a bundle of authority readings into sorted, function-free facts.
 *
 * Pure over the bundle: no filesystem, no git, no imports. That is what lets a
 * negative test flip one authority and observe the document move.
 *
 * @param {any} bundle
 * @returns {{facts: any[], authorities: any[], problems: Array<{code: string, message: string}>}}
 */
export function buildFacts(bundle) {
  /** @type {any[]} */
  const facts = [];
  /** @type {Array<{code: string, message: string}>} */
  const problems = [];

  /**
   * Add one fact, refusing anything outside the vocabulary it is allowed.
   *
   * Most facts take a token from {@link FACT_VALUES}. Three shapes are bounded
   * literals instead, because a commit id and a count are not tokens: `sha`
   * (7–40 lowercase hex, or the token `unknown`), `count` (a non-negative
   * integer, or `unknown`) and `contract` (a positive integer). Nothing else
   * may carry a literal, so a free-form sentence can never become a fact value.
   */
  const add = (fact) => {
    const shapes = {
      sha: (value) => /^[0-9a-f]{7,40}$/.test(String(value)) || value === 'unknown',
      count: (value) => (Number.isInteger(value) && value >= 0) || value === 'unknown',
      contract: (value) => Number.isInteger(value) && value > 0,
    };
    const allowed = fact.shape
      ? shapes[fact.shape](fact.value)
      : FACT_VALUES.includes(String(fact.value));
    if (!allowed) {
      problems.push({
        code: 'TRUTH_AUTHORITY_UNAVAILABLE',
        message: `fact ${fact.id} produced ${JSON.stringify(fact.value)}, which is outside the `
          + `${fact.shape ? `bounded "${fact.shape}" literal shape` : 'closed value vocabulary'} it is allowed. `
          + 'A fact whose authority answers something unrecognised is refused, never published.',
      });
      return;
    }
    facts.push({
      id: fact.id,
      value: fact.value,
      authority: fact.authority,
      evidence: [...fact.evidence].sort(compare),
      scope: fact.scope,
      status: fact.status ?? 'current',
      limitations: [...(fact.limitations ?? [])].sort(compare),
    });
  };

  /**
   * Two authorities disagreed about one fact, so **neither answer is published**.
   *
   * A fact already added is withdrawn rather than left standing. Publishing the
   * first authority's answer and a problem beside it would mean a reader who
   * looked only at `facts[]` saw a value two authorities could not agree on,
   * which is the failure this whole contract exists to close, reproduced inside
   * the contract itself.
   */
  const refuse = (id, message) => {
    const index = facts.findIndex((fact) => fact.id === id);
    if (index >= 0) facts.splice(index, 1);
    problems.push({ code: 'TRUTH_AUTHORITIES_CONTRADICT', message });
  };

  // ── spine ────────────────────────────────────────────────────────────────
  add({
    id: 'spine.identity.contract',
    value: bundle.identityContract,
    shape: 'contract',
    authority: 'identity.contract',
    evidence: ['packages/core/src/identity.js#IDENTITY_CONTRACT', `kinds:${bundle.identityKinds.join('|')}`],
    scope: 'framework',
  });

  add({
    id: 'spine.authentication.framework_verifier',
    // Production refuses to start without a verifier supplied from outside, so
    // the framework ships none. `absent` here is a positive statement about the
    // seam, not an observation of silence.
    value: bundle.verifierRefusal === 'SPINE_VERIFIER_REQUIRED' ? 'absent' : 'unknown',
    authority: 'runtime.mode',
    evidence: [
      'packages/core/src/runtime-mode.js#resolveRuntimeMode',
      `refusal:${bundle.verifierRefusal ?? 'none'}`,
      `mode-env:${bundle.modeEnv}`,
    ],
    scope: 'framework',
    limitations: ['TRUTH_IS_SOURCE_AND_RECEIPTS_NOT_RUNTIME'],
  });

  add({
    id: 'spine.authorization.enforced',
    value: bundle.anonymousAllowed === false ? 'enforced' : 'unknown',
    authority: 'spine.contract',
    evidence: [
      'packages/core/src/authorization.js#decideAuthorization',
      `permissions:${bundle.permissions.length}`,
      `roles:${bundle.roles.length}`,
      `spineContract:${bundle.spineContract}`,
    ],
    scope: 'framework',
  });

  add({
    id: 'spine.tenant.isolation.mode',
    value: bundle.tenantStrategy === 'one-tenant-per-instance' ? 'one_tenant_per_instance' : 'unknown',
    authority: 'tenant.storage',
    evidence: ['packages/core/src/tenant-storage.js#TENANT_STRATEGY', `tenantStorageContract:${bundle.tenantStorageContract}`],
    scope: 'framework',
  });

  const probe = bundle.tenantProbe ?? {};
  add({
    id: 'spine.tenant.crm_data_plane_enforced',
    // Three questions asked of the objects themselves. Before ADR-038
    // Amendment 2 the bound handle *did* expose `databasePathFor`, and this
    // generator would have produced `declared_not_enforced` — which is the
    // point of keeping that token in the vocabulary.
    value: probe.provisioningCanNameAnyTenant && !probe.boundHandleCanNameASecondTenant && probe.planesSeparate
      ? 'enforced_by_binding'
      : probe.boundHandleCanNameASecondTenant
        ? 'declared_not_enforced'
        : 'unknown',
    authority: 'tenant.storage',
    evidence: [
      'packages/core/src/tenant-storage.js#bindTenantStorage',
      `boundHandleCanNameASecondTenant:${probe.boundHandleCanNameASecondTenant}`,
      `planesSeparate:${probe.planesSeparate}`,
    ],
    scope: 'framework',
  });

  add({
    id: 'spine.multi_tenant_single_instance',
    value: (bundle.tenantLimitationCodes ?? []).includes('ONE_TENANT_PER_INSTANCE') ? 'refused_at_startup' : 'unknown',
    authority: 'tenant.storage',
    evidence: ['packages/core/src/tenant-storage.js#TENANT_LIMITATIONS', ...(bundle.tenantLimitationCodes ?? [])],
    scope: 'framework',
  });

  add({
    id: 'spine.storage.contract',
    value: bundle.storageContract,
    shape: 'contract',
    authority: 'storage.contract',
    evidence: ['packages/core/src/storage-contract.js#STORAGE_CONTRACT'],
    scope: 'framework',
  });
  add({
    id: 'spine.storage.company_runtime',
    value: bundle.companyUsesStorage ? 'implemented' : 'absent',
    authority: 'storage.contract',
    evidence: ['packages/modules/company/src/company-service.js#CompanyService'],
    scope: 'framework',
    limitations: ['STORAGE_FACT_IS_BOUNDED_PROBE'],
  });
  add({
    id: 'spine.storage.generated_runtime',
    value: bundle.generatedRuntimeUsesStorage ? 'implemented' : 'absent',
    authority: 'storage.contract',
    evidence: ['packages/cli/src/module-factory.js#serviceTemplate'],
    scope: 'framework',
    limitations: ['STORAGE_FACT_IS_BOUNDED_PROBE'],
  });
  add({
    id: 'spine.storage.work_legacy_raw',
    value: bundle.workLegacyUsesRaw ? 'implemented' : 'absent',
    authority: 'storage.contract',
    evidence: ['packages/work/src/legacy-tasks.js#migrateLegacyTasks'],
    scope: 'framework',
    limitations: ['STORAGE_FACT_IS_BOUNDED_PROBE'],
  });

  for (const [id, rule] of Object.entries(DECLARED_ABSENCE)) {
    const declaration = (bundle.spineNotModeled ?? []).find((entry) => rule.match.test(String(entry)));
    if (!declaration) {
      problems.push({
        code: 'TRUTH_AUTHORITY_UNAVAILABLE',
        message: `${id} is a declared-absence fact, but nothing in ${rule.in} matches ${rule.match}. `
          + 'A declared-absence fact whose declaration has gone is refused, never defaulted to `absent`',
      });
      continue;
    }
    add({
      id,
      value: 'absent',
      authority: 'spine.contract',
      evidence: ['packages/app/src/spine.js#SPINE_NOT_MODELED', `declared:${declaration}`],
      scope: 'framework',
      limitations: ['TRUTH_IS_SOURCE_AND_RECEIPTS_NOT_RUNTIME'],
    });
  }

  // PostgreSQL has a second, independent authority: this project declares no
  // production dependency at all, and the only adapter is node:sqlite. If the
  // two ever disagree the run fails rather than picking one.
  const postgres = facts.find((fact) => fact.id === 'spine.postgresql.implemented');
  if (postgres) {
    const dependencyEvidence = (bundle.productionDependencies ?? []).length === 0;
    if (!dependencyEvidence) {
      refuse(
        'spine.postgresql.implemented',
        `spine.postgresql.implemented reads 'absent' from SPINE_NOT_MODELED, but package.json now declares `
          + `production dependencies (${(bundle.productionDependencies ?? []).join(', ')}). Two authorities must `
          + 'agree before a boundary fact may stand',
      );
    } else {
      postgres.evidence = [...postgres.evidence, 'package.json#dependencies:none'].sort(compare);
    }
  }

  // ── domain packages ──────────────────────────────────────────────────────
  const composition = bundle.composition ?? { packages: [], problems: [] };
  if (composition.problems.length) {
    problems.push({
      code: 'TRUTH_AUTHORITY_UNAVAILABLE',
      message: `the reference composition did not resolve (${composition.problems.map((p) => p.code).join(', ')}), `
        + 'so no package fact and no namespace probe may be read from it',
    });
  } else {
    for (const [name] of REFERENCE_PACKAGES) {
      const pkg = composition.packages.find((entry) => entry.name === name);
      const id = `domain.${name.replace(/-/g, '_')}.package_native`;
      if (!pkg) {
        problems.push({
          code: 'TRUTH_AUTHORITIES_CONTRADICT',
          message: `${id}: packages/${name}/src/index.js exports a factory but the resolved composition holds no `
            + 'package by that name',
        });
        continue;
      }
      add({
        id,
        value: pkg.packageContract === bundle.supportedPackageContract ? 'package_native' : 'unknown',
        authority: 'reference.composition',
        evidence: [
          `package:${pkg.name}@${pkg.version}`,
          `packageContract:${pkg.packageContract}`,
          `resources:${pkg.resources.length}`,
          `provides:${pkg.provides.join('|') || 'none'}`,
        ],
        scope: 'package',
        limitations: ['REFERENCE_COMPOSITION_NOT_THE_PROJECT'],
      });
    }
  }

  // ── rails ────────────────────────────────────────────────────────────────
  for (const [id, verb, handlerPath, exportName] of RAILS) {
    const reading = bundle.rails?.[id] ?? { dispatched: false, handler: false };
    if (reading.dispatched !== reading.handler) {
      problems.push({
        code: 'TRUTH_AUTHORITIES_CONTRADICT',
        message: `${id}: the CLI dispatch table ${reading.dispatched ? 'names' : 'does not name'} "${verb}" while `
          + `${handlerPath} ${reading.handler ? 'exports' : 'does not export'} ${exportName}(). Two authorities `
          + 'disagree about whether the rail exists, so neither answer is published',
      });
      continue;
    }
    add({
      id,
      value: reading.dispatched ? 'implemented' : 'absent',
      authority: 'cli.rails',
      evidence: [`verb:${verb}`, `handler:${handlerPath}#${exportName}`],
      scope: 'framework',
    });
  }

  // ── product limits ───────────────────────────────────────────────────────
  const compositionNames = () => [
    ...composition.resources,
    ...composition.capabilities.map((entry) => String(entry).split('@')[0]),
    ...composition.policies.map((entry) => String(entry).split('/').pop()),
    ...composition.packages.flatMap((pkg) => pkg.actions.map((action) => String(action).split('.')[0])),
  ];
  const probeFor = (prefixes) => compositionNames()
    .find((name) => prefixes.some((prefix) => name === prefix || String(name).startsWith(`${prefix}-`)));

  if (!composition.problems.length) {
    for (const [id, prefixes] of Object.entries(NAMESPACE_PROBES)) {
      const hit = probeFor(prefixes);
      add({
        id,
        value: hit ? 'implemented' : 'absent',
        authority: 'reference.composition',
        evidence: [`namespace-probe:${prefixes.join('|')}`, `match:${hit ?? 'none'}`],
        scope: 'repository',
        limitations: ['REFERENCE_COMPOSITION_NOT_THE_PROJECT'],
      });
    }

    // The second authority on the two declared-absence facts that had only a
    // sentence behind them. Deleting the sentence already refused the fact;
    // *building* the thing and leaving the sentence standing moved nothing,
    // which is a claim outliving the code it describes.
    for (const [id, rule] of Object.entries(DECLARED_ABSENCE)) {
      if (!rule.absentPrefixes) continue;
      const existing = facts.find((fact) => fact.id === id);
      if (!existing) continue;
      const hit = probeFor(rule.absentPrefixes);
      if (hit) {
        refuse(
          id,
          `${id}: ${rule.in} still declares this absent, but the reference composition now carries "${hit}", `
            + `which the namespace probe (${rule.absentPrefixes.join('|')}) reads as the thing being present. `
            + 'Two authorities must agree before a boundary fact may stand — update the declaration or the probe',
        );
      } else {
        existing.evidence = [...existing.evidence, `namespace-probe:${rule.absentPrefixes.join('|')}`].sort(compare);
      }
    }
  }

  for (const [id, code] of Object.entries(DECLARED_JOURNEY_CODES)) {
    const declared = (bundle.journeyCodes ?? []).includes(code);
    const existing = facts.find((fact) => fact.id === id);
    if (existing) {
      // Two authorities on `billing.implemented`: the namespace probe and the
      // journey's declared limitation code. They must agree.
      const fromCode = declared ? 'absent' : 'unknown';
      if (existing.value !== fromCode) {
        refuse(
          id,
          `${id}: the reference composition says "${existing.value}" while the frozen journey registry `
            + `${declared ? 'declares' : 'no longer declares'} ${code}`,
        );
      } else {
        existing.evidence = [...existing.evidence, `journey-code:${code}`].sort(compare);
      }
      continue;
    }
    if (!declared) {
      problems.push({
        code: 'TRUTH_AUTHORITY_UNAVAILABLE',
        message: `${id} is a declared-absence fact resting on the journey limitation code ${code}, and the frozen `
          + 'journey registry no longer declares it. The fact is refused rather than defaulted',
      });
      continue;
    }
    add({
      id,
      value: 'absent',
      authority: 'reference.composition',
      evidence: ['packages/cli/src/scenario-journey.js#JOURNEYS', `journey-code:${code}`],
      scope: 'repository',
      limitations: ['NO_SCENARIO_RECEIPT_AVAILABLE'],
    });
  }

  // ── the JTBD portfolio, six summary counts ───────────────────────────────
  if (bundle.jtbd) {
    const portfolio = bundle.jtbd;
    /** @type {Array<[string, any, 'count'|undefined, string[]]>} */
    const jtbdFacts = [
      ['jtbd.catalog.record_count', portfolio.records, 'count', ['docs/jtbd/catalog/jtbd.jsonl']],
      ['jtbd.catalog.unique_ids', portfolio.uniqueIds, 'count', ['docs/jtbd/catalog/jtbd.jsonl#jtbd_id']],
      ['jtbd.coverage.overlay_complete', portfolio.overlayComplete ? 'true' : 'false', undefined,
        ['docs/jtbd/coverage/coverage.overlay.jsonl', 'docs/jtbd/roadmap/roadmap.overlay.jsonl']],
      ['jtbd.roadmap.unassigned_count', portfolio.unassigned, 'count', ['docs/jtbd/roadmap/roadmap.overlay.jsonl#ownerStatus']],
      ['jtbd.crosswalk.unmapped_count', portfolio.unmapped, 'count', ['docs/jtbd/coverage/matrix_crosswalk.json#rows']],
      ['jtbd.positive_coverage_without_evidence_count', portfolio.positiveWithoutEvidence, 'count',
        ['docs/jtbd/coverage/coverage.overlay.jsonl#evidence']],
    ];
    for (const [id, value, shape, evidence] of jtbdFacts) {
      add({
        id,
        value,
        shape,
        authority: 'jtbd.portfolio',
        evidence,
        scope: 'repository',
        limitations: ['JTBD_ROWS_NOT_ENCODED'],
      });
    }
  }

  // ── benchmark receipts ───────────────────────────────────────────────────
  if (bundle.benchmark) {
    add({
      id: 'benchmark.tool_selection.comparative',
      value: bundle.benchmark.comparative ? 'true' : 'false',
      authority: 'benchmark.tool_selection',
      evidence: [
        BENCHMARK_PANEL.aggregate,
        BENCHMARK_PANEL.protocol,
        `protocolFingerprint:${bundle.benchmark.protocolFingerprint.slice(0, 12)}`,
        `admitted:${bundle.benchmark.admitted}/${bundle.benchmark.supplied}`,
      ],
      scope: 'repository',
      limitations: ['TRUTH_IS_SOURCE_AND_RECEIPTS_NOT_RUNTIME'],
    });
    add({
      id: 'benchmark.build_rate.measured',
      value: bundle.benchmark.ratePublished ? 'implemented' : 'not_measured',
      authority: 'benchmark.tool_selection',
      evidence: [BENCHMARK_PANEL.aggregate, 'no rate, sabr, successRate or buildRate key exists in the record'],
      scope: 'repository',
    });
  }

  // ── measurement ──────────────────────────────────────────────────────────
  const measurement = bundle.measurement;
  if (measurement) {
    add({
      id: 'measurement.source_sha',
      value: measurement.sha || 'unknown',
      shape: 'sha',
      authority: 'measurement.ledger',
      evidence: ['site/claims.json#measuredAgainst.sha'],
      scope: 'measurement',
      status: measurement.treeCurrent === 'true' ? 'current' : measurement.treeCurrent === 'false' ? 'stale' : 'unknown',
      limitations: ['MEASUREMENT_DESCRIBES_COMMITTED_TREE'],
    });
    add({
      id: 'measurement.test_count',
      value: measurement.tests ?? 'unknown',
      shape: 'count',
      authority: 'measurement.ledger',
      evidence: ['site/claims.json#measuredAgainst.tests'],
      scope: 'measurement',
      status: measurement.treeCurrent === 'true' ? 'current' : measurement.treeCurrent === 'false' ? 'stale' : 'unknown',
      limitations: ['MEASUREMENT_DESCRIBES_COMMITTED_TREE'],
    });
    add({
      id: 'measurement.test_file_count',
      value: measurement.testFiles ?? 'unknown',
      shape: 'count',
      authority: 'measurement.ledger',
      evidence: ['site/claims.json#measuredAgainst.testFiles'],
      scope: 'measurement',
      status: measurement.treeCurrent === 'true' ? 'current' : measurement.treeCurrent === 'false' ? 'stale' : 'unknown',
      limitations: ['MEASUREMENT_DESCRIBES_COMMITTED_TREE'],
    });
    add({
      id: 'measurement.source_is_ancestor',
      value: measurement.ancestor,
      authority: 'measurement.git',
      evidence: [`sha:${measurement.sha}`, 'git merge-base --is-ancestor <sha> HEAD'],
      scope: 'measurement',
    });
    add({
      id: 'measurement.test_tree_current',
      // The one fact this contract exists to keep visible. `false` here is not
      // a defect: the ledger is provably honest about the commit it names, and
      // provably describing an older tests/ tree than HEAD's. What must never
      // happen is a *sentence* quoting that count as current, and the citation
      // check is what stops one being written.
      value: measurement.treeCurrent,
      authority: 'measurement.git',
      // **`HEAD:tests` is deliberately not published here.** It moves on every
      // commit that touches `tests/` — including the commit that adds the test
      // proving this rule — so publishing it would make the document stale
      // against itself on a commit where no fact moved at all, and a gate that
      // cries wolf on every green PR gets regenerated without being read. What
      // is published is the half that is fixed by the measured commit, plus the
      // comparison. The answer is the fact's own value.
      evidence: [
        `measuredTree:${String(measurement.measuredTree ?? '').slice(0, 12) || 'unknown'}`,
        'git rev-parse <sha>:tests versus HEAD:tests',
      ],
      scope: 'measurement',
      status: measurement.treeCurrent === 'unknown' ? 'unknown' : 'current',
      limitations: ['MEASUREMENT_DESCRIBES_COMMITTED_TREE'],
    });
  }

  facts.sort((a, b) => compare(a.id, b.id));

  const authorities = [
    { id: 'identity.contract', kind: 'source', reads: ['packages/core/src/identity.js'] },
    { id: 'spine.contract', kind: 'source', reads: ['packages/app/src/spine.js', 'packages/core/src/authorization.js'] },
    { id: 'runtime.mode', kind: 'source', reads: ['packages/core/src/runtime-mode.js'] },
    { id: 'tenant.storage', kind: 'source', reads: ['packages/core/src/tenant-storage.js', 'packages/core/src/tenant-binding.js'] },
    { id: 'storage.contract', kind: 'source', reads: ['scripts/repo-truth.js', 'packages/core/src/storage-contract.js', 'packages/core/src/database.js', 'packages/core/src/errors.js', 'packages/core/src/validation.js', 'packages/core/src/time.js', 'packages/core/src/actor.js', 'packages/core/src/module-manifest.js', 'packages/core/src/module-evolution.js', 'packages/core/src/timeout.js', 'packages/core/src/action-runtime.js', 'packages/core/src/external-operation.js', 'packages/core/src/core-adapters.js', 'packages/core/src/definition-fingerprint.js', 'packages/core/src/money.js', 'packages/core/src/solution-plan.js', 'packages/core/src/implementation-evidence.js', 'packages/core/src/spine-store.js', 'packages/core/src/package-registry.js', 'packages/core/src/identity.js', 'packages/core/src/runtime-mode.js', 'packages/core/src/authorization.js', 'packages/core/src/tenant-storage.js', 'packages/core/src/tenant-binding.js', 'packages/modules/company/src/company-service.js', 'packages/cli/src/module-factory.js', 'packages/work/src/legacy-tasks.js', 'packages/work/src/follow-up.js', 'packages/core/index.js'] },
    { id: 'reference.composition', kind: 'source', reads: REFERENCE_PACKAGES.map(([, path]) => path).concat(['packages/core/src/package-composition.js']) },
    { id: 'cli.rails', kind: 'source', reads: ['packages/cli/src/commands.js', ...RAILS.map(([, , path]) => path)] },
    { id: 'jtbd.portfolio', kind: 'source', reads: JTBD_PORTFOLIO_SOURCES },
    { id: 'benchmark.tool_selection', kind: 'receipt', reads: [BENCHMARK_PANEL.aggregate, BENCHMARK_PANEL.protocol] },
    { id: 'measurement.ledger', kind: 'measurement', reads: ['site/claims.json'] },
    { id: 'measurement.git', kind: 'measurement', reads: ['git'] },
  ].map((entry) => ({ ...entry, reads: [...entry.reads].sort(compare) }))
    .sort((a, b) => compare(a.id, b.id));

  return { facts, authorities, problems };
}

/**
 * Build the whole document.
 *
 * @param {{rootDir: string}} options
 */
export async function buildTruthDocument({ rootDir }) {
  const bundle = await readAuthorities({ rootDir });
  const { facts, authorities, problems } = bundle.problems?.length
    ? { facts: [], authorities: [], problems: [] }
    : buildFacts(bundle);

  const body = {
    repositoryTruthContract: REPOSITORY_TRUTH_CONTRACT,
    authorities,
    facts,
    limitations: TRUTH_LIMITATIONS.map(([code, message]) => ({ code, message })),
  };

  const document = {
    repositoryTruthContract: REPOSITORY_TRUTH_CONTRACT,
    // What was read. `fingerprint` is what was concluded. Keeping them apart
    // means a comment-only edit to an authority moves `sourceSha` and leaves
    // the fingerprint — and every fact — exactly where it was.
    sourceSha: bundle.sourceSha,
    authorities: body.authorities,
    facts: body.facts,
    limitations: body.limitations,
    fingerprint: sha256(canonical(body)),
  };

  return { document, problems: [...(bundle.problems ?? []), ...(bundle.deferredProblems ?? []), ...problems] };
}

// ────────────────────────────────────────────────────── checking the documents

/**
 * Every fact citation in one source, with its line.
 *
 * Markdown carries `<!-- truth: id=value -->`; JSON carries the same text in a
 * `facts` array. One grammar, one parser, both surfaces.
 *
 * @param {string} source
 * @returns {Array<{line: number, id: string, value: string}>}
 */
export function parseCitations(source, { javascript = false } = {}) {
  /** @type {Array<{line: number, id: string, value: string}>} */
  const found = [];
  const text = String(source);
  const lines = text.split('\n');
  // Which `"word=word"` literals in this source are *declared* citations.
  //
  // v1 read the JSON form off any line, so any quoted `a=b` anywhere in a bound
  // JSON file became a citation: adding `"note": "mode=production"` to
  // `site/claims.json` produced `TRUTH_FACT_UNKNOWN` telling the author to
  // "cite a generated fact or drop the citation" for a string that was never
  // one. Both `docs/QUALITY_GATES.md` §6.1 and `docs/REPOSITORY_TRUTH.md`
  // publish the narrower grammar — "a `facts` array of the same text in JSON" —
  // so the parser now reads what the grammar says. A document is checked for
  // the citations it *declares*; anything else is prose the contract does not
  // get an opinion about.
  const declared = declaredJsonCitations(text);
  for (let index = 0; index < lines.length; index += 1) {
    for (const match of lines[index].matchAll(CITATION)) {
      found.push({ line: index + 1, id: match[1], value: match[2] });
    }
    if (javascript) {
      // Own-line comments only. `CITATION_JS` used to match anywhere on the
      // line, so a string literal holding the text of a citation *became* one:
      // measured on this branch, `const example = '// truth: made.up.fact=x';`
      // in the bound source surface produced TRUTH_FACT_UNKNOWN for a citation
      // nobody wrote. A grammar that reads its own examples is not bounded.
      const trimmed = lines[index].trimStart();
      if (trimmed.startsWith('//')) {
        for (const match of trimmed.matchAll(CITATION_JS)) {
          found.push({ line: index + 1, id: match[1], value: match[2] });
        }
      }
    }
    if (!declared) continue;
    // Matched where it sits, so the reported line is the one a reader opens.
    for (const match of lines[index].matchAll(/"([a-z][a-z0-9_.]*=[A-Za-z0-9_.-]+)"/g)) {
      if (!declared.has(match[1])) continue;
      const parsed = CITATION_LITERAL.exec(match[1]);
      if (parsed) found.push({ line: index + 1, id: parsed[1], value: parsed[2] });
    }
  }
  return found;
}

/**
 * Every string this source declares inside a `facts` array, at any depth.
 *
 * `null` when the source is not JSON at all — a Markdown document carries its
 * citations as comments, and a quoted `a=b` in a sentence is a sentence.
 *
 * @param {string} text
 * @returns {Set<string> | null}
 */
function declaredJsonCitations(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  /** @type {Set<string>} */
  const declared = new Set();
  const walkValue = (value, inFacts) => {
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (inFacts && typeof entry === 'string') declared.add(entry);
        else walkValue(entry, false);
      }
      return;
    }
    if (value && typeof value === 'object') {
      for (const [key, entry] of Object.entries(value)) walkValue(entry, key === 'facts');
    }
  };
  walkValue(parsed, false);
  return declared;
}

/**
 * Check every citation against the generated facts.
 *
 * An unknown id and a reversed polarity are different failures with different
 * messages, because they are different mistakes: one cites something that was
 * never a fact, the other cites a fact and states the opposite of it.
 *
 * @param {Array<{line: number, id: string, value: string}>} citations
 * @param {Map<string, any>} factIndex
 * @param {string} label
 */
export function checkCitations(citations, factIndex, label) {
  /** @type {Array<{code: string, message: string}>} */
  const problems = [];
  for (const citation of citations) {
    const fact = factIndex.get(citation.id);
    if (!fact) {
      problems.push({
        code: 'TRUTH_FACT_UNKNOWN',
        message: `${label}:${citation.line}: cites "${citation.id}", which is not a fact in ${TRUTH_DOCUMENT}. `
          + 'Cite a generated fact or drop the citation; a citation nothing resolves is worse than none, because '
          + 'it reads as proof.',
      });
      continue;
    }
    if (String(fact.value) !== citation.value) {
      problems.push({
        code: 'TRUTH_FACT_VALUE_STALE',
        message: `${label}:${citation.line}: says ${citation.id} is "${citation.value}", but the authority `
          + `(${fact.authority}) currently makes it "${fact.value}". The document was not updated when the code `
          + 'moved — which is the exact failure this contract exists to catch.',
      });
    }
  }
  return problems;
}

/**
 * Harvest every machine code the source declares.
 *
 * This is the one lexical rule kept from the rejected option A, and it is kept
 * because it matches **identifiers**, never wording, and because the vocabulary
 * is *harvested* rather than hand-listed: nothing has to be maintained, and a
 * code deleted from the code fails every document still naming it. That is the
 * `TENANT_ISOLATION_NOT_ENFORCED` regression, written as a rule.
 *
 * @param {string} rootDir
 */
export function harvestCodeVocabulary(rootDir) {
  /** @type {Set<string>} */
  const vocabulary = new Set();
  for (const root of VOCABULARY_ROOTS) {
    for (const path of walk(join(rootDir, root))) {
      if (!/\.(js|mjs|cjs|json)$/.test(path)) continue;
      for (const match of readFileSync(path, 'utf8').matchAll(CODE_TOKEN)) vocabulary.add(match[0]);
    }
  }
  for (const code of RETIRED_CODES) vocabulary.delete(code);
  return vocabulary;
}

/**
 * Every file basename in the repository, without extension.
 *
 * `docs/QUALITY_GATES.md` is a path, not a code, and a document naming it is
 * naming a file. Deriving the exemption from the filesystem rather than from a
 * list is what keeps this rule maintenance-free.
 *
 * @param {string} rootDir
 */
export function repositoryBasenames(rootDir) {
  /** @type {Set<string>} */
  const names = new Set();
  for (const path of walk(rootDir)) names.add(basename(path, extname(path)));
  return names;
}

/**
 * Machine codes named in a document that no source file declares.
 *
 * Two things are not codes and are excluded structurally, not by list: a
 * repository file's basename, and anything already in the harvested vocabulary.
 *
 * **There is deliberately no angle-bracket exemption.** v1 stripped
 * `<[A-Z][A-Z0-9_]*>` first, on the argument that a metavariable stands for a
 * value the reader supplies. It also stood for any code at all: writing
 * `<TENANT_ISOLATION_NOT_ENFORCED>` in `README.md` or in `site/assets/llms.txt`
 * passed this rule, which disarmed the one rule written because that code
 * survived its own fix. The exemption bought nothing either: `ERROR_CODE` — the
 * only metavariable any bound surface actually uses — is declared in source and
 * so is in the harvested vocabulary already, which is why the test that claimed
 * to prove the exemption passed with the strip removed. A placeholder a bound
 * document wants to write must be a name the source declares, like every other
 * code in every other sentence this contract checks.
 *
 * @param {string} source
 * @param {Set<string>} vocabulary
 * @param {Set<string>} basenames
 */
export function findUnknownCodes(source, vocabulary, basenames) {
  /** @type {Array<{line: number, code: string}>} */
  const found = [];
  const text = String(source);
  // A document may name a retired code, once it says so: `<!-- truth:
  // retired-code CODE — why -->`. Declared per file, so an exemption never
  // travels, and visible in review, which is the whole cost of it.
  const retired = new Set([...text.matchAll(RETIRED_CODE)].map((match) => match[1]));
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    for (const match of lines[index].matchAll(CODE_TOKEN)) {
      const code = match[0];
      if (vocabulary.has(code) || basenames.has(code) || retired.has(code)) continue;
      found.push({ line: index + 1, code });
    }
  }
  return found;
}

/**
 * Every retired claim a bound surface states without declaring it as history.
 *
 * The counterpart of the retired-code half of {@link findUnknownCodes}, and it
 * exists because the citation half cannot reach it: seven `// truth:` lines
 * above `productionPosture` bind seven **values**, and say nothing at all about
 * the sentence they sit above. Pasting the historical falsehood back into that
 * sentence and leaving the citations alone was measured green on this branch.
 *
 * The declaration escape is the same one a retired code gets, for the same
 * reason and at the same cost — a reviewable edit with an argument attached,
 * scoped to the file that writes it.
 *
 * **In a `.js` surface the declaration reaches comment lines only**, and that
 * restriction is not tidiness. The retired posture and the paragraph explaining
 * it live in the *same file*: a file-scoped declaration excused the explanation
 * and the published `productionPosture` string alike, and restoring the
 * falsehood went back to passing. A comment is the file talking about itself; a
 * string literal is what `app inspect` hands to an agent, and nothing excuses
 * that. Every other bound surface is prose or data end to end, so the
 * declaration stays file-scoped there.
 *
 * @param {string} source
 * @param {{javascript?: boolean}} [options]
 * @returns {Array<{line: number, claim: string}>}
 */
export function findRetiredClaims(source, { javascript = false } = {}) {
  /** @type {Array<{line: number, claim: string}>} */
  const found = [];
  const text = String(source);
  const declared = new Set([...text.matchAll(RETIRED_CLAIM)].map((match) => normalizeClaimText(match[1])));
  const lines = text.split('\n');
  const isComment = (line) => {
    const trimmed = line.trimStart();
    return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
  };
  for (let index = 0; index < lines.length; index += 1) {
    // The line, and the line joined to its successor. A prose document re-wraps,
    // and a claim that fell across a line break would otherwise be a one-keystroke
    // escape from a rule whose whole job is to survive re-typing. One join covers
    // every single break; a claim deliberately spread over three lines is beyond
    // this rule, and POSTURE_PROSE_NOT_GENERATED already says where the boundary is.
    const next = index + 1 < lines.length ? lines[index + 1] : null;
    for (const claim of RETIRED_CLAIMS) {
      const needle = normalizeClaimText(claim);
      const here = normalizeClaimText(lines[index]).includes(needle);
      // Each occurrence is reported once. A pair is only consulted when neither
      // of its lines carries the claim on its own — otherwise the line that does
      // is reported here, or on the next turn of the loop.
      let excusable = isComment(lines[index]);
      if (!here) {
        if (next === null || normalizeClaimText(next).includes(needle)) continue;
        if (!normalizeClaimText(`${lines[index]} ${next}`).includes(needle)) continue;
        excusable = excusable && isComment(next);
      }
      // In a `.js` surface the declaration reaches comments only: a file-scoped
      // escape excused the published `productionPosture` string as readily as the
      // paragraph explaining it, and the mutation went back to passing.
      if ((!javascript || excusable) && declared.has(needle)) continue;
      found.push({ line: index + 1, claim });
    }
  }
  return found;
}

/**
 * Is the committed document still what the authorities produce?
 *
 * Compared canonically, so key order and formatting cannot hide a difference —
 * and the message names the facts whose **values** moved, because that is the
 * part a reader has to act on. A change with no moved value (a new evidence
 * pointer, a renamed authority) is still stale and still says so, but it says a
 * different thing.
 *
 * @param {any} committed
 * @param {any} fresh
 */
export function diffDocuments(committed, fresh) {
  if (canonical(committed) === canonical(fresh)) return [];
  const before = new Map((committed?.facts ?? []).map((fact) => [fact.id, fact]));
  const moved = (fresh?.facts ?? [])
    .filter((fact) => String(before.get(fact.id)?.value) !== String(fact.value))
    .map((fact) => `${fact.id}: ${JSON.stringify(before.get(fact.id)?.value ?? null)} → ${JSON.stringify(fact.value)}`);
  const dropped = [...before.keys()].filter((id) => !(fresh?.facts ?? []).some((fact) => fact.id === id));
  // `sourceSha` is a fingerprint of the bytes that were *read*, so a
  // comment-only edit to any authority source moves it while every fact,
  // every piece of evidence and the semantic `fingerprint` stand still. That
  // is by design — but v1's message then reported "the evidence, the authority
  // list or a limitation did", naming three things that had not changed. A
  // gate that misdescribes its own failure teaches the reader to stop reading
  // it, which is the habit this contract exists to break.
  const sourceMoved = String(committed?.sourceSha ?? '') !== String(fresh?.sourceSha ?? '');
  const bodyMoved = !moved.length && !dropped.length
    && canonical({ ...committed, sourceSha: null }) !== canonical({ ...fresh, sourceSha: null });
  return [{
    code: 'TRUTH_DOCUMENT_STALE',
    message: `${TRUTH_DOCUMENT} no longer matches its authorities. `
      + (moved.length ? `Facts that moved: ${moved.join('; ')}. ` : '')
      + (dropped.length ? `Facts that no longer exist: ${dropped.join(', ')}. ` : '')
      + (bodyMoved ? 'No fact value moved; the evidence, the authority list or a limitation did. ' : '')
      + (!moved.length && !dropped.length && !bodyMoved && sourceMoved
        ? `No fact moved and no conclusion changed: only sourceSha did, because an authority source was edited `
          + `(${String(committed?.sourceSha ?? 'none').slice(0, 12)} → ${String(fresh?.sourceSha ?? 'none').slice(0, 12)}). `
        : '')
      + 'Run `npm run repo:truth` and commit the result.',
  }];
}

/**
 * The whole check: regeneration, citations, code vocabulary, measurement.
 *
 * @param {{rootDir: string}} options
 */
export async function checkRepository({ rootDir }) {
  /** @type {Array<{code: string, message: string}>} */
  const problems = [];
  const { document, problems: buildProblems } = await buildTruthDocument({ rootDir });
  problems.push(...buildProblems);

  // ── 1. the committed document is a fresh generation ──────────────────────
  const documentPath = join(rootDir, TRUTH_DOCUMENT);
  let committed = null;
  if (!existsSync(documentPath)) {
    problems.push({
      code: 'TRUTH_DOCUMENT_UNREADABLE',
      message: `${TRUTH_DOCUMENT} does not exist. Run \`npm run repo:truth\` and commit the result.`,
    });
  } else {
    try {
      committed = JSON.parse(readFileSync(documentPath, 'utf8'));
    } catch (error) {
      problems.push({
        code: 'TRUTH_DOCUMENT_UNREADABLE',
        message: `${TRUTH_DOCUMENT} is not valid JSON: ${/** @type {any} */ (error)?.message ?? error}`,
      });
    }
  }
  if (committed) problems.push(...diffDocuments(committed, document));

  // ── 2 & 3. citations and machine codes across the bound surfaces ─────────
  const factIndex = new Map(document.facts.map((fact) => [fact.id, fact]));
  const vocabulary = harvestCodeVocabulary(rootDir);
  const basenames = repositoryBasenames(rootDir);

  for (const surface of BOUND_SURFACES) {
    const safe = resolveSurfacePath(rootDir, surface);
    if (!safe.ok) {
      problems.push({
        code: 'TRUTH_SURFACE_UNSAFE',
        message: `${surface} cannot be read as itself: ${safe.reason}. A bound surface the filesystem can redirect `
          + 'is not bound — pointing this path at a citation-free file drops its citations and leaves the gate '
          + 'green with the claim it was checking still standing.',
      });
      continue;
    }
    const full = safe.full;
    if (!existsSync(full)) continue;
    const source = readFileSync(full, 'utf8');
    const javascript = surface.endsWith('.js');
    problems.push(...checkCitations(parseCitations(source, { javascript }), factIndex, surface));
    for (const { line, body } of findMalformedDirectives(source, { javascript })) {
      problems.push({
        code: 'TRUTH_CITATION_MALFORMED',
        message: `${surface}:${line}: writes \`truth: ${body}\`, which is not a citation (\`id=value\`), a `
          + '`retired-code CODE — why` declaration or a `retired-claim <claim> — why` one. A directive no rule '
          + 'reads is worse than none: it looks like proof and checks nothing.',
      });
    }
    for (const { line, claim } of findRetiredClaims(source, { javascript })) {
      problems.push({
        code: 'TRUTH_CLAIM_RETIRED',
        message: `${surface}:${line}: states "${claim}", a claim this repository deliberately retired. It is the `
          + 'first of the two failures ADR-039 opens by naming, and the citations beside it prove nothing about it '
          + '— they bind values, not sentences. Remove it, or declare `truth: retired-claim ' + claim + ' — why` '
          + 'in this file if the surface names it as history.',
      });
    }
    for (const { line, code } of findUnknownCodes(source, vocabulary, basenames)) {
      problems.push({
        code: 'TRUTH_CODE_UNKNOWN',
        message: RETIRED_CODES.includes(code)
          ? `${surface}:${line}: names ${code}, a code this repository deliberately retired. A retired limitation `
            + 'standing in a current document is the exact failure this contract exists to catch — it survived its '
            + 'own fix once already. Remove it, or declare `<!-- truth: retired-code ' + code + ' — why -->` in this '
            + 'file if the document names it as history rather than asserting it.'
          : `${surface}:${line}: names the machine code ${code}, which no source file under `
            + `${VOCABULARY_ROOTS.join('/, ')}/ declares. Either the code was removed from the code and left `
            + 'standing in this document, or it was never a code.',
      });
    }
  }

  return {
    document,
    problems,
    ok: problems.length === 0,
    counts: {
      facts: document.facts.length,
      authorities: document.authorities.length,
      surfaces: BOUND_SURFACES.filter((surface) => existsSync(join(rootDir, surface))).length,
      citations: BOUND_SURFACES
        .filter((surface) => existsSync(join(rootDir, surface)))
        .reduce((total, surface) => total
          + parseCitations(readFileSync(join(rootDir, surface), 'utf8'), { javascript: surface.endsWith('.js') }).length, 0),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────── CLI

/** Serialize with a trailing newline, the way every other generator here does. */
export function serialize(document) {
  return `${JSON.stringify(document, null, 2)}\n`;
}

async function main() {
  const argv = process.argv.slice(2);
  const wantsCheck = argv.includes('--check');
  const wantsJson = argv.includes('--json');
  const rootDir = process.cwd();

  for (const flag of argv) {
    if (flag !== '--check' && flag !== '--json') {
      process.stderr.write(`repo:truth: unknown flag ${flag}. Usage: node scripts/repo-truth.js [--check] [--json]\n`);
      process.exit(2);
    }
  }

  if (!wantsCheck) {
    const { document, problems } = await buildTruthDocument({ rootDir });
    if (problems.length) {
      for (const problem of problems) process.stderr.write(`  ✗ ${problem.code}: ${problem.message}\n`);
      process.stderr.write('\nrepo:truth refused to write a document it could not derive. Nothing was changed.\n');
      process.exit(1);
    }
    writeFileSync(join(rootDir, TRUTH_DOCUMENT), serialize(document));
    if (wantsJson) process.stdout.write(serialize(document));
    else {
      process.stderr.write(`\n  ${TRUTH_DOCUMENT} written: ${document.facts.length} facts from `
        + `${document.authorities.length} authorities.\n  fingerprint ${document.fingerprint.slice(0, 16)}\n\n`);
    }
    return;
  }

  const report = await checkRepository({ rootDir });
  if (wantsJson) {
    process.stdout.write(`${JSON.stringify({
      repositoryTruthContract: REPOSITORY_TRUTH_CONTRACT,
      ok: report.ok,
      counts: report.counts,
      problems: report.problems,
      fingerprint: report.document.fingerprint,
    }, null, 2)}\n`);
  } else {
    process.stderr.write(`\n  repo:truth --check — ${report.counts.facts} facts, ${report.counts.citations} citations `
      + `across ${report.counts.surfaces} bound surfaces\n\n`);
    for (const problem of report.problems) process.stderr.write(`  ✗ ${problem.code}\n    ${problem.message}\n\n`);
    process.stderr.write(report.ok
      ? '  Every bound claim still agrees with the code.\n\n'
      : `  repo:truth --check failed: ${report.problems.length} problem(s).\n\n`);
  }
  process.exit(report.ok ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(`repo:truth: ${error?.stack ?? error}\n`);
    process.exit(2);
  });
}
