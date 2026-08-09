// @ts-check

/**
 * Generates the four hub-and-spoke clusters — capabilities, agent tools, concepts, compare — and
 * the blog engine, from the JSON sources in `site/`.
 *
 * **Why this file exists at all.** `docs/marketing/SITE_ARCHITECTURE.md` §1 records the decision:
 * content lives in JSON with evidence attached to every row, and a page is a rendering of it. The
 * reason is not tidiness. `scripts/site-check.js` refuses to ship a capability sentence no test
 * holds, and a hand-written marketing page cannot pass that gate reliably. A page that has to be
 * argued past a gate is a page that will eventually be argued past it wrongly.
 *
 * **Why the boundary block is emitted above the sections.** SITE_ARCHITECTURE.md §3 requires the
 * `boundaries` array and requires it above the fold. A reader who scrolls half a spoke page has read
 * only the capability half of a sentence this project exists to state in one breath. Ordering is the
 * only mechanism that makes that structural rather than editorial, so `boundaries` is emitted before
 * the first `.section-block` and an empty `boundaries` array fails the build.
 *
 * **Why the generator validates rather than the checker alone.** `site-check.js` runs against
 * `site/dist` and reports a file path. By then the failure has lost its author: a bad claim id
 * surfaces as a missing sentence on a page, and a job id that gets no page of its own surfaces as an
 * internal 404 — the one defect SITE_ARCHITECTURE.md §Internal-linking-rules calls a defect rather
 * than a cosmetic issue. Every check here fails the build naming the source file, the entry and the
 * id, before a byte is written.
 *
 * **Why job links are resolved and not guessed.** Which jobs get their own URL is decided by
 * `hasOwnPage()` in `scripts/site-pages.js` — a rule that recomputes itself from the matrix. This
 * file imports that function rather than restating it. A cited job that earns no page renders as
 * plain text carrying its status, which is the honest rendering: the job is still catalogued, it
 * simply has no destination.
 *
 * **Why the overclaim list appears twice.** `scripts/site-check.js` is the canonical gate and runs
 * last, against `site/dist`. The same vocabulary is checked here against the *source strings*, so a
 * violation is reported as `site/<cluster>.json → <slug>: writes "…"` rather than as a line of built
 * HTML somebody then has to trace back to the sentence that produced it. Two lists is the cost; an
 * author who can find the sentence is the return. It caught one on its first run.
 *
 * The blog engine originally shipped empty (SITE_ARCHITECTURE.md §5). Its
 * front-matter gate is mechanical, so each real piece remains a one-file,
 * evidence-bound publication rather than a placeholder or an editorial plan.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { hasOwnPage, truncate } from './site-pages.js';

/**
 * The four clusters, in nav order, with the pillar copy that is not derivable from the source.
 *
 * Every sentence here is a repository fact: the counts are derived from the sources at render time,
 * and the boundaries restate `site/claims.json` and `site/brand.json` rather than adding to them.
 */
const CLUSTERS = [
  {
    key: 'capabilities',
    dir: 'capabilities',
    name: 'Capabilities',
    eyebrow: 'Capabilities',
    heading: 'The commercial domains that are merged, and where each one stops.',
    title: 'Capabilities: what is merged, and where each one stops',
    lede:
      `<p>Each page below states the boundary before the capability, cites the entry in
      <a href="{{page.root}}evidence.html">the claims ledger</a> that carries it, and names the test file that
      proves it. <strong>None of it is deployable.</strong> There is no authentication, tenancy or RBAC, every
      provider is an offline fixture, persistence is local SQLite and there is no scheduler — so a domain that
      works here works on one developer's machine.</p>`,
    description:
      'The merged domains — leads, quoting, orders, contracts, delivery, service — each boundary-first with the test that carries it. Local development only.',
  },
  {
    key: 'tools',
    dir: 'tools',
    name: 'Agent tools',
    eyebrow: 'Agent tools',
    heading: 'What a coding agent can actually run in this checkout.',
    title: 'Agent tools: what a coding agent can run in this checkout',
    lede:
      `<p>Each page names the command, quotes what it printed in this repository, and states what its report
      does not prove. <strong>Nothing here installs from npm.</strong> The project bootstrap scaffolds a working project
      from a checkout of this repository; the two names on the registry are still empty reservations, so
      ownership means copying source and upgrading means merging (<span class="mono">site/brand.json</span>, L-08). The MCP server is
      stdio and local only, and it inherits the authority of the process that starts it.</p>`,
    description:
      'Inspect, plan, diagnose, scaffold, conformance-test, quality gates, falsify, install: the commands a coding agent runs here, each with what it does not prove.',
  },
  {
    key: 'concepts',
    dir: 'concepts',
    name: 'Concepts',
    eyebrow: 'Concepts',
    heading: 'Why the framework is shaped this way.',
    title: 'Concepts: why the framework is shaped this way',
    lede:
      `<p>These pages argue rather than describe, and every paragraph still resolves to a file in this
      repository — an ADR, a strategy document, a test, or a command whose output is quoted. Where an argument
      would need a fact the repository does not hold, the argument stops. <strong>None of these pages states a
      capability the capability pages do not already carry with its limitation attached.</strong></p>`,
    description:
      'Why an agent may not approve a deal, what code you own costs today and what determinism buys. Every argument resolves to a file in this repository.',
  },
  {
    key: 'compare',
    dir: 'compare',
    name: 'Compare',
    eyebrow: 'Compare',
    heading: 'Why this and not that.',
    title: 'Compare: why this framework and not that',
    lede:
      `<p>Every fact about another project on these pages is single-sourced to
      <span class="mono">docs/strategy/COMPETITOR_MAP.md</span> and carries that file's research date.
      <strong>Nothing from another project was installed, configured or run.</strong> Where a comparison would
      need a fact the map does not carry, the sentence is dropped rather than softened — and every page opens
      by naming where the alternative wins.</p>`,
    description:
      'How this differs from building a CRM yourself, from Twenty, from Odoo and from a CDP. Every competitor fact is single-sourced and dated; nothing was run.',
  },
];

