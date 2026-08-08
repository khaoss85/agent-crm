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

/**
 * Build the site into a throwaway root, optionally with brand.json edited first. The builder reads
 * `process.cwd()`, so a copied tree is all it takes — no flag, no injection point, and the real
 * script under test rather than a re-implementation of it.
 *
 * @param {{repositoryStatus?: string}} [options]
 */
function build(options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'accordo-site-'));
  cpSync(join(repo, 'site'), join(root, 'site'), { recursive: true });
  rmSync(join(root, 'site/dist'), { recursive: true, force: true });
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
  assert.equal(
    source.codeRepository,
    undefined,
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
  const catchAll = vercel.headers.find((/** @type {any} */ entry) => entry.source === '/(.*)');
  assert.ok(catchAll, 'vercel.json has no catch-all headers entry');

  const robotsHeader = catchAll.headers.find((/** @type {any} */ header) => header.key === 'X-Robots-Tag');
  const isPublic = brand.repository.status === 'public';

  if (isPublic) {
    assert.equal(
      robotsHeader,
      undefined,
      'the repository is public but vercel.json still sends X-Robots-Tag: the header outranks the meta tag, so the site would stay unindexed',
    );
  } else {
    assert.ok(
      robotsHeader,
      'the repository is private and vercel.json sends no X-Robots-Tag. The meta tag cannot reach '
      + 'llms.txt, llms-full.txt, jobs.json or sitemap.xml — plain text and JSON carry no meta tags '
      + '— so those would be indexable while every HTML page asks not to be.',
    );
    assert.match(robotsHeader.value, /noindex/);
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
