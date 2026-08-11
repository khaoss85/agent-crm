// @ts-check

/**
 * The head of every published page, and the indexing gate that decides whether any of it should be
 * crawled at all.
 *
 * This file exists because an audit of the site turned up the same sentence twice: the SEO surface
 * was the one public surface on a project whose whole thesis is "every public sentence is bound to
 * a merged test" that had no test behind it. A build that silently dropped the robots meta, or a
 * canonical that pointed at the wrong page, would have shipped.
 *
 * The gate is exercised **in both directions**. A test that only checks the private state proves
 * that a hardcoded `noindex` works; what has to be true is that the same one-field edit flips
 * every dependent output together. So the public state is built for real, in a temporary root, and
 * compared.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

const repo = process.cwd();
const builder = join(repo, 'scripts/site-build.js');
const brand = JSON.parse(readFileSync(join(repo, 'site/brand.json'), 'utf8'));
const ORIGIN = `https://${brand.domain.value}`;

test('the Vercel config contains no comment pseudo-field that deployment rejects', () => {
  const config = JSON.parse(readFileSync(join(repo, 'vercel.json'), 'utf8'));
  assert.equal(
    Object.hasOwn(config, '$comment'),
    false,
    'Vercel validates vercel.json against a closed schema and rejects the otherwise harmless $comment field',
  );
});

/**
 * Build the site into a throwaway root, optionally with brand.json edited first. The builder reads
 * `process.cwd()`, so a copied tree is all it takes — no flag, no injection point, and the real
 * script under test rather than a re-implementation of it.
 *
 * @param {{repositoryStatus?: string}} [options]
 */
function build(options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'accordo-site-'));
  // site/dist is build output and is deliberately not copied. Copying it raced with any other
  // suite that rebuilds the real one — the copy walked a directory the other build had just
  // deleted — which made this file pass alone and fail beside tests/site-pages.test.js.
  const source = join(repo, 'site');
  const distPath = join(source, 'dist');
  cpSync(source, join(root, 'site'), {
    recursive: true,
    filter: (from) => from !== distPath && !from.startsWith(`${distPath}/`),
  });
  mkdirSync(join(root, 'docs/benchmarks'), { recursive: true });
  if (existsSync(join(repo, 'docs/benchmarks/jobs.json'))) {
    cpSync(join(repo, 'docs/benchmarks/jobs.json'), join(root, 'docs/benchmarks/jobs.json'));
  }

  if (options.repositoryStatus) {
    const path = join(root, 'site/brand.json');
    const edited = JSON.parse(readFileSync(path, 'utf8'));
    edited.repository.status = options.repositoryStatus;
    writeFileSync(path, `${JSON.stringify(edited, null, 2)}\n`);
  }

  const run = spawnSync(process.execPath, ['--no-warnings', builder], { cwd: root, encoding: 'utf8' });
  assert.equal(run.status, 0, `site-build failed in the fixture root: ${run.stderr}`);

  const dist = join(root, 'site/dist');
  return {
    root,
    dist,
    read: (/** @type {string} */ name) => readFileSync(join(dist, name), 'utf8'),
    pages: htmlPages(dist),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** @param {string} dist */
function htmlPages(dist) {
  /** @type {string[]} */
  const found = [];
  const walk = (/** @type {string} */ directory) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith('.html')) found.push(relative(dist, path).split('\\').join('/'));
    }
  };
  walk(dist);
  return found.sort();
}

/** @param {string} html @param {string} name */
const metaContent = (html, name) => {
  const match = new RegExp(`<meta\\s+(?:name|property)="${name}"\\s+content="([^"]*)"`).exec(html);
  return match ? match[1] : null;
};

/** @param {string} html */
const canonicalOf = (html) => {
  const match = /<link rel="canonical" href="([^"]*)"/.exec(html);
  return match ? match[1] : null;
};