/**
 * The limitations printed on every pillar and in the closing line of every spoke.
 *
 * They are ids, not sentences: the ledger's own text is rendered so a page cannot drift from it.
 * These six are the ones that survive the topic of the page — a visitor who reads one capability
 * page and nothing else has still been told the framework is not deployable, is not measured, and is
 * not installable.
 */
const STANDING_LIMITS = ['L-01', 'L-02', 'L-04', 'L-05', 'L-03', 'L-08'];

/** Front-matter fields a blog post must declare (SITE_ARCHITECTURE.md §5). */
export const REQUIRED_FRONT_MATTER = ['title', 'date', 'claims', 'transcript', 'editor'];

/**
 * The vocabulary this project does not use, mirrored from `scripts/site-check.js` so a violation is
 * reported against its source file rather than against built HTML. See the module header.
 */
const FORBIDDEN = [
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

/**
 * Build every cluster page, and the blog index plus any posts.
 *
 * @param {{
 *   sources: Record<string, any>,
 *   ledger: any,
 *   jobs: any,
 *   brand: any,
 *   origin: string,
 *   blogDir?: string,
 * }} input
 * @returns {{path: string, title: string, description: string, body: string, jsonLd: any[]}[]}
 */
export function buildClusterPages({ sources, ledger, jobs, brand, origin, blogDir }) {
  const claims = new Map(ledger.claims.map((/** @type {any} */ item) => [item.id, item]));
  const limitations = new Map(ledger.limitations.map((/** @type {any} */ item) => [item.id, item]));

  // Which jobs have a destination. `hasOwnPage` is imported rather than restated: it is the rule the
  // job pages are actually emitted by, and a second copy of it here would drift the first time the
  // threshold moves — silently, into dead links.
  //
  // A missing index is one error here, not eighty-eight. site-build.js degrades to a note when
  // docs/benchmarks/jobs.json is absent, because the job pages simply do not get built; these pages
  // are different — they cite job ids as evidence, and a cited id that cannot be resolved is either
  // a dead link or a citation with nothing behind it.
  if (!jobs || !Array.isArray(jobs.jobs)) {
    throw new Error('site-clusters: docs/benchmarks/jobs.json is missing, and every cluster entry cites job ids as evidence. Run `npm run jobs` first.');
  }
  const jobIndex = new Map(jobs.jobs.map((/** @type {any} */ job) => [job.id, job]));

  // ------------------------------------------------------------------ resolve and validate
  const entries = [];
  const slugs = new Map();
  for (const cluster of CLUSTERS) {
    const source = sources[cluster.key];
    if (!source) throw new Error(`site-clusters: no source supplied for the ${cluster.key} cluster`);
    if (!Array.isArray(source.entries) || source.entries.length === 0) {
      throw new Error(`site-clusters: site/${cluster.key}.json has no entries`);
    }
    for (const entry of source.entries) {
      const where = `site/${cluster.key}.json → ${entry.slug ?? entry.id ?? '(no slug)'}`;
      for (const field of ['id', 'slug', 'title', 'plainName', 'intent', 'summary', 'metaDescription']) {
        if (!entry[field] || typeof entry[field] !== 'string') throw new Error(`${where}: missing ${field}`);
      }
      if (!Array.isArray(entry.sections) || entry.sections.length === 0) throw new Error(`${where}: no sections`);

      if (entry.recordChain !== undefined) {
        const chain = entry.recordChain;
        if (!chain || typeof chain !== 'object' || Array.isArray(chain)) throw new Error(`${where}: recordChain must be an object`);
        for (const field of ['title', 'caption']) {
          if (!chain[field] || typeof chain[field] !== 'string') throw new Error(`${where}: recordChain is missing ${field}`);
        }
        if (!Array.isArray(chain.nodes) || chain.nodes.length < 2 || chain.nodes.length > 8) {
          throw new Error(`${where}: recordChain.nodes must contain 2-8 nodes`);
        }
        for (const [index, node] of chain.nodes.entries()) {
          for (const field of ['label', 'detail', 'state']) {
            if (!node?.[field] || typeof node[field] !== 'string') throw new Error(`${where}: recordChain.nodes[${index}] is missing ${field}`);
          }
          if (!['working', 'partial'].includes(node.state)) {
            throw new Error(`${where}: recordChain.nodes[${index}].state must be working or partial`);
          }
        }
      }

      if (entry.refusalProof !== undefined) {
        const proof = entry.refusalProof;
        if (!proof || typeof proof !== 'object' || Array.isArray(proof)) throw new Error(`${where}: refusalProof must be an object`);
        for (const field of ['title', 'caption', 'request', 'actor', 'result']) {
          if (!proof[field] || typeof proof[field] !== 'string') throw new Error(`${where}: refusalProof is missing ${field}`);
        }
      }

      // `title` is the H1 — the sentence the page argues, and often longer than a search result
      // will render. `metaTitle` is the same page named in under 60 characters for the tab, the
      // result and the share card. It is optional only while the H1 already fits: the moment it
      // does not, a page that ships no short name is a page whose <title> ends in an ellipsis.
      if (entry.metaTitle !== undefined && typeof entry.metaTitle !== 'string') throw new Error(`${where}: metaTitle must be a string`);
      const metaTitle = (entry.metaTitle ?? entry.title).trim();
      if (metaTitle.length > TITLE_MAX) {
        throw new Error(
          `${where}: the <title> would be ${metaTitle.length} characters and a search result truncates near ${TITLE_MAX}. `
          + 'Add a metaTitle that names this page in fewer, rather than letting truncate() cut the H1.',
        );
      }

      // The meta description is authored, not cut from the summary. `summary` is 500-odd characters
      // of boundary-first prose that the page renders in full; truncating it to fit a search result
      // reliably severed the sentence mid-clause, and on this site the clause that gets severed is
      // the limitation. So it is its own field, and it has to be a whole thought that fits.
      assertDescription(entry.metaDescription, where);

      // The check this cluster exists for. A page with no stated boundary is a page claiming
      // completeness, and completeness is the one thing the ledger's limitations contradict.
      if (!Array.isArray(entry.boundaries) || entry.boundaries.length === 0) {
        throw new Error(`${where}: boundaries is empty. SITE_ARCHITECTURE.md §3 requires it, and requires it above the sections.`);
      }

      if (slugs.has(entry.slug)) {
        throw new Error(`${where}: duplicate slug "${entry.slug}", already used by ${slugs.get(entry.slug)}. Slugs are the URL and are unique across all clusters.`);
      }
      slugs.set(entry.slug, where);

      for (const id of entry.claims ?? []) {
        if (!claims.has(id)) throw new Error(`${where}: claim ${id} is not in site/claims.json. Claim ids come from the ledger and nowhere else.`);
      }
      for (const id of entry.limitations ?? []) {
        if (!limitations.has(id)) throw new Error(`${where}: limitation ${id} is not in site/claims.json.`);
      }
      for (const id of entry.jobs ?? []) {
        if (!jobIndex.has(id)) {
          throw new Error(`${where}: job ${id} is not in docs/benchmarks/jobs.json. It cannot be cited and it cannot be linked.`);
        }
      }
      for (const text of authoredStrings(entry)) {
        for (const rule of FORBIDDEN) {
          const match = rule.pattern.exec(text);
          if (match) throw new Error(`${where}: writes "${match[0]}" — ${rule.why}. Delete the sentence; do not soften it.`);
        }
      }

      entries.push({ cluster, entry });
    }
  }

  // `related` resolves across every cluster, so it can only be checked once all slugs are known.
  const target = new Map(entries.map(({ cluster, entry }) => [entry.slug, { cluster, entry }]));
  for (const { cluster, entry } of entries) {
    for (const slug of entry.related ?? []) {
      if (!target.has(slug)) {
        throw new Error(`site/${cluster.key}.json → ${entry.slug}: related slug "${slug}" is emitted by no cluster. An internal 404 is a defect, not a cosmetic issue.`);
      }
      if (slug === entry.slug) {
        throw new Error(`site/${cluster.key}.json → ${entry.slug}: relates to itself.`);
      }
    }
  }

  const standing = STANDING_LIMITS.map((id) => {
    const limitation = limitations.get(id);
    if (!limitation) throw new Error(`site-clusters: standing limitation ${id} is not in site/claims.json`);
    return limitation;
  });

  // ------------------------------------------------------------------ render
  const pages = [];

  for (const cluster of CLUSTERS) {
    const own = entries.filter((item) => item.cluster.key === cluster.key).map((item) => item.entry);
    pages.push(pillarPage(cluster, own, standing, origin));
    for (const entry of own) {
      pages.push(spokePage({ cluster, entry, claims, limitations, jobIndex, standing, target, origin }));
    }
  }

  pages.push(...blogPages({
    posts: readBlogPosts(blogDir ?? join('site', 'blog'), ledger),
    claims,
    standing,
    brand,
    origin,
  }));

  return pages;
}

// ---------------------------------------------------------------------------- the pillar page

/**
 * @param {any} cluster @param {any[]} own @param {any[]} standing @param {string} origin
 */
function pillarPage(cluster, own, standing, origin) {
  return {
    path: `${cluster.dir}.html`,
    title: truncate(cluster.title, 70),
    description: assertDescription(cluster.description, `site-clusters: the ${cluster.key} pillar`),
    jsonLd: [
      breadcrumbList(origin, [['Home', '/'], [cluster.name, `/${cluster.dir}.html`]]),
      {
        '@context': 'https://schema.org',
        '@type': 'ItemList',
        name: cluster.heading,
        numberOfItems: own.length,
        itemListElement: own.map((entry, index) => ({
          '@type': 'ListItem',
          position: index + 1,
          name: entry.title,
          url: `${origin}/${cluster.dir}/${entry.slug}.html`,
        })),
      },
    ],
    body: [
      '  <div class="shell">',
      breadcrumbs([['Home', '{{page.root}}index.html'], [cluster.name, null]]),
      '    <header class="cluster-hero">',
      `      <p class="eyebrow">${escapeHtml(cluster.eyebrow)}</p>`,
      `      <h1>${escapeHtml(cluster.heading)}</h1>`,
      cluster.lede,
      '    </header>',
      '  </div>',
      '  <div class="shell">',
      '    <section>',
      '      <ul class="cluster-grid">',
      ...own.map((entry) => [
        '        <li class="cluster-card">',
        `          <h2><a href="{{page.root}}${cluster.dir}/${entry.slug}.html">${escapeHtml(entry.title)}</a></h2>`,
        `          <p class="card-plain">${escapeHtml(entry.plainName)}</p>`,
        `          <p>${escapeHtml(oneLine(entry.summary))}</p>`,
        '        </li>',
      ].join('\n')),
      '      </ul>',
      standingLimits(standing, `What none of the ${own.length} pages above means`),
      '    </section>',
      '  </div>',
    ].join('\n'),
  };
}

// ---------------------------------------------------------------------------- the spoke page

/**
 * @param {{cluster: any, entry: any, claims: Map<string, any>, limitations: Map<string, any>,
 *   jobIndex: Map<string, any>, standing: any[], target: Map<string, any>, origin: string}} input
 */
function spokePage({ cluster, entry, claims, limitations, jobIndex, standing, target, origin }) {
  const url = `/${cluster.dir}/${entry.slug}.html`;
  return {
    path: `${cluster.dir}/${entry.slug}.html`,
    title: entry.metaTitle ?? entry.title,
    description: entry.metaDescription,
    jsonLd: [
      breadcrumbList(origin, [['Home', '/'], [cluster.name, `/${cluster.dir}.html`], [entry.title, url]]),
    ],
    body: [
      '  <div class="shell">',
      breadcrumbs([
        ['Home', '{{page.root}}index.html'],
        [cluster.name, `{{page.root}}${cluster.dir}.html`],
        [entry.title, null],
      ]),
      '    <header class="spoke-hero">',
      `      <h1>${escapeHtml(entry.title)}</h1>`,
      `      <p class="plain-name">${escapeHtml(entry.plainName)}</p>`,
      `      <p class="intent-line"><b class="intent-label">People ask this as:</b> <q>${escapeHtml(entry.intent)}</q></p>`,
      `      <p>${escapeHtml(entry.summary)}</p>`,
      '    </header>',
      '  </div>',
      '  <div class="shell">',
      '    <section>',
      // Above the sections, deliberately. Everything below is downstream of this being read.
      boundaryBlock(entry, standing),
      recordChain(entry),
      refusalProof(entry),
      ...entry.sections.map((section) => [
        '      <div class="section-block">',
        `        <h2>${escapeHtml(section.heading)}</h2>`,
        ...(section.body ?? []).map((paragraph) => `        <p>${escapeHtml(paragraph)}</p>`),
        '      </div>',
      ].join('\n')),
      evidenceRail({ entry, claims, limitations, jobIndex }),
      relatedRail(entry, target),
      '    </section>',
      '  </div>',
    ].join('\n'),
  };
}

/**
 * An optional executable receipt for pages whose argument is a refusal boundary. It is deliberately
 * fixed to request, actor and result: a free-form code sample would be decoration, while these three
 * fields state who tried what and the machine-readable outcome that stopped it.
 *
 * @param {any} entry
 */
function refusalProof(entry) {
  if (!entry.refusalProof) return '';
  const proof = entry.refusalProof;
  return [
    '      <figure class="refusal-proof" aria-labelledby="refusal-proof-title">',
    '        <figcaption>',
    '          <span class="kicker">The boundary, executed</span>',
    `          <strong id="refusal-proof-title">${escapeHtml(proof.title)}</strong>`,
    `          <span>${escapeHtml(proof.caption)}</span>`,
    '        </figcaption>',
    '        <div class="code refusal">',
    `<pre><span class="c">request</span>  ${escapeHtml(proof.request)}
<span class="c">actor</span>    <span class="s">${escapeHtml(proof.actor)}</span>

<span class="bad">${escapeHtml(proof.result)}</span></pre>`,
    '        </div>',
    '      </figure>',
  ].join('\n');
}

/**
 * An optional, semantic record chain for pages whose argument is a sequence of owned records.
 * It is an ordered list rather than decorative SVG: the same relationship remains readable to a
 * crawler, a screen reader and a browser with styles disabled.
 *
 * @param {any} entry
 */
function recordChain(entry) {
  if (!entry.recordChain) return '';
  return [
    '      <figure class="record-chain" aria-labelledby="record-chain-title">',
    `        <figcaption><span class="kicker">Working record chain</span><strong id="record-chain-title">${escapeHtml(entry.recordChain.title)}</strong><span>${escapeHtml(entry.recordChain.caption)}</span></figcaption>`,
    '        <ol>',
    ...entry.recordChain.nodes.map((node) => [
      `          <li data-state="${escapeHtml(node.state)}">`,
      `            <span class="record-state">${node.state === 'working' ? 'Validated path' : 'Partial domain'}</span>`,
      `            <strong>${escapeHtml(node.label)}</strong>`,
      `            <small>${escapeHtml(node.detail)}</small>`,
      '          </li>',
    ].join('\n')),
    '        </ol>',
    '      </figure>',
  ].join('\n');
}

/**
 * The boundary list, and the two framework-wide limitations that survive every topic.
 *
 * The closing paragraph prints `L-01` word for word rather than paraphrasing it. A paraphrase is a
 * fourth place for a limitation to drift, and the ledger exists so that there is one.
 *
 * @param {any} entry @param {any[]} standing
 */
function boundaryBlock(entry, standing) {
  const first = standing.find((item) => item.id === 'L-01');
  return [
    '      <div class="boundary-block">',
    '        <h2 id="limits">Where this stops</h2>',
    '        <p>Read this before the rest of the page. Every line below is a thing this does not do.</p>',
    ...(entry.verifiedOn ? [
      `        <p>Every fact about another project on this page is single-sourced to
        <code>docs/strategy/COMPETITOR_MAP.md</code> and dated ${escapeHtml(entry.verifiedOn)}. Nothing from
        another project was installed, configured or run, and there is no network access here to re-verify
        any of it.</p>`,
    ] : []),
    '        <ul class="boundary-list">',
    ...entry.boundaries.map((line) => `          <li>${escapeHtml(line)}</li>`),
    '        </ul>',
    first
      ? `        <p><strong>${escapeHtml(first.headline)}</strong> ${escapeHtml(first.text)}
        <a href="{{page.root}}evidence.html">Every claim and every limitation</a> is on one page.</p>`
      : '',
    '      </div>',
  ].filter(Boolean).join('\n');
}

/**
 * Claims, limitations, jobs, docs and tests — the whole evidence surface of one page, in one rail.
 *
 * Claims and limitations are printed from the ledger, never re-worded. Docs and tests link into the
 * repository, which `site/brand.json` records as public, so a reader can open the file the sentence
 * rests on rather than take the citation on trust.
 *
 * @param {{entry: any, claims: Map<string, any>, limitations: Map<string, any>, jobIndex: Map<string, any>}} input
 */
function evidenceRail({ entry, claims, limitations, jobIndex }) {
  const groups = [];

  if ((entry.claims ?? []).length) groups.push(claimGroup(entry.claims, claims));

  if ((entry.limitations ?? []).length) {
    groups.push(group('Limitations', entry.limitations.map((/** @type {string} */ id) => {
      const limitation = limitations.get(id);
      return `<span class="mono muted">${escapeHtml(id)}</span> <strong>${escapeHtml(limitation.headline)}</strong> `
        + escapeHtml(limitation.text);
    })));
  }

  if ((entry.jobs ?? []).length) {
    groups.push(group('Jobs it covers', entry.jobs.map((/** @type {string} */ id) => {
      const job = jobIndex.get(id);
      // A job with no page of its own is still catalogued; it simply has no destination. Linking it
      // anyway is how a generated site acquires internal 404s.
      const name = hasOwnPage(job)
        ? `<a href="{{page.root}}jobs/${escapeHtml(id.toLowerCase())}.html">${escapeHtml(job.title)}</a>`
        : escapeHtml(job.title);
      return `<span class="mono muted">${escapeHtml(id)}</span> ${name} — ${escapeHtml(job.status)}`;
    })));
  }

  if ((entry.docs ?? []).length) groups.push(group('Documented in', entry.docs.map(repositoryLink)));
  if ((entry.tests ?? []).length) groups.push(group('Proved by', entry.tests.map(repositoryLink)));

  if (groups.length === 0) return '';
  return [
    '      <div class="evidence-rail">',
    '        <h2>The evidence this page rests on</h2>',
    `        <p>Claims and limitations are printed from <span class="mono">site/claims.json</span> word for word.
        Job statuses come from <span class="mono">docs/benchmarks/jobs.json</span>; a job with no page of its own
        is listed with its status rather than linked.</p>`,
    ...groups,
    '      </div>',
  ].join('\n');
}

/**
 * Claims, printed from the ledger with the limitation that travels with each one. Never re-worded:
 * a paraphrase is a second place for a claim to drift, and the ledger exists so there is one.
 * @param {string[]} ids @param {Map<string, any>} claims
 */
function claimGroup(ids, claims) {
  return group('Claims', ids.map((id) => {
    const claim = claims.get(id);
    return `<span class="mono muted">${escapeHtml(id)}</span> ${escapeHtml(claim.text)}`
      + `<p class="limit"><b>Limit</b>${escapeHtml(claim.limitation)}</p>`;
  }));
}

/** @param {string} heading @param {string[]} items */
function group(heading, items) {
  return [
    '        <div class="evidence-group">',
    `          <h3>${escapeHtml(heading)}</h3>`,
    '          <ul>',
    ...items.map((item) => `            <li>${item}</li>`),
    '          </ul>',
    '        </div>',
  ].join('\n');
}

/** @param {string} path */
function repositoryLink(path) {
  return `<a href="{{brand.repository}}/blob/main/${escapeHtml(path)}"><code>${escapeHtml(path)}</code></a>`;
}

/**
 * Anchor text is the target page's own title, never "related" or "learn more"
 * (SITE_ARCHITECTURE.md §Internal linking rules, rule 4).
 * @param {any} entry @param {Map<string, any>} target
 */
function relatedRail(entry, target) {
  const related = entry.related ?? [];
  if (related.length === 0) return '';
  return [
    '      <nav class="related-rail" aria-label="Related pages">',
    '        <h2>Read next</h2>',
    '        <ul>',
    ...related.map((/** @type {string} */ slug) => {
      const found = target.get(slug);
      return `          <li><a href="{{page.root}}${found.cluster.dir}/${found.entry.slug}.html">${escapeHtml(found.entry.title)}</a></li>`;
    }),
    '        </ul>',
    '      </nav>',
  ].join('\n');
}

// ---------------------------------------------------------------------------- shared blocks

/** @param {any[]} standing @param {string} heading */
function standingLimits(standing, heading) {
  return [
    '      <div class="boundary-block">',
    `        <h2 id="limits">${escapeHtml(heading)}</h2>`,
    `        <p>These pages describe <em>this repository at this commit</em>. None of them implies the framework
        is deployable, and none of them is a roadmap: nothing that is not merged appears on this site, in any
        tense.</p>`,
    '        <ul class="boundary-list">',
    ...standing.map((item) => (
      `          <li><strong>${escapeHtml(item.headline)}</strong> ${escapeHtml(item.text)}</li>`
    )),
    '        </ul>',
    `        <p><a href="{{page.root}}evidence.html">Every claim and every limitation</a> is on one page, and
        <a href="{{page.root}}answers.html#limits">the questions this project refuses to answer</a> are published
        beside them.</p>`,
    '      </div>',
  ].join('\n');
}

/**
 * A breadcrumb trail as an ordered list. The last item is the current page and carries no href —
 * a link to the page you are on is noise for a reader and a self-reference for a crawler.
 * @param {[string, string | null][]} trail
 */
function breadcrumbs(trail) {
  return [
    '    <nav aria-label="Breadcrumb">',
    '      <ol class="breadcrumbs">',
    ...trail.map(([name, href]) => (
      href
        ? `        <li><a href="${href}">${escapeHtml(name)}</a></li>`
        : `        <li><strong aria-current="page">${escapeHtml(name)}</strong></li>`
    )),
    '      </ol>',
    '    </nav>',
  ].join('\n');
}

/** @param {string} origin @param {[string, string][]} trail */
function breadcrumbList(origin, trail) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: trail.map(([name, path], index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name,
      item: `${origin}${path}`,
    })),
  };
}

