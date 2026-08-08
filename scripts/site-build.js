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

import { buildJobPages, buildAnswerPages } from './site-pages.js';

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

/**
 * Where these pages will actually live. Canonical, Open Graph and the sitemap all need an
 * absolute origin, and inventing one per template is how a site ends up with three of them.
 */
const ORIGIN = `https://${brand.domain.value}`;

/**
 * Every page written to dist, in the order it was written. The sitemap is derived from this rather
 * than hand-listed, so a page that exists is a page that is listed — the same reason the evidence
 * page renders the whole ledger instead of hand-written rows.
 * @type {{path: string, title: string, description: string}[]}
 */
const emitted = [];

const repositoryIsPublic = brand.repository.status === 'public';
const jobsSource = join(root, 'docs', 'benchmarks', 'jobs.json');

/**
 * Structured data, per page, describing only things that are true right now.
 *
 * `codeRepository` follows the same rule as the primary call to action: while the repository is
 * private the URL resolves to a 404, and putting a broken link into a knowledge graph is more
 * expensive to undo than leaving the property out. Nothing here asserts an offer, a price, an
 * aggregate rating or a deployability — the page does not claim those, so the markup must not
 * either, or the structured data becomes the one surface that overclaims.
 * @type {Record<string, any[]>}
 */
const STRUCTURED_DATA = {
  'index.html': [
    {
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: brand.name.value,
      url: `${ORIGIN}/`,
      inLanguage: 'en',
    },
    {
      '@context': 'https://schema.org',
      '@type': 'SoftwareSourceCode',
      name: brand.name.value,
      description: brand.promise,
      url: `${ORIGIN}/`,
      programmingLanguage: 'JavaScript',
      runtimePlatform: 'Node.js 22',
      license: 'https://opensource.org/licenses/MIT',
      ...(repositoryIsPublic ? { codeRepository: brand.repository.value } : {}),
    },
  ],
};

const templates = readdirSync(join(siteDir, 'templates')).filter((name) => name.endsWith('.html'));
for (const page of templates) {
  const source = readFileSync(join(siteDir, 'templates', page), 'utf8');
  emit(page, render(source, page), { jsonLd: STRUCTURED_DATA[page] ?? [] });
}

// The catalogue pages. They are generated rather than written because the thing being published is
// a 149-row assessment that changes with the code — a hand-written page per job would be 63 chances
// to describe a status the matrix no longer holds.
const shell = readFileSync(join(siteDir, 'shell.html'), 'utf8');
const jobsIndex = existsSync(jobsSource) ? readJson(jobsSource) : null;
const answers = readJson(join(siteDir, 'answers.json'));

const generated = [
  ...(jobsIndex ? buildJobPages({ jobs: jobsIndex, brand, origin: ORIGIN }) : []),
  ...buildAnswerPages({ answers, ledger, brand, origin: ORIGIN }),
];
for (const page of generated) {
  const source = shell
    .replace('{{page.title}}', escapeHtml(page.title))
    .replace('{{page.description}}', escapeHtml(page.description))
    .replace('{{page.body}}', () => page.body);
  emit(page.path, render(source, page.path), { jsonLd: page.jsonLd });
}

// The same answers, machine-readable, with the ledger text resolved so a retrieval step does not
// have to fetch two documents and join them.
writeFileSync(join(outDir, 'answers.json'), `${JSON.stringify({
  answersContract: answers.answersContract,
  generatedFrom: 'site/answers.json and site/claims.json',
  questions: answers.questions.map((entry) => ({
    ...entry,
    url: `${ORIGIN}/answers/${entry.slug}.html`,
    evidence: [...entry.claims, ...entry.limitations]
      .map((id) => claims.get(id) ?? limitations.get(id))
      .filter(Boolean)
      .map((item) => ({ id: item.id, text: item.text, limitation: item.limitation ?? null, evidence: item.evidence })),
  })),
  refused: answers.refused,
}, null, 2)}\n`);

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

// The machine-readable jobs index is a first-class public artifact, not a docs
// file: an agent deciding whether to recommend this framework can fetch one URL
// and get 149 jobs with their status and evidence, including the ones we cannot
// do. It is generated by scripts/generate-jobs.js and copied, never edited here.
if (existsSync(jobsSource)) {
  copyFileSync(jobsSource, join(outDir, 'jobs.json'));
} else {
  console.error('note: docs/benchmarks/jobs.json is missing — run `npm run jobs` before publishing.');
}

