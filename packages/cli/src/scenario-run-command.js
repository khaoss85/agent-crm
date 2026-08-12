// @ts-check

import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { canonicalJson, inspectionFingerprint, parseSolutionPlan, validateSolutionPlan, MAX_PLAN_BYTES } from '../../core/index.js';
import { inspectApplicationCommand } from './app-inspect-command.js';
import { safeMessage } from './safe-text.js';
import {
  MAX_SCENARIO_BYTES, OBSERVATION_KINDS, parseScenarioDocument, safeRelativePath,
  scenarioFingerprint, validateScenarioDocument,
} from './scenario-document.js';
import { JOURNEYS, RECURSION_ENV, journeyById, journeyFacts, journeyMetrics, runJourney } from './scenario-journey.js';

/**
 * `crm scenario run <scenario> [--json] [--root <dir>]` — DX6.
 *
 * > **Which JTBD rows does this checkout actually earn — and which does it not?**
 *
 * ```text
 * crm app inspect      what is composed?                             source facts
 * crm solution check   is this plan still compatible?                a document
 * crm project doctor   what is stale in the source?                  cheap
 * crm project verify   can we PROVE the project is healthy?          expensive
 * crm scenario run     which business jobs does this checkout earn?  DX6
 * ```
 *
 * **It is not a second test runner.** It runs no suite, grades no package and
 * calls no doctor — doing any of that would make it DX5 with extra words. What
 * it produces is the mapping that does not exist today: *this scenario ran,
 * against this composition, these JTBD rows it exercised with this evidence, and
 * these rows it did **not** establish*. The negative is a counted, enumerated
 * field, because a scenario that earns three rows and cannot speak to forty has
 * to say so in its own output.
 *
 * **It never promotes a row.** `docs/QUALITY_GATES.md` §3 puts the burden of
 * proof on the higher status and gives that decision to a person reviewing
 * merged tests. This reports *evidence*; the report carries a `promotion` block
 * saying it performed none, and its claim vocabulary
 * (`established | not_established | unresolved`) is deliberately **not** the
 * four-value JTBD status vocabulary so the two can never be confused.
 * `docs/benchmarks/jobs.json` and `CRM_JTBD_MATRIX.md` are opened read-only.
 *
 * ```text
 * exit 0   the scenario ran and every claim is established
 * exit 1   the scenario ran and something did not hold, or the document is
 *          invalid — in which case no journey is started
 * exit 2   the scenario document could not be read at all
 * ```
 *
 * Deterministic and offline: nothing reaches the network, and **no duration, no
 * timestamp, no temporary path and no random value enters the report at all** —
 * not merely the fingerprint. Two runs of an unchanged checkout produce
 * byte-identical documents.
 *
 * ## What a second consumer changed (contract 2)
 *
 * Contract 1 was validated by exactly one scenario, and a generic contract with
 * one consumer is not generic, it is a shape fitted to that consumer.
 * `examples/scenarios/service-sla-escalation.scenario.json` is the second, and
 * it is deliberately unlike the first: Service has a state machine, real clock
 * semantics and evidence records, where Lead has a funnel. Three things had to
 * change, and each is a thing contract 1 got wrong rather than merely lacked:
 *
 * 1. **Journey evidence was numeric only.** `journey.count` can say a run
 *    recorded two SLA evaluations; it cannot say either of them said the right
 *    thing. `journey.fact` observes a *stated outcome* — `at_risk`, `breached`,
 *    `false` — which is what a support process is actually judged on.
 * 2. **The report never said which clock produced the evidence.** Nothing in
 *    the sales funnel is a function of the current instant, so nobody noticed.
 *    An SLA state is a function of nothing else. `journey.clock` is published
 *    from the frozen registry — never from the document, because a document
 *    that could choose the instant could choose the one where the breach
 *    disappears.
 * 3. **Limitations were global, and half of them were false.** "No
 *    business-hours calendar" is meaningless for a lead funnel; "no external
 *    enrichment provider" is meaningless for a support case. Limitations now
 *    carry a `scope`, and a journey declares its own in the registry.
 *
 * The document contract (`scenarioContract`) stayed at 1: every v1 scenario is
 * still valid, because a vocabulary gained an entry rather than changing one.
 * The **report** contract moved to 2, because the report gained fields and every
 * fingerprint moved with them, and a consumer diffing fingerprints across that
 * boundary deserves to be told rather than to discover it.
 */

export const SCENARIO_RUN_CONTRACT = 2;

/** Every status an observation may carry. Closed vocabulary. */
export const OBSERVATION_STATUSES = Object.freeze(['passed', 'failed', 'skipped', 'not_applicable']);

/**
 * Every outcome a JTBD claim may carry. **Deliberately not** the four-value JTBD
 * status vocabulary in `docs/QUALITY_GATES.md` §3: this says what one run
 * observed, never what a row's status is.
 */
export const CLAIM_OUTCOMES = Object.freeze(['established', 'not_established', 'unresolved']);

/** Where the JTBD index lives, and the matrix it is generated from. */
export const JOBS_PATH = 'docs/benchmarks/jobs.json';
export const JOBS_SOURCE_PATH = 'docs/benchmarks/CRM_JTBD_MATRIX.md';
/** The index is a document. A runaway one is a defect. */
export const MAX_JOBS_BYTES = 4 * 1024 * 1024;
/** The jobs contract this runner understands. */
export const JOBS_CONTRACT = 1;

