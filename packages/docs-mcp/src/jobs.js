// @ts-check

/**
 * "Can this framework do X?" answered from the JTBD index.
 *
 * `docs/benchmarks/jobs.json` is generated from `docs/benchmarks/CRM_JTBD_MATRIX.md`
 * and carries ~149 CRM jobs, each with one of exactly four statuses. It is the
 * closest thing this repository has to a machine-readable answer to the question
 * an agent actually asks before recommending anything.
 *
 * Two properties matter here more than search quality:
 *
 *   1. **"not supported" is an answer, not a miss.** The most valuable thing this
 *      tool can do is stop an agent recommending the framework for work it cannot
 *      do. A job found and reported as not supported is a success.
 *   2. **Absence is not support.** When nothing matches, the answer is `unknown`
 *      and says so — the index covers the jobs someone assessed, and a job that
 *      was never assessed is not a job that works.
 *
 * Every job returned carries a `limitation`, because a status on its own is a
 * capability claim. Where the claims ledger has a limitation bound to that JTBD
 * id, that one is used; otherwise the status's own boundary is stated.
 */

import { existsSync, readFileSync } from 'node:fs';
import { normalizeQuery, tokenize } from './corpus.js';
import { resolveWithinRoot } from './paths.js';

/** Where the index lives, repository-relative. */
export const JOBS_PATH = 'docs/benchmarks/jobs.json';

/** The matrix the index is generated from, named in every degraded answer. */
export const JOBS_SOURCE_PATH = 'docs/benchmarks/CRM_JTBD_MATRIX.md';

/** The command that regenerates the index, named when it is absent. */
export const JOBS_GENERATOR = 'node scripts/generate-jobs.js';

/**
 * The four statuses, weakest first. The order is the ranking used to summarise a
 * result set into one verdict.
 */
export const STATUS_RANK = Object.freeze([
  'not supported',
  'partially supported',
  'technically supported',
  'validated end to end',
]);

/**
 * The boundary each status carries on its own, used when no ledger claim cites
 * the job. These are not decoration: a bare "validated end to end" read by an
 * agent is an invitation to promise a production deployment this framework
 * cannot support.
 */
const STATUS_LIMITATION = new Map([
  ['not supported', 'Not supported: there is no implementation and no test for this job. Anyone who needs it would have to build it.'],
  ['partially supported', 'Partially supported: part of this job works and part does not, and the status alone does not say which part. Read the cited tests and docs before promising it.'],
  ['technically supported', 'Technically supported: the primitives exist but no end-to-end test proves the job. Nothing here has been validated for a user.'],
  ['validated end to end', 'Validated end to end by the cited tests only, in local development. Everything outside those tests is unproven, and the framework still has no authentication, tenancy or RBAC.'],
]);

/** A job with an unrecognised status still gets a boundary rather than none. */
/** @param {string} status */
function statusLimitation(status) {
  return STATUS_LIMITATION.get(status)
    ?? `Status "${status}" is outside the four-value vocabulary of ${JOBS_PATH}; treat this job as unassessed.`;
}

/**
 * Read-only view over the JTBD index.
 *
 * @param {{rootDir: string, ledger: any}} dependencies
 */
export function createJobsIndex({ rootDir, ledger }) {
  /** @type {any} */
  let index = null;
  /** @type {boolean | null} */
  let present = null;

  function load() {
    if (present === false) return null;
    if (index) return index;
    let absolute;
    try {
      absolute = resolveWithinRoot(rootDir, JOBS_PATH);
    } catch {
      present = false;
      return null;
    }
    if (!existsSync(absolute)) {
      present = false;
      return null;
    }
    index = JSON.parse(readFileSync(absolute, 'utf8'));
    present = true;
    return index;
  }

  return {
    available: () => load() !== null,

    /**
     * @param {string} rawQuery
     * @param {number} limit
     */
    check(rawQuery, limit) {
      const query = normalizeQuery(rawQuery, 'query');
      const loaded = load();

      if (!loaded) {
        // Degrade with a message, not an exception: an agent asking whether a
        // framework can do something should be told the index is missing, not
        // handed a stack trace it will read as "broken server".
        return {
          available: false,
          query,
          answer: 'unknown',
          answerText:
            `The jobs index ${JOBS_PATH} is not present in this checkout, so this server cannot say `
            + `whether the framework supports "${query}". It is generated from ${JOBS_SOURCE_PATH}; `
            + `run \`${JOBS_GENERATOR}\` to produce it. Until then, read ${JOBS_SOURCE_PATH} directly `
            + 'and treat every job as unassessed rather than as supported.',
          source: JOBS_PATH,
          generatedFrom: JOBS_SOURCE_PATH,
          remediation: JOBS_GENERATOR,
          matches: [],
        };
      }

      const terms = tokenize(query);
      const scored = rankJobs(loaded.jobs ?? [], terms);
      const matches = scored.slice(0, limit).map((entry) => toJob(entry.job, ledger));
      const verdict = summarise(matches, query, loaded);

      return {
        available: true,
        query,
        terms,
        answer: verdict.answer,
        answerText: verdict.text,
        source: JOBS_PATH,
        generatedFrom: loaded.generatedFrom ?? JOBS_SOURCE_PATH,
        statusVocabulary: loaded.statusVocabulary ?? STATUS_RANK,
        counts: loaded.counts ?? null,
        totalMatches: scored.length,
        truncated: scored.length > limit,
        matches,
      };
    },
  };
}

