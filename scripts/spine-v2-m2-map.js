// @ts-check

/**
 * Binds the ratified Spine v2 M2 section to a classification for every
 * requirement it states.
 *
 * The failure this exists to stop is the one the campaign named: declaring M2
 * complete because the visible raw-driver consumers are gone, while two thirds
 * of what the milestone actually requires has never been read. The ratified
 * plan is prose, and prose has no gate — so a milestone can be "finished"
 * against a summary of itself rather than against its text.
 *
 * So the plan is split into the smallest units a requirement can claim, and
 * every unit must be claimed by exactly one group in
 * `docs/plans/spine-v2-m2-requirements.json`. Add a sentence to M2 and this
 * fails until someone classifies it. Delete one and it fails until someone
 * removes its claim. The map cannot drift from the text it describes, and it
 * cannot be made to look complete by omission — the two ways a hand-kept
 * checklist normally rots.
 *
 * It classifies. It does not prove: `CURRENT_CAMPAIGN` means "this milestone
 * owes this", not "this is done". Evidence lives in the tests each slice
 * merges, and `MERGED_PROVED` names the sources or facts that carry it.
 *
 *   node scripts/spine-v2-m2-map.js            check and print the summary
 *   node scripts/spine-v2-m2-map.js --write    also regenerate the Markdown map
 *
 * Exit codes: 0 the map covers the section exactly, 1 it does not.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const planPath = join(root, 'docs', 'plans', 'production-spine-v2-postgresql.md');
const dataPath = join(root, 'docs', 'plans', 'spine-v2-m2-requirements.json');
const outPath = join(root, 'docs', 'plans', 'spine-v2-m2-requirement-map.md');

const CLASSIFICATIONS = new Set([
  'MERGED_PROVED', 'CURRENT_CAMPAIGN', 'DEFERRED_OUTSIDE_M2', 'CONTRADICTION_REQUIRES_FIX',
]);

/**
 * The unit split. Sentence-level inside paragraphs, whole rows for tables,
 * headings dropped — a heading states no requirement. The 25-character floor
 * drops fragments a classification could not meaningfully attach to.
 *
 * @param {string} source
 */
