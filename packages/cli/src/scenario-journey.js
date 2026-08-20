// @ts-check

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The **journey**: the only thing DX6 ever executes.
 *
 * A scenario names a journey by **id**. This registry — frozen, in DX6's own
 * source — is what an id resolves to. A scenario cannot name a path, a script,
 * an interpreter, an argument or an environment variable, so there is no code
 * path from document content to an invocation. That is the same discipline DX5
 * uses for declared scripts (the project declares a *name*; the framework owns
 * the list) and the same one `docs/CODER_TOOLING_ROADMAP.md` requires when it
 * refuses "executable commands as trusted content".
 *
 * A journey is checked-in repository source and runs with the operator's
 * authority. The child is bounded in time, output and process group. That is
 * **isolation, not a sandbox**, and the report says so (`JOURNEY_SOURCE_TRUSTED`).
 */

/**
 * How a journey reads the time, which is part of what its evidence *means*.
 *
 * The first version of this registry had no such field, because the first
 * journey is a sales funnel and nothing in it is a function of the clock. The
 * second one is Service, where an SLA state is *only* a function of the clock
 * (`packages/service/src/service-actions.js` `evaluateSla()` reads `now()` and
 * exposes no `at` parameter) — and a report that says `firstResponseState:
 * breached` without saying which clock produced it is not evidence, it is a
 * number with a story attached.
 *
 * So the clock is declared **here**, in the runner's own frozen source, and
 * published in every report. It is deliberately **not** a scenario field: a
 * document that could choose the instant could choose the instant at which the
 * breach disappears, and a scenario that can pick its own answer proves
 * nothing.
 */
export const JOURNEY_CLOCKS = Object.freeze({
  wall: Object.freeze({
    mode: 'wall-clock',
    describes: 'the journey runs on the real system clock. Nothing it asserts is a function of the '
      + 'current instant, so the evidence is the same whenever it runs — but it can never witness a '
      + 'time boundary, because reaching one would mean waiting for it',
  }),
  injected: Object.freeze({
    mode: 'injected-fixed',
    describes: 'the journey composes the application with an injected UTC clock (createAccordoApp({ clock }), '
      + 'packages/core/src/time.js) and steps it to named instants declared in its own checked-in source. A '
      + 'time boundary is therefore observed exactly rather than approached. The instants are constants in '
      + 'the journey, never values a scenario document supplies',
  }),
});

/**
 * Every journey DX6 knows how to run.
 *
 * Two rules held when this registry had one entry, and both survive a second
 * consumer:
 *
 * - a journey is **checked-in repository source**, selected by id, so no
 *   document value ever becomes an invocation;
 * - a journey is a *stronger* authority than DX6, not a weaker one: its own
 *   in-process assertions are the claim, and DX6 adds the mapping nobody has.
 *
 * What the second entry added is `clock` and `limitations`. A journey knows
 * things about itself that are false of the other one — Service has no
 * business-hours calendar and notifies nobody; the sales funnel has neither
 * concept — and publishing those globally would attach a Service disclaimer to
 * a Lead run and a Lead disclaimer to a Service run. Both are lies, in opposite
 * directions, and a limitation nobody believes is worse than none.
 */
