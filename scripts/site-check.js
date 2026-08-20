// @ts-check

/**
 * The gate that keeps marketing copy honest.
 *
 * `docs/QUALITY_GATES.md` requires that every claim in a doc, an ADR, a PR body
 * or a JTBD row trace to a merged test, with the limitation stated in the same
 * breath. A landing page is the one surface where that rule is easiest to break
 * and most expensive to break. This script applies the same standard mechanically:
 *
 *   1. every claim carries evidence, and every file that evidence names exists;
 *   2. every claim carries a limitation — a capability with no stated boundary fails;
 *   3. every claim promised to a surface is actually used on it, and nothing
 *      unledgered is asserted in its place;
 *   4. no template hardcodes a brand name, domain or package scope, because none
 *      of those has been decided (docs/strategy/BRAND_REQUIREMENTS.md);
 *   5. no built page contains an overclaim this project cannot support today;
 *   6. the measurement every public number resolves from is traceable to a commit
 *      this checkout descends from, and no surface types a count of its own.
 *
 * Run: npm run site:check   (site:build runs first — it fails on unresolved tokens)
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import {
  inspectProvenance,
  findLooseTestCounts,
  inspectStatusMeasurement,
  scansForLooseCounts,
} from './measurement.js';

const root = process.cwd();
const siteDir = join(root, 'site');
const outDir = join(siteDir, 'dist');

const failures = [];
const notes = [];

const ledger = JSON.parse(readFileSync(join(siteDir, 'claims.json'), 'utf8'));
const answersPath = join(root, 'site', 'answers.json');
const answers = existsSync(answersPath) ? JSON.parse(readFileSync(answersPath, 'utf8')) : null;
const brand = JSON.parse(readFileSync(join(siteDir, 'brand.json'), 'utf8'));

// ---------------------------------------------------------------- 1 & 2. ledger integrity

const seen = new Set();
for (const claim of ledger.claims) {
  const where = `claims.json ${claim.id}`;
  if (seen.has(claim.id)) fail(`${where}: duplicate id`);
  seen.add(claim.id);

  if (!claim.text || claim.text.length < 20) fail(`${where}: missing or trivial text`);
  if (!claim.limitation || claim.limitation.length < 20) {
    fail(`${where}: no limitation. A capability and its limitation are stated in the same breath (AGENTS.md).`);
  }
  if (!claim.evidence) {
    fail(`${where}: no evidence`);
    continue;
  }
  const { tests = [], docs = [], repoFacts = [] } = claim.evidence;
  if (tests.length === 0 && repoFacts.length === 0) {
    fail(`${where}: evidence names no test and no repo fact. A claim proven only by prose is not proven.`);
  }
  for (const path of [...tests, ...docs]) {
    if (!existsSync(join(root, path))) fail(`${where}: evidence file does not exist — ${path}`);
  }
  if (tests.length === 0) notes.push(`${claim.id} rests on repo facts rather than a test — verify by hand before publishing.`);
}

for (const limitation of ledger.limitations) {
  const where = `claims.json ${limitation.id}`;
  if (!limitation.headline || !limitation.text) fail(`${where}: a limitation needs both a headline and a text`);
  for (const path of [...(limitation.evidence?.docs ?? [])]) {
    if (!existsSync(join(root, path))) fail(`${where}: evidence file does not exist — ${path}`);
  }
}

// The measurement block must name the commit it was taken against. §3c checks that the
// commit is real, is one this checkout descends from, and carries the corpus recorded
// beside it — three different failures that used to be one sentence.

// ---------------------------------------------------------------- 3. surface coverage

const templates = collect(join(siteDir, 'templates'), '.html').concat(collect(join(siteDir, 'partials'), '.html'));
const templateSource = templates.map((path) => readFileSync(path, 'utf8')).join('\n');

// A page may render the whole ledger at once, which covers every entry by construction.
const rendersWholeLedger = {
  claims: templateSource.includes('{{ledger:claims}}'),
  limitations: templateSource.includes('{{ledger:limitations}}'),
};

for (const entry of [...ledger.claims, ...ledger.limitations]) {
  if (!entry.surfaces?.includes('site')) continue;
  const isClaim = ledger.claims.includes(entry);
  if (isClaim ? rendersWholeLedger.claims : rendersWholeLedger.limitations) continue;
  const referenced = templateSource.includes(`{{claim:${entry.id}}}`)
    || templateSource.includes(`{{claim:${entry.id}.`)
    || templateSource.includes(`{{limitation:${entry.id}`);
  if (!referenced) {
    fail(`claims.json ${entry.id}: declared for the site surface but no template references it. Use it or drop the surface.`);
  }
}

// ---------------------------------------------------------------- 3b. the other surfaces
//
// A ledger entry declares the surfaces it is promised to. Enforcing only the site
// surface left `readme` and `launch` as decoration — a claim could name README.md
// and never appear there, which is the exact rot the ledger exists to prevent.
//
// The two surfaces are checked differently because they fail differently. A README
// paraphrases, so demanding its sentences match the ledger verbatim would be
// unusable; what must not drift is the *evidence*, so a readme-surface claim has to
// cite at least one of the test files the ledger names. A limitation has no
// paraphrase licence at all — its headline is the whole point — so that is matched
// literally. A launch-surface entry must be addressed by id in the launch packet,
// where copy is written per channel and cannot be diffed textually.

const readmePath = join(root, 'README.md');
const readme = existsSync(readmePath) ? readFileSync(readmePath, 'utf8') : '';
if (!readme) fail('README.md is missing — claims declare it as a surface');

for (const claim of ledger.claims) {
  if (!claim.surfaces?.includes('readme')) continue;
  const tests = claim.evidence?.tests ?? [];
  if (tests.length === 0) continue;
  if (!tests.some((path) => readme.includes(path))) {
    fail(
      `claims.json ${claim.id}: declared for the readme surface, but README.md cites none of its `
      + `evidence (${tests.join(', ')}). Either the claim is not actually made there, or it is made `
      + 'without its proof.',
    );
  }
}

// ---------------------------------------------- the test count lives in exactly one place
//
// The previous rule here was "every surface that quotes a count must quote the measured one".
// It was the right instinct and the wrong shape: it made every merge that adds a test a
// four-file edit, so the surfaces drifted anyway — README said 793, the ledger said 701,
// the strategy notes said 373, all in the same tree. Coupling four copies is not how you
// stop copies drifting; having one copy is.
//
// So a count is now a *derived* value, exactly like the brand name. Authored copy states it
// as `{{measured.tests}}` and `scripts/site-build.js` resolves it from the measurement
// record; copy that cannot carry a token — a README, a JSON answer served raw to a machine —
// says what the gate proves instead of how many tests it ran. Stable public sentences stop
// moving; the one number that does move lives in the record, which §3c makes provable.

const countSurfaces = [
  ['README.md', readme],
  ...['answers.json', 'concepts.json', 'compare.json', 'capabilities.json', 'tools.json']
    .map((name) => [`site/${name}`, existsSync(join(siteDir, name)) ? readFileSync(join(siteDir, name), 'utf8') : ''])
    .filter(([, source]) => source),
  // Every document under docs/, not only docs/marketing/. The site surfaces were already
  // broad; docs/ was the hole, and it was the expensive one — docs/PROJECT_STATUS.md is the
  // file AGENTS.md orders every agent to trust, and it typed a stale count for months with
  // nothing watching. `scansForLooseCounts` exempts a short, named list of dated-history
  // documents whose numbers are stamps rather than claims (scripts/measurement.js).
  ...collect(join(root, 'docs'), '.md')
    .map((path) => relative(root, path).split(sep).join('/'))
    .filter((path) => scansForLooseCounts(path))
    .map((path) => [path, readFileSync(join(root, path), 'utf8')]),
  ...templates.map((path) => [relative(root, path), readFileSync(path, 'utf8')]),
  // The two other root documents an agent is told to read as current truth.
  ...['AGENTS.md', 'TASKS.md']
    .filter((name) => existsSync(join(root, name)))
    .map((name) => [name, readFileSync(join(root, name), 'utf8')]),
];

// The ledger's own prose is copy too — C-20 opened with the number, which is why the claim
// had to be rewritten on every merge. The measurement block is deliberately not scanned:
// it is the one place the number belongs.
countSurfaces.push(['site/claims.json (claim and limitation text)', [
  ...ledger.claims.flatMap((/** @type {any} */ claim) => [claim.text, claim.limitation, ...(claim.evidence?.repoFacts ?? [])]),
  ...ledger.limitations.flatMap((/** @type {any} */ limitation) => [limitation.headline, limitation.text, ...(limitation.evidence?.repoFacts ?? [])]),
].join('\n')]);

