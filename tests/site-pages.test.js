// @ts-check

/**
 * The generated pages: the CRM job catalogue, the answer pages, and the links between them.
 *
 * Two failure modes matter more than the rest, and both are silent.
 *
 * **A job disappearing.** Only jobs the catalogue wrote something specific about get their own URL.
 * That threshold is a convenience for readers, not a filter on the truth, so every one of the 149
 * jobs must still be reachable and readable in full — on its section page if not on its own.
 *
 * **An answer drifting from its evidence.** Answer pages exist to be lifted by an answer engine, so
 * the sentence they carry has to be the ledger's sentence. The lede is a human summary; everything
 * below it is rendered verbatim from `site/claims.json`, and these tests check that it still is.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, relative, dirname, resolve } from 'node:path';

import { hasOwnPage, OWN_PAGE_MIN_SUMMARY, slugify, sectionTitle, truncate, stripMarkdown } from '../scripts/site-pages.js';
import { buildClusterPages } from '../scripts/site-clusters.js';

const repo = process.cwd();
const dist = join(repo, 'site/dist');

const jobs = JSON.parse(readFileSync(join(repo, 'docs/benchmarks/jobs.json'), 'utf8'));
const ledger = JSON.parse(readFileSync(join(repo, 'site/claims.json'), 'utf8'));
const answers = JSON.parse(readFileSync(join(repo, 'site/answers.json'), 'utf8'));

test('the site builds before anything here is inspected', () => {
  const run = spawnSync(process.execPath, ['--no-warnings', join(repo, 'scripts/site-build.js')], { cwd: repo, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(existsSync(join(dist, 'jobs.html')), 'the catalogue hub must exist');
  assert.ok(existsSync(join(dist, 'answers.html')), 'the answers hub must exist');
});

test('the documented site inventory is derived from the pages the build emits', () => {
  const countPages = (/** @type {string} */ directory) => readdirSync(join(dist, directory))
    .filter((name) => name.endsWith('.html')).length;
  const jobsCount = countPages('jobs');
  const answersCount = countPages('answers');
  const conceptsCount = countPages('concepts');
  const total = readdirSync(dist, { recursive: true })
    .filter((name) => String(name).endsWith('.html')).length;
  const architecture = readFileSync(join(repo, 'docs/marketing/SITE_ARCHITECTURE.md'), 'utf8');
  const brief = readFileSync(join(repo, 'docs/marketing/DESIGN_BRIEF.md'), 'utf8');

  assert.match(architecture, new RegExp('`jobs\\.html` over ' + jobsCount + ' job pages'));
  assert.match(architecture, new RegExp('`answers\\.html` over ' + answersCount + ' answer pages'));
  assert.match(architecture, new RegExp('\\| \\*\\*Concepts\\*\\* \\| `concepts\\.html` \\| ' + conceptsCount + ' \\|'));
  for (const [label, directory] of [['Capabilities', 'capabilities'], ['Agent tools', 'tools'], ['Compare', 'compare'], ['Glossary', 'glossary']]) {
    assert.match(
      architecture,
      new RegExp('\\| \\*\\*' + label + '\\*\\* \\| `' + directory + '\\.html` \\| ' + countPages(directory) + ' \\|'),
      `SITE_ARCHITECTURE's ${label} spoke count must match the ${countPages(directory)} pages the build emits`,
    );
  }
  assert.match(brief, new RegExp(`Page inventory — ${total} pages`));
});