export const JOURNEYS = Object.freeze({
  'b2b-lead-qualification': Object.freeze({
    installer: 'examples/starters/b2b-lead-qualification/install.mjs',
    clock: JOURNEY_CLOCKS.wall,
    describes: 'the checked-in B2B lead-qualification starter installer: it composes an application '
      + 'from manifests through the real module factory and drives capture → qualify → convert → '
      + 'pipeline → enrich/score/route → catalog → quote → approval → signature → order → contract '
      + 'activation → delivery handover in process, asserting each guarantee as it goes',
    limitations: Object.freeze([
      Object.freeze({
        code: 'JOURNEY_CLOCK_IS_WALL_CLOCK',
        message: 'this journey runs on the real system clock and asserts nothing that depends on the current '
          + 'instant. It is not evidence about time-dependent behaviour, and it cannot observe a time boundary',
      }),
      Object.freeze({
        code: 'ENRICHMENT_PROVIDER_IS_A_FIXTURE',
        message: 'enrichment runs against a deterministic checked-in fixture behind the real provider contract. '
          + 'No paid external enrichment provider is contacted, and nothing here says one works',
      }),
    ]),
  }),
  'service-sla-escalation': Object.freeze({
    installer: 'examples/journeys/service-sla-escalation/journey.mjs',
    clock: JOURNEY_CLOCKS.injected,
    describes: 'the checked-in service-operations journey: it composes an application holding the contracts '
      + 'and service packages and nothing else, sells one annual-support subscription through catalog → quote → '
      + 'discount policy → signature → immutable order → contract activation, activates the resulting pending '
      + 'service obligation into an operational ServiceCoverage with an immutable Entitlement under a '
      + 'fingerprinted versioned policy, then opens one support case on the injected clock and observes its '
      + 'first-response SLA at the due instant and one millisecond later, records the breach as immutable '
      + 'evidence, records a human escalation citing it, and resolves and closes the case over the declared '
      + 'transition table — asserting each guarantee, and each refusal, as it goes',
    limitations: Object.freeze([
      Object.freeze({
        code: 'SLA_IS_ELAPSED_TIME_NOT_A_CONTRACTUAL_JUDGEMENT',
        message: 'the SLA is elapsed wall-clock minutes from openedAt against the injected clock. There is no '
          + 'business-hours calendar, no holiday table, no timezone interpretation and no paused clock — '
          + 'waiting_customer does not stop it. A recorded evaluation is what the clock said at a stated instant, '
          + 'and never a contractual or legal determination that anybody breached anything',
      }),
      Object.freeze({
        code: 'NOTHING_WAS_NOTIFIED_OR_ROUTED',
        message: 'no email, chat, telephony or contact-centre provider exists. A first response notifies nobody, '
          + 'an escalation routes to nobody and pages nobody, and a target is a label. Each of those is published '
          + 'as false by the journey and observed as false, rather than left unsaid',
      }),
      Object.freeze({
        code: 'ESCALATION_IS_MANUALLY_RECORDED',
        message: 'escalation is a human recording that a case was escalated. There is no scheduler, no automatic '
          + 'escalation rule and no role enforcement, so nothing escalates on its own',
      }),
      Object.freeze({
        code: 'SERVICE_COVERAGE_IS_NOT_A_CONTRACT',
        message: 'a ServiceCoverage is operational: nobody signed it, it has no envelope, signer or artifact, and '
          + 'it neither amends nor replaces the Commercial Contract it was activated from. No billing, invoicing, '
          + 'renewal, contract amendment or customer portal exists',
      }),
    ]),
  }),
  'contract-renewal-execution': Object.freeze({
    installer: 'examples/journeys/contract-renewal-execution/journey.mjs',
    clock: JOURNEY_CLOCKS.injected,
    describes: 'the checked-in renewal/amendment journey: it composes an application holding the commercial, '
      + 'signature, contracts and lifecycle packages and nothing else, sells and signs one agreement carrying a '
      + 'SIGNED commercial term and activates it, produces three further signed Orders — one for another customer, '
      + 'one whose signed document carried no term, one for the same customer with its own signed term and a raised '
      + 'quantity — plans the renewal read-only, refuses the Order with no signed term rather than promoting its '
      + 'operational dates, refuses an agent actor at every writing step, refuses a wrong-customer pairing at attach '
      + 'and parks a maturing one, executes the successor as a human into its own contract, subscription and one '
      + 'immutable 1:1:1 lineage row carrying a classification DERIVED from the line delta, proves the source '
      + 'agreement is byte-identical afterwards, and replays a lost response without producing a second successor',
    limitations: Object.freeze([
      Object.freeze({
        code: 'NOTHING_RENEWS_ON_A_CLOCK',
        message: 'the clock is injected so the two terms are fixed business facts, not because anything here is '
          + 'time-dependent. There is no scheduler: autoRenew and renewalNoticeDays are recorded only on both '
          + 'provenances, nothing fires on a boundary, and every transition in this run has a human actor',
      }),
      Object.freeze({
        code: 'A_SUCCESSOR_IS_NOT_A_LEGAL_RENEWAL',
        message: 'the successor agreement is evidence assembled from a signed Order — its own document hash, its own '
          + 'term, its own subscription — not a legal opinion about what was renewed. It amends nothing in place, it '
          + 'cancels nothing, and the signature-provider limitation of ADR-017 is unchanged',
      }),
      Object.freeze({
        code: 'SIGNED_TERM_REQUIRED_AND_PROVEN_BY_REFUSAL',
        message: 'a successor is built only from an Order carrying the ADR-033 term snapshot. The Order whose signed '
          + 'document carried no term is attempted in this run and refused, and the refusal is published as a positive '
          + 'fact — post-signature operational dates are never promoted into a signed renewal term',
      }),
      Object.freeze({
        code: 'NOTHING_WAS_BILLED_OR_NOTIFIED',
        message: 'no invoice, payment, tax, proration or revenue recognition exists to follow from an execution, no '
          + 'MRR/ARR/TCV is derived anywhere, and no customer, signer or colleague is told that any of this happened. '
          + 'Each is published as false by the journey and observed as false, rather than left unsaid',
      }),
    ]),
  }),
  'tenant-isolation-and-authorization': Object.freeze({
    installer: 'examples/journeys/tenant-isolation-and-authorization/journey.mjs',
    clock: JOURNEY_CLOCKS.injected,
    describes: 'the checked-in Production Spine journey (ADR-038): it composes TWO tenants as two separate '
      + 'applications with two databases — the wiring the framework does not do for you — creates identically '
      + 'named records in both, and proves neither can '
      + 'reach the other by id, by collection or by write; proves a membership in one tenant means nothing in '
      + 'the other and that a genuine owner of B pointed at A is refused for the organization rather than for '
      + 'the record; lets an authorized manager decide and refuses a viewer the same decision while leaving '
      + 'their read intact; keeps 401 and 403 distinct; attempts a self-grant, an escalation by a manager, the '
      + 'demotion of an organization\'s last administrator and a second bootstrap, and is refused each time; '
      + 'lets a signature webhook reconcile and refuses it a commercial approval; refuses a developer assertion '
      + 'outright in production mode; and proves no credential reaches an identity, a decision or an audit row',
    limitations: Object.freeze([
      Object.freeze({
        code: 'ISOLATION_IS_TWO_DATABASES_NOT_A_ROW_COLUMN',
        message: 'the isolation this run proves comes from the run itself: it composes two separate '
          + 'applications with two database files. The framework does NOT enforce it — the declared '
          + 'database-per-tenant strategy has no wiring, and two organizations inside one application share '
          + 'one database and can read and write each other\'s records and audit rows, which the runtime '
          + 'publishes as TENANT_ISOLATION_NOT_ENFORCED. So this run establishes isolation for a '
          + 'one-application-per-tenant deployment and nothing more; it says nothing about shared-database '
          + 'row-level tenancy, which is a later slice and is deliberately not claimed',
      }),
      Object.freeze({
        code: 'NO_IDENTITY_PROVIDER_IS_CONTACTED',
        message: 'the framework authenticates nobody. The verified identities in this run are constructed '
          + 'directly, as a deployment adapter would supply them — no OIDC, SAML, vendor or network call '
          + 'happens, and no credential exists to be checked. Nothing here is evidence that any real identity '
          + 'provider integration works',
      }),
      Object.freeze({
        code: 'EVERY_REFUSAL_IS_EARNED_BY_ATTEMPTING_IT',
        message: 'each safety fact this run publishes is produced by performing the forbidden operation and '
          + 'recording that it was refused. A report claiming nothing leaked could be produced by a run that '
          + 'never tried, which is why the refusals are positive facts rather than absences',
      }),
      Object.freeze({
        code: 'NOT_PRODUCTION_READINESS',
        message: 'identity, tenancy and authorization exist; PostgreSQL and shared-database tenancy, durable '
          + 'jobs and outbox, a scheduler, secrets, backups, restore and deployment do not. This run is not a '
          + 'production-readiness statement and no part of it should be quoted as one',
      }),
    ]),
  }),
  'customer-identity-governance': Object.freeze({
    installer: 'examples/journeys/customer-identity-governance/journey.mjs',
    clock: JOURNEY_CLOCKS.injected,
    describes: 'the checked-in customer-identity journey: it composes an application holding the customer-data '
      + 'package over the host\'s own Company and Contact and nothing else, previews a bounded import and proves it '
      + 'wrote nothing while receipting every row, applies it into real host records with the source identifier held '
      + 'beside them, retries the identical import and gets the same run, imports the SAME customer from a second '
      + 'source system and matches it exactly on normalized name and domain without creating a parallel record, then '
      + 'attempts a genuinely ambiguous row and proves the foundation refuses to guess — reporting every candidate, '
      + 'breaking no tie and leaving durable evidence for a person — refuses an agent, an out-of-candidate canonical '
      + 'and a reasonless decision, records the human canonical link and proves it deleted, rewrote and cascaded '
      + 'nothing with both source rows byte-identical and both still resolving onto one cluster of one canonical and '
      + 'one alias, refuses to silently re-parent a record already in a cluster, reads the consolidated profile from '
      + 'both sides where an uncomposed package reads not available rather than empty, proves no raw provider payload '
      + 'was stored anywhere, and governs a data-quality finding as a human while keeping the finding and its evidence',
    limitations: Object.freeze([
      Object.freeze({
        code: 'MATCHING_IS_EXACT_ONLY',
        message: 'every rule is an exact comparison on normalized values. Nothing scores, guesses, learns or breaks a '
          + 'tie, so this run is not evidence about fuzzy matching, probabilistic identity resolution or machine-learning '
          + 'entity resolution — none of which exist here. An ambiguous row is left unresolved for a person, and this '
          + 'run attempts one so that the refusal is a fact rather than an absence',
      }),
      Object.freeze({
        code: 'CANONICAL_IDENTITY_IS_A_LOGICAL_LINK',
        message: 'linking records a human decision. Every linked record still exists, still resolves and is never '
          + 'deleted, rewritten, re-parented or cascaded, and the run fingerprints both business rows as bytes before '
          + 'and after to prove it. Physical merge or consolidation is not implemented and is deliberately deferred',
      }),
      Object.freeze({
        code: 'THIS_IS_NOT_A_CDP_OR_A_WAREHOUSE',
        message: 'the import reads the bounded rows it is handed and nothing else. There is no warehouse, no streaming, '
          + 'no real-time activation, no arbitrary ETL, no global search index, and no external system is ever written. '
          + 'No raw provider payload is stored, and the run searches the whole database to prove it',
      }),
      Object.freeze({
        code: 'NO_CONSENT_RETENTION_OR_ERASURE_CLAIM',
        message: 'nothing here is a GDPR, consent, retention or erasure claim, and no consent, purpose or lawful-basis '
          + 'concept exists in this framework. Erasure against immutable signed evidence is deliberately unresolved, and '
          + 'governing a data-quality finding records a decision and erases nothing',
      }),
      Object.freeze({
        code: 'THE_PROFILE_IS_A_PROJECTION_NOT_A_TIMELINE',
        message: 'the profile is a read-only projection over the packages this application composes. It creates '
          + 'nothing, it is not a complete cross-channel customer timeline, and a package that is not composed reads '
          + '"not available" with a reason rather than as an empty result — which this composition, holding no other '
          + 'package at all, is what makes observable',
      }),
    ]),
  }),
});

