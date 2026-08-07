// @ts-check

/**
 * Renders the public site from templates, brand tokens and the claims ledger.
 *
 * Every page is plain HTML with `{{token}}` placeholders. There is no framework,
 * no bundler and no dependency — the same rule the runtime follows.
 *
 * The important property is not the rendering. It is that a claim about the
 * product cannot be typed into a page: `{{claim:C-03}}` pulls the sentence from
 * `site/claims.json`, where it is bound to the tests that prove it. Marketing
 * copy and evidence move together or not at all.
 *
 * Tokens:
 *   {{brand.name}} {{brand.slug}} {{brand.promise}} {{brand.domain}}
 *   {{brand.repository}} {{brand.license}} {{brand.createCommand}}
 *   {{color.accent}} … {{font.sans}} {{font.mono}}
 *   {{measured.tests}} {{measured.sha}} {{measured.date}}
 *   {{claim:C-01}}              the claim sentence
 *   {{claim:C-01.limitation}}   the limitation that must travel with it
 *   {{limitation:L-01.headline}} {{limitation:L-01.text}}
 *   {{include:partial.html}}    inlines site/partials/<name>
 *   {{year}}
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, existsSync, copyFileSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';

const root = process.cwd();
const siteDir = join(root, 'site');
const outDir = join(siteDir, 'dist');

const brand = readJson(join(siteDir, 'brand.json'));
const ledger = readJson(join(siteDir, 'claims.json'));

const claims = indexBy(ledger.claims, 'id');
const limitations = indexBy(ledger.limitations, 'id');

/** @type {Set<string>} every claim/limitation id a template actually used. */
export const used = new Set();

const unresolved = [];

if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const pages = readdirSync(join(siteDir, 'templates')).filter((name) => name.endsWith('.html'));
for (const page of pages) {
  const source = readFileSync(join(siteDir, 'templates', page), 'utf8');
  writeFileSync(join(outDir, page), render(source, page));
}

// Non-template assets are copied verbatim.
for (const asset of walk(join(siteDir, 'assets'))) {
  const target = join(outDir, relative(join(siteDir, 'assets'), asset));
  mkdirSync(dirname(target), { recursive: true });
  if (asset.endsWith('.css') || asset.endsWith('.svg') || asset.endsWith('.txt')) {
    writeFileSync(target, render(readFileSync(asset, 'utf8'), relative(siteDir, asset)));
  } else {
    copyFileSync(asset, target);
  }
}

if (unresolved.length) {
  for (const problem of unresolved) console.error(`  ${problem.file}: unresolved token {{${problem.token}}}`);
  console.error(`\nsite-build failed: ${unresolved.length} unresolved token(s).`);
  process.exit(1);
}

writeFileSync(join(outDir, '.used-claims.json'), `${JSON.stringify([...used].sort(), null, 2)}\n`);
console.log(`Site built: ${pages.length} page(s) into site/dist, ${used.size} ledger entries referenced.`);

/**
 * @param {string} source
 * @param {string} file
 * @returns {string}
 */
function render(source, file) {
  let output = source;
  // Includes first, so a partial's own tokens are resolved in the same pass.
  output = output.replace(/\{\{include:([\w.-]+)\}\}/g, (_match, name) => {
    const path = join(siteDir, 'partials', name);
    if (!existsSync(path)) {
      unresolved.push({ file, token: `include:${name}` });
      return '';
    }
    return readFileSync(path, 'utf8');
  });

  output = output.replace(/\{\{([\w.:-]+)\}\}/g, (match, token) => {
    const value = resolve(String(token));
    if (value === null) {
      unresolved.push({ file, token });
      return match;
    }
    return value;
  });

  return output;
}

/**
 * @param {string} token
 * @returns {string | null}
 */
function resolve(token) {
  if (token === 'year') return '2026';

  // Renders the whole ledger. Using this rather than hand-written blocks is what
  // makes the evidence page complete by construction: a claim added to the ledger
  // appears here without anyone remembering to add it.
  if (token === 'ledger:claims') {
    return ledger.claims.map((claim) => {
      used.add(claim.id);
      return renderLedgerRow(claim);
    }).join('\n');
  }
  if (token === 'ledger:limitations') {
    return ledger.limitations.map((limitation) => {
      used.add(limitation.id);
      return [
        '        <div class="limit-card">',
        `          <h3><span class="mono muted">${limitation.id}</span> · ${escapeHtml(limitation.headline)}</h3>`,
        `          <p>${escapeHtml(limitation.text)}</p>`,
        `          <div class="evidence">${evidenceChips(limitation.evidence)}</div>`,
        '        </div>',
      ].join('\n');
    }).join('\n');
  }

  if (token.startsWith('claim:')) {
    const [id, field] = token.slice('claim:'.length).split('.');
    const claim = claims.get(id);
    if (!claim) return null;
    used.add(id);
    if (!field) return escapeHtml(claim.text);
    if (field === 'limitation') return escapeHtml(claim.limitation);
    return null;
  }

  if (token.startsWith('limitation:')) {
    const [id, field] = token.slice('limitation:'.length).split('.');
    const limitation = limitations.get(id);
    if (!limitation) return null;
    used.add(id);
    if (field === 'headline') return escapeHtml(limitation.headline);
    if (field === 'text' || !field) return escapeHtml(limitation.text);
    return null;
  }

  const table = {
    'brand.name': brand.name.value,
    'brand.slug': brand.name.slug,
    'brand.promise': brand.promise,
    'brand.domain': brand.domain.value,
    'brand.repository': brand.repository.value,
    'brand.license': brand.license.value,
    'brand.createCommand': brand.npm.createCommand,
    'brand.nameStatus': brand.name.status,
    'font.sans': brand.typography.sans,
    'font.mono': brand.typography.mono,
    'measured.tests': String(ledger.measuredAgainst.tests),
    'measured.sha': ledger.measuredAgainst.sha,
    'measured.date': ledger.measuredAgainst.date,
  };
  if (token in table) return escapeHtml(String(table[token]));

  if (token.startsWith('color.')) {
    const key = token.slice('color.'.length);
    return key in brand.colors ? brand.colors[key] : null;
  }

  return null;
}

/**
 * One ledger entry as a table row: the claim, what proves it, and the boundary
 * that travels with it. The three are rendered together because they are only
 * true together.
 * @param {Record<string, any>} claim
 */
function renderLedgerRow(claim) {
  return [
    '          <tr>',
    `            <td><span class="mono muted">${claim.id}</span></td>`,
    `            <td>${escapeHtml(claim.text)}<p class="limit"><b>Limit</b>${escapeHtml(claim.limitation)}</p></td>`,
    `            <td><div class="evidence">${evidenceChips(claim.evidence)}</div></td>`,
    '          </tr>',
  ].join('\n');
}

/** @param {Record<string, any> | undefined} evidence */
function evidenceChips(evidence) {
  if (!evidence) return '';
  const chips = [
    ...(evidence.tests ?? []),
    ...(evidence.docs ?? []),
    ...(evidence.repoFacts ?? []),
  ];
  if (evidence.jtbd) chips.unshift(evidence.jtbd);
  return chips.map((chip) => `<code>${escapeHtml(chip)}</code>`).join('');
}

/** @param {string} value */
function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** @param {string} path */
function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * @param {Array<Record<string, any>>} items
 * @param {string} key
 */
function indexBy(items, key) {
  return new Map(items.map((item) => [item[key], item]));
}

/** @param {string} directory */
function walk(directory) {
  if (!existsSync(directory)) return [];
  const results = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) results.push(...walk(path));
    else results.push(path);
  }
  return results;
}
