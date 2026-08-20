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
  ['validated end to end', 'Validated end to end by the cited tests only, in local development. Everything outside those tests is unproven, and the framework still ships no authentication.'],
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
      const verdict = summarise(scored, matches, query, loaded, ledger);

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
    // The claim's own evidence travels with the job. Some matrix rows are marked
    // validated without naming a test in the row itself (a known gap, held by
    // tests/jobs-json.test.js) — and a "validated end to end" job served with an
    // empty evidence list reads as an unproven claim. Where the ledger has the
    // proof, it is shown here rather than left one tool call away.
    claim: capability
      ? { id: capability.id, text: capability.claim, tests: capability.evidence.tests }
      : null,
    evidence: {
      tests: Array.isArray(job.tests) ? job.tests.map(String) : [],
      docs: Array.isArray(job.docs) ? job.docs.map(String) : [],
    },
    source: JOBS_PATH,
  };
}

/**
 * A job qualifies only if the query hits its id or its title.
 *
 * Summary and section text is deliberately not enough on its own. Every section
 * name in the matrix contains "CRM", every other summary contains "customer",
 * and letting those qualify turned a nonsense query into 108 matches — one of
 * which was inevitably "validated end to end".
 *
 * @param {any[]} jobs
 * @param {string[]} terms
 */
function rankJobs(jobs, terms) {
  /** @type {{score: number, coverage: number, id: string, job: any}[]} */
  const scored = [];
  if (terms.length === 0) return scored;

  for (const job of jobs) {
    const id = String(job.id ?? '').toLowerCase();
    const title = String(job.title ?? '').toLowerCase();
    const summary = String(job.summary ?? '').toLowerCase();
    const section = String(job.section ?? '').toLowerCase();

    let score = 0;
    let covered = 0;
    for (const term of terms) {
      const inId = id === term ? 20 : id.includes(term) ? 6 : 0;
      const inTitle = title.includes(term) ? 4 : 0;
      if (inId > 0 || inTitle > 0) covered += 1;
      score += inId + inTitle;
      if (summary.includes(term)) score += 2;
      if (section.includes(term)) score += 1;
    }
    if (covered === 0) continue;
    scored.push({ score, coverage: covered / terms.length, id: String(job.id ?? ''), job });
  }

  scored.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return scored;
}

/** Below this share of the query's terms matched in a title or id, nothing is answered. */
/**
 * How close a competing job's score must be to the top score to count as
 * comparably relevant. Two points is roughly one weaker signal — a summary hit
 * or a section hit — so a job that matches the question almost as well counts,
 * and a distant one does not.
 */
const NEAR_MISS_MARGIN = 2;

const MINIMUM_COVERAGE = 0.5;

/**
 * A query must be answered by the job it actually asked about, not by the
 * strongest status anywhere in the result set.
 *
 * Answering from the strongest status is the bug that matters here: "send a
 * marketing email campaign" returned "partially supported" on the strength of
 * an unrelated job that happened to be in the list, and "teleport the customer
 * to mars" returned "validated end to end". A tool whose whole purpose is to
 * stop an agent overclaiming must not be the thing that overclaims.
 *
 * So the verdict comes from the top-scoring job alone, ties are broken toward
 * the *weakest* status, and a query that no title really covers is answered
 * `unknown` with its near-misses listed rather than resolved into a status.
 *
 * @param {{score: number, coverage: number, id: string, job: any}[]} scored
 * @param {any[]} matches the jobs actually returned, already limited
 * @param {string} query
 * @param {any} loaded
 * @param {any} ledger
 */
function summarise(scored, matches, query, loaded, ledger) {
  const total = Array.isArray(loaded.jobs) ? loaded.jobs.length : 0;

  if (scored.length === 0) {
    return {
      answer: 'unknown',
      text:
        `No job in the index matches "${query}". The index carries ${total} assessed jobs generated from `
        + `${JOBS_SOURCE_PATH}; a job that is absent was never assessed, which is not the same as a job `
        + 'that works. Treat it as unsupported until a test proves otherwise.',
    };
  }

  const topScore = scored[0].score;
  const tied = scored.filter((entry) => entry.score === topScore);
  const bestCoverage = Math.max(...tied.map((entry) => entry.coverage));

  if (bestCoverage < MINIMUM_COVERAGE) {
    return {
      answer: 'unknown',
      text:
        `No job in the index is close enough to "${query}" to answer it. The ${matches.length} `
        + `job${matches.length === 1 ? '' : 's'} listed share only some words with the question and were not `
        + `assessed for it. Read them, or read ${JOBS_SOURCE_PATH}; do not read this as support.`,
    };
  }

  // Conservative tie-break: among equally-scoring jobs, the weakest status wins.
  let verdict = toJob(tied[0].job, ledger);
  for (const entry of tied) {
    const candidate = toJob(entry.job, ledger);
    if (STATUS_RANK.indexOf(candidate.status) < STATUS_RANK.indexOf(verdict.status)) verdict = candidate;
  }
  const stronger = matches.filter(
    (match) => STATUS_RANK.indexOf(match.status) > STATUS_RANK.indexOf(verdict.status),
  ).length;

  // Refusing to answer from the strongest match is right. Answering from the
  // top match alone while a comparably-relevant job is marked stronger is not:
  // that is a claim about the framework the question never actually asked for.
  // "human approval" ranked a marketing job top and reported that the framework
  // does not do the one thing it is built around; the same query one rank up
  // reports "partially supported" over a flagship boundary that is validated.
  //
  // So a disagreement at comparable relevance resolves to `unknown` with both
  // sides shown, whatever the top match's status. Only an unambiguous match —
  // one no comparably-relevant job outranks — answers with a status. A query
  // whose top match is already the strongest status has no contenders by
  // construction, so a specific question still gets its specific answer.
  const contenders = scored.filter(
    (entry) => entry.score >= topScore - NEAR_MISS_MARGIN
      && entry.coverage >= MINIMUM_COVERAGE
      && STATUS_RANK.indexOf(toJob(entry.job, ledger).status) > STATUS_RANK.indexOf(verdict.status),
  );

  if (contenders.length > 0) {
    const best = contenders
      .map((entry) => toJob(entry.job, ledger))
      .sort((a, b) => STATUS_RANK.indexOf(b.status) - STATUS_RANK.indexOf(a.status))[0];
    return {
      answer: 'unknown',
      text:
        `Ambiguous — the question matches jobs with different answers, so this tool will not pick one for you. `
        + `${verdict.id} (${verdict.title}) is "${verdict.status}", while ${best.id} (${best.title}) is `
        + `"${best.status}" and scores comparably. Read both rather than taking either as the answer: `
        + `${best.limitation}`,
    };
  }

  if (verdict.status === 'not supported') {
    return {
      answer: 'not supported',
      text:
        `Not supported. The job this question is asking about is ${verdict.id} — ${verdict.title} — and it is `
        + `marked "not supported" in ${JOBS_SOURCE_PATH}: no implementation, no test. Do not recommend this `
        + 'framework for that work without saying it would have to be built.'
        + (stronger > 0
          ? ` ${stronger} loosely related job${stronger === 1 ? ' is' : 's are'} listed with a stronger status; `
            + 'they answer different questions.'
          : ''),
    };
  }

  return {
    answer: verdict.status,
    text:
      `The closest job is ${verdict.id} — ${verdict.title} — marked "${verdict.status}". `
      + `${verdict.limitation}`,
  };
}