/** A journey that has not finished in this long is a defect, not a slow machine. */
export const JOURNEY_TIMEOUT_MS = 10 * 60_000;
/** Journey chatter is diagnostic; a journey that floods it is not. */
export const MAX_JOURNEY_OUTPUT = 256 * 1024;
/** Between asking the process group to stop and insisting. */
export const KILL_GRACE_MS = 2_000;
/** After the journey process exits, how long to collect what it wrote. */
export const DRAIN_MS = 250;

/**
 * The environment variable that makes a re-entrant run refuse.
 *
 * DX5 shipped without one and a project whose `verify` script re-invoked the
 * command recursed 2^depth. Nothing a journey does today can re-enter DX6 — but
 * "nothing can today" is exactly the assumption that stopped being true there,
 * and the guard costs one string.
 */
export const RECURSION_ENV = 'ACCORDO_SCENARIO_RUN';

/** @param {string} id */
export function journeyById(id) {
  if (typeof id !== 'string' || !Object.prototype.hasOwnProperty.call(JOURNEYS, id)) return null;
  return JOURNEYS[id];
}

/**
 * Run a journey to completion, bounded, and bring back its receipt.
 *
 * Four details are deliberate, each of them a defect found in this repository's
 * own child runners before:
 *
 * - **it settles on `exit`, never on stream `close`.** A grandchild the journey
 *   spawned inherits these pipes and holds them open for as long as it lives,
 *   so `close` can arrive minutes after the process we started has finished and
 *   written its receipt. Waiting for it makes every journey that spawns
 *   anything take the full timeout and then report a false failure.
 *   `packages/cli/src/child-report.js` documents finding and fixing exactly this.
 * - **streams are decoded with `setEncoding('utf8')`**, so a multi-byte
 *   character split across two chunks is reassembled rather than corrupted.
 * - **truncation is explicit.** Output past the bound sets `truncated: true`
 *   and the report carries it. Output that silently disappears is worse than
 *   output that is refused.
 * - **a signal-killed child reports its signal.** `exit null` is not a
 *   diagnostic; `killed by SIGKILL` is.
 *
 * @param {{
 *   rootDir: string,
 *   installer: string,
 *   projectDir: string,
 *   timeoutMs?: number,
 *   maxOutput?: number,
 *   env?: Record<string, string|undefined>,
 * }} options
 * @returns {Promise<{
 *   ok: boolean, code: number|null, signal: string|null, receipt: any,
 *   output: string, truncated: boolean, timedOut: boolean,
 *   spawnError: string|null, durationMs: number,
 * }>}
 */
