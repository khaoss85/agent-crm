/**
 * Source-hash drift is an advisory; behaviour drift is the gate.
 *
 * Each characterization baseline digests the source files its behaviour
 * depends on (`source`: path -> sha256). The digest answers "is this
 * baseline still about the code in front of me" — but a changed file whose
 * behaviour did not move must not fail the suite: every regeneration
 * rewrites the hash lines, so two behaviour-neutral PRs touching different
 * digested files conflict on lines neither of them meant (backlog:e0347551).
 *
 * Forma (a), like `repo:truth --check --drift-advisory --base`: the
 * observation comparison (`compareToBaseline`) is the blocking gate — a
 * moved, missing, added or reclassified asserted value fails, regenerated
 * or not. A source-only drift only warns, loudly, naming the files. The
 * hashes realign by regeneration inside a behaviour-changing PR, or by a
 * normal PR on main afterwards — never by a direct push.
 *
 * This module is deliberately dependency-free (the caller passes the
 * comparison in): nothing here may name a domain internal, so the wiring
 * seam of every domain stays owned by its harness.
 */

/**
 * Files whose current digest differs from the checked-in one, including
 * files added or removed on either side. Sorted, so the advisory is stable.
 *
 * @param {Record<string, string>} baselineSource the checked-in `source` map
 * @param {Record<string, string>} current fresh fingerprints of the same shape
 * @returns {string[]}
 */
export function driftedSourceFiles(baselineSource, current) {
  const base = baselineSource ?? {};
  const now = current ?? {};
  const files = new Set([...Object.keys(base), ...Object.keys(now)]);
  return [...files].filter((file) => (base[file] ?? null) !== (now[file] ?? null)).sort();
}

/**
 * @param {{baselineSource: Record<string, string>, current: Record<string, string>,
 *   comparison: {ok: boolean, changed?: Array<{id: string}>, missing?: string[],
 *   added?: string[], reclassified?: Array<{id: string}>}}} input
 */
export function classifySourceDrift({ baselineSource, current, comparison }) {
  const drifted = driftedSourceFiles(baselineSource, current);
  const blocking = !comparison.ok;
  return {
    blocking,
    advisory: drifted.length > 0 && !blocking,
    drifted,
    changed: comparison.changed ?? [],
    missing: comparison.missing ?? [],
    added: comparison.added ?? [],
    reclassified: comparison.reclassified ?? [],
  };
}

/**
 * The loud warning for a hash-only drift: names the files, says no
 * regeneration is needed, and says where the hashes realign.
 */
export function formatDriftAdvisory({ domain, drifted, regenerate }) {
  return [
    `CHARACTERIZATION_DRIFT_ADVISORY ${domain}: ${drifted.length} behaviour-bearing source file(s) changed without changing any observed value.`,
    ...drifted.map((file) => `  drifted ${file}`),
    'No baseline regeneration is needed for this drift. When behaviour does change, '
    + `regenerate deliberately with \`${regenerate}\` and review the diff.`,
    'The hashes realign on main afterwards with `npm run characterize:realign-source` in a normal PR and its gate, never a direct push.',
  ].join('\n');
}

/** The failure detail for a blocking drift: what moved, and the deliberate fix. */
export function formatBlockingDrift({ domain, verdict, regenerate }) {
  const ids = (entries) => entries.map((entry) => entry.id).join(', ');
  return `a behaviour-bearing source changed what ${domain} does — regenerate the baseline deliberately `
    + `with \`${regenerate}\` and review the diff. `
    + `changed=[${ids(verdict.changed)}] missing=[${verdict.missing.join(', ')}] `
    + `added=[${verdict.added.join(', ')}] reclassified=[${ids(verdict.reclassified)}]`;
}