/** Where a bare scenario id resolves, and the suffix it carries. */
export const SCENARIO_DIR = 'examples/scenarios';
export const SCENARIO_SUFFIX = '.scenario.json';

/**
 * What this command does **not** prove, **whichever** journey ran. Published
 * with every report, passing or failing, because a green exit code that quietly
 * means less than a reader assumes is the failure mode this whole family of
 * commands exists to avoid.
 *
 * These are `scope: 'global'` in the report. A journey's own limitations —
 * declared in the frozen registry, never in the document — arrive as
 * `scope: 'journey'` beside them. Contract 1 had only this list, and it was
 * fine while one journey existed: with two, half of any merged list is false of
 * whichever run you are reading, and a disclaimer that is obviously irrelevant
 * teaches a reader to skip the ones that are not.
 */
export const LIMITATIONS = Object.freeze([
  {
    code: 'SCENARIO_IS_NOT_PROMOTION',
    message: 'this changes no JTBD status and writes to no document. A row is promoted by a person against '
      + 'docs/QUALITY_GATES.md §3, on merged tests, with the burden of proof on the higher status',
  },
  {
    code: 'COVERAGE_IS_CLAIMED_NOT_DISCOVERED',
    message: 'this checks the rows a scenario claims. It cannot discover which rows a journey happens to '
      + 'exercise, so a row absent from the claims is absent from the evidence even if the run touched it',
  },
  {
    code: 'NEGATIVE_EVIDENCE_IS_SILENCE',
    message: 'a row under notEstablished means this scenario said nothing about it — never that the row is '
      + 'unsupported. The recorded status in the JTBD index is the only statement about support',
  },
  {
    code: 'EVIDENCE_IS_ONE_COMPOSITION',
    message: 'the evidence is about the one application this journey composed. It says nothing about a '
      + 'different composition, a different data set or a different policy version',
  },
  {
    code: 'JOURNEY_SOURCE_TRUSTED',
    message: 'the journey is checked-in repository source and runs with the operator\'s authority. The child '
      + 'is bounded in time, output and process group; that is isolation, not a filesystem, network or OS sandbox',
  },
  {
    code: 'BROWSER_EVIDENCE_NOT_AUTOMATED',
    message: 'no browser is driven and no rendered page is checked, so nothing here is evidence about the '
      + 'Admin as a user sees it',
  },
  {
    code: 'NO_PROVIDER_CONTACTED',
    message: 'offline by construction. No external provider is contacted, authenticated or health-checked, '
      + 'and every provider in the journey is a checked-in fixture',
  },
  {
    code: 'PRODUCTION_READINESS_NOT_ASSESSED',
    message: 'there is no auth, tenancy or RBAC in this framework, and nothing here assesses deployment, '
      + 'capacity or operational readiness',
  },
]);

/**
 * The limitations of one run: the global ones, then the ones the journey that
 * actually ran declares about itself.
 *
 * Global first, then the journey's, each in its own declaration order — both
 * lists are frozen constants, so the result is canonical without a sort. The
 * journey's come from the registry rather than from the scenario document: a
 * document that could write its own limitations could write a **shorter** set,
 * and every incentive points that way.
 *
 * @param {any} chosen a journey registry entry, or null
 */
export function limitationsFor(chosen) {
  const own = Array.isArray(chosen?.limitations) ? chosen.limitations : [];
  return [
    ...LIMITATIONS.map((entry) => ({ scope: 'global', code: entry.code, message: entry.message })),
    ...own.map((entry) => ({ scope: 'journey', code: entry.code, message: entry.message })),
  ];
}

/**
 * Resolve the command's one argument.
 *
 * A bare id resolves inside `examples/scenarios/` and may not contain a
 * separator, so it cannot become a traversal. Anything else is treated as a
 * path the operator typed — the same posture `crm solution check` takes with a
 * plan file.
 *
 * @param {string} value @param {string} rootDir
 * @returns {{path: string, relative: string|null, problem: string|null}}
 */
export function resolveScenarioArgument(value, rootDir) {
  if (typeof value !== 'string' || value.trim() === '') {
    return { path: '', relative: null, problem: 'Usage: crm scenario run <scenario> [--json] [--root dir]' };
  }
  if (value.includes('\0')) {
    return { path: '', relative: null, problem: 'a scenario name may not contain a null byte' };
  }
  const bare = /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
  if (bare) {
    const relative = `${SCENARIO_DIR}/${value}${SCENARIO_SUFFIX}`;
    return { path: join(rootDir, relative), relative, problem: null };
  }
  const path = isAbsolute(value) ? value : resolve(rootDir, value);
  const within = path === rootDir || path.startsWith(rootDir + sep);
  return { path, relative: within ? path.slice(rootDir.length + 1).split(sep).join('/') : null, problem: null };
}

/**
 * The JTBD index, read-only. Its `jobsContract` and `statusVocabulary` are
 * **used**, never paralleled: this command has no opinion about which rows
 * exist or what a status means.
 *
 * @param {string} rootDir
 */
