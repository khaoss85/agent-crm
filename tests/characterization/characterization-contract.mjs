import { createHash } from 'node:crypto';

/**
 * `legacyCharacterizationContract: 1` — the shape of a pre-extraction baseline.
 *
 * A characterization harness records what a system *does*, not what somebody
 * intended it to do. That is its value and its danger: the naive version freezes
 * every observed behaviour as a contract, and an extraction then has to preserve
 * the bugs. So every observation carries a **classification**, and only two of
 * the four are things the extraction must preserve.
 */

export const LEGACY_CHARACTERIZATION_CONTRACT = 1;

/**
 * What an observation *means*. The distinction is the whole point of the file.
 *
 * - `contractual` — documented, public behaviour. An extraction that changes it
 *   has broken a promise.
 * - `compatibility_required` — undocumented, but a real consumer depends on it
 *   today. It must survive the move, or move deliberately with its consumer in
 *   a separate, reviewed change. Not a promise; a fact with a dependant.
 * - `incidental` — an implementation detail visible by accident: row ordering
 *   nobody specified, an internal id shape, a field order. **Recorded and not
 *   asserted.** Freezing these is how a characterization suite becomes a
 *   cement mixer that makes the refactor it was built to enable impossible.
 * - `defect_candidate` — behaviour that looks wrong or unsafe. Reproduced and
 *   documented so nobody rediscovers it mid-extraction, and deliberately **not**
 *   encoded as must-stay. A defect frozen as a contract is a defect forever.
 */
export const CLASSIFICATIONS = Object.freeze([
  'contractual', 'compatibility_required', 'incidental', 'defect_candidate',
]);

/** Only these two are compared against the baseline as must-not-change. */
export const ASSERTED = Object.freeze(['contractual', 'compatibility_required']);

/** The observable surfaces a case may exercise. */
export const SURFACES = Object.freeze([
  'sdk', 'http', 'schema', 'action-metadata', 'app-inspect', 'solution-plan', 'audit', 'events', 'trace', 'storage', 'admin',
]);

export const CATEGORIES = Object.freeze([
  'enrichment', 'signals', 'scoring', 'routing', 'assignment', 'lifecycle',
  'audit-events-trace', 'storage-restart', 'hostile-input', 'architecture', 'helpers',
]);

/**
 * One observation.
 *
 * @param {{id: string, category: string, classification: string, surface: string,
 *   observed: unknown, note?: string|null}} input
 */
export function observation({ id, category, classification, surface, observed, note = null }) {
  if (!CATEGORIES.includes(category)) throw new Error(`characterization: unknown category "${category}" for ${id}`);
  if (!CLASSIFICATIONS.includes(classification)) throw new Error(`characterization: unknown classification "${classification}" for ${id}`);
  if (!SURFACES.includes(surface)) throw new Error(`characterization: unknown surface "${surface}" for ${id}`);
  if (classification === 'defect_candidate' && !note) {
    throw new Error(`characterization: ${id} is a defect candidate with no explanation — the note IS the finding`);
  }
  return { id, category, classification, surface, observed, note };
}

