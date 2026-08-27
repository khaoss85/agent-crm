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
import { fileURLToPath } from 'node:url';
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
  const units = [];
  let paragraph = [];
  const flush = () => {
    if (!paragraph.length) return;
    const text = paragraph.join(' ').replace(/\s+/g, ' ').trim();
    if (text) {
      for (const sentence of text.split(/(?<=[.:;])\s+(?=[A-Z`\-])/)) {
        const unit = sentence.trim();
        if (unit.length > 25) units.push(unit);
      }
    }
    paragraph = [];
  };
  for (const line of lines.slice(start, end)) {
    const text = line.trim();
    if (!text) { flush(); continue; }
    if (text.startsWith('#')) { flush(); continue; }
    if (text.startsWith('|')) {
      flush();
      if (text.length > 25 && !/^\|[\s-]*\|/.test(text)) units.push(text);
      continue;
    }
    paragraph.push(text.replace(/^[-*]\s+/, '').replace(/^\d+\.\s+/, ''));
  }
  flush();
  return units;
}

/**
 * @param {string[]} units
 * @param {{groups: any[]}} data
 * @returns {string[]} reasons the gate must fail
 */
export function inspectCoverage(units, data) {
  const failures = [];
  const groups = Array.isArray(data?.groups) ? data.groups : null;
  if (!groups) return ['spine-v2-m2-map: the requirements document has no `groups` array.'];

  /** @type {Map<number, string>} */
  const claimed = new Map();
  for (const group of groups) {
    if (!CLASSIFICATIONS.has(group.classification)) {
      failures.push(`${group.id}: unknown classification ${JSON.stringify(group.classification)}.`);
    }
    if (group.classification === 'DEFERRED_OUTSIDE_M2' && !group.provedIn) {
      failures.push(`${group.id}: deferred without naming where it is proved. A deferral that names no milestone is an omission.`);
    }
    for (const index of group.units ?? []) {
      if (claimed.has(index)) {
        failures.push(`unit ${index} is claimed by both ${claimed.get(index)} and ${group.id}; one requirement, one owner.`);
      }
      claimed.set(index, group.id);
    }
  }

  for (let index = 0; index < units.length; index += 1) {
    if (!claimed.has(index)) {
      failures.push(
        `unit ${index} is unclassified: "${units[index].slice(0, 90)}…". The ratified plan states it and this map does `
        + 'not answer for it, so M2 cannot be called complete against this map.',
      );
    }
  }
  for (const index of claimed.keys()) {
    if (index >= units.length) {
      failures.push(`${claimed.get(index)} claims unit ${index}, past the ${units.length} the plan states; the section moved under the map.`);
    }
  }
  return failures;
}

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
  byClassification[group.classification] = (byClassification[group.classification] ?? 0) + group.units.length;
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

/**
 * @param {string[]} units
 * @param {{groups: any[]}} data
 */
function render(units, data) {
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
    const count = data.groups.filter((g) => g.classification === name).reduce((n, g) => n + g.units.length, 0);
    if (count) lines.push(`| \`${name}\` | ${count} | ${Math.round((count / units.length) * 100)}% |`);
  }
  lines.push('');
  for (const name of order) {
    const groups = data.groups.filter((group) => group.classification === name);
    if (!groups.length) continue;
    lines.push(`## ${name}`, '');
    lines.push('| Group | Slice / proved in | Units | Requirement |', '|---|---|---|---|');
    for (const group of groups) {
      lines.push(`| \`${group.id}\` | ${group.slice ?? group.provedIn ?? '—'} | ${group.units.length} | ${group.title} |`);
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
