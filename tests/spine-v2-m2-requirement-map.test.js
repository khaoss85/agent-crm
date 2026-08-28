import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { m2Section, fingerprintOf, inspect, render, OWNERS } from '../scripts/spine-v2-m2-map.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (...parts) => readFileSync(join(root, ...parts), 'utf8');
const plan = read('docs', 'plans', 'production-spine-v2-postgresql.md');
const data = JSON.parse(read('docs', 'plans', 'spine-v2-m2-requirements.json'));
const section = m2Section(plan);

test('the inventory matches the section it indexes', () => {
  assert.deepEqual(inspect(section, data), []);
});

/**
 * **The one thing this gate is for.** The inventory is hand-kept prose about
 * prose; it cannot notice on its own that the ratified section moved
 * underneath it. The fingerprint is what turns that from silent staleness into
 * a failure a person has to answer, and adopting a new fingerprint is
 * deliberately a separate act from passing the check.
 */
test('a changed section stops the inventory from claiming to index it', () => {
  const moved = plan.replace(
    'Delete the compatibility path only after a repository guard',
    'Every production write is additionally attested. Delete the compatibility path only after a repository guard',
  );
  assert.notEqual(moved, plan, 'anchor moved; fix this fixture, not the plan');
  const failures = inspect(m2Section(moved), data);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /the ratified M2 section is [0-9a-f]{16}, but this inventory was written against/);
});

test('the inventory shape is checked', () => {
  const mutate = (fn) => ({ ...data, entries: data.entries.map((e, i) => (i === 0 ? fn(e) : e)) });

  assert.ok(inspect(section, mutate((e) => ({ ...e, id: 'nope' }))).some((f) => /is not of the form M2-01/.test(f)));
  assert.ok(inspect(section, mutate((e) => ({ ...e, owner: 'someday' }))).some((f) => /not a milestone this campaign recognises/.test(f)));
  assert.ok(inspect(section, mutate((e) => ({ ...e, title: '' }))).some((f) => /title is required/.test(f)));

  const duplicated = { ...data, entries: [...data.entries, data.entries[0]] };
  assert.ok(inspect(section, duplicated).some((f) => /used by more than one entry/.test(f)));

  const invented = mutate((e) => ({ ...e, excerpt: 'A requirement the ratified section does not state anywhere at all.' }));
  assert.ok(inspect(section, invented).some((f) => /indexes text that is not there/.test(f)));

  // The whole excerpt is checked, not a prefix: an excerpt that opens with real
  // section text and then says something else is the shape a wrong quote takes.
  const drifted = mutate((e) => ({ ...e, excerpt: `${e.excerpt} and then asserts something the section never says.` }));
  assert.ok(inspect(section, drifted).some((f) => /indexes text that is not there/.test(f)));
});

/**
 * The rendered table is Markdown, and both of these silently corrupt it rather
 * than failing: a pipe inside a reason splits its own row, and truncation cuts
 * these reasons mid-qualification — they are mostly qualifications, so the cut
 * lands exactly where the meaning is.
 */
test('rendered cells survive their own content', () => {
  const piped = {
    ...data,
    entries: [{ id: 'M2-99', title: 'a | title', owner: 'M2F', reason: 'refuses a | b | c and nothing else' }],
  };
  const rendered = render(piped, 'deadbeefdeadbeef');
  const row = rendered.split('\n').find((line) => line.includes('M2-99'));
  assert.equal(row.split(/(?<!\\)\|/).length - 2, 4, 'a pipe in a cell must not split the row');

  const long = 'x'.repeat(400);
  assert.ok(render({ ...data, entries: [{ id: 'M2-98', title: 't', owner: 'M2F', reason: long }] }, 'd').includes(long),
    'a reason must render whole; truncation drops the qualification it exists for');
});

/** `--write` adopts a fingerprint. It cannot know whether a person re-read anything. */
test('the document does not claim a reread it cannot observe', () => {
  const rendered = render(data, fingerprintOf(section));
  assert.match(rendered, /is not\s+evidence that anyone re-read anything/);
  assert.doesNotMatch(rendered, /fails until someone re-reads it/);
});

/**
 * **No owner may read as a verdict.** `merged` used to be accepted, defined as
 * "landed before this campaign" — a completion assertion sitting beside a
 * promise that this index asserts nothing is met. An owner column answers who
 * owns an area, never whether it is done, and nothing here can establish the
 * second.
 */
test('the owner vocabulary carries no completion claim', () => {
  for (const owner of OWNERS) {
    assert.doesNotMatch(owner, /merged|done|complete[d]?|proved|shipped/i,
      `${owner} reads as a verdict; owners say who owns an area, not whether it is finished`);
  }
  assert.ok(inspect(section, { ...data, entries: data.entries.map((e, i) => (i === 0 ? { ...e, owner: 'merged' } : e)) })
    .some((f) => /not a milestone this campaign recognises/.test(f)));
});

/**
 * **The rendered document must not claim more than the gate holds.** Its
 * wording said the campaign had assigned "each area of M2" — an exhaustiveness
 * claim nothing here establishes, since deleting a row fails nothing. It now
 * says what a green run actually means, and this pins that it keeps saying so.
 */
test('the rendered index disclaims exhaustiveness and completion', () => {
  const rendered = render(data, fingerprintOf(section));
  assert.match(rendered, /does not establish that\s+they are all of M2/);
  assert.match(rendered, /deleting a row from it fails nothing/);
  assert.match(rendered, /makes no\s+claim that any requirement is met/);
  assert.doesNotMatch(rendered, /each area of M2/);

  // The claim it disclaims is real: a shorter inventory still passes.
  assert.deepEqual(inspect(section, { ...data, entries: data.entries.slice(0, 5) }), []);
});

/**
 * A reason is optional, but a coerced one publishes something nobody wrote
 * while the run stays green — `[object Object]` in a document whose whole
 * claim is that its entries are well-formed.
 */
test('a reason is null or real text, never coerced', () => {
  const withReason = (reason) => ({ ...data, entries: data.entries.map((e, i) => (i === 0 ? { ...e, reason } : e)) });
  for (const bad of [{}, ['a', 'b'], 42, '', '   ', true]) {
    assert.ok(inspect(section, withReason(bad)).some((f) => /reason must be null or a non-empty string/.test(f)),
      `${JSON.stringify(bad)} must be refused`);
  }
  assert.deepEqual(inspect(section, withReason(null)), []);
  assert.deepEqual(inspect(section, withReason('a real reason')), []);
});

/**
 * The script's own header is where a maintainer reads the contract, and it
 * promised two things the gate cannot deliver: that a changed fingerprint makes
 * a person re-read, and that every entry carries a reason. Ten do not.
 */
test('the script header promises only what the gate checks', () => {
  const header = readFileSync(join(root, 'scripts', 'spine-v2-m2-map.js'), 'utf8').slice(0, 2600);
  assert.match(header, /not evidence anyone re-read anything/);
  assert.match(header, /a reason is optional/);
  assert.doesNotMatch(header, /a person re-reads/);
  assert.ok(data.entries.some((e) => e.reason === null), 'the optional-reason claim must describe the real inventory');
});

/** Every owner in the inventory is one the script publishes, so the two cannot drift apart. */
test('owners come from the published list', () => {
  for (const entry of data.entries) assert.ok(OWNERS.includes(entry.owner), `${entry.id}: ${entry.owner}`);
});

test('the published index matches what the inventory renders', () => {
  assert.equal(read('docs', 'plans', 'spine-v2-m2-requirement-map.md'), render(data, fingerprintOf(section)));
});