test('every published page carries the head a crawler and an answer engine both need', (t) => {
  const site = build();
  t.after(site.cleanup);

  assert.ok(site.pages.length >= 2, 'the site must publish at least the landing and evidence pages');

  const titles = new Map();
  const descriptions = new Map();
  const canonicals = new Map();

  for (const page of site.pages) {
    const html = site.read(page);
    const where = `${page}:`;

    assert.match(html, /<html lang="en">/, `${where} no lang attribute — a crawler cannot tell what language this is`);
    assert.match(html, /<meta charset="utf-8"/, `${where} no charset`);
    assert.ok(metaContent(html, 'viewport'), `${where} no viewport`);
    assert.ok(metaContent(html, 'theme-color'), `${where} no theme-color`);

    const title = /<title>([\s\S]*?)<\/title>/.exec(html)?.[1]?.trim();
    assert.ok(title, `${where} no <title>`);
    assert.ok(title.length <= 70, `${where} title is ${title.length} characters; a search result truncates near 60`);
    assert.equal(titles.get(title), undefined, `${where} shares its title with ${titles.get(title)} — two pages claiming to be the same page`);
    titles.set(title, page);

    const description = metaContent(html, 'description');
    assert.ok(description, `${where} no meta description`);
    assert.ok(description.length >= 50, `${where} description is ${description.length} characters, too short to be a summary`);
    assert.equal(descriptions.get(description), undefined, `${where} shares its description with ${descriptions.get(description)}`);
    descriptions.set(description, page);

    const canonical = canonicalOf(html);
    assert.ok(canonical, `${where} no rel=canonical — /evidence and /evidence.html both return 200`);
    assert.ok(canonical.startsWith(`${ORIGIN}/`), `${where} canonical "${canonical}" is not absolute against ${ORIGIN}`);
    assert.equal(canonicals.get(canonical), undefined, `${where} shares a canonical with ${canonicals.get(canonical)}`);
    canonicals.set(canonical, page);

    // Self-referencing: a canonical that points anywhere else is a page asking to be dropped.
    const expected = page === 'index.html' ? `${ORIGIN}/` : `${ORIGIN}/${page}`;
    assert.equal(canonical, expected, `${where} canonical does not point at this page`);

    for (const property of ['og:title', 'og:description', 'og:url', 'og:image', 'og:type', 'og:site_name']) {
      assert.ok(metaContent(html, property), `${where} no ${property} — a shared link renders as a bare URL`);
    }
    assert.equal(metaContent(html, 'og:url'), canonical, `${where} og:url and canonical disagree`);
    assert.equal(metaContent(html, 'twitter:card'), 'summary_large_image');
    for (const property of ['twitter:title', 'twitter:description', 'twitter:image']) {
      assert.ok(metaContent(html, property), `${where} no ${property}`);
    }

    // The social image has to be a raster that unfurlers actually render, and it has to exist.
    const image = metaContent(html, 'og:image');
    assert.match(image, /\.png$/, `${where} og:image is not a PNG — SVG is not honoured by the major unfurlers`);
    assert.ok(existsSync(join(site.dist, image.slice(ORIGIN.length + 1))), `${where} og:image ${image} is not published`);

    assert.ok(!html.includes('{{'), `${where} an unresolved template token reached the output`);
  }
});

test('structured data parses, and asserts nothing the page does not', (t) => {
  const site = build();
  t.after(site.cleanup);

  const home = site.read('index.html');
  const blocks = [...home.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map((match) => JSON.parse(match[1]));

  assert.ok(blocks.length >= 2, 'the landing page publishes structured data');
  const types = blocks.map((block) => block['@type']);
  assert.ok(types.includes('SoftwareSourceCode'), 'the thing being described is source code, and says so');
  assert.ok(types.includes('WebSite'));

  for (const block of blocks) {
    assert.equal(block['@context'], 'https://schema.org');
    // The markup must not become the one surface that overclaims: this is not a product with a
    // price, a rating or a download, and nothing here may imply it is deployable.
    for (const forbidden of ['offers', 'aggregateRating', 'review', 'downloadUrl', 'installUrl']) {
      assert.equal(block[forbidden], undefined, `structured data asserts ${forbidden}, which no page on this site claims`);
    }
  }

  const source = blocks.find((block) => block['@type'] === 'SoftwareSourceCode');
  assert.equal(source.license, 'https://opensource.org/licenses/MIT');
  // Branching on the actual status rather than hardcoding today's: the flip to public has to be
  // completable with a green suite, or the cheapest way to go green again is to delete the
  // behaviour that made it red.
  assert.equal(
    source.codeRepository,
    brand.repository.status === 'public' ? brand.repository.value : undefined,
    'while the repository is private its URL 404s, and a broken link in a knowledge graph is expensive to undo',
  );
});

test('the sitemap lists exactly the pages that were built', (t) => {
  const site = build();
  t.after(site.cleanup);

  const sitemap = site.read('sitemap.xml');
  assert.match(sitemap, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(sitemap, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);

  const listed = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]).sort();
  const expected = site.pages
    // A 404 is a status, not a destination.
    .filter((page) => page !== '404.html')
    .map((page) => (page === 'index.html' ? `${ORIGIN}/` : `${ORIGIN}/${page}`))
    .sort();
  assert.deepEqual(listed, expected, 'the sitemap and the built page set have to be the same set');
  assert.ok(listed.length > 50, 'the catalogue pages are generated, so the sitemap should be large');
  assert.equal(new Set(listed).size, listed.length, 'a URL listed twice is a crawl budget spent twice');

  for (const location of listed) {
    assert.ok(location.startsWith('https://'), `sitemap entry ${location} is not an absolute https URL`);
  }
});