export function loadJobsIndex(rootDir) {
  const path = join(rootDir, JOBS_PATH);
  const stat = statSync(path, { throwIfNoEntry: false });
  if (!stat || !stat.isFile()) {
    return { ok: false, reason: `${JOBS_PATH} is not in this project`, jobs: new Map(), fingerprint: null, contract: null, statusVocabulary: [] };
  }
  if (stat.size > MAX_JOBS_BYTES) {
    return { ok: false, reason: `${JOBS_PATH} is larger than ${MAX_JOBS_BYTES} bytes`, jobs: new Map(), fingerprint: null, contract: null, statusVocabulary: [] };
  }
  let raw;
  let source;
  try {
    source = readFileSync(path);
    raw = JSON.parse(source.toString('utf8'));
  } catch (error) {
    return { ok: false, reason: `${JOBS_PATH} is not readable JSON: ${safeMessage(error, rootDir)}`, jobs: new Map(), fingerprint: null, contract: null, statusVocabulary: [] };
  }
  if (!raw || typeof raw !== 'object' || raw.jobsContract !== JOBS_CONTRACT || !Array.isArray(raw.jobs)) {
    return { ok: false, reason: `${JOBS_PATH} must be a jobsContract ${JOBS_CONTRACT} document with a jobs array`, jobs: new Map(), fingerprint: null, contract: raw?.jobsContract ?? null, statusVocabulary: [] };
  }
  /** @type {Map<string, any>} */
  const jobs = new Map();
  for (const entry of raw.jobs) {
    if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string') continue;
    if (entry.id === '__proto__' || entry.id === 'constructor' || entry.id === 'prototype') continue;
    if (jobs.has(entry.id)) continue;
    jobs.set(entry.id, {
      id: entry.id,
      title: typeof entry.title === 'string' ? entry.title : '',
      section: typeof entry.section === 'string' ? entry.section : '',
      status: typeof entry.status === 'string' ? entry.status : '',
      tests: Array.isArray(entry.tests) ? entry.tests.filter((t) => typeof t === 'string').slice(0, 12) : [],
    });
  }
  return {
    ok: true,
    reason: null,
    jobs,
    fingerprint: createHash('sha256').update(source).digest('hex'),
    contract: JOBS_CONTRACT,
    statusVocabulary: Array.isArray(raw.statusVocabulary) ? raw.statusVocabulary.filter((s) => typeof s === 'string') : [],
  };
}

/**
 * Index the facts AX1 already resolved. **Nothing is recomputed here.** DX5
 * shipped a defect where package selection re-derived what an upstream authority
 * had already decided and silently matched nothing; the rule that follows from
 * it is to take the authority's own names verbatim.
 *
 * @param {any} report an AX1 application-inspection report
 */
export function indexComposition(report) {
  const packages = new Set((report?.packages ?? []).map((entry) => entry?.name).filter(Boolean));
  const resources = new Set((report?.resources ?? []).map((entry) => entry?.resource).filter(Boolean));
  const modules = new Set((report?.modules ?? []).map((entry) => entry?.name).filter(Boolean));
  const actions = new Set((report?.actions ?? [])
    .filter((entry) => entry?.module && entry?.name)
    .map((entry) => `${entry.module}.${entry.name}`));
  const capabilities = (report?.capabilities ?? [])
    .filter((entry) => entry?.name)
    .map((entry) => ({ name: entry.name, version: entry.version ?? null, status: entry.status ?? null }));
  const policies = (report?.policies ?? [])
    .filter((entry) => entry?.name)
    .map((entry) => ({ name: entry.name, version: entry.version ?? null, kind: entry.kind ?? null }));
  return { packages, resources, modules, actions, capabilities, policies };
}

/**
 * @param {{
 *   scenarioRef: string, rootDir?: string, json?: boolean,
 *   out?: (text: string) => void, err?: (text: string) => void,
 *   journey?: Function, inspect?: Function, jobs?: Function,
 *   env?: Record<string, string|undefined>, workDir?: string|null,
 * }} options
 * @returns {Promise<{exitCode: number, report: any}>}
 */