const read = (/** @type {string} */ path) => readFileSync(join(dist, path), 'utf8');
const escape = (/** @type {string} */ value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

test('every catalogued job is reachable and readable, whether or not it has its own page', () => {
  const sections = new Map();
  for (const job of jobs.jobs) {
    const slug = slugify(sectionTitle(job.section));
    if (!sections.has(slug)) sections.set(slug, []);
    sections.get(slug).push(job);
  }

  const hub = read('jobs.html');

  for (const [slug, entries] of sections) {
    // A section earns a URL only when one of its jobs did. Where none did, its rows are listed in
    // full on the hub — the threshold denies a URL, it never hides a row.
    const earnsPage = entries.some(hasOwnPage);
    const path = `jobs/${slug}.html`;
    if (!earnsPage) {
      assert.equal(existsSync(join(dist, path)), false, `${slug} has no job worth a URL and should not have one either`);
      for (const job of entries) {
        assert.ok(hub.includes(escape(job.title)), `${job.id} is in a folded section and is not listed on the hub — the threshold has started hiding rows`);
        if (job.summary) {
          assert.ok(hub.includes(escape(stripMarkdown(job.summary))), `the hub truncates what the catalogue says about ${job.id}, which has nowhere else to be read`);
        }
      }
      continue;
    }
    assert.ok(existsSync(join(dist, path)), `no section page for ${slug}`);
    const html = read(path);

    for (const job of entries) {
      assert.ok(html.includes(escape(job.title)), `${path} does not list ${job.id} (${job.title})`);
      assert.ok(html.includes(escape(job.status)), `${path} does not carry the status of ${job.id}`);
      // A job with no page of its own must be readable in full here, because there is nowhere
      // else. A job that has one gets a lead-in, so the paragraph is the substance of exactly one
      // indexable URL rather than two.
      if (job.summary && !hasOwnPage(job)) {
        assert.ok(
          html.includes(escape(stripMarkdown(job.summary))),
          `${path} truncates or omits what the catalogue says about ${job.id} — the section page is where a job with no URL of its own has to be readable in full`,
        );
      }
      if (job.summary && hasOwnPage(job)) {
        assert.ok(
          !html.includes(escape(stripMarkdown(job.summary))) || job.summary.length <= 180,
          `${path} repeats ${job.id}'s whole summary, which is also the substance of its own page — two URLs carrying the same paragraph`,
        );
      }
    }
  }

  // And the hub reaches every section that has a page.
  for (const [slug, entries] of sections) {
    if (!entries.some(hasOwnPage)) continue;
    assert.ok(hub.includes(`jobs/${slug}.html`), `the hub does not link the ${slug} section`);
  }
});

test('a job gets its own URL exactly when the catalogue had something specific to say', () => {
  let own = 0;
  for (const job of jobs.jobs) {
    const path = join(dist, `jobs/${job.id.toLowerCase()}.html`);
    if (hasOwnPage(job)) {
      own += 1;
      assert.ok(existsSync(path), `${job.id} has a ${job.summary.length}-character summary but no page`);
      const html = readFileSync(path, 'utf8');
      assert.ok(html.includes(escape(job.title)));
      assert.ok(html.includes(escape(stripMarkdown(job.summary))));
      for (const test of job.tests ?? []) {
        assert.ok(html.includes(escape(test)), `${job.id}'s page does not cite ${test}, which the catalogue names as its evidence`);
      }
    } else {
      assert.equal(existsSync(path), false, `${job.id} has only ${String(job.summary ?? '').length} characters of summary and should not carry a URL`);
    }
  }

  assert.ok(own > 20, 'a threshold that leaves almost nothing with its own page is not a catalogue');
  assert.ok(own < jobs.jobs.length * 0.6, 'if most jobs qualify, the threshold has stopped filtering thin content');
  assert.equal(OWN_PAGE_MIN_SUMMARY, 150, 'the threshold is a published number; changing it changes the URL set');
});

test('an answer page renders its evidence verbatim from the ledger', () => {
  const claims = new Map(ledger.claims.map((/** @type {any} */ claim) => [claim.id, claim]));
  const limitations = new Map(ledger.limitations.map((/** @type {any} */ item) => [item.id, item]));

  for (const entry of answers.questions) {
    const path = `answers/${entry.slug}.html`;
    assert.ok(existsSync(join(dist, path)), `no page for ${entry.slug}`);
    const html = read(path);

    assert.ok(entry.claims.length + entry.limitations.length > 0, `${entry.slug} cites no ledger entry, so it answers from nowhere`);

    for (const id of [...entry.claims, ...entry.limitations]) {
      const item = claims.get(id) ?? limitations.get(id);
      assert.ok(item, `${entry.slug} cites ${id}, which is not in the ledger`);
      assert.ok(
        html.includes(escape(item.text)),
        `${path} does not carry ${id}'s sentence verbatim. The lede may summarise; the page must quote.`,
      );
      if (item.limitation) {
        assert.ok(html.includes(escape(item.limitation)), `${path} carries ${id} without the limitation that travels with it`);
      }
    }

    // The question is the H1 and the title, so a retrieval step lands on the right thing.
    assert.ok(html.includes(`<h1>${escape(entry.question)}</h1>`), `${path} does not use its question as the heading`);

    const qa = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
      .map((match) => JSON.parse(match[1]))
      .find((block) => block['@type'] === 'FAQPage');
    assert.ok(qa, `${path} publishes no FAQPage structured data`);
    // FAQPage, not QAPage: QAPage is for pages where readers submit answers. These are
    // site-authored, one question and one fixed answer each.
    assert.equal(qa.mainEntity[0].name, entry.question);
    assert.ok(qa.mainEntity[0].acceptedAnswer.text.length > 80, `${path}'s structured answer is too short to be an answer`);
  }
});

test('every answer page states its boundary in the one surface read alone', () => {
  // A description is what a search result and a social card show, and an unfurler ignores the
  // noindex the rest of the site relies on. Truncating the answer to 300 characters dropped the
  // limit on four of these and published the capability half by itself.
  const NEGATIONS = /\b(no|not|none|never|nothing|only|cannot|does not|is not)\b/i;
  for (const entry of answers.questions) {
    assert.ok(entry.snippet, `${entry.slug} has no snippet, so its description is a truncation of the answer`);
    assert.ok(entry.snippet.length <= 300, `${entry.slug}'s snippet is ${entry.snippet.length} characters and would be cut`);
    assert.ok(NEGATIONS.test(entry.snippet), `${entry.slug}'s snippet states a capability with no boundary`);
    assert.doesNotMatch(entry.snippet, /…$/, `${entry.slug}'s snippet ends mid-sentence`);

    const html = read(`answers/${entry.slug}.html`);
    for (const tag of ['description', 'og:description', 'twitter:description']) {
      const value = new RegExp(`(?:name|property)="${tag}" content="([^"]*)"`).exec(html)?.[1];
      assert.equal(value, escape(entry.snippet), `${path_of(entry)} ${tag} is not the snippet`);
    }
  }
});

/** @param {any} entry */
function path_of(entry) { return `answers/${entry.slug}.html`; }

test('the refused questions are published, and only the published ones are exempt from the overclaim scan', () => {
  const html = read('answers.html');
  assert.ok(answers.refused.length >= 10, 'the list of questions this project will not answer is the informative half');

  for (const entry of answers.refused) {
    assert.ok(html.includes(escape(entry.question)), `answers.html does not publish the refused question "${entry.question}"`);
    assert.ok(html.includes(escape(entry.why)), 'a refusal without its reason is a gap, not a refusal');
    assert.ok(entry.why.length > 40, `the reason for refusing "${entry.question}" is too short to be one`);
  }

  const quoted = [...html.matchAll(/<h3 class="refused-question">([\s\S]*?)<\/h3>/g)]
    .map((match) => match[1].trim());
  assert.equal(quoted.length, answers.refused.length);
  const published = new Set(answers.refused.map((/** @type {any} */ entry) => escape(entry.question)));
  for (const question of quoted) {
    assert.ok(published.has(question), `"${question}" is marked exempt from the overclaim scan but is not a published refusal`);
  }
});

test('the machine-readable answers resolve their own evidence', () => {
  const published = JSON.parse(read('answers.json'));
  assert.equal(published.answersContract, answers.answersContract);
  assert.equal(published.questions.length, answers.questions.length);

  for (const entry of published.questions) {
    assert.match(entry.url, /^https:\/\/[^/]+\/answers\/[a-z0-9-]+\.html$/);
    assert.ok(entry.evidence.length > 0, `${entry.slug} carries no resolved evidence, so a fetch of this file alone answers nothing`);
    for (const item of entry.evidence) {
      assert.ok(item.id && item.text, `${entry.slug} has an evidence entry with no id or text`);
    }
  }
  assert.deepEqual(
    published.refused.map((/** @type {any} */ entry) => entry.question),
    answers.refused.map((/** @type {any} */ entry) => entry.question),
  );
});

test('the agent-native CRM intent is one authoring model, not a hosted AI product', () => {
  const path = 'concepts/customer-and-revenue-os.html';
  const html = read(path);
  const source = JSON.parse(readFileSync(join(repo, 'site/concepts.json'), 'utf8'))
    .entries.find((/** @type {any} */ entry) => entry.slug === 'customer-and-revenue-os');

  assert.match(html, /<h1>An agent-native CRM framework is something a coding agent builds with<\/h1>/);
  assert.match(html, /What agent-native means here/);
  assert.match(html, /development interface, not a model running the business/i);
  assert.match(html, /not a hosted AI CRM, a runtime copilot or an autonomous salesperson/i);
  assert.match(html, /Claude Code, Codex and Gemini CLI/);
  assert.match(html, /does not prove that a model will recommend Accordo/i);
  assert.ok(
    html.indexOf('boundary-block') < html.indexOf('section-block'),
    'the deployment and recommendation boundaries must precede the category essay',
  );

  assert.match(source.intent, /agent-native CRM framework for Claude Code Codex and Gemini/i);
  assert.match(source.summary, /running commercial process remains deterministic/i);
  assert.doesNotMatch(source.summary, /autonomous CRM|production-ready|model-operated CRM/i);

  assert.match(read('concepts.html'), new RegExp(`concepts/${source.slug}\\.html`));
  const llms = read('llms.txt');
  assert.match(
    llms,
    /\[An agent-native CRM framework is something a coding agent builds with\]\(concepts\/customer-and-revenue-os\.html\)/,
  );
  assert.match(llms, /checked first-contact instructions for Claude Code, Codex and Gemini CLI/);
  assert.doesNotMatch(llms, /Claude Code, Codex(?:,| and) Gemini CLI\) use to generate/i);
});

