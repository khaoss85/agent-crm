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
 *   5. no built page contains an overclaim this project cannot support today.
 *
 * Run: npm run site:check   (site:build runs first — it fails on unresolved tokens)
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, relative } from 'node:path';

const root = process.cwd();
const siteDir = join(root, 'site');
const outDir = join(siteDir, 'dist');

const failures = [];
const notes = [];

const ledger = JSON.parse(readFileSync(join(siteDir, 'claims.json'), 'utf8'));
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

// The measurement block must name the commit it was taken against.
if (!/^[0-9a-f]{7,40}$/.test(String(ledger.measuredAgainst?.sha ?? ''))) {
  fail('claims.json measuredAgainst.sha is not a commit SHA');
}

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

// ---------------------------------------------------------------- 3c. ledger freshness

const headSha = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout?.trim();
const ledgerSha = String(ledger.measuredAgainst?.sha ?? '');
if (headSha && ledgerSha) {
  if (headSha.startsWith(ledgerSha)) {
    notes.push('The ledger was measured against HEAD.');
  } else {
    const known = spawnSync('git', ['cat-file', '-e', `${ledgerSha}^{commit}`], { encoding: 'utf8' });
    if (known.status !== 0) {
      fail(`claims.json measuredAgainst.sha ${ledgerSha} is not a commit in this repository`);
    } else {
      const behind = spawnSync('git', ['rev-list', '--count', `${ledgerSha}..HEAD`], { encoding: 'utf8' }).stdout?.trim();
      notes.push(`The ledger was measured ${behind} commit(s) ago at ${ledgerSha}. Re-run npm run verify and update measuredAgainst before publishing anything.`);
    }
  }
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
  { pattern: /\bproduction[-\s]ready\b/i, why: 'there is no authentication, tenancy or RBAC (L-01)' },
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
for (const path of built) {
  const text = readFileSync(path, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
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