// ---------------------------------------------------------------------------- the blog

/**
 * Read and gate `site/blog/*.md`.
 *
 * The six gates in `docs/strategy/ORGANIC_GROWTH.md` §11 become five front-matter fields and one
 * build failure. A post that does not declare the claim ids it uses, the transcript it is grounded
 * in and the human editor of record does not render — it stops the build, which is the only version
 * of an editorial gate that cannot be skipped on a deadline.
 *
 * @param {string} dir @param {any} ledger
 * @returns {{slug: string, title: string, date: string, claims: string[], transcript: string, editor: string, summary: string, body: string}[]}
 */
export function readBlogPosts(dir, ledger) {
  if (!existsSync(dir)) return [];
  const claims = new Set((ledger?.claims ?? []).map((/** @type {any} */ item) => item.id));
  const posts = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.md') || name === 'README.md') continue;
    const where = `${dir}/${name}`;
    const raw = readFileSync(join(dir, name), 'utf8');
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
    if (!match) throw new Error(`${where}: no front matter. A post opens with a --- delimited block declaring ${REQUIRED_FRONT_MATTER.join(', ')}.`);

    const front = parseFrontMatter(match[1], where);
    for (const field of REQUIRED_FRONT_MATTER) {
      const value = front[field];
      const empty = value === undefined || value === '' || (Array.isArray(value) && value.length === 0);
      if (empty) throw new Error(`${where}: front matter is missing "${field}". SITE_ARCHITECTURE.md §5 requires ${REQUIRED_FRONT_MATTER.join(', ')}, and site/blog/README.md says why.`);
    }
    if (!Array.isArray(front.claims)) throw new Error(`${where}: "claims" must be a list of ledger ids.`);
    for (const id of front.claims) {
      if (!claims.has(id)) throw new Error(`${where}: claims cites ${id}, which is not in site/claims.json. Claim ids come from the ledger and nowhere else.`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(front.date))) throw new Error(`${where}: "date" must be YYYY-MM-DD, not "${front.date}".`);

    const body = match[2];
    for (const rule of FORBIDDEN) {
      const hit = rule.pattern.exec(`${front.title}\n${body}`);
      if (hit) throw new Error(`${where}: writes "${hit[0]}" — ${rule.why}. Delete the sentence; do not soften it.`);
    }

    posts.push({
      slug: name.replace(/\.md$/, ''),
      title: String(front.title),
      date: String(front.date),
      claims: front.claims.map(String),
      transcript: String(front.transcript),
      editor: String(front.editor),
      summary: String(front.summary ?? firstParagraph(body)),
      body,
    });
  }
  return posts.sort((a, b) => (a.date < b.date ? 1 : -1));
}

