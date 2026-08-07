// @ts-check

/**
 * The claims ledger, served to agents.
 *
 * `site/claims.json` is where this repository keeps its capabilities bound to
 * the tests that prove them, each paired with the limitation that bounds it.
 * `scripts/site-check.js` enforces that pairing for the website. This module
 * enforces the same thing for every MCP client, and it does it structurally:
 *
 *   there is exactly one way to build a capability object — `toCapability` —
 *   and it throws if the limitation is missing.
 *
 * That is the whole design. A future tool cannot accidentally return a bare
 * claim, because it has no way to construct one. The alternative (remembering
 * to attach the limitation at each call site) is the design that eventually
 * ships an overclaim.
 */

import { existsSync, readFileSync } from 'node:fs';
import { AppError, NotFoundError, ValidationError } from '../../core/src/errors.js';
import { documentUri, normalizeQuery, tokenize } from './corpus.js';
import { resolveWithinRoot } from './paths.js';

/** Where the ledger lives, repository-relative. */
export const CLAIMS_PATH = 'site/claims.json';

/** A limitation shorter than this is not a limitation; `site-check.js` uses the same floor. */
const MINIMUM_LIMITATION_LENGTH = 20;

const CLAIM_ID = /^C-\d+$/i;
const LIMITATION_ID = /^L-\d+$/i;

/**
 * The single constructor for a capability answer.
 *
 * @param {any} claim a raw entry from `claims.json`
 * @param {{corpus?: {byPath: (path: string) => unknown}}} [options]
 * @returns {object} the claim, its evidence and its limitation, together
 */
export function toCapability(claim, options = {}) {
  if (!claim || typeof claim !== 'object') {
    throw new ValidationError('a capability needs a claim record', { field: 'claim' });
  }
  const id = typeof claim.id === 'string' ? claim.id : '';
  const text = typeof claim.text === 'string' ? claim.text.trim() : '';
  const limitation = typeof claim.limitation === 'string' ? claim.limitation.trim() : '';

  if (limitation.length < MINIMUM_LIMITATION_LENGTH) {
    // Not a validation error about caller input — a defect in the ledger, and one
    // that must stop the answer rather than degrade it. AGENTS.md: a capability and
    // its limitation are stated in the same breath.
    throw new AppError(
      `${CLAIMS_PATH} ${id || '(unidentified claim)'} has no limitation; `
      + 'a capability may not be served without the boundary that bounds it',
      { code: 'LIMITATION_MISSING', status: 500, details: { id, source: CLAIMS_PATH } },
    );
  }

  const evidence = claim.evidence ?? {};
  const tests = asArray(evidence.tests);
  const docs = asArray(evidence.docs);

  return {
    id,
    kind: 'capability',
    claim: text,
    limitation,
    evidence: {
      jtbd: splitJtbd(evidence.jtbd),
      tests,
      docs,
      repoFacts: asArray(evidence.repoFacts),
      ...(typeof evidence.testName === 'string' ? { testName: evidence.testName } : {}),
      ...(typeof evidence.assertion === 'string' ? { assertion: evidence.assertion } : {}),
    },
    documentResources: docs
      .filter((path) => options.corpus?.byPath(path))
      .map((path) => documentUri(path)),
    source: CLAIMS_PATH,
  };
}

/**
 * The one place a limitation-free capability could still slip through is a
 * caller that builds a result object by hand. This asserts the invariant over a
 * finished response, and the tools run it before returning.
 *
 * @param {unknown} value any tool response
 * @param {string} where a label for the error message
 */
export function assertLimitationsPresent(value, where) {
  for (const node of walkObjects(value, new WeakSet())) {
    const kind = /** @type {any} */ (node).kind;
    if (kind !== 'capability' && kind !== 'job') continue;
    const limitation = /** @type {any} */ (node).limitation;
    if (typeof limitation === 'string' && limitation.trim().length >= MINIMUM_LIMITATION_LENGTH) continue;
    throw new AppError(
      `${where}: a ${kind} was about to be returned without a limitation`,
      { code: 'LIMITATION_MISSING', status: 500, details: { id: /** @type {any} */ (node).id ?? null } },
    );
  }
  return value;
}

/** @param {unknown} value @param {WeakSet<object>} seen @returns {Generator<object>} */
function* walkObjects(value, seen) {
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) yield* walkObjects(item, seen);
    return;
  }
  yield /** @type {object} */ (value);
  for (const child of Object.values(value)) yield* walkObjects(child, seen);
}

/**
 * Read-only view over `site/claims.json`.
 *
 * @param {{rootDir: string, corpus: any}} dependencies
 */