for (const [label, source] of countSurfaces) {
  for (const { line, phrase } of findLooseTestCounts(String(source))) {
    fail(
      `${label}:${line}: types the literal "${phrase}". A test count is measured, not written — it is stale the `
      + 'next time anyone adds a test. Write `{{measured.tests}}` where the build resolves tokens, or say what '
      + 'the verification gate proves instead of how many tests it ran. The measured number lives in '
      + 'claims.json measuredAgainst and nowhere else.',
    );
  }
}

for (const limitation of ledger.limitations) {
  if (!limitation.surfaces?.includes('readme')) continue;
  if (!readme.includes(limitation.headline)) {
    fail(`claims.json ${limitation.id}: declared for the readme surface, but README.md does not contain its headline verbatim — "${limitation.headline}"`);
  }
}

const launchDir = join(root, 'docs', 'marketing');
const launchSource = collect(launchDir, '.md').map((path) => readFileSync(path, 'utf8')).join('\n');
for (const entry of [...ledger.claims, ...ledger.limitations]) {
  if (!entry.surfaces?.includes('launch')) continue;
  if (!launchSource.includes(entry.id)) {
    fail(`claims.json ${entry.id}: declared for the launch surface, but no document under docs/marketing/ references it by id`);
  }
}

// ---------------------------------------------------------------- 3c. measurement provenance
//
// Every public number on this site resolves from one `measuredAgainst` block, so the block is
// the thing that has to be provable. The old check ran `git cat-file -e <sha>` — object
// existence — which answered the wrong question in both directions. It passed a commit pushed
// to an unrelated branch, because that object exists in the same store; and it failed every
// honest historical measurement under `actions/checkout`'s default `fetch-depth: 1`, where no
// commit but HEAD has been fetched, reporting "not a commit in this repository" about a commit
// that plainly is one. Three open pull requests were red for that reason.
//
// `inspectProvenance` separates them: missing, present-but-not-an-ancestor, facts that do not
// match the named tree — and, when the checkout is shallow, refuses to answer rather than
// guessing, because a truncated commit graph cannot tell "never here" from "not fetched".
// See scripts/measurement.js, and .github/workflows/ci.yml which gives that job full history.