/**
 * A deliberately small front-matter reader: `key: value`, `key: [a, b]`, and block lists of `- `.
 *
 * It is not YAML and does not pretend to be. A dependency would be the first one in this repository,
 * and the contract it has to read is five fields long.
 *
 * @param {string} source @param {string} where
 * @returns {Record<string, any>}
 */
function parseFrontMatter(source, where) {
  /** @type {Record<string, any>} */
  const front = {};
  let key = null;
  for (const line of source.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item) {
      if (!key || !Array.isArray(front[key])) throw new Error(`${where}: list item "${item[1]}" belongs to no key.`);
      front[key].push(unquote(item[1]));
      continue;
    }
    const pair = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!pair) throw new Error(`${where}: cannot read front-matter line "${line.trim()}".`);
    key = pair[1];
    const value = pair[2].trim();
    if (value === '') front[key] = [];
    else if (value.startsWith('[') && value.endsWith(']')) {
      front[key] = value.slice(1, -1).split(',').map((part) => unquote(part.trim())).filter(Boolean);
    } else front[key] = unquote(value);
  }
  return front;
}

/** @param {string} value */
function unquote(value) {
  return value.replace(/^['"]|['"]$/g, '').trim();
}

/** @param {string} body */
function firstParagraph(body) {
  const paragraph = body.split(/\n\s*\n/).map((block) => block.trim()).find((block) => block && !block.startsWith('#'));
  return truncate(stripInline(paragraph ?? ''), 300);
}

/**
 * @param {{posts: any[], claims: Map<string, any>, standing: any[], brand: any, origin: string}} input
 */
function blogPages({ posts, claims, standing, brand, origin }) {
  const pages = [];

  pages.push({
    path: 'blog.html',
    title: truncate(`Writing — ${brand.name.value}`, 70),
    description: assertDescription(
      posts.length === 0
        ? 'There are zero posts. The engine ships and the blog ships empty, because a post that has not been '
          + 'written is not content and a calendar is not a publication.'
        : `${posts.length} post${posts.length === 1 ? '' : 's'}. Each one declares the ledger claim ids it uses, `
          + 'the transcript it is grounded in and the named human editor of record, or it does not build.',
      'site-clusters: the blog index',
    ),
    jsonLd: [
      breadcrumbList(origin, [['Home', '/'], ['Writing', '/blog.html']]),
      {
        '@context': 'https://schema.org',
        '@type': 'ItemList',
        name: 'Writing',
        numberOfItems: posts.length,
        itemListElement: posts.map((post, index) => ({
          '@type': 'ListItem',
          position: index + 1,
          name: post.title,
          url: `${origin}/blog/${post.slug}.html`,
        })),
      },
    ],
    body: [
      '  <div class="shell">',
      breadcrumbs([['Home', '{{page.root}}index.html'], ['Writing', null]]),
      '    <header class="cluster-hero">',
      '      <p class="eyebrow">Writing</p>',
      posts.length === 0
        ? '      <h1>The engine ships; the blog ships empty.</h1>'
        : '      <h1>Writing grounded in evidence.</h1>',
      posts.length === 0
        ? `      <p><strong>There are zero posts.</strong> Nothing has been written, so nothing is listed —
        no placeholders, no editorial calendar rendered as if it were published. A post that has not been
        written is not content, and publishing the plan to write one would be exactly the roadmap-ware the
        content rules on this site forbid.</p>`
        : `      <p>${posts.length} post${posts.length === 1 ? '' : 's'}. Each one declares, in its front
        matter, the ledger claim ids it uses, the transcript it is grounded in and the named human editor of
        record — and the build fails without them.</p>`,
      '    </header>',
      '  </div>',
      '  <div class="shell">',
      '    <section>',
      ...(posts.length === 0 ? [
        '      <div class="section-block">',
        '        <h2>What has to be true before a post exists</h2>',
        `        <p>Every file in <code>site/blog/</code> declares five things before it renders: a title, a
        date, the claim ids from <span class="mono">site/claims.json</span> it uses, the transcript it is
        grounded in, and the named human editor of record. A post missing any of them fails the build rather
        than publishing — the editorial gates are mechanical, which is the only version of a gate that cannot
        be waived on a deadline.</p>`,
        `        <p>The contract is written out in <code>site/blog/README.md</code>. It exists so that
        publishing the first piece is a one-file commit rather than a project.</p>`,
        '      </div>',
      ] : [
        '      <ul class="cluster-grid">',
        ...posts.map((post) => [
          '        <li class="cluster-card">',
          `          <h2><a href="{{page.root}}blog/${escapeHtml(post.slug)}.html">${escapeHtml(post.title)}</a></h2>`,
          `          <p class="card-plain">${escapeHtml(post.date)} · edited by ${escapeHtml(post.editor)}</p>`,
          `          <p>${escapeHtml(post.summary)}</p>`,
          '        </li>',
        ].join('\n')),
        '      </ul>',
      ]),
      standingLimits(standing, 'What nothing published here would mean'),
      '    </section>',
      '  </div>',
    ].join('\n'),
  });

  for (const post of posts) {
    pages.push({
      path: `blog/${post.slug}.html`,
      title: truncate(post.title, 70),
      description: truncate(post.summary, 300),
      jsonLd: [
        breadcrumbList(origin, [['Home', '/'], ['Writing', '/blog.html'], [post.title, `/blog/${post.slug}.html`]]),
        {
          '@context': 'https://schema.org',
          '@type': 'BlogPosting',
          headline: post.title,
          description: post.summary,
          datePublished: post.date,
          dateModified: post.date,
          author: { '@type': 'Person', name: post.editor },
          editor: { '@type': 'Person', name: post.editor },
          mainEntityOfPage: { '@type': 'WebPage', '@id': `${origin}/blog/${post.slug}.html` },
          url: `${origin}/blog/${post.slug}.html`,
          isPartOf: { '@type': 'Blog', name: `Writing — ${brand.name.value}`, url: `${origin}/blog.html` },
          keywords: post.claims,
        },
      ],
      body: [
        '  <div class="shell">',
        breadcrumbs([
          ['Home', '{{page.root}}index.html'],
          ['Writing', '{{page.root}}blog.html'],
          [post.title, null],
        ]),
        '    <header class="spoke-hero">',
        `      <h1>${escapeHtml(post.title)}</h1>`,
        `      <p class="plain-name">${escapeHtml(post.date)} · edited by ${escapeHtml(post.editor)}</p>`,
        '    </header>',
        '  </div>',
        '  <div class="shell">',
        '    <section>',
        standingLimits(standing, 'What this post does not mean'),
        '      <div class="section-block">',
        renderMarkdown(post.body),
        '      </div>',
        '      <div class="evidence-rail">',
        '        <h2>The evidence this post rests on</h2>',
        claimGroup(post.claims, claims),
        group('Grounded in', [`<code>${escapeHtml(post.transcript)}</code>`]),
        group('Editor of record', [escapeHtml(post.editor)]),
        '      </div>',
        '    </section>',
        '  </div>',
      ].join('\n'),
    });
  }

  return pages;
}

/**
 * A small Markdown subset: headings, paragraphs, lists, fenced code, blockquotes, and inline code,
 * emphasis and links. Everything is HTML-escaped before any markup is added, so a post cannot inject
 * an element the shell does not expect — this site's Content-Security-Policy is `default-src 'none'`
 * and the markup it serves should not be the first thing to test that.
 *
 * @param {string} source
 */
export function renderMarkdown(source) {
  const out = [];
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  let list = null;
  let fence = null;

  const closeList = () => { if (list) { out.push(`        </${list}>`); list = null; } };

  for (const line of lines) {
    if (fence !== null) {
      if (/^```/.test(line.trim())) { out.push(`        <pre><code>${escapeHtml(fence)}</code></pre>`); fence = null; }
      else fence += `${line}\n`;
      continue;
    }
    if (/^```/.test(line.trim())) { closeList(); fence = ''; continue; }

    if (!line.trim()) { closeList(); continue; }

    const heading = /^(#{2,4})\s+(.*)$/.exec(line);
    if (heading) {
      closeList();
      const level = heading[1].length;
      out.push(`        <h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }

    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) { closeList(); out.push(`        <blockquote><p>${inline(quote[1])}</p></blockquote>`); continue; }

    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      if (list !== 'ul') { closeList(); out.push('        <ul>'); list = 'ul'; }
      out.push(`          <li>${inline(bullet[1])}</li>`);
      continue;
    }
    const numbered = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (numbered) {
      if (list !== 'ol') { closeList(); out.push('        <ol>'); list = 'ol'; }
      out.push(`          <li>${inline(numbered[1])}</li>`);
      continue;
    }

    closeList();
    out.push(`        <p>${inline(line.trim())}</p>`);
  }
  closeList();
  if (fence !== null) out.push(`        <pre><code>${escapeHtml(fence)}</code></pre>`);
  return out.join('\n');
}

/** @param {string} value */
function inline(value) {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, (_m, code) => `<code>${code}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text, href) => `<a href="${href}">${text}</a>`);
}

/** @param {string} value */
function stripInline(value) {
  return value
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/\*([^*]*)\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------- helpers

/**
 * The first sentence of a summary, capped. Summaries are 500 characters and boundary-bearing; a
 * card is a promise that the page keeps, not a place to fit the whole boundary.
 * @param {string} summary
 */
function oneLine(summary) {
  const sentence = /^(.*?[.!?])(\s|$)/.exec(String(summary).trim());
  return truncate(sentence ? sentence[1] : String(summary), 190);
}

/** Every authored string on an entry, for the vocabulary check. @param {any} entry */
function authoredStrings(entry) {
  return [
    entry.title, entry.plainName, entry.intent, entry.summary, entry.metaDescription,
    entry.recordChain?.title, entry.recordChain?.caption,
    ...(entry.recordChain?.nodes ?? []).flatMap((/** @type {any} */ node) => [node.label, node.detail, node.state]),
    entry.refusalProof?.title, entry.refusalProof?.caption, entry.refusalProof?.request,
    entry.refusalProof?.actor, entry.refusalProof?.result,
    ...(entry.boundaries ?? []),
    ...(entry.sections ?? []).flatMap((/** @type {any} */ section) => [section.heading, ...(section.body ?? [])]),
  ].filter((value) => typeof value === 'string');
}

/**
 * The one length rule every meta description on these pages obeys.
 *
 * A description is the surface always read alone — a search result, a social card, a retrieval
 * snippet — and it is the surface with the least room. Under 120 characters it is not a summary;
 * over 160 the renderer, not the author, decides which half of the sentence a reader sees, and on
 * this site the discarded half is the boundary. So the cut is made here, at build time, against a
 * string an author wrote to fit — never by truncating prose written for the page body.
 *
 * @param {string} value @param {string} where
 */
function assertDescription(value, where) {
  const text = String(value).trim();
  if (text.length < DESCRIPTION_MIN || text.length > DESCRIPTION_MAX) {
    throw new Error(
      `${where}: metaDescription is ${text.length} characters; it must be ${DESCRIPTION_MIN}-${DESCRIPTION_MAX}. `
      + 'Rewrite it to fit rather than letting a search engine choose where to cut it.',
    );
  }
  if (text.endsWith('…')) throw new Error(`${where}: metaDescription ends mid-sentence.`);
  return text;
}

export const DESCRIPTION_MIN = 120;
export const DESCRIPTION_MAX = 160;
export const TITLE_MAX = 60;

/** @param {string} value */
function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