test('the first article is discoverable by both people and coding agents', (t) => {
  const site = build();
  t.after(site.cleanup);
  const slug = 'if-a-coding-agent-builds-your-crm-what-should-it-refuse-to-do';
  const title = 'If a coding agent builds your CRM, what should it refuse to do?';

  assert.ok(site.pages.includes(`blog/${slug}.html`), 'the canonical article was built');
  const index = site.read('blog.html');
  assert.match(index, new RegExp(`href="blog/${slug}\\.html"`));
  assert.match(index, /<h1>Writing grounded in evidence\.<\/h1>/);
  assert.doesNotMatch(index, /<h1>The engine ships; the blog ships empty\.<\/h1>/,
    'the populated index must not keep presenting the original empty state');
  const article = site.read(`blog/${slug}.html`);
  const structured = [...article.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map((match) => JSON.parse(match[1]));
  const posting = structured.find((block) => block['@type'] === 'BlogPosting');
  assert.ok(posting, 'the canonical article identifies itself as a BlogPosting');
  assert.equal(posting.headline, title);
  assert.equal(posting.datePublished, '2026-08-09');
  assert.equal(posting.author?.name, 'Daniele Pelleri');
  assert.equal(posting.url, `${ORIGIN}/blog/${slug}.html`);
  const llmsEntry = `[${title}](blog/${slug}.html)`;
  assert.ok(site.read('llms.txt').includes(llmsEntry), 'the short retrieval surface links the canonical article');
  assert.ok(site.read('llms-full.txt').includes(llmsEntry), 'the full retrieval surface links the canonical article');
  assert.doesNotMatch(readFileSync(join(repo, 'site/partials/footer.html'), 'utf8'), /zero posts/i,
    'the shared footer must not describe the old empty state after the first post ships');
});

test('the agent-native CRM framework intent reuses one canonical search identity', (t) => {
  const site = build();
  t.after(site.cleanup);

  const path = 'concepts/customer-and-revenue-os.html';
  assert.ok(site.pages.includes(path));
  const html = site.read(path);
  assert.equal(
    /<title>([\s\S]*?)<\/title>/.exec(html)?.[1],
    'Agent-native CRM framework for coding agents | Accordo',
  );
  assert.equal(canonicalOf(html), `${ORIGIN}/${path}`);
  assert.match(metaContent(html, 'description') ?? '', /CRM framework coding agents build with/);
  assert.match(metaContent(html, 'description') ?? '', /Not a hosted AI CRM/);
  assert.equal(metaContent(html, 'og:url'), `${ORIGIN}/${path}`);

  const structured = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map((match) => JSON.parse(match[1]));
  assert.deepEqual(structured.map((block) => block['@type']), ['BreadcrumbList']);
  assert.equal(
    structured[0]?.itemListElement.at(-1)?.name,
    'An agent-native CRM framework is something a coding agent builds with',
  );
});

test('the Smart CRM intent has one bounded search identity', (t) => {
  const site = build();
  t.after(site.cleanup);

  const path = 'concepts/smart-crm.html';
  assert.ok(site.pages.includes(path));
  const html = site.read(path);
  assert.equal(/<title>([\s\S]*?)<\/title>/.exec(html)?.[1], 'Smart CRM with deterministic guardrails | Accordo');
  assert.equal(canonicalOf(html), `${ORIGIN}/${path}`);
  assert.match(metaContent(html, 'description') ?? '', /coding agents compose the system/);
  assert.equal(metaContent(html, 'og:url'), `${ORIGIN}/${path}`);

  const structured = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map((match) => JSON.parse(match[1]));
  assert.deepEqual(structured.map((block) => block['@type']), ['BreadcrumbList']);
  const breadcrumb = structured.find((block) => block['@type'] === 'BreadcrumbList');
  assert.equal(breadcrumb?.itemListElement.at(-1)?.name, 'A smart CRM knows when the agent must stop');
});

test('the CDP + CRM intent has one bounded search identity', (t) => {
  const site = build();
  t.after(site.cleanup);

  const path = 'concepts/cdp-plus-crm.html';
  assert.ok(site.pages.includes(path));
  const html = site.read(path);
  assert.equal(/<title>([\s\S]*?)<\/title>/.exec(html)?.[1], 'CDP + CRM: profile beside process | Accordo');
  assert.equal(canonicalOf(html), `${ORIGIN}/${path}`);
  assert.match(metaContent(html, 'description') ?? '', /Pair a CDP profile layer/);
  assert.equal(metaContent(html, 'og:url'), `${ORIGIN}/${path}`);

  const structured = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map((match) => JSON.parse(match[1]));
  const breadcrumb = structured.find((block) => block['@type'] === 'BreadcrumbList');
  assert.equal(
    breadcrumb?.itemListElement.at(-1)?.name,
    'CDP + CRM works when profile and process stay separate',
  );
});

test('the indexing gate flips every dependent output together, in both directions', (t) => {
  const priv = build({ repositoryStatus: 'private' });
  const pub = build({ repositoryStatus: 'public' });
  t.after(() => { priv.cleanup(); pub.cleanup(); });

  for (const page of priv.pages) {
    assert.equal(metaContent(priv.read(page), 'robots'), 'noindex, nofollow', `${page} must refuse indexing while the source is private`);
  }
  for (const page of pub.pages) {
    assert.equal(metaContent(pub.read(page), 'robots'), 'index, follow', `${page} must allow indexing once the source is public`);
  }

  // Crawling is allowed either way. `Disallow: /` would stop a crawler fetching the page it needs
  // to read the noindex directive on, which leaves a URL-only index entry nothing can remove.
  for (const site of [priv, pub]) {
    const robots = site.read('robots.txt');
    assert.match(robots, /^Allow: \/$/m, 'robots.txt must permit the fetch that reveals the directive');
    assert.doesNotMatch(robots, /^Disallow: \//m);
  }

  assert.doesNotMatch(priv.read('robots.txt'), /^Sitemap:/m, 'a private site must not advertise a crawl list');
  assert.match(pub.read('robots.txt'), new RegExp(`^Sitemap: ${ORIGIN}/sitemap\\.xml$`, 'm'));

  // The sitemap itself is an inventory, not an instruction, so it exists in both states.
  assert.ok(priv.read('sitemap.xml').includes('<loc>'));

  // The public build links the source; the private one cannot, and says something else instead.
  assert.ok(pub.read('index.html').includes(brand.repository.value));
  const publicSource = [...pub.read('index.html').matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map((match) => JSON.parse(match[1]))
    .find((block) => block['@type'] === 'SoftwareSourceCode');
  assert.equal(publicSource.codeRepository, brand.repository.value, 'once the URL resolves, the graph should carry it');
});

test('the deployment headers agree with the ledger about whether this may be indexed', () => {
  const vercel = JSON.parse(readFileSync(join(repo, 'vercel.json'), 'utf8'));
  const isPublic = brand.repository.status === 'public';
  // Every entry, not the catch-all alone, and case-insensitively: HTTP header names are
  // case-insensitive and Vercel accepts either casing, and an affirmative directive on the five
  // machine-readable entries would defeat the whole gate while a catch-all-only check stayed green.
  const directives = vercel.headers.flatMap((/** @type {any} */ entry) => (entry.headers ?? [])
    .filter((/** @type {any} */ header) => String(header.key).toLowerCase() === 'x-robots-tag')
    .map((/** @type {any} */ header) => ({ source: entry.source, value: String(header.value) })));

  if (isPublic) {
    assert.deepEqual(directives, [], 'the repository is public but vercel.json still sends X-Robots-Tag: the header outranks the meta tag, so the site would stay unindexed');
  } else {
    assert.equal(
      directives.length,
      vercel.headers.length,
      'every headers entry must carry X-Robots-Tag. Whether Vercel merges overlapping entries or '
      + 'applies only the first is not verifiable from this repository, so the directive has to be '
      + 'on all of them for the outcome to be the same under either rule.',
    );
    for (const directive of directives) {
      assert.match(directive.value, /noindex/, `${directive.source} sends "${directive.value}", which does not refuse indexing`);
    }
  }

  // The honesty gate has to run where the deploy happens, not only in CI: a claim that loses its
  // evidence must fail the deployment, which is what vercel.json's own $comment promises.
  assert.match(vercel.buildCommand, /site:check/, 'the Vercel build must run the claims gate, not just the renderer');
});

test('the build receipt is not published', (t) => {
  const site = build();
  t.after(site.cleanup);

  assert.equal(
    existsSync(join(site.dist, '.used-claims.json')),
    false,
    'a build receipt nothing reads was being served with no content type and no cache policy',
  );
  assert.ok(existsSync(join(site.root, 'site/.used-claims.json')), 'it should still be written, just not into the output');
});

test('the screenshot harness drives a full Chrome binary headlessly and verifies the artifact', () => {
  const source = readFileSync(join(repo, 'scripts/site-shots.js'), 'utf8');
  assert.match(
    source,
    /headless_shell.*--headless=new/s,
    'a full Chrome binary is not the headless shell; it needs an explicit headless mode',
  );
  assert.match(
    source,
    /Library.*Caches.*ms-playwright/s,
    'macOS stores Playwright browsers outside the Linux-only cache this harness first searched',
  );
  assert.match(
    source,
    /if \(!existsSync\(output\)\)/,
    'the harness must verify the artifact, not treat exit 0 as proof that Chrome wrote it',
  );
});