// The sitemap is an inventory of what exists, so it is written either way and stays honest about
// the page set. The *instruction* to crawl it lives in robots.txt, which is where the visibility
// gate belongs — a sitemap referenced while the source is private would be asking a crawler to
// index pages whose primary link 404s.
writeFileSync(join(outDir, 'sitemap.xml'), [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  // A 404 is a status, not a destination: listing it would be asking a crawler to index the page
  // that says nothing is here.
  ...emitted
    .filter((page) => page.path !== '404.html')
    .map((page) => `  <url><loc>${escapeHtml(canonicalUrl(page.path))}</loc><lastmod>${ledger.measuredAgainst.date}</lastmod></url>`),
  '</urlset>',
  '',
].join('\n'));

// Crawling is allowed either way; *indexing* is what the visibility gate refuses.
//
// This used to be `Disallow: /` while the repository was private, which quietly defeated itself:
// a crawler that honours Disallow never fetches the page, so it never reads the `noindex` meta
// tag inside it — and a URL discovered from an external link then lands in the index as a bare
// entry that noindex is powerless to remove, because the page can never be fetched to read it.
// The pairing that delivers the stated intent is Allow + noindex: fetch it, and refuse to index
// what you found. The `noindex` arrives twice, in the meta tag here and in the `X-Robots-Tag`
// header in vercel.json — which is the only one of the two that reaches llms.txt, jobs.json and
// sitemap.xml, none of which can carry a meta tag. site-check.js refuses to let the two disagree.
writeFileSync(join(outDir, 'robots.txt'), [
  '# Indexing follows the repository\'s visibility (site/brand.json).',
  repositoryIsPublic
    ? '# The source is public, so the links on these pages resolve.'
    : '# The source is not public yet, so every link into it would 404 for a visitor. Crawling is',
  ...(repositoryIsPublic ? [] : [
    '# still allowed: a crawler has to fetch a page to read the noindex directive on it, and',
    '# X-Robots-Tag (vercel.json) refuses indexing for every byte, including the ones that',
    '# cannot carry a meta tag.',
  ]),
  '',
  'User-agent: *',
  'Allow: /',
  '',
  ...(repositoryIsPublic ? [`Sitemap: ${ORIGIN}/sitemap.xml`, ''] : [
    `# ${ORIGIN}/sitemap.xml exists and lists every page, but is deliberately not advertised`,
    '# here while the source is private: it would invite a crawl of pages this site is',
    '# simultaneously asking not to index.',
    '',
  ]),
  `# A machine-readable summary lives at /llms.txt and /llms-full.txt,`,
  `# and every CRM job with its status and evidence at /jobs.json.`,
  '',
].join('\n'));

if (unresolved.length) {
  for (const problem of unresolved) console.error(`  ${problem.file}: unresolved token {{${problem.token}}}`);
  console.error(`\nsite-build failed: ${unresolved.length} unresolved token(s).`);
  process.exit(1);
}

// A build receipt, not a published artifact. It used to be written into the output directory,
// where Vercel served it: a file nothing reads, with no content type and no cache policy,
// fetchable by anyone. It lives beside the templates now and is gitignored.
writeFileSync(join(siteDir, '.used-claims.json'), `${JSON.stringify([...used].sort(), null, 2)}\n`);
console.log(`Site built: ${emitted.length} page(s) into site/dist (${templates.length} hand-written, ${emitted.length - templates.length} generated), ${used.size} ledger entries referenced.`);

/**
 * Write one page, resolve its `{{page.seo}}` block, and record it for the sitemap.
 *
 * The SEO block is resolved *after* the page renders, not during, because it is derived from the
 * page's own `<title>` and description. Those live in the template where an author edits them; a
 * second source of truth for the same sentence is how a canonical tag ends up describing a page
 * that no longer exists.
 *
 * @param {string} path relative to dist, using forward slashes
 * @param {string} html
 * @param {{jsonLd?: any[]}} [options]
 */
function emit(path, html, options = {}) {
  const title = firstMatch(html, /<title>([\s\S]*?)<\/title>/);
  const description = firstMatch(html, /<meta\s+name="description"\s+content="([\s\S]*?)"/);

  if (!title) unresolved.push({ file: path, token: 'title (the page has no <title>)' });
  if (!description) unresolved.push({ file: path, token: 'description (the page has no meta description)' });

  const depth = path.split('/').length - 1;
  const output = html
    .replaceAll('{{page.root}}', '../'.repeat(depth))
    .replace('{{page.seo}}', () => seoBlock(path, title, description, options.jsonLd ?? []));
  if (output.includes('{{page.seo}}')) unresolved.push({ file: path, token: 'page.seo' });
  if (output.includes('{{')) unresolved.push({ file: path, token: 'a token survived the whole render' });

  const target = join(outDir, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, output);
  emitted.push({ path, title, description });
}