/**
 * Turn a raw index entry into an answer that carries its own boundary.
 *
 * @param {any} job
 * @param {any} ledger
 */
export function toJob(job, ledger) {
  const status = String(job.status ?? '');
  const id = String(job.id ?? '');
  const capability = ledger?.capabilityForJob ? ledger.capabilityForJob(id) : null;
  return {
    id,
    kind: 'job',
    title: String(job.title ?? ''),
    status,
    summary: String(job.summary ?? ''),
    section: String(job.section ?? ''),
    // The ledger's limitation when the job is claimed publicly; the status's own
    // boundary otherwise. Never absent — `assertLimitationsPresent` holds the line.
    limitation: capability ? capability.limitation : statusLimitation(status),
    limitationSource: capability ? `site/claims.json ${capability.id}.limitation` : `status "${status}"`,
    claim: capability ? { id: capability.id, text: capability.claim } : null,
    evidence: {
      tests: Array.isArray(job.tests) ? job.tests.map(String) : [],
      docs: Array.isArray(job.docs) ? job.docs.map(String) : [],
    },
    source: JOBS_PATH,
  };
}

/**
 * @param {any[]} jobs
 * @param {string[]} terms
 */
function rankJobs(jobs, terms) {
  /** @type {{score: number, id: string, job: any}[]} */
  const scored = [];
  if (terms.length === 0) return scored;

  for (const job of jobs) {
    const id = String(job.id ?? '').toLowerCase();
    const title = String(job.title ?? '').toLowerCase();
    const summary = String(job.summary ?? '').toLowerCase();
    const section = String(job.section ?? '').toLowerCase();

    let score = 0;
    for (const term of terms) {
      if (id === term) score += 20;
      else if (id.includes(term)) score += 6;
      if (title.includes(term)) score += 4;
      if (summary.includes(term)) score += 2;
      if (section.includes(term)) score += 1;
    }
    if (score === 0) continue;
    scored.push({ score, id: String(job.id ?? ''), job });
  }

  scored.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return scored;
}

/**
 * One verdict for a result set. The strongest status among the matches, because
 * an agent asking "can it do X" is asking whether any evidence exists — and the
 * text always names how many of the matches are weaker.
 *
 * @param {any[]} matches
 * @param {string} query
 * @param {any} loaded
 */
function summarise(matches, query, loaded) {
  const total = Array.isArray(loaded.jobs) ? loaded.jobs.length : 0;
  if (matches.length === 0) {
    return {
      answer: 'unknown',
      text:
        `No job in the index matches "${query}". The index carries ${total} assessed jobs generated from `
        + `${JOBS_SOURCE_PATH}; a job that is absent was never assessed, which is not the same as a job `
        + 'that works. Treat it as unsupported until a test proves otherwise.',
    };
  }

  let best = matches[0];
  for (const match of matches) {
    if (STATUS_RANK.indexOf(match.status) > STATUS_RANK.indexOf(best.status)) best = match;
  }
  const weaker = matches.filter((match) => match.status !== best.status).length;

  if (best.status === 'not supported') {
    return {
      answer: 'not supported',
      text:
        `Not supported. The closest job is ${best.id} — ${best.title} — and every one of the `
        + `${matches.length} matching job${matches.length === 1 ? '' : 's'} is marked "not supported" in `
        + `${JOBS_SOURCE_PATH}. Do not recommend this framework for that work without saying it would have `
        + 'to be built.',
    };
  }

  return {
    answer: best.status,
    text:
      `The strongest match is ${best.id} — ${best.title} — marked "${best.status}". `
      + `${best.limitation}`
      + (weaker > 0
        ? ` ${weaker} other matching job${weaker === 1 ? ' is' : 's are'} weaker than this; read the whole match list before answering.`
        : ''),
  };
}