export function createClaimsLedger({ rootDir, corpus }) {
  /** @type {any} */
  let ledger = null;

  function load() {
    if (ledger) return ledger;
    const absolute = resolveWithinRoot(rootDir, CLAIMS_PATH);
    if (!existsSync(absolute)) {
      throw new NotFoundError('claims ledger', CLAIMS_PATH);
    }
    ledger = JSON.parse(readFileSync(absolute, 'utf8'));
    return ledger;
  }

  /** @param {string} id */
  function findClaim(id) {
    const wanted = id.trim().toUpperCase();
    return load().claims.find((/** @type {any} */ claim) => String(claim.id).toUpperCase() === wanted) ?? null;
  }

  /** @param {string} id */
  function findLimitation(id) {
    const wanted = id.trim().toUpperCase();
    const found = load().limitations.find(
      (/** @type {any} */ entry) => String(entry.id).toUpperCase() === wanted,
    );
    return found ? toLimitation(found) : null;
  }

  return {
    /** Contract version and the commit the ledger was measured against. */
    provenance: () => ({
      source: CLAIMS_PATH,
      claimsContract: load().claimsContract ?? null,
      measuredAgainst: load().measuredAgainst ?? null,
    }),

    /** The standing limitations that bound everything else this server says. */
    frameworkLimitations: () => load().limitations.map(toLimitation),

    /**
     * Resolve by id. `C-*` returns a capability; `L-*` returns a standing
     * limitation, which is not a capability and therefore needs no pairing.
     *
     * @param {string} rawId
     */
    byId(rawId) {
      const id = normalizeQuery(rawId, 'id');
      if (CLAIM_ID.test(id)) {
        const claim = findClaim(id);
        if (!claim) throw new NotFoundError('capability', id);
        return toCapability(claim, { corpus });
      }
      if (LIMITATION_ID.test(id)) {
        const limitation = findLimitation(id);
        if (!limitation) throw new NotFoundError('limitation', id);
        return limitation;
      }
      throw new NotFoundError('capability', id);
    },

    /**
     * Rank capabilities by a free-text topic. Matches the claim sentence, the
     * limitation and the JTBD ids it cites — the limitation is searchable on
     * purpose, so "does it do multi-tenancy" finds the claim that says it does not.
     *
     * @param {string} rawTopic
     * @param {number} limit
     */
    byTopic(rawTopic, limit) {
      const topic = normalizeQuery(rawTopic, 'topic');
      const terms = tokenize(topic);
      /** @type {{score: number, id: string, claim: any}[]} */
      const scored = [];
      for (const claim of load().claims) {
        const haystack = [
          claim.text ?? '',
          claim.limitation ?? '',
          claim.evidence?.jtbd ?? '',
          ...asArray(claim.evidence?.tests),
          ...asArray(claim.evidence?.docs),
        ].join(' ').toLowerCase();
        const score = terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0);
        if (score === 0) continue;
        scored.push({ score, id: String(claim.id), claim });
      }
      scored.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return {
        terms,
        totalMatches: scored.length,
        truncated: scored.length > limit,
        matches: scored.slice(0, limit).map((entry) => toCapability(entry.claim, { corpus })),
      };
    },

    /**
     * The capability that cites a given JTBD id, if any. This is what lets
     * `check_job` answer with the ledger's limitation instead of a generic one.
     *
     * @param {string} jtbdId
     */
    capabilityForJob(jtbdId) {
      const wanted = jtbdId.trim().toUpperCase();
      const claim = load().claims.find(
        (/** @type {any} */ entry) => splitJtbd(entry.evidence?.jtbd).some((id) => id.toUpperCase() === wanted),
      );
      return claim ? toCapability(claim, { corpus }) : null;
    },
  };
}

/** @param {any} limitation */
function toLimitation(limitation) {
  return {
    id: String(limitation.id ?? ''),
    kind: 'limitation',
    headline: String(limitation.headline ?? ''),
    text: String(limitation.text ?? ''),
    evidence: {
      jtbd: splitJtbd(limitation.evidence?.jtbd),
      docs: asArray(limitation.evidence?.docs),
      repoFacts: asArray(limitation.evidence?.repoFacts),
    },
    source: CLAIMS_PATH,
  };
}

/**
 * `evidence.jtbd` is a string in the ledger and is sometimes a comma-separated
 * list of ids. Agents need an array.
 *
 * @param {unknown} value
 * @returns {string[]}
 */
export function splitJtbd(value) {
  if (Array.isArray(value)) return value.map(String).map((id) => id.trim()).filter(Boolean);
  if (typeof value !== 'string') return [];
  return value.split(',').map((id) => id.trim()).filter(Boolean);
}

/** @param {unknown} value @returns {string[]} */
function asArray(value) {
  return Array.isArray(value) ? value.map(String) : [];
}