test('the Customer Hub intent separates local writes from missing cross-system ingestion', () => {
  const html = read('concepts/customer-hub.html');
  assert.match(html, /no pipeline that ingests records or events from external systems/);
  assert.match(html, /audited CRUD and service APIs/);
  assert.doesNotMatch(
    html,
    /nothing enters this database except through an action|framework(?:'s)? own actions (?:already )?wrote/i,
    'the framework has public CRUD and service write paths; denying them to sharpen the CDP contrast is false',
  );

  const source = JSON.parse(readFileSync(join(repo, 'site/concepts.json'), 'utf8'))
    .entries.find((/** @type {any} */ entry) => entry.slug === 'customer-hub');
  const authored = [
    source.summary,
    ...source.boundaries,
    ...source.sections.flatMap((/** @type {any} */ section) => section.body),
  ].join('\n');
  assert.doesNotMatch(
    authored,
    /framework(?:'s)? own actions (?:already )?wrote/i,
    'the rendered paragraph was fixed once while the hero and boundary kept the false narrower write path',
  );

  assert.match(html, /<figure class="record-chain"/);
  assert.equal((html.match(/<li data-state=/g) ?? []).length, 6, 'the visible chain must carry every commercial stage it claims');
  assert.ok(
    html.indexOf('boundary-block') < html.indexOf('record-chain'),
    'the visual may strengthen the value, but it cannot push ahead of the mandatory boundary',
  );

  const llms = read('llms.txt');
  assert.match(llms, /Service operations are a partial local slice, not a helpdesk product/);
  assert.doesNotMatch(llms, /Service package is the next\s+milestone and is not merged/);
});

test('the Smart CRM intent prints a tested refusal without widening it into a universal AI claim', () => {
  const html = read('concepts/smart-crm.html');
  const source = JSON.parse(readFileSync(join(repo, 'site/concepts.json'), 'utf8'))
    .entries.find((/** @type {any} */ entry) => entry.slug === 'smart-crm');

  assert.match(html, /<figure class="refusal-proof" aria-labelledby="refusal-proof-title">/);
  assert.match(html, /POST \/api\/modules\/quote\/records\/:id\/actions\/approve/);
  assert.match(html, /\{ type: "agent" \}/);
  assert.match(html, /403 HUMAN_APPROVAL_REQUIRED/);
  assert.ok(
    html.indexOf('boundary-block') < html.indexOf('refusal-proof')
      && html.indexOf('refusal-proof') < html.indexOf('section-block'),
    'limitations must be read before the receipt, and the receipt before the supporting essay',
  );
  assert.match(html, /actor is asserted rather than authenticated/i);
  assert.match(html, /no model can run anywhere at runtime/i);
  assert.doesNotMatch(
    source.summary,
    /no (?:LLM|model) (?:runs|decides) at runtime/i,
    'the ledger does not support a repository-wide absence-of-runtime-model claim',
  );

  const pillar = read('concepts.html');
  assert.match(pillar, /concepts\/smart-crm\.html/);
  assert.match(read('llms.txt'), /\[A smart CRM knows when the agent must stop\]\(concepts\/smart-crm\.html\)/);
});

test('the refusal proof content contract rejects an incomplete receipt', () => {
  const readJson = (/** @type {string} */ path) => JSON.parse(readFileSync(join(repo, path), 'utf8'));
  const sources = {
    capabilities: readJson('site/capabilities.json'),
    tools: readJson('site/tools.json'),
    concepts: readJson('site/concepts.json'),
    compare: readJson('site/compare.json'),
    glossary: readJson('site/glossary.json'),
  };
  const build = (source) => buildClusterPages({
    sources: source,
    ledger,
    jobs,
    brand: readJson('site/brand.json'),
    origin: 'https://accordo.dev',
  });
  const edited = structuredClone(sources);
  const smart = edited.concepts.entries.find((/** @type {any} */ entry) => entry.slug === 'smart-crm');
  delete smart.refusalProof.result;

  assert.throws(
    () => build(edited),
    /site\/concepts\.json → smart-crm: refusalProof is missing result/,
  );

  for (const [value, expected] of [
    ['   ', /refusalProof\.result must not be blank/],
    ['200 OK\n403 HUMAN_APPROVAL_REQUIRED', /refusalProof\.result must be one line/],
    ['x'.repeat(161), /refusalProof\.result exceeds 160 characters/],
  ]) {
    const invalid = structuredClone(sources);
    invalid.concepts.entries.find((/** @type {any} */ entry) => entry.slug === 'smart-crm')
      .refusalProof.result = value;
    assert.throws(() => build(invalid), expected);
  }

  const unknown = structuredClone(sources);
  unknown.concepts.entries.find((/** @type {any} */ entry) => entry.slug === 'smart-crm')
    .refusalProof.reslt = '403 TYPO';
  assert.throws(() => build(unknown), /refusalProof has unknown field reslt/);

  for (const field of ['title', 'caption', 'request', 'actor', 'result']) {
    const hostile = structuredClone(sources);
    hostile.concepts.entries.find((/** @type {any} */ entry) => entry.slug === 'smart-crm')
      .refusalProof[field] = `<${field} & value>`;
    const page = build(hostile).find((candidate) => candidate.path === 'concepts/smart-crm.html');
    assert.match(page.body, new RegExp(`&lt;${field} &amp; value&gt;`), `${field} must be escaped before rendering`);
    assert.doesNotMatch(page.body, new RegExp(`<${field} & value>`));
  }
});

test('the CDP + CRM intent separates profile and process without inventing a connector', () => {
  const html = read('concepts/cdp-plus-crm.html');
  const answer = read('answers/how-to-pair-a-cdp-with-a-crm-framework.html');

  assert.match(html, /<figure class="responsibility-map" aria-labelledby="responsibility-map-title">/);
  assert.match(html, /Profile layer/);
  assert.match(html, /Customer data platform/);
  assert.match(html, /Process layer/);
  assert.match(html, /Accordo CRM framework/);
  assert.match(html, /Accordo ships no connector, importer or sync runtime/);
  assert.ok(
    html.indexOf('boundary-block') < html.indexOf('responsibility-map')
      && html.indexOf('responsibility-map') < html.indexOf('section-block'),
    'limitations must be read before the layer map, and the map before the supporting essay',
  );
  assert.match(html, /not a deployment guide/i);
  assert.match(html, /authenticates nobody/i);
  assert.doesNotMatch(html, /built-in (?:CDP )?(?:connector|integration)/i);

  assert.match(read('concepts.html'), /concepts\/cdp-plus-crm\.html/);
  assert.match(read('compare/vs-a-customer-data-platform.html'), /concepts\/cdp-plus-crm\.html/);
  assert.match(answer, /different layers, not substitutes/i);
  assert.match(answer, /no importer, scheduler, integration runtime or external adapter ships/i);
  assert.match(read('llms.txt'), /\[CDP \+ CRM works when profile and process stay separate\]\(concepts\/cdp-plus-crm\.html\)/);
  assert.match(read('llms.txt'), /answers\/how-to-pair-a-cdp-with-a-crm-framework\.html/);
});

test('the responsibility map contract is closed, bounded, single-line and escaped', () => {
  const readJson = (/** @type {string} */ path) => JSON.parse(readFileSync(join(repo, path), 'utf8'));
  const sources = {
    capabilities: readJson('site/capabilities.json'),
    tools: readJson('site/tools.json'),
    concepts: readJson('site/concepts.json'),
    compare: readJson('site/compare.json'),
    glossary: readJson('site/glossary.json'),
  };
  const build = (source) => buildClusterPages({
    sources: source,
    ledger,
    jobs,
    brand: readJson('site/brand.json'),
    origin: 'https://accordo.dev',
  });
  const mapOf = (source) => source.concepts.entries
    .find((/** @type {any} */ entry) => entry.slug === 'cdp-plus-crm').responsibilityMap;

  const incomplete = structuredClone(sources);
  delete mapOf(incomplete).bridge;
  assert.throws(() => build(incomplete), /responsibilityMap\.bridge must not be blank/);

  const wrongLayerCount = structuredClone(sources);
  mapOf(wrongLayerCount).layers.pop();
  assert.throws(() => build(wrongLayerCount), /responsibilityMap\.layers must contain exactly 2 layers/);

  for (const [value, expected] of [
    ['   ', /responsibilityMap\.bridge must not be blank/],
    ['connector\nexists', /responsibilityMap\.bridge must be one line/],
    ['x'.repeat(241), /responsibilityMap\.bridge exceeds 240 characters/],
  ]) {
    const invalid = structuredClone(sources);
    mapOf(invalid).bridge = value;
    assert.throws(() => build(invalid), expected);
  }

  const shortOwns = structuredClone(sources);
  mapOf(shortOwns).layers[0].owns.pop();
  assert.throws(() => build(shortOwns), /responsibilityMap\.layers\[0\]\.owns must contain exactly 3 items/);

  const rootUnknown = structuredClone(sources);
  mapOf(rootUnknown).bridg = 'typo';
  assert.throws(() => build(rootUnknown), /responsibilityMap has unknown field bridg/);

  const layerUnknown = structuredClone(sources);
  mapOf(layerUnknown).layers[0].owner = 'typo';
  assert.throws(() => build(layerUnknown), /responsibilityMap\.layers\[0\] has unknown field owner/);

  for (const [label, target] of [
    ['root', (map) => map],
    ['layer', (map) => map.layers[0]],
  ]) {
    const prototypeShaped = structuredClone(sources);
    Object.defineProperty(target(mapOf(prototypeShaped)), '__proto__', {
      value: { polluted: true }, enumerable: true, configurable: true, writable: true,
    });
    assert.throws(
      () => build(prototypeShaped),
      /responsibilityMap.*unknown field __proto__/,
      `${label} prototype-shaped content must fail closed`,
    );
    assert.equal(Object.hasOwn({}, 'polluted'), false);
  }

  const fields = [
    ['title', (map) => map],
    ['caption', (map) => map],
    ['bridge', (map) => map],
    ['label', (map) => map.layers[0]],
    ['name', (map) => map.layers[0]],
    ['doesNotOwn', (map) => map.layers[0]],
  ];
  for (const [field, target] of fields) {
    const hostile = structuredClone(sources);
    target(mapOf(hostile))[field] = `<${field} & value>`;
    const page = build(hostile).find((candidate) => candidate.path === 'concepts/cdp-plus-crm.html');
    assert.match(page.body, new RegExp(`&lt;${field} &amp; value&gt;`), `${field} must be escaped before rendering`);
    assert.doesNotMatch(page.body, new RegExp(`<${field} & value>`));
  }

  const hostileOwn = structuredClone(sources);
  mapOf(hostileOwn).layers[0].owns[0] = '<owns & value>';
  const page = build(hostileOwn).find((candidate) => candidate.path === 'concepts/cdp-plus-crm.html');
  assert.match(page.body, /&lt;owns &amp; value&gt;/);
  assert.doesNotMatch(page.body, /<owns & value>/);
});

test('every internal link resolves to a page that was built', () => {
  /** @type {string[]} */
  const pages = [];
  const walk = (/** @type {string} */ directory) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith('.html')) pages.push(path);
    }
  };
  walk(dist);

  const broken = [];
  for (const page of pages) {
    const html = readFileSync(page, 'utf8');
    for (const match of html.matchAll(/href="([^"]+)"/g)) {
      const href = match[1];
      if (/^(https?:|mailto:|#)/.test(href)) continue;
      assert.ok(!href.startsWith('/'), `${relative(dist, page)} uses the root-absolute href "${href}"; the built site is also opened from disk, where that resolves to the filesystem root`);
      const target = resolve(dirname(page), href.split('#')[0]);
      if (!existsSync(target)) broken.push(`${relative(dist, page)} → ${href}`);
    }
  }
  assert.deepEqual(broken, [], 'a link that 404s teaches a crawler the site is unreliable, and teaches a reader the same');
});

test('the helpers behave at the edges the pages actually hit', () => {
  assert.equal(slugify('Delivery & Service (handover at M13)'), 'delivery-service');
  assert.equal(slugify('Analytics (target: M16)'), 'analytics');
  assert.equal(sectionTitle('Analytics (target: M16)'), 'Analytics');
  assert.equal(sectionTitle('Audience and governance'), 'Audience and governance');

  assert.equal(truncate('short', 70), 'short');
  assert.equal(truncate('x'.repeat(80), 20).length, 20);
  assert.ok(truncate('a sentence that will certainly be cut somewhere in the middle of it', 30).endsWith('…'));

  assert.equal(stripMarkdown('**bold** and `code` and *em*'), 'bold and code and em');
  assert.equal(stripMarkdown('multi\n  line   spacing'), 'multi line spacing');

  // Every slug the section set produces has to be unique, or two sections overwrite one page.
  const slugs = [...new Set(jobs.jobs.map((/** @type {any} */ job) => job.section))].map((section) => slugify(sectionTitle(String(section))));
  assert.equal(new Set(slugs).size, slugs.length, 'two sections slugify to the same URL');
  for (const slug of slugs) assert.match(slug, /^[a-z0-9-]+$/);
});