/**
 * Canonical JSON: sorted keys, so a baseline diff shows a changed *value* and
 * never a changed key order.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

/** @param {unknown} value */
export function digest(value) {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

/**
 * Everything a baseline promises *not* to cover. Written into the document, so
 * a reader who finds a gap after the extraction can see it was declared rather
 * than discovered.
 */
export const LIMITATIONS = Object.freeze([
  ['DETERMINISTIC_FIXTURES_ONLY', 'every provider is a checked-in deterministic fixture. No network call is made, so nothing here characterizes a real provider\'s latency, error shape or data quality'],
  ['INCIDENTAL_NOT_ASSERTED', 'observations classified incidental are recorded and not compared. Row ordering nobody specified and internal id shapes are free to change; freezing them would block the refactor this baseline exists to enable'],
  ['DEFECTS_NOT_FROZEN', 'observations classified defect_candidate are reproduced and documented but never asserted as must-stay. Each one is a recommendation for a separate pre-extraction fix'],
  ['NOT_A_PERFORMANCE_BASELINE', 'no timing is captured. An extraction that preserves every value and doubles the latency passes this suite'],
  ['CONCURRENCY_ONLY_WHERE_OBSERVABLE', 'races are characterized only where the current implementation exposes a deterministic outcome. Where it does not, the absence of a case is not a statement that concurrency is safe'],
  ['ADMIN_SURFACE_NOT_MODELLED', 'Lead Intelligence contributes no Admin section today, so there is no Admin behaviour to freeze. If one is added before the extraction, this baseline does not cover it'],
  ['SINGLE_ATTACHMENT_SHAPE', 'a baseline records how Intelligence was attached when it was generated. Comparing baselines generated under different attachment shapes is a comparison of two different applications, and the contract carries the shape so that cannot happen silently'],
]);

/**
 * @param {{domain: string, attachment: string, source: Record<string, string>,
 *   observations: ReturnType<typeof observation>[]}} input
 */
export function buildBaseline({ domain, attachment, source, observations }) {
  const sorted = [...observations].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const seen = new Set();
  for (const entry of sorted) {
    if (seen.has(entry.id)) throw new Error(`characterization: duplicate observation id "${entry.id}"`);
    seen.add(entry.id);
  }
  const baseline = {
    legacyCharacterizationContract: LEGACY_CHARACTERIZATION_CONTRACT,
    domain,
    // The attachment shape and the source fingerprints together answer "is this
    // baseline still about the code in front of me". They are what makes a
    // deliberate pre-extraction behaviour change *stale* the baseline instead of
    // silently passing.
    attachment,
    source,
    counts: CLASSIFICATIONS.reduce((totals, classification) => ({
      ...totals,
      [classification]: sorted.filter((entry) => entry.classification === classification).length,
    }), {}),
    observations: sorted,
    limitations: LIMITATIONS.map(([code, message]) => ({ code, message })),
  };
  // Over the asserted observations only: an incidental value changing must not
  // move the fingerprint, or "incidental" would mean nothing.
  baseline.fingerprint = digest(sorted
    .filter((entry) => ASSERTED.includes(entry.classification))
    .map((entry) => ({ id: entry.id, classification: entry.classification, observed: entry.observed })));
  return baseline;
}

/**
 * Compare a fresh run against a checked-in baseline.
 *
 * Three kinds of difference, and they are not the same kind of problem:
 * a **changed** asserted value is a behaviour change; a **missing** observation
 * means a case stopped running, which hides a behaviour change; and an **added**
 * one means the suite grew, which needs a deliberate regeneration rather than a
 * silent pass.
 *
 * @param {any} baseline @param {ReturnType<typeof observation>[]} fresh
 */
export function compareToBaseline(baseline, fresh) {
  const freshById = new Map(fresh.map((entry) => [entry.id, entry]));
  const baseById = new Map((baseline.observations ?? []).map((entry) => [entry.id, entry]));

  const changed = [];
  const missing = [];
  const added = [];
  const reclassified = [];

  for (const [id, before] of baseById) {
    const after = freshById.get(id);
    if (!after) { missing.push(id); continue; }
    if (after.classification !== before.classification) {
      reclassified.push({ id, from: before.classification, to: after.classification });
    }
    if (!ASSERTED.includes(before.classification)) continue;
    if (canonical(after.observed) !== canonical(before.observed)) {
      changed.push({ id, classification: before.classification, before: before.observed, after: after.observed });
    }
  }
  for (const id of freshById.keys()) if (!baseById.has(id)) added.push(id);

  return {
    ok: changed.length === 0 && missing.length === 0 && added.length === 0 && reclassified.length === 0,
    changed, missing: missing.sort(), added: added.sort(), reclassified,
  };
}