const provenance = inspectProvenance(ledger.measuredAgainst, { cwd: root });
for (const failure of provenance.failures) fail(failure);
for (const note of provenance.notes) notes.push(note);

// ---------------------------------------------------------------- 3d. the status file cites the ledger
//
// `docs/PROJECT_STATUS.md` is the narrative half of the same fact, and AGENTS.md §12 orders
// every agent to read it for what is true today. It used to own a SHA and a test count of its
// own; both went stale, and a test pinned them there, so the most-trusted document in the
// repository was also the most confidently wrong one. It now states no count and *cites* the
// ledger's commit, and this is the string comparison that keeps the citation honest. Narrow on
// purpose: it reads one table row and no prose. docs/QUALITY_GATES.md §6 states what it does
// not check.

const statusPath = join(root, 'docs', 'PROJECT_STATUS.md');
if (existsSync(statusPath)) {
  for (const failure of inspectStatusMeasurement(readFileSync(statusPath, 'utf8'), ledger.measuredAgainst)) {
    fail(failure);
  }
} else {
  fail('docs/PROJECT_STATUS.md is missing — AGENTS.md tells every agent to read it for what is true today.');
}

// ---------------------------------------------------------------- 4. no hardcoded brand

const brandLeaks = [
  { pattern: /agent[-\s]?crm/i, why: 'the working title — use {{brand.name}} or {{brand.slug}}' },
  { pattern: /\bhttps?:\/\/(?!localhost)[\w.-]*(?:\.dev|\.com|\.io|\.ai)\b/i, why: 'an absolute external URL — routed through brand.json, or it survives the rename by accident' },
  { pattern: /\baccordo|pactio|vinculo|relato\b/i, why: 'a shortlisted name that has not been chosen' },
];
// Text assets are authored copy too, so they are held to the same rule.
const authored = templates.concat(collect(join(siteDir, 'assets'), '.txt'), collect(join(siteDir, 'assets'), '.svg'));
for (const path of authored) {
  const source = readFileSync(path, 'utf8');
  for (const line of source.split('\n')) {
    // Token references are exempt: they are the sanctioned way to say these things.
    const stripped = line.replace(/\{\{[^}]+\}\}/g, '');
    for (const leak of brandLeaks) {
      if (leak.pattern.test(stripped)) {
        fail(`${relative(root, path)}: hardcodes ${leak.why}\n      ${line.trim().slice(0, 120)}`);
      }
    }
  }
}

