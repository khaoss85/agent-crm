// @ts-check

/**
 * Keeps the curated M2 inventory honest about the section it indexes.
 *
 * **What this is not.** An earlier cut of this script tokenized the ratified M2
 * prose into sentences and claimed to prove every requirement was classified.
 * It could not: prose tokenization decides what a requirement *is*, and five
 * review rounds found five different ways that decision silently dropped text —
 * a length floor, unrecognised sentence terminators, discarded headings, a
 * table row whose first cell was empty, and duplicate text collapsing into one
 * claim. Each fix introduced the next. A gate whose correctness depends on
 * parsing English is a gate that reports completeness it has not established,
 * which is the failure it existed to prevent.
 *
 * **What this is.** Two much smaller facts, both checkable:
 *
 *   1. the fingerprint of the whole ratified M2 section — if it moves, the
 *      inventory below was written against different text and a person re-reads
 *      it, which is the only honest response to prose changing;
 *   2. the inventory's own shape — every entry has a stable id, a source
 *      excerpt, an owning milestone and a reason, ids are unique, and owners
 *      are milestones this campaign recognises.
 *
 * It indexes; it does not prove. **Proof is tests, Repository Truth and
 * measurement** — nothing here asserts a requirement is met, and no reader
 * should take a green run as saying so.
 *
 *   node scripts/spine-v2-m2-map.js            check
 *   node scripts/spine-v2-m2-map.js --write    adopt the current section fingerprint and render the index
 *
 * Exit codes: 0 the inventory matches the section it indexes, 1 it does not.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const planPath = join(root, 'docs', 'plans', 'production-spine-v2-postgresql.md');
const dataPath = join(root, 'docs', 'plans', 'spine-v2-m2-requirements.json');
const outPath = join(root, 'docs', 'plans', 'spine-v2-m2-requirement-map.md');

/** Milestones an entry may be assigned to. `merged` means it landed before this campaign. */
export const OWNERS = Object.freeze([
  'merged', 'M2C/M2D/M2F', 'M2E', 'M2E-1', 'M2E/M2F', 'M2F', 'M2 completion gate', 'M3', 'M4',
]);

/** The ratified section, verbatim, between its own heading and M3's. */
export function m2Section(source) {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => line.startsWith('### M2 — '));
  const end = lines.findIndex((line, index) => index > start && line.startsWith('### M3 — '));
  if (start === -1 || end === -1) {
    throw new Error('spine-v2-m2-map: could not find the M2 section boundaries in the ratified plan.');
  }
  return lines.slice(start, end).join('\n');
}

export function fingerprintOf(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

/**
 * @param {string} section
 * @param {{section?: {fingerprint?: string}, entries?: any[]}} data
 * @returns {string[]} reasons the gate must fail
 */
export function inspect(section, data) {
  const failures = [];
  // The ratified section wraps its prose, so an excerpt taken from it will not
  // match byte for byte. Both sides are compared with whitespace collapsed,
  // which is the difference between "this text is not there" and "this text is
  // there, hard-wrapped".
  const flat = section.replace(/\s+/g, ' ');
  const entries = Array.isArray(data?.entries) ? data.entries : null;
  if (!entries) return ['spine-v2-m2-map: the inventory has no `entries` array.'];

  const actual = fingerprintOf(section);
  const recorded = data.section?.fingerprint;
  if (recorded !== actual) {
    failures.push(
      `the ratified M2 section is ${actual}, but this inventory was written against ${recorded ?? 'nothing'}. `
      + 'Re-read the section, update the entries it changed, then `--write` to adopt the new fingerprint. '
      + 'Adopting it without reading is how an index stops describing the thing it indexes.',
    );
  }

  const seen = new Set();
  for (const entry of entries) {
    const id = entry?.id;
    if (typeof id !== 'string' || !/^M2-\d{2}$/.test(id)) {
      failures.push(`entry id ${JSON.stringify(id)} is not of the form M2-01.`);
      continue;
    }
    if (seen.has(id)) failures.push(`${id} is used by more than one entry; ids are how an entry is referred to elsewhere.`);
    seen.add(id);
    for (const field of ['title', 'excerpt']) {
      if (typeof entry[field] !== 'string' || entry[field].trim() === '') {
        failures.push(`${id}: ${field} is required and must be a non-empty string.`);
      }
    }
    if (!OWNERS.includes(entry.owner)) {
      failures.push(`${id}: owner ${JSON.stringify(entry.owner)} is not a milestone this campaign recognises.`);
    }
    if (typeof entry.excerpt === 'string' && entry.excerpt.trim()
      && !flat.includes(entry.excerpt.replace(/\s+/g, ' ').trim().slice(0, 60))) {
      failures.push(`${id}: its excerpt does not appear in the ratified section, so it indexes text that is not there.`);
    }
  }
  return failures;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const section = m2Section(readFileSync(planPath, 'utf8'));
  const data = JSON.parse(readFileSync(dataPath, 'utf8'));

  if (process.argv.includes('--write')) {
    data.section = { ...data.section, fingerprint: fingerprintOf(section) };
    writeFileSync(dataPath, `${JSON.stringify(data, null, 2)}\n`);
  }

  const failures = inspect(section, data);
  if (failures.length) {
    process.stderr.write(`\n  spine-v2-m2-map: ${failures.length} problem(s).\n\n`);
    for (const failure of failures) process.stderr.write(`  - ${failure}\n`);
    process.stderr.write('\n');
    process.exit(1);
  }

  const byOwner = {};
  for (const entry of data.entries) byOwner[entry.owner] = (byOwner[entry.owner] ?? 0) + 1;
  process.stderr.write(`\n  spine-v2-m2-map — ${data.entries.length} inventory entries indexing section ${fingerprintOf(section)}\n\n`);
  for (const owner of OWNERS) if (byOwner[owner]) process.stderr.write(`  ${owner.padEnd(22)} ${byOwner[owner]}\n`);
  process.stderr.write('\n  This is an index. Proof is tests, Repository Truth and measurement.\n\n');

  if (process.argv.includes('--write')) {
    writeFileSync(outPath, render(data, fingerprintOf(section)));
    process.stderr.write(`  ${outPath.slice(root.length)} written.\n\n`);
  }
}

/** @param {{entries: any[]}} data @param {string} fingerprint */
export function render(data, fingerprint) {
  const lines = [
    '# Spine v2 M2 — requirement inventory',
    '',
    '**Generated by `node scripts/spine-v2-m2-map.js --write`. Do not edit by hand.**',
    'The entries live in `docs/plans/spine-v2-m2-requirements.json`; the section they',
    'index is the M2 part of `docs/plans/production-spine-v2-postgresql.md`, which is',
    'ratified and is not edited to fit this file.',
    '',
    `Indexing section \`${fingerprint}\`. If that fingerprint moves, the ratified text`,
    'changed and these entries were written against a different section — the gate',
    'fails until someone re-reads it.',
    '',
    '**This is an index, not a proof.** It records how the campaign has assigned each',
    'area of M2 and why. It makes no claim that any requirement is met, and a green',
    'run does not say one is: proof is tests, Repository Truth and measurement.',
    '',
    '| Id | Area | Owner | Why |',
    '|---|---|---|---|',
  ];
  for (const entry of data.entries) {
    const why = (entry.reason ?? '').replace(/\s+/g, ' ').slice(0, 200) || '—';
    lines.push(`| \`${entry.id}\` | ${entry.title} | ${entry.owner} | ${why} |`);
  }
  lines.push('');
  return lines.join('\n');
}