export function runJourney({
  rootDir, installer, projectDir,
  timeoutMs = JOURNEY_TIMEOUT_MS, maxOutput = MAX_JOURNEY_OUTPUT, env = process.env,
}) {
  return new Promise((settle) => {
    const started = Date.now();
    const installerPath = join(rootDir, installer);
    if (!existsSync(installerPath)) {
      settle({
        ok: false, code: null, signal: null, receipt: null, output: '', truncated: false,
        timedOut: false, spawnError: `the journey's installer is not in this project: ${installer}`,
        durationMs: 0,
      });
      return;
    }

    /** @type {any} */
    let child;
    try {
      child = spawn(process.execPath, ['--no-warnings', installerPath], {
        cwd: rootDir,
        // Its own process group, so a timeout stops the group rather than only
        // the process we started. A journey that *deliberately* detaches into a
        // new group still outlives the run; reaching that would mean tracking
        // descendants, which is neither attempted nor a sandbox.
        detached: true,
        // No stdin: a reader never prompts, so a journey that reads it gets EOF
        // instead of stalling a CI job.
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...env,
          ACCORDO_KEEP_ROOT: projectDir,
          // The recursion guard. A journey that somehow reached back into
          // `crm scenario run` finds this already set and is refused.
          [RECURSION_ENV]: '1',
        },
      });
    } catch (error) {
      settle({
        ok: false, code: null, signal: null, receipt: null, output: '', truncated: false,
        timedOut: false, spawnError: String(/** @type {any} */ (error).message), durationMs: Date.now() - started,
      });
      return;
    }

    /** @type {string[]} */
    const chunks = [];
    let bytes = 0;
    let truncated = false;
    const absorb = (stream) => {
      if (!stream) return;
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        if (truncated) return;
        const size = Buffer.byteLength(chunk, 'utf8');
        if (bytes + size <= maxOutput) {
          bytes += size;
          chunks.push(chunk);
          return;
        }
        // Keep the part that fits rather than dropping the chunk.
        //
        // The first draft discarded any chunk that crossed the bound, which
        // meant a journey whose *first* write was larger than the whole budget
        // left nothing at all — output that vanishes instead of output that is
        // bounded. Characters are appended whole, so the prefix is still valid
        // UTF-8, and the loop stops as soon as the room is used.
        const room = maxOutput - bytes;
        let kept = '';
        let used = 0;
        for (const character of chunk) {
          const width = Buffer.byteLength(character, 'utf8');
          if (used + width > room) break;
          kept += character;
          used += width;
        }
        if (kept !== '') { chunks.push(kept); bytes += used; }
        truncated = true;
      });
      stream.on('error', () => { /* a stream torn down by the kill is not a diagnostic */ });
    };
    absorb(child.stdout);
    absorb(child.stderr);

    let timedOut = false;
    /** @type {any} */
    let insist = null;
    const stop = () => {
      if (timedOut) return;
      timedOut = true;
      killGroup(child, 'SIGTERM');
      insist = setTimeout(() => killGroup(child, 'SIGKILL'), KILL_GRACE_MS);
      if (typeof insist.unref === 'function') insist.unref();
    };
    const timer = setTimeout(stop, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    let settled = false;
    /** @type {any} */
    let drain = null;
    /** @type {{code: number|null, signal: string|null}} */
    let exited = { code: null, signal: null };

    const finish = (spawnError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (insist) clearTimeout(insist);
      if (drain) clearTimeout(drain);
      const output = chunks.join('');
      settle({
        ok: !spawnError && !timedOut && exited.code === 0,
        code: exited.code,
        signal: exited.signal,
        receipt: spawnError ? null : parseTrailingJson(output),
        output,
        truncated,
        timedOut,
        spawnError: spawnError ? String(spawnError.message) : null,
        durationMs: Date.now() - started,
      });
    };

    child.once('error', (error) => finish(error));
    // `close` still settles — it is the cheap, common case where nothing leaked.
    child.once('close', (code, signal) => {
      exited = { code: code ?? exited.code, signal: signal ?? exited.signal };
      finish(null);
    });
    child.once('exit', (code, signal) => {
      exited = { code: code ?? null, signal: signal ?? null };
      if (settled || drain) return;
      drain = setTimeout(() => finish(null), DRAIN_MS);
      if (typeof drain.unref === 'function') drain.unref();
    });
  });
}