export async function scenarioRunCommand({
  scenarioRef,
  rootDir = process.cwd(),
  json = false,
  out = (text) => process.stdout.write(text),
  err = (text) => process.stderr.write(text),
  journey = runJourney,
  inspect = inspectApplicationCommand,
  jobs = loadJobsIndex,
  env = process.env,
  workDir = null,
}) {
  const root = resolve(rootDir);

  // ---- 0. the recursion guard ---------------------------------------------
  // Nothing a journey does today can re-enter this command. "Nothing can today"
  // is exactly the assumption that stopped being true in DX5, where a project
  // whose verify script re-invoked the command recursed 2^depth.
  if (env?.[RECURSION_ENV] === '1') {
    err('SCENARIO_RECURSION_REFUSED: this process is already inside a scenario run. '
      + 'A journey may not start another one, and nothing was executed.\n');
    return { exitCode: 2, report: null };
  }

  // ---- 1. the document, refused before anything runs -----------------------
  const located = resolveScenarioArgument(scenarioRef, root);
  if (located.problem) {
    err(`${located.problem}\n`);
    return { exitCode: 2, report: null };
  }
  const stat = statSync(located.path, { throwIfNoEntry: false });
  if (!stat || !stat.isFile()) {
    err(`No such scenario: ${scenarioRef}. A bare id resolves to ${SCENARIO_DIR}/<id>${SCENARIO_SUFFIX}.\n`);
    return { exitCode: 2, report: null };
  }
  if (stat.size > MAX_SCENARIO_BYTES) {
    err(`A scenario document must be at most ${MAX_SCENARIO_BYTES} bytes; this one is ${stat.size}.\n`);
    return { exitCode: 2, report: null };
  }
  let source;
  try {
    source = readFileSync(located.path, 'utf8');
  } catch (error) {
    err(`${safeMessage(error, root)}\n`);
    return { exitCode: 2, report: null };
  }

  const parsed = parseScenarioDocument(source);
  if (parsed.raw === null) {
    emitRefusal({ json, out, problems: parsed.problems, scenarioPath: located.relative });
    return { exitCode: 2, report: null };
  }
  const { valid, scenario, problems: documentProblems } = validateScenarioDocument(parsed.raw);
  if (scenario === null) {
    emitRefusal({ json, out, problems: documentProblems, scenarioPath: located.relative });
    return { exitCode: 2, report: null };
  }

  /** @type {any[]} */
  const problems = [...documentProblems];
  const chosen = journeyById(scenario.journey);
  if (!chosen) {
    problems.push({
      code: 'SCENARIO_JOURNEY_UNKNOWN',
      path: 'scenario.journey',
      message: `"${scenario.journey}" is not a journey this runner knows. Known journeys: ${Object.keys(JOURNEYS).sort().join(', ')}. `
        + 'A journey is chosen by id from a frozen registry in the runner\'s own source; a scenario can never name a path or a command',
    });
  }

  // A document with a problem never starts a journey. The refusal is the whole
  // point of a declarative contract: it costs nothing and it happens first.
  const refused = problems.length > 0 || !valid;

  // ---- 2. run the journey --------------------------------------------------
  let journeyResult = null;
  let projectDir = null;
  let created = null;
  try {
    if (!refused && chosen) {
      created = workDir ?? mkdtempSync(join(tmpdir(), 'accordo-scenario-'));
      projectDir = created;
      journeyResult = await journey({
        rootDir: root,
        installer: chosen.installer,
        projectDir,
        env,
      });
      if (!journeyResult.ok) {
        problems.push({
          code: 'SCENARIO_JOURNEY_FAILED',
          path: 'scenario.journey',
          message: journeyFailure(journeyResult, root),
        });
      }
    }

    // ---- 3. inspect what the journey composed ------------------------------
    let composition = { inspected: false, valid: false, compositionFingerprint: null, packages: [], problems: [] };
    let index = indexComposition(null);
    let compositionReadable = false;
    if (journeyResult?.ok) {
      const inspected = await inspect({ rootDir: projectDir, json: true, capture: true });
      const report = inspected?.report ?? null;
      if (report === null) {
        problems.push({
          code: 'SCENARIO_COMPOSITION_UNREADABLE',
          path: 'composition',
          message: 'the journey completed but the application it composed could not be inspected, so no composition '
            + 'observation could be answered',
        });
      } else {
        compositionReadable = true;
        index = indexComposition(report);
        let fingerprint = null;
        try {
          fingerprint = inspectionFingerprint(report);
        } catch {
          fingerprint = null;
        }
        composition = {
          inspected: true,
          valid: report.valid === true,
          compositionFingerprint: fingerprint,
          packages: [...(report.packages ?? [])].map((entry) => entry?.name).filter(Boolean).sort(),
          problems: [...(report.problems ?? [])].map((entry) => entry?.code).filter(Boolean).sort(),
        };
      }
    }

    // ---- 4. answer every declared observation -------------------------------
    const observations = [];
    for (const step of scenario.steps) {
      step.observe.forEach((declared, position) => {
        observations.push(evaluate({
          declared,
          code: `${step.id}.${String(position + 1).padStart(2, '0')}`,
          step: step.id,
          refused,
          journeyResult,
          compositionReadable,
          index,
          rootDir: root,
        }));
      });
    }
    // Codes are `<step>.<n>`, and a step id is unique in a valid document — but a
    // *refused* document may repeat one, and a report whose counts disagree with
    // its own list is not a report. Dedupe once, then count what is published.
    const byCode = new Map(observations.map((entry) => [entry.code, entry]));
    const published = [...byCode.values()];
    const stepStatus = new Map(scenario.steps.map((step) => {
      const own = published.filter((entry) => entry.step === step.id);
      const status = own.length === 0 ? 'not_applicable'
        : own.every((entry) => entry.status === 'passed') ? 'passed'
          : own.some((entry) => entry.status === 'failed') ? 'failed' : 'skipped';
      return [step.id, status];
    }));

    // ---- 5. resolve claims against the JTBD index ---------------------------
    const jobsIndex = jobs(root);
    if (!jobsIndex.ok) {
      problems.push({
        code: 'SCENARIO_JOBS_INDEX_UNREADABLE',
        path: JOBS_PATH,
        message: `${jobsIndex.reason}. Every claim is unresolved: the index is the only authority on which rows exist, `
          + 'and this command will not invent one',
      });
    }
    const claims = scenario.claims.map((claim) => {
      const row = jobsIndex.jobs.get(claim.job) ?? null;
      const cited = claim.steps.map((id) => stepStatus.get(id) ?? 'skipped');
      const evidence = claim.steps.flatMap((id) => published.filter((entry) => entry.step === id).map((entry) => entry.code)).sort();
      let outcome;
      let reason;
      if (!jobsIndex.ok) {
        outcome = 'unresolved';
        reason = 'SCENARIO_JOBS_INDEX_UNREADABLE';
      } else if (row === null) {
        outcome = 'unresolved';
        reason = `no row "${claim.job}" exists in ${JOBS_PATH}`;
      } else if (cited.length > 0 && cited.every((status) => status === 'passed')) {
        outcome = 'established';
        reason = null;
      } else {
        outcome = 'not_established';
        reason = claim.steps
          .filter((id) => stepStatus.get(id) !== 'passed')
          .map((id) => `${id} ${stepStatus.get(id) ?? 'missing'}`)
          .join(', ') || 'no cited step was observed';
      }
      return {
        job: claim.job,
        title: row?.title ?? '',
        section: row?.section ?? '',
        recordedStatus: row?.status ?? null,
        recordedTests: row?.tests ?? [],
        outcome,
        steps: [...claim.steps],
        evidence,
        note: claim.note,
        reason,
      };
    });
    for (const claim of claims) {
      if (claim.outcome === 'unresolved' && jobsIndex.ok) {
        problems.push({
          code: 'SCENARIO_JOB_UNKNOWN',
          path: `scenario.claims.${claim.job}`,
          message: `${claim.reason}. A claim that resolves to no row is a typo reading as coverage, so it fails closed`,
        });
      }
    }

    // ---- 6. the honest negative ---------------------------------------------
    const established = claims.filter((claim) => claim.outcome === 'established').map((claim) => claim.job).sort();
    const establishedSet = new Set(established);
    const notEstablished = [...jobsIndex.jobs.keys()].filter((id) => !establishedSet.has(id)).sort();
    /** @type {Map<string, number>} */
    const bySection = new Map();
    for (const id of notEstablished) {
      const section = jobsIndex.jobs.get(id)?.section ?? '';
      bySection.set(section, (bySection.get(section) ?? 0) + 1);
    }

    const counts = {
      observations: tally(published.map((entry) => entry.status), OBSERVATION_STATUSES),
      claims: tally(claims.map((claim) => claim.outcome), CLAIM_OUTCOMES),
      jobs: {
        total: jobsIndex.jobs.size,
        established: established.length,
        notEstablished: notEstablished.length,
      },
    };
    const status = problems.length > 0
      || counts.observations.failed > 0
      || counts.claims.not_established > 0
      || counts.claims.unresolved > 0
      ? 'failed' : 'passed';

    const report = {
      scenarioRunContract: SCENARIO_RUN_CONTRACT,
      command: 'scenario:run',
      scenario: {
        id: scenario.id,
        title: scenario.title,
        summary: scenario.summary,
        path: located.relative,
        fingerprint: scenarioFingerprint(scenario),
      },
      status,
      counts,
      journey: {
        id: scenario.journey,
        source: chosen?.installer ?? null,
        describes: chosen?.describes ?? null,
        // Which clock produced this evidence. Taken from the frozen registry,
        // never from the document: an SLA state *is* a function of the clock,
        // and a report that omits it is a number with a story attached.
        clock: chosen?.clock
          ? { mode: chosen.clock.mode, describes: chosen.clock.describes }
          : { mode: null, describes: null },
        completed: journeyResult?.ok === true,
        exit: journeyResult === null
          ? { code: null, signal: null, timedOut: false, truncated: false, started: false }
          : {
            code: journeyResult.code, signal: journeyResult.signal,
            timedOut: journeyResult.timedOut === true, truncated: journeyResult.truncated === true,
            started: true,
          },
        metrics: journeyMetrics(journeyResult?.receipt),
        facts: journeyFacts(journeyResult?.receipt),
      },
      composition,
      steps: scenario.steps.map((step) => ({
        id: step.id,
        narrative: step.narrative,
        status: stepStatus.get(step.id) ?? 'skipped',
        observations: step.observe.map((_, position) => `${step.id}.${String(position + 1).padStart(2, '0')}`),
      })),
      observations: [...published].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0)),
      jtbd: {
        jobsContract: jobsIndex.contract,
        source: JOBS_PATH,
        matrix: JOBS_SOURCE_PATH,
        sourceFingerprint: jobsIndex.fingerprint,
        statusVocabulary: [...jobsIndex.statusVocabulary],
        claims,
        established,
        notEstablished: {
          count: notEstablished.length,
          bySection: [...bySection.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([section, count]) => ({ section, count })),
          jobs: notEstablished,
        },
      },
      promotion: {
        performed: false,
        authority: 'human',
        rule: 'docs/QUALITY_GATES.md §3 — status changes only for what merged tests prove, with the burden of proof '
          + 'on the higher status. This command reports evidence and promotes nothing',
        wrote: [],
      },
      problems: [...problems].sort((a, b) => (a.code === b.code ? (a.path < b.path ? -1 : 1) : a.code < b.code ? -1 : 1)),
      limitations: limitationsFor(chosen),
      fingerprint: '',
    };
    report.fingerprint = semanticFingerprint(report);

    if (json) out(`${JSON.stringify(report, null, 2)}\n`);
    else out(render(report));

    return { exitCode: status === 'failed' ? 1 : 0, report };
  } finally {
    // The journey composed a whole project. It lives in a temporary directory
    // outside the repository and is removed here: DX6 makes no worktree claim
    // because it never writes into the project it is reporting on.
    if (created && !workDir) {
      try { rmSync(created, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
}

/**
 * Answer one declared observation from the authority its kind names.
 *
 * @param {{declared: any, code: string, step: string, refused: boolean,
 *   journeyResult: any, compositionReadable: boolean, index: any, rootDir: string}} context
 */
function evaluate({ declared, code, step, refused, journeyResult, compositionReadable, index, rootDir }) {
  const spec = OBSERVATION_KINDS[declared.kind];
  const base = { code, step, kind: declared.kind, authority: spec?.authority ?? 'unknown' };
  const skip = (reason) => ({ ...base, status: 'skipped', expected: expectation(declared), actual: null, reason });

  if (refused) return skip('SCENARIO_REFUSED');

  if (spec?.authority === 'journey') {
    if (journeyResult === null) return skip('JOURNEY_NOT_STARTED');
    if (declared.kind === 'journey.completed') {
      return {
        ...base,
        status: journeyResult.ok ? 'passed' : 'failed',
        expected: 'the journey completes and reports success',
        actual: journeyResult.ok ? 'completed' : exitDescription(journeyResult),
        reason: journeyResult.ok ? null : 'SCENARIO_JOURNEY_FAILED',
      };
    }
    if (!journeyResult.ok) return skip('SCENARIO_JOURNEY_FAILED');
    if (declared.kind === 'journey.fact') {
      const facts = journeyFacts(journeyResult.receipt);
      if (!Object.prototype.hasOwnProperty.call(facts, declared.fact)) {
        return {
          ...base, status: 'failed', expected: expectation(declared), actual: 'not reported',
          reason: `the journey reported no stated fact "${declared.fact}"; it reported ${Object.keys(facts).join(', ') || 'none'}. `
            + 'A fact nobody reported is a claim nobody made, so it fails rather than passing vacuously',
        };
      }
      const stated = facts[declared.fact];
      return {
        ...base, status: stated === declared.is ? 'passed' : 'failed',
        expected: expectation(declared), actual: `${declared.fact} = ${stated}`,
        reason: stated === declared.is ? null : 'the journey stated a different outcome',
      };
    }
    const metrics = journeyMetrics(journeyResult.receipt);
    if (!Object.prototype.hasOwnProperty.call(metrics, declared.metric)) {
      return {
        ...base, status: 'failed', expected: expectation(declared), actual: 'not reported',
        reason: `the journey reported no numeric metric "${declared.metric}"; it reported ${Object.keys(metrics).join(', ') || 'none'}`,
      };
    }
    const value = metrics[declared.metric];
    const ok = 'equals' in declared ? value === declared.equals : value >= declared.atLeast;
    return {
      ...base, status: ok ? 'passed' : 'failed',
      expected: expectation(declared), actual: `${declared.metric} = ${value}`,
      reason: ok ? null : 'the journey reported a different number',
    };
  }

  if (spec?.authority === 'app-inspect') {
    if (journeyResult === null) return skip('JOURNEY_NOT_STARTED');
    if (!journeyResult.ok) return skip('SCENARIO_JOURNEY_FAILED');
    if (!compositionReadable) return skip('SCENARIO_COMPOSITION_UNREADABLE');
    return composed(base, declared, index);
  }

  if (declared.kind === 'plan.valid') {
    // A document check, independent of the journey: a plan is valid or not
    // whether or not a journey ran.
    return planValid(base, declared, rootDir);
  }

  return { ...base, status: 'not_applicable', expected: expectation(declared), actual: null, reason: 'no authority answers this kind' };
}

/** @param {any} base @param {any} declared @param {any} index */
function composed(base, declared, index) {
  const pass = (actual) => ({ ...base, status: 'passed', expected: expectation(declared), actual, reason: null });
  const fail = (actual, reason) => ({ ...base, status: 'failed', expected: expectation(declared), actual, reason });

  if (declared.kind === 'package.composed') {
    return index.packages.has(declared.package)
      ? pass('composed')
      : fail('absent', `this composition holds ${index.packages.size} package(s), and "${declared.package}" is not one of them`);
  }
  if (declared.kind === 'resource.present') {
    return index.resources.has(declared.resource)
      ? pass('present')
      : fail('absent', `no package in this composition owns a resource named "${declared.resource}"`);
  }
  if (declared.kind === 'module.present') {
    return index.modules.has(declared.module)
      ? pass('present')
      : fail('absent', `this composition has no record module named "${declared.module}"`);
  }
  if (declared.kind === 'action.present') {
    return index.actions.has(declared.action)
      ? pass('present')
      : fail('absent', `this composition publishes no action "${declared.action}"`);
  }
  if (declared.kind === 'capability.available') {
    const matches = index.capabilities.filter((entry) => entry.name === declared.capability
      && (!('version' in declared) || entry.version === declared.version));
    const resolved = matches.filter((entry) => entry.status === 'resolved');
    if (resolved.length > 0) return pass(`resolved@${resolved[0].version}`);
    if (matches.length > 0) return fail(String(matches[0].status), 'the capability is declared but did not resolve in this composition');
    return fail('absent', `no capability "${declared.capability}"${'version' in declared ? `@${declared.version}` : ''} is declared in this composition`);
  }
  if (declared.kind === 'policy.present') {
    const matches = index.policies.filter((entry) => entry.name === declared.policy
      && (!('version' in declared) || entry.version === declared.version));
    return matches.length > 0
      ? pass(`${matches[0].kind ?? 'policy'}@${matches[0].version}`)
      : fail('absent', `this composition registered no policy "${declared.policy}"${'version' in declared ? ` version ${declared.version}` : ''}`);
  }
  return { ...base, status: 'not_applicable', expected: expectation(declared), actual: null, reason: 'unhandled composition kind' };
}

/**
 * A cited Solution Plan, read and validated as a document. It is never executed
 * — nothing in this framework executes one, which is what AX2's own validator
 * enforces and what this scenario contract enforces again.
 *
 * Exported so a test can attack the project boundary directly. Reaching it
 * through a whole run would compose an application first, which puts minutes
 * between the attack and its answer and hides which guard actually refused.
 *
 * @param {any} base @param {any} declared @param {string} rootDir
 */
export function planValid(base, declared, rootDir) {
  const relative = safeRelativePath(declared.plan);
  const expected = expectation(declared);
  if (relative === null) {
    return { ...base, status: 'failed', expected, actual: 'refused', reason: 'the cited path is not a safe repository-relative path' };
  }
  const path = resolve(rootDir, relative);
  if (!(path === rootDir || path.startsWith(rootDir + sep))) {
    return { ...base, status: 'failed', expected, actual: 'refused', reason: 'the cited path resolves outside the project' };
  }
  const stat = statSync(path, { throwIfNoEntry: false });
  if (!stat || !stat.isFile()) {
    return { ...base, status: 'failed', expected, actual: 'absent', reason: `no such plan file: ${relative}` };
  }
  // The check above is lexical, and a lexical check cannot see a symlink: a cited
  // path with no `..` in it, resolving under the root by string comparison, still
  // reads whatever it points at. ADR-026 already settled this for the publication
  // assembler — canonicalize, then enforce the boundary — and the same rule has to
  // hold here, because "it is read as a document and never executed" is a claim
  // about *which* document, not only about not running it.
  let realPath;
  let realRoot;
  try {
    realPath = realpathSync(path);
    realRoot = realpathSync(rootDir);
  } catch (error) {
    return { ...base, status: 'failed', expected, actual: 'unreadable', reason: safeMessage(error, rootDir) };
  }
  if (!(realPath === realRoot || realPath.startsWith(realRoot + sep))) {
    return {
      ...base,
      status: 'failed',
      expected,
      actual: 'refused',
      reason: 'the cited path is a link that resolves outside the project',
    };
  }
  if (stat.size > MAX_PLAN_BYTES) {
    return { ...base, status: 'failed', expected, actual: 'too large', reason: `a solution plan must be at most ${MAX_PLAN_BYTES} bytes` };
  }
  try {
    const plan = parseSolutionPlan(readFileSync(path, 'utf8'));
    const result = validateSolutionPlan(plan);
    return result.valid
      ? { ...base, status: 'passed', expected, actual: `solutionPlanContract ${result.plan?.solutionPlanContract}`, reason: null }
      : {
        ...base, status: 'failed', expected, actual: 'invalid',
        reason: [...new Set(result.problems.map((entry) => entry.code))].sort().join(', '),
      };
  } catch (error) {
    return { ...base, status: 'failed', expected, actual: 'unreadable', reason: safeMessage(error, rootDir) };
  }
}

/** A bounded, machine-stable description of what a declaration asked for. */
function expectation(declared) {
  const args = Object.keys(declared).filter((key) => key !== 'kind').sort()
    .map((key) => `${key}=${declared[key]}`).join(' ');
  return args === '' ? declared.kind : `${declared.kind} ${args}`;
}

/** How a child ended, in words. Never `exit null` for a signal-killed child. */
function exitDescription(result) {
  if (result.spawnError) return 'could not start';
  if (result.timedOut) return 'timed out';
  if (result.signal) return `killed by ${result.signal}`;
  return `exit ${result.code}`;
}

/**
 * Why a journey failed, bounded and free of this machine.
 *
 * Deliberately **not** a log dump and deliberately **not** a home-grown
 * redactor: DX5 shipped one that turned `foreign key: fk_x` into
 * `foreign key=<redacted>` while leaving `/home/José/app` half-scrubbed. This
 * takes the child's last non-empty line and passes it through `safeMessage`,
 * the scrubber AX1 and `crm package test` already share.
 */
function journeyFailure(result, rootDir) {
  const how = exitDescription(result);
  if (result.spawnError) return `the journey could not start: ${safeMessage(new Error(result.spawnError), rootDir)}`;
  const lines = String(result.output ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
  const last = lines.length > 0 ? safeMessage(new Error(lines[lines.length - 1]), rootDir) : '';
  return `the journey did not complete (${how})${last ? `: ${last}` : ''}${result.truncated ? ' [output truncated]' : ''}`;
}

/** @param {string[]} values @param {readonly string[]} vocabulary */
function tally(values, vocabulary) {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const name of vocabulary) counts[name] = 0;
  for (const value of values) if (value in counts) counts[value] += 1;
  return counts;
}

/**
 * The semantic fingerprint: what the run *decided*. Every field of the report is
 * already free of duration, timestamp, temporary path and random value, so this
 * excludes only prose a reader looks at rather than depends on.
 *
 * @param {any} report
 */
export function semanticFingerprint(report) {
  const semantic = {
    scenarioRunContract: report.scenarioRunContract,
    scenario: { id: report.scenario.id, fingerprint: report.scenario.fingerprint },
    status: report.status,
    journey: {
      id: report.journey.id, completed: report.journey.completed,
      // The clock mode is part of what the run decided, not decoration: the same
      // observations mean different things measured against a stepped clock and
      // against the wall clock.
      clock: report.journey.clock?.mode ?? null,
      metrics: report.journey.metrics,
      facts: report.journey.facts,
    },
    composition: {
      compositionFingerprint: report.composition.compositionFingerprint,
      valid: report.composition.valid,
      packages: report.composition.packages,
    },
    observations: report.observations.map((entry) => ({
      code: entry.code, kind: entry.kind, status: entry.status, expected: entry.expected, actual: entry.actual,
    })),
    jtbd: {
      sourceFingerprint: report.jtbd.sourceFingerprint,
      claims: report.jtbd.claims.map((claim) => ({ job: claim.job, outcome: claim.outcome, recordedStatus: claim.recordedStatus })),
      notEstablished: report.jtbd.notEstablished.count,
    },
    problems: report.problems.map((entry) => entry.code).sort(),
  };
  return createHash('sha256').update(canonicalJson(semantic)).digest('hex');
}

/** A document too broken to run still gets a complete, machine-readable refusal. */
function emitRefusal({ json, out, problems, scenarioPath }) {
  const document = {
    scenarioRunContract: SCENARIO_RUN_CONTRACT,
    command: 'scenario:run',
    scenario: { path: scenarioPath },
    status: 'failed',
    problems: [...problems].sort((a, b) => (a.code === b.code ? (a.path < b.path ? -1 : 1) : a.code < b.code ? -1 : 1)),
    // Global only: the document was refused before a journey was chosen, so
    // there is no journey whose own limitations could honestly be published.
    limitations: limitationsFor(null),
    note: 'the document was refused, so no journey was started and nothing was executed',
  };
  if (json) out(`${JSON.stringify(document, null, 2)}\n`);
  else {
    out(`Accordo scenario run (contract ${SCENARIO_RUN_CONTRACT})\nrefused: the scenario document is not valid, so nothing ran.\n\n`);
    for (const problem of document.problems) out(`  ${problem.code} ${problem.path}: ${problem.message}\n`);
    out('\n');
  }
}

/** @param {any} report */
function render(report) {
  const lines = [];
  lines.push(`Accordo scenario run (contract ${report.scenarioRunContract})`);
  lines.push(`scenario: ${report.scenario.id} — ${report.scenario.title}`);
  lines.push(`journey:  ${report.journey.id} — ${report.journey.completed ? 'completed' : 'did not complete'}`);
  lines.push(`clock:    ${report.journey.clock?.mode ?? 'unknown'}`);
  lines.push(`status:   ${report.status}`);
  lines.push('');
  for (const step of report.steps) {
    const mark = { passed: 'ok', failed: 'FAIL', skipped: 'skip', not_applicable: '-' }[step.status] ?? step.status;
    lines.push(`  ${mark.padEnd(5)} ${step.id} — ${step.narrative}`);
    for (const code of step.observations) {
      const entry = report.observations.find((row) => row.code === code);
      if (!entry) continue;
      const inner = { passed: 'ok', failed: 'FAIL', skipped: 'skip', not_applicable: '-' }[entry.status] ?? entry.status;
      lines.push(`        ${inner.padEnd(5)} ${entry.expected}${entry.actual ? ` → ${entry.actual}` : ''}${entry.reason ? ` (${entry.reason})` : ''}`);
    }
  }
  lines.push('');
  lines.push(`JTBD rows this run established (${report.jtbd.established.length} of ${report.counts.jobs.total}):`);
  for (const claim of report.jtbd.claims) {
    lines.push(`  ${claim.outcome.padEnd(15)} ${claim.job}  recorded: ${claim.recordedStatus ?? 'unknown'} — ${claim.title}`);
  }
  lines.push('');
  lines.push(`Rows this scenario did NOT establish: ${report.jtbd.notEstablished.count}`);
  for (const row of report.jtbd.notEstablished.bySection) {
    lines.push(`  ${String(row.count).padStart(4)}  ${row.section}`);
  }
  lines.push('  "not established" means this scenario said nothing about the row — never that it is unsupported.');
  lines.push('');
  if (report.problems.length > 0) {
    lines.push('problems:');
    for (const problem of report.problems) lines.push(`  ${problem.code} ${problem.path}: ${problem.message}`);
    lines.push('');
  }
  lines.push('this promotes nothing: a JTBD row is promoted by a person, on merged tests (docs/QUALITY_GATES.md §3).');
  lines.push('');
  lines.push('not proven here:');
  for (const limitation of report.limitations) lines.push(`  ${limitation.scope.padEnd(7)} ${limitation.code}`);
  lines.push('');
  return lines.join('\n');
}