/**
 * Canonical, social cards and structured data for one page.
 *
 * Structured data is emitted as `application/ld+json`, which the site's own CSP
 * (`default-src 'none'` with no `script-src`) does not block — measured in headless Chromium
 * rather than assumed, because a silently dropped block would be invisible in the HTML source.
 *
 * @param {string} path @param {string} title @param {string} description @param {any[]} jsonLd
 */
function seoBlock(path, title, description, jsonLd) {
  const url = canonicalUrl(path);
  const image = `${ORIGIN}/social-preview.png`;
  const lines = [
    `  <link rel="canonical" href="${escapeHtml(url)}" />`,
    '  <meta property="og:type" content="website" />',
    `  <meta property="og:site_name" content="${escapeHtml(brand.name.value)}" />`,
    `  <meta property="og:title" content="${escapeHtml(title)}" />`,
    `  <meta property="og:description" content="${escapeHtml(description)}" />`,
    `  <meta property="og:url" content="${escapeHtml(url)}" />`,
    `  <meta property="og:image" content="${escapeHtml(image)}" />`,
    '  <meta name="twitter:card" content="summary_large_image" />',
    `  <meta name="twitter:title" content="${escapeHtml(title)}" />`,
    `  <meta name="twitter:description" content="${escapeHtml(description)}" />`,
    `  <meta name="twitter:image" content="${escapeHtml(image)}" />`,
  ];
  for (const block of jsonLd) {
    lines.push(`  <script type="application/ld+json">${jsonLdText(block)}</script>`);
  }
  return lines.join('\n');
}

/**
 * JSON-LD is data, not script, but it still sits inside a `<script>` element: a literal `</script>`
 * anywhere in a string value would end the element early and spill the rest of the graph into the
 * document. Escaping the sequence is the whole mitigation, and it is cheap.
 * @param {any} value
 */
function jsonLdText(value) {
  return JSON.stringify(value).replace(/<\/(script)/gi, '<\\/$1');
}

/** @param {string} path */
function canonicalUrl(path) {
  return path === 'index.html' ? `${ORIGIN}/` : `${ORIGIN}/${path}`;
}

/** @param {string} text @param {RegExp} pattern */
function firstMatch(text, pattern) {
  const match = pattern.exec(text);
  return match ? match[1].trim() : '';
}

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

  // Left for the post-pass in emit(), which is the only place that knows the page's own title,
  // description and path. Returning the literal token keeps it out of the unresolved list here
  // and puts it back into it if emit() ever stops substituting.
  if (token === 'page.seo') return '{{page.seo}}';

  // Same deferral, for the same reason: the prefix that walks back to the site root depends on how
  // deep the page sits, which only emit() knows. Every in-site href goes through it so a nested
  // page works both on the deployment and when the built site is opened from disk — which is how
  // scripts/site-shots.js loads it, and where a root-absolute href resolves to the filesystem root.
  if (token === 'page.root') return '{{page.root}}';

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

  // Derived tokens. The site's honesty about its own state should not depend on
  // anyone remembering to edit a template: while the repository is private, a
  // "read the source" button is a 404 with a confident label on it, and indexing
  // a page whose primary link is broken teaches answer engines the wrong thing.
  // Both flip automatically when brand.json says the repository is public.
  const derived = {
    'meta.robots': repositoryIsPublic ? 'index, follow' : 'noindex, nofollow',
    'cta.primaryHref': repositoryIsPublic ? brand.repository.value : 'evidence.html',
    'cta.primaryLabel': repositoryIsPublic ? 'Read the source' : 'See every claim and its tests',
    'cta.secondaryHref': repositoryIsPublic ? 'evidence.html' : '#limits',
    // Deliberately not conditional: the second call to action says the same thing either way.
    'cta.secondaryLabel': 'See what it can’t do yet',
    // The footer used to assert, on every page, that the licence was pending and the name a
    // working title. brand.json calls itself the single source of brand truth and recorded both
    // decisions as made; the prose had simply not been told. Both sentences are derived now.
    'status.license': brand.license.status === 'confirmed'
      ? `${brand.license.value}-licensed (ADR-021).`
      : `${brand.license.value} today, pending a final human confirmation before launch.`,
    'status.name': brand.name.status === 'chosen'
      ? `\u201c${brand.name.value}\u201d is the chosen name; the trademark screen has not been run.`
      : `\u201c${brand.name.value}\u201d is a working title, not the public name.`,
    'status.headline': repositoryIsPublic ? 'Pre-launch.' : 'Pre-launch, source not yet public.',
    'status.text': repositoryIsPublic
      ? 'Not deployable to production. This page states what the tests prove and what is missing — nothing else.'
      : 'The repository opens shortly; until it does, every source link here will not resolve for you. Not deployable to production either. This page states what the tests prove and what is missing — nothing else.',
  };
  if (token in derived) return escapeHtml(derived[token]);

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