/** Signal the child's whole process group, tolerating a group that is already gone. */
export function killGroup(child, signal) {
  try {
    if (child.pid) process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* already gone */ }
  }
}

/**
 * A journey prints human lines before its JSON receipt. Take the last balanced
 * JSON document in the stream rather than assuming the whole stream is JSON —
 * the same rule `scripts/tour.js` uses on the same installer.
 *
 * @param {string} text
 */
export function parseTrailingJson(text) {
  if (!text) return null;
  const start = text.lastIndexOf('\n{');
  const candidates = [text.slice(start === -1 ? text.indexOf('{') : start + 1), text];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate.trim());
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/**
 * The numeric facts a journey reported about itself, in canonical order.
 *
 * Numbers only, and only the receipt's own enumerable keys: a journey's prose
 * summary is for a person, and letting it into the evidence would make the
 * fingerprint change every time somebody improved a sentence.
 *
 * @param {any} receipt
 */
export function journeyMetrics(receipt) {
  /** @type {Record<string, number>} */
  const metrics = {};
  if (!receipt || typeof receipt !== 'object') return metrics;
  for (const key of Object.keys(receipt).sort()) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    const value = receipt[key];
    if (typeof value === 'number' && Number.isFinite(value)) metrics[key] = value;
  }
  return metrics;
}