export function m2Units(source) {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => line.startsWith('### M2 — '));
  const end = lines.findIndex((line, index) => index > start && line.startsWith('### M3 — '));
  if (start === -1 || end === -1) {
    throw new Error('spine-v2-m2-map: could not find the M2 section boundaries in the ratified plan.');
  }

  /** @type {{fingerprint: string, text: string}[]} */
  const units = [];
  const emit = (text) => {
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (!normalized) return;
    units.push({ fingerprint: fingerprintOf(normalized), text: normalized });
  };

  let paragraph = [];
  const flush = () => {
    if (!paragraph.length) return;
    const text = paragraph.join(' ').replace(/\s+/g, ' ').trim();
    // Every sentence terminator, not the three that happened to appear in the
    // section when this was written. A terminator the splitter does not know
    // merges two requirements into one unit, and classifying the merged unit
    // silently covers a requirement nobody read.
    if (text) for (const sentence of text.split(/(?<=[.:;?!])\s+(?=[A-Z`\-])/)) emit(sentence);
    paragraph = [];
  };

  for (const line of lines.slice(start, end)) {
    const text = line.trim();
    if (!text) { flush(); continue; }
    // Headings are emitted, not discarded. A heading that states a requirement
    // ("#### Refuse all writes in production") is a requirement, and the only
    // safe assumption about text this gate has not read is that it matters.
    if (text.startsWith('#')) { flush(); emit(text.replace(/^#+\s*/, '')); continue; }
    if (text.startsWith('|')) {
      flush();
      // A separator row is one whose every cell is dashes or empty. Testing
      // only the first cell discards a real row whose first cell is blank.
      const cells = text.split('|').slice(1, -1);
      if (cells.length && cells.every((cell) => /^[\s:-]*$/.test(cell))) continue;
      emit(text);
      continue;
    }
    paragraph.push(text.replace(/^[-*]\s+/, '').replace(/^\d+\.\s+/, ''));
  }
  flush();
  return units;
}

/** Content identity. Twelve hex is ample for a few hundred sentences and stays readable in a diff. */
export function fingerprintOf(text) {
  return createHash('sha256').update(text.replace(/\s+/g, ' ').trim(), 'utf8').digest('hex').slice(0, 12);
}

/**
 * **Positions are not identities.** An earlier cut of this gate had groups claim
 * numeric indices. Insert a requirement anywhere but the end and every later
 * index retargets a different sentence: the gate reports only the old final
 * index as unclassified, a maintainer assigns it, the gate goes green — and the
 * *inserted* requirement now carries a classification nobody chose for it. That
 * is worse than no map, because it launders an unreviewed requirement through a
 * passing gate. Claims are content fingerprints, so an edit orphans its old
 * claim and surfaces its new text, and neither can be mistaken for the other.
 *
 * @param {{fingerprint: string, text: string}[]} units
 * @param {{groups: any[]}} data
 * @returns {string[]} reasons the gate must fail
 */
export function inspectCoverage(units, data) {
  const failures = [];
  const groups = Array.isArray(data?.groups) ? data.groups : null;
  if (!groups) return ['spine-v2-m2-map: the requirements document has no `groups` array.'];

  const stated = new Map(units.map((unit) => [unit.fingerprint, unit.text]));
  /** @type {Map<string, string>} */
  const claimed = new Map();

  for (const group of groups) {
    if (!CLASSIFICATIONS.has(group.classification)) {
      failures.push(`${group.id}: unknown classification ${JSON.stringify(group.classification)}.`);
    }
    if (group.classification === 'DEFERRED_OUTSIDE_M2' && !group.provedIn) {
      failures.push(`${group.id}: deferred without naming where it is proved. A deferral that names no milestone is an omission.`);
    }
    for (const fingerprint of group.claims ?? []) {
      if (claimed.has(fingerprint)) {
        failures.push(`${fingerprint} is claimed by both ${claimed.get(fingerprint)} and ${group.id}; one requirement, one owner.`);
      }
      claimed.set(fingerprint, group.id);
      if (!stated.has(fingerprint)) {
        failures.push(
          `${group.id} claims ${fingerprint}, which the M2 section no longer states. The requirement was edited or removed: `
          + 'reclassify its new text rather than deleting the claim to make this pass.',
        );
      }
    }
  }

  for (const unit of units) {
    if (!claimed.has(unit.fingerprint)) {
      failures.push(
        `unclassified ${unit.fingerprint}: "${unit.text.slice(0, 100)}…" — the ratified plan states it and this map does `
        + 'not answer for it, so M2 cannot be called complete against this map.',
      );
    }
  }
  return failures;
}

// Importable without side effects: the tests import `m2Units` and
// `inspectCoverage`, and a module that runs a gate merely because it was
// imported cannot be tested without also being obeyed.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const planSource = readFileSync(planPath, 'utf8');
  const data = JSON.parse(readFileSync(dataPath, 'utf8'));
  const units = m2Units(planSource);
  const failures = inspectCoverage(units, data);

  if (failures.length) {
    process.stderr.write(`\n  spine-v2-m2-map: ${failures.length} problem(s).\n\n`);
    for (const failure of failures) process.stderr.write(`  - ${failure}\n`);
    process.stderr.write('\n  Classify the new text in docs/plans/spine-v2-m2-requirements.json rather than editing the ratified plan to fit the map.\n\n');
    process.exit(1);
  }

  const byClassification = {};
  for (const group of data.groups) {
    byClassification[group.classification] = (byClassification[group.classification] ?? 0) + group.claims.length;
  }

  process.stderr.write(`\n  spine-v2-m2-map — ${units.length} requirement units, ${data.groups.length} groups, every unit classified once\n\n`);
  for (const [name, count] of Object.entries(byClassification)) {
    process.stderr.write(`  ${name.padEnd(28)} ${String(count).padStart(3)}  (${Math.round((count / units.length) * 100)}%)\n`);
  }
  process.stderr.write('\n');

  if (process.argv.includes('--write')) {
    writeFileSync(outPath, render(units, data));
    process.stderr.write(`  ${outPath.slice(root.length)} written.\n\n`);
  }
}

/**
 * @param {string[]} units
 * @param {{groups: any[]}} data
 */
export function render(units, data) {
  const order = ['CONTRADICTION_REQUIRES_FIX', 'CURRENT_CAMPAIGN', 'DEFERRED_OUTSIDE_M2', 'MERGED_PROVED'];
  const lines = [
    '# Spine v2 M2 — requirement-to-evidence map',
    '',
    '**Generated by `node scripts/spine-v2-m2-map.js --write`. Do not edit by hand.**',
    'Classification lives in `docs/plans/spine-v2-m2-requirements.json`; the units come',
    'from the M2 section of `docs/plans/production-spine-v2-postgresql.md`, which is',
    'ratified and is not edited to fit this map.',
    '',
    `The M2 section states **${units.length}** requirement units. Every one is claimed by exactly`,
    'one group below — a unit nobody classifies fails the gate, so this map cannot be',
    'made to look complete by leaving something out.',
    '',
    '**What this answers and what it does not.** `CURRENT_CAMPAIGN` means the milestone',
    'owes the requirement, not that it is delivered; the tests each slice merges are the',
    'evidence. `DEFERRED_OUTSIDE_M2` must name where it is proved instead — a deferral',
    'without a destination is an omission, and the gate refuses one.',
    '',
    '| Classification | Units | Share |',
    '|---|---|---|',
  ];
  for (const name of order) {
    const count = data.groups.filter((g) => g.classification === name).reduce((n, g) => n + g.claims.length, 0);
    if (count) lines.push(`| \`${name}\` | ${count} | ${Math.round((count / units.length) * 100)}% |`);
  }
  lines.push('');
  for (const name of order) {
    const groups = data.groups.filter((group) => group.classification === name);
    if (!groups.length) continue;
    lines.push(`## ${name}`, '');
    lines.push('| Group | Slice / proved in | Units | Requirement |', '|---|---|---|---|');
    for (const group of groups) {
      lines.push(`| \`${group.id}\` | ${group.slice ?? group.provedIn ?? '—'} | ${group.claims.length} | ${group.title} |`);
    }
    lines.push('');
    for (const group of groups) {
      const why = group.reason ?? group.note;
      if (why) lines.push(`- **${group.id}** — ${why}`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}`;
}