// ---------------------------------------------------------------- 5. overclaim guard

const overclaims = [
  { pattern: /\bproduction[-\s]ready\b/i, why: 'there is no authentication ships, and a deployment must supply the verifier (L-01)' },
  { pattern: /\benterprise[-\s]grade\b/i, why: 'unfalsifiable, and the production spine does not exist' },
  { pattern: /\b(soc\s?2|iso\s?27001|hipaa|gdpr[-\s]compliant)\b/i, why: 'no compliance posture exists or has been assessed' },
  { pattern: /\bbank[-\s]grade\b/i, why: 'unfalsifiable' },
  { pattern: /\b(fastest|best|leading|world[-\s]class|revolutionary|game[-\s]chang)/i, why: 'unfalsifiable superlative' },
  { pattern: /\bguarantee[sd]?\b/i, why: 'nothing here is guaranteed, least of all model behaviour' },
  { pattern: /\b\d{1,3}(\.\d+)?%\s*(success|SABR|build rate|pass rate)/i, why: 'the benchmark has not been run (L-03)' },
  { pattern: /\bfully autonomous\b/i, why: 'human approval is the product; autonomy is not the pitch' },
  { pattern: /\breplaces? salesforce\b/i, why: 'explicitly not the positioning (PRODUCT.md)' },
  { pattern: /\bzero[-\s]config\b/i, why: 'you write manifests and policies; that is configuration' },
  { pattern: /\btrusted by\b/i, why: 'there are no users to cite' },
];
const built = collect(outDir, '.html').concat(collect(outDir, '.txt'));
if (built.length === 0) fail('site/dist is empty — run npm run site:build first');

// The page that publishes the questions this project refuses to answer quotes them verbatim, and
// several contain the exact phrases these patterns exist to catch. The quotation is scrubbed before
// the scan — and the scrubbing is itself constrained: every quoted question must appear verbatim in
// site/answers.json's refused list, so the only thing this exemption can ever hide is a sentence
// already published as one we will not make.
const refusedQuestions = new Set((answers?.refused ?? []).map((/** @type {any} */ entry) => entry.question));
const QUOTED_QUESTION = /<h3 class="refused-question">([\s\S]*?)<\/h3>/g;

for (const path of built) {
  const raw = readFileSync(path, 'utf8').replace(/<!--[\s\S]*?-->/g, '');

  for (const match of raw.matchAll(QUOTED_QUESTION)) {
    const quoted = unescapeHtml(match[1].trim());
    if (!refusedQuestions.has(quoted)) {
      fail(`${relative(root, path)}: a refused-question block quotes "${quoted}", which is not in site/answers.json. That markup exempts its text from the overclaim scan, so it may only hold a published refusal.`);
    }
  }

  const text = raw.replace(QUOTED_QUESTION, '');
  for (const claim of overclaims) {
    const match = text.match(claim.pattern);
    if (match) fail(`${relative(root, path)}: overclaim "${match[0]}" — ${claim.why}`);
  }
}

// A built page that mentions a capability must not omit the limitation block.
for (const path of collect(outDir, '.html')) {
  const text = readFileSync(path, 'utf8');
  if (!text.includes('id="limits"') && !text.includes('data-limits')) {
    notes.push(`${relative(root, path)} carries no limitations block — confirm that is deliberate.`);
  }
}

// ---------------------------------------------- the indexing gate, end to end
//
// This runs on Vercel now, so it is the last thing between a wrong indexing directive and a live
// page. The meta tag alone cannot cover llms.txt, llms-full.txt, jobs.json or sitemap.xml — plain
// text and JSON carry no meta tags — so the visibility decision has to be enforced in two places
// that must never disagree: brand.json, and the X-Robots-Tag header in vercel.json.

const shouldIndex = brand.repository.status === 'public';
const expectedRobots = shouldIndex ? 'index, follow' : 'noindex, nofollow';

for (const path of collect(outDir, '.html')) {
  const text = readFileSync(path, 'utf8');
  const label = relative(root, path);
  const robots = /<meta\s+name="robots"\s+content="([^"]*)"/.exec(text)?.[1];
  if (robots !== expectedRobots) {
    fail(`${label}: robots is "${robots ?? 'absent'}" but brand.json says the repository is ${brand.repository.status}, which means "${expectedRobots}".`);
  }
  if (!/<link rel="canonical" href="https:\/\//.test(text)) {
    fail(`${label}: no absolute rel=canonical. Two URLs serve this page and neither is declared primary.`);
  }
}