/** The longest a receipt value may be and still be a fact rather than prose. */
export const MAX_FACT_VALUE = 64;
/**
 * A stated outcome, not a sentence: one lower-case token. It matches the state
 * names the domain already uses (`at_risk`, `breached`, `met`, `on_track`,
 * `closed`, `active`) and the two boolean spellings, and matches nothing a
 * person would write to be read.
 */
export const FACT_VALUE = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * The **stated facts** a journey reported about itself, in canonical order.
 *
 * This is the field the first consumer never needed. A sales funnel is
 * countable — three leads, one won, two contacts — so `journeyMetrics` was
 * enough, and "numbers only" read like a principle rather than the accident it
 * was. Service is not countable in the parts that matter: the load-bearing
 * facts are *which state* the SLA was in at the boundary (`at_risk` versus
 * `breached`, one millisecond apart) and *whether* anything was notified,
 * routed or billed. `slaEvaluations: 2` is true of a run that recorded the
 * wrong answer twice.
 *
 * The rule that keeps prose out is unchanged in spirit and tightened in
 * practice: a fact is a **boolean**, or a string that is a single lower-case
 * token no longer than `MAX_FACT_VALUE`. A summary sentence has spaces, capital
 * letters and length, so it is excluded by construction rather than by a
 * denylist somebody has to maintain. Booleans are published as `true`/`false`
 * so that one closed grammar covers every fact and a document never has to
 * carry a JSON type.
 *
 * @param {any} receipt
 * @returns {Record<string, string>}
 */
export function journeyFacts(receipt) {
  /** @type {Record<string, string>} */
  const facts = {};
  if (!receipt || typeof receipt !== 'object') return facts;
  for (const key of Object.keys(receipt).sort()) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    const value = receipt[key];
    if (typeof value === 'boolean') { facts[key] = value ? 'true' : 'false'; continue; }
    if (typeof value !== 'string' || value.length > MAX_FACT_VALUE) continue;
    if (FACT_VALUE.test(value)) facts[key] = value;
  }
  return facts;
}