const vercelPath = join(root, 'vercel.json');
if (existsSync(vercelPath)) {
  const vercel = JSON.parse(readFileSync(vercelPath, 'utf8'));
  const entries = vercel.headers ?? [];

  // Every entry, not just the catch-all, and the VALUE, not just the key.
  //
  // An adversarial review broke the first version of this check twice by mutation: it set the
  // catch-all's value to `index, follow` (the check only tested that a header named X-Robots-Tag
  // existed) and it put an affirmative directive on the five entries for llms.txt, jobs.json,
  // answers.json and sitemap.xml — the exact files that cannot carry a meta tag, and the entire
  // reason the header exists. Both mutations passed green. Selecting one entry by an exact source
  // string, and asserting presence rather than content, is how a gate ends up guarding nothing.
  const directives = entries.flatMap((/** @type {any} */ entry) => (entry.headers ?? [])
    .filter((/** @type {any} */ item) => String(item.key).toLowerCase() === 'x-robots-tag')
    .map((/** @type {any} */ item) => ({ source: entry.source, value: String(item.value) })));

  if (shouldIndex) {
    for (const directive of directives) {
      fail(`vercel.json sends X-Robots-Tag "${directive.value}" on ${directive.source} while brand.json says the repository is public. The header outranks the meta tag, so the site would stay unindexed.`);
    }
  } else {
    const uncovered = entries.filter((/** @type {any} */ entry) => !(entry.headers ?? [])
      .some((/** @type {any} */ item) => String(item.key).toLowerCase() === 'x-robots-tag'));
    for (const entry of uncovered) {
      fail(`vercel.json headers entry "${entry.source}" carries no X-Robots-Tag. Whether Vercel merges overlapping entries or applies only the first is not verifiable from here, so every entry must carry the directive for the outcome to be the same either way.`);
    }
    for (const directive of directives) {
      if (!/\bnoindex\b/i.test(directive.value)) {
        fail(`vercel.json sends X-Robots-Tag "${directive.value}" on ${directive.source}, which does not refuse indexing, while brand.json says the repository is private.`);
      }
    }
    if (directives.length === 0) {
      fail('vercel.json sends no X-Robots-Tag at all while brand.json says the repository is private. llms.txt, jobs.json, answers.json and sitemap.xml would be indexable while every HTML page asks not to be.');
    }
  }

  if (!/site:check/.test(String(vercel.buildCommand ?? ''))) {
    fail('vercel.json buildCommand does not run the claims gate, so a claim that loses its evidence would reach a visitor even though CI caught it.');
  }
} else if (shouldIndex) {
  notes.push('vercel.json is absent, so the deployment half of the indexing gate is unchecked.');
} else {
  // Degrading this to a note meant the deployment half of the gate could vanish and the build
  // would still go green, with five files that carry no meta tag left wholly undefended.
  fail('vercel.json is absent while brand.json says the repository is private. With no X-Robots-Tag, llms.txt, jobs.json, answers.json and sitemap.xml carry no indexing directive of any kind.');
}

// ---------------------------------------------------------------- report

if (brand.name.status !== 'chosen') {
  notes.push('brand.json: the public name is still a working title. The site is buildable, not launchable.');
}
if (brand.domain.status !== 'registered') {
  notes.push('brand.json: no domain is registered, so absolute URLs deliberately point at a reserved TLD.');
}

for (const note of notes) console.log(`note: ${note}`);

if (failures.length) {
  console.error('');
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  console.error(`\nsite-check failed: ${failures.length} problem(s).`);
  process.exitCode = 1;
} else {
  console.log(`\nsite-check passed: ${ledger.claims.length} claims and ${ledger.limitations.length} limitations, every one with evidence on disk.`);
}

/** @param {string} message */
function fail(message) {
  failures.push(message);
}

/**
 * @param {string} directory
 * @param {string} extension
 * @returns {string[]}
 */
function collect(directory, extension) {
  if (!existsSync(directory)) return [];
  const results = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) results.push(...collect(path, extension));
    else if (path.endsWith(extension)) results.push(path);
  }
  return results;
}

/** @param {string} value */
function unescapeHtml(value) {
  return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
