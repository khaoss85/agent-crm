// @ts-check

/**
 * Generates the reference pages: one hub, one page per catalogued section, and one page per job
 * that has enough to say for its own URL.
 *
 * **Why generate pages at all.** The single genuinely unique thing this project can publish is the
 * JTBD catalogue: 149 classic CRM jobs, each with a status that is conservative by policy and, for
 * the ones that pass, the test that proves it. Nobody else has that document, and it is the shape
 * both a search engine and a retrieval-augmented model want — a specific question with a specific,
 * sourced answer. Publishing it as one 63 KB JSON file and one long Markdown table is publishing it
 * for machines only.
 *
 * **Why not 149 pages.** Most of the catalogue is `not supported`, and most of those rows say the
 * same thing in the same words ("no health-scoring primitives", "no usage primitives"). A hundred
 * URLs restating a title and a one-word status is thin content by any definition, and it would be
 * this project publishing exactly the sort of page it refuses to write. So a job earns its own URL
 * only when the catalogue had something specific to say about it, and every other job still appears
 * in full on its section page. Nothing is hidden by the threshold; only the URL count changes.
 *
 * **Why the threshold is a character count.** It is a crude proxy for "the matrix had something
 * specific to say", and a crude proxy that recomputes itself beats a curated list that silently
 * stops matching the matrix the first time a row is rewritten. It is stated here, applied in one
 * place, and asserted in tests/site-pages.test.js.
 */

/**
 * Every catalogue page carries the same boundary. A status page read on its own is exactly where
 * "validated end to end" gets mistaken for "deployable", so the correction travels with each one.
 */
const LIMITS_BLOCK = `      <h2 id="limits">What a status here does not mean</h2>
      <p>These statuses describe <em>this repository at this commit</em>. None of them implies the
      framework is deployable: no authentication ships, so a deployment must supply the
      verifier before anyone but you reaches it, whatever any row says. Every claim and every limitation is on
      <a href="{{page.root}}evidence.html">one page</a>.</p>`;

/** How much the catalogue has to have written about a job before length alone earns it a URL. */
export const OWN_PAGE_MIN_SUMMARY = 150;

/**
 * What each status actually means, in the words the repository uses. An answer engine lifting a
 * status without this gloss would report "not supported" as a product limitation rather than as
 * "nobody has proved it, so we will not claim it".
 */
export const STATUS_MEANING = Object.freeze({
  'validated end to end': 'An automated test or a checked-in example proves the whole job. This is the only status that counts as evidence.',
  'partially supported': 'Part of the job works and is proved; the rest is named rather than implied. Read what is excluded before planning around it.',
  'technically supported': 'The primitives exist but no test proves the job end to end, so it is not claimed as working.',
  'not supported': 'No implementation and no test. It would have to be built. This is the default status in the catalogue — a row moves out of it only when a test proves it.',
});

/** @param {string} value */
export function slugify(value) {
  return value
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
}

/** The section name without its parenthetical status note, which belongs in the prose, not the H1. */
export function sectionTitle(section) {
  return section.replace(/\s*\([^)]*\)\s*$/, '').trim();
}

/** @param {string} section */
export function sectionNote(section) {
  const match = /\(([^)]*)\)\s*$/.exec(section);
  return match ? match[1].trim() : '';
}

/**
 * Whether a job earns its own URL.
 *
 * Length alone was the first rule, and it inverted this project's own hierarchy of value: a terse
 * row proved by four merged tests got no page, while a long paragraph explaining why something is
 * *not supported* got one. `STATUS_MEANING` says validated end to end "is the only status that
 * counts as evidence" — so a job something actually proves earns a page however briefly the matrix
 * described it. That moved twenty of the twenty-one validated jobs onto their own URLs.
 *
 * A cited **test** counts; a cited **document** does not. A design document for an unimplemented
 * track proves nothing, and counting it would have minted eight pages for `not supported` rows
 * whose entire summary is twenty-odd characters — precisely the thin content the threshold exists
 * to refuse.
 *
 * @param {any} job
 */
export function hasOwnPage(job) {
  return String(job.summary ?? '').length >= OWN_PAGE_MIN_SUMMARY || (job.tests ?? []).length > 0;
}

/**
 * @param {{jobs: any, brand: any, origin: string}} input
 * @returns {{path: string, title: string, description: string, body: string, jsonLd: any[]}[]}
 */
export function buildJobPages({ jobs, brand, origin }) {
  const all = jobs.jobs;
  const sections = [];
  for (const job of all) {
    let entry = sections.find((candidate) => candidate.section === job.section);
    if (!entry) {
      entry = { section: job.section, slug: slugify(sectionTitle(job.section)), jobs: [] };
      sections.push(entry);
    }
    entry.jobs.push(job);
  }

  const owned = new Map(all.filter(hasOwnPage).map((job) => [job.id, true]));

  /**
   * A section earns a URL only when at least one of its jobs did.
   *
   * The threshold used to apply to leaves alone, so ten sections whose every row it had judged too
   * thin for a URL got one anyway — the thin content was not denied a URL, it was aggregated into
   * one. `/jobs/content.html` was the string "MK3" five times. Those sixty-five rows are listed in
   * full on the hub instead: readable, and not pretending to be nine more destinations.
   */
  for (const entry of sections) entry.earnsPage = entry.jobs.some((job) => owned.has(job.id));
  const hubSections = sections.filter((entry) => entry.earnsPage);
  const foldedSections = sections.filter((entry) => !entry.earnsPage);

  const pages = [];

  // ------------------------------------------------------------------ the hub
  pages.push({
    path: 'jobs.html',
    title: `Every CRM job, and whether ${brand.name.value} does it`,
    description:
      `All ${all.length} catalogued CRM jobs with their status and, where the matrix names one, the test that proves it: `
      + `${count(all, 'validated end to end')} validated end to end, ${count(all, 'partially supported')} partially supported, `
      + `${count(all, 'not supported')} not supported. Conservative by policy — a job moves only when a test proves it.`,
    jsonLd: [breadcrumbs(origin, [['Home', '/'], ['CRM jobs', '/jobs.html']])],
    body: [
      hero(
        'The catalogue',
        `Every CRM job, and whether ${escapeHtml(brand.name.value)} does it.`,
        `<p class="lede">This is the honest inventory: ${all.length} jobs a CRM is normally expected to do, each with a
         status and, where it passes, the test that proves it. <strong>“Not supported” is the default.</strong> A row
         moves out of it only when an automated test or a checked-in example proves the whole job — which is why
         ${count(all, 'not supported')} of ${all.length} are still in that column, and why the ones that are not
         mean something.</p>`,
      ),
      '  <div class="shell">',
      '    <section>',
      statusLegend(),
      `      <p class="section-lede">The same catalogue is published as machine-readable JSON at
        <a href="{{page.root}}jobs.json"><span class="mono">/jobs.json</span></a>, generated from
        <span class="mono">docs/benchmarks/CRM_JTBD_MATRIX.md</span> and kept in step with it by a test.</p>`,
      '      <table class="ledger">',
      '        <thead><tr><th>Area</th><th>Jobs</th><th>Where it stands</th></tr></thead>',
      '        <tbody>',
      ...hubSections.map((entry) => [
        '          <tr>',
        `            <td><a href="{{page.root}}jobs/${entry.slug}.html">${escapeHtml(sectionTitle(entry.section))}</a>`,
        sectionNote(entry.section) ? `<p class="limit">${escapeHtml(sectionNote(entry.section))}</p></td>` : '</td>',
        `            <td class="mono">${entry.jobs.length}</td>`,
        `            <td>${statusBar(entry.jobs)}</td>`,
        '          </tr>',
      ].join('\n')),
      '        </tbody>',
      '      </table>',
      ...(foldedSections.length ? [
        `      <h2 id="unbuilt">The ${foldedSections.reduce((sum, entry) => sum + entry.jobs.length, 0)} jobs with no page of their own</h2>`,
        `      <p class="section-lede">These areas are catalogued and unbuilt, and the matrix had a line or two to say
        about each. They are listed here in full rather than spread over ${foldedSections.length} further URLs, because
        a page whose body is a milestone code repeated five times is a page this project would be publishing against
        its own rules.</p>`,
        ...foldedSections.map((entry) => [
          `      <h3>${escapeHtml(sectionTitle(entry.section))}</h3>`,
          sectionNote(entry.section) ? `      <p class="limit">${escapeHtml(sectionNote(entry.section))}</p>` : '',
          '      <ul class="plain">',
          ...entry.jobs.map((job) => (
            `        <li id="${escapeHtml(job.id)}"><span class="mono muted">${escapeHtml(job.id)}</span> `
            + `<strong>${escapeHtml(job.title)}</strong> — <span class="pill ${statusClass(job.status)}">${escapeHtml(job.status)}</span>`
            + `${job.summary ? ` ${escapeHtml(stripMarkdown(job.summary))}` : ''}</li>`
          )),
          '      </ul>',
        ].filter(Boolean).join('\n')),
      ] : []),
      LIMITS_BLOCK,
      '    </section>',
      '  </div>',
    ].join('\n'),
  });

  // ------------------------------------------------------- one page per section
  for (const entry of hubSections) {
    const name = sectionTitle(entry.section);
    const note = sectionNote(entry.section);
    pages.push({
      path: `jobs/${entry.slug}.html`,
      title: truncate(`${name} — CRM job status`, 70),
      description: truncate(
        `${entry.jobs.length} catalogued CRM jobs under ${name}: `
        + `${count(entry.jobs, 'validated end to end')} validated end to end, `
        + `${count(entry.jobs, 'partially supported')} partially supported, `
        + `${count(entry.jobs, 'not supported')} not supported, each with the evidence the matrix names for it, where it names one.`,
        300,
      ),
      jsonLd: [
        breadcrumbs(origin, [['Home', '/'], ['CRM jobs', '/jobs.html'], [name, `/jobs/${entry.slug}.html`]]),
        {
          '@context': 'https://schema.org',
          '@type': 'ItemList',
          name: `${name} — CRM job status`,
          numberOfItems: entry.jobs.length,
          itemListElement: entry.jobs.map((job, index) => ({
            '@type': 'ListItem',
            position: index + 1,
            // The status is the whole point of the list, and a parser that reads only the markup
            // has to get it. Without this the block said "CRM job status" and carried none.
            name: `${job.title} — ${job.status}`,
            ...(owned.has(job.id) ? { url: `${origin}/jobs/${job.id.toLowerCase()}.html` } : {}),
          })),
        },
      ],
      body: [
        hero(
          'CRM job catalogue',
          escapeHtml(name),
          `${note ? `<p class="lede">${escapeHtml(note)}</p>` : ''}
           <p class="lede">${entry.jobs.length} jobs in this area. ${escapeHtml(statusSentence(entry.jobs))}</p>`,
        ),
        '  <div class="shell">',
        '    <section>',
        statusLegend(),
        ...entry.jobs.map((job) => jobCard(job, owned.has(job.id))),
        LIMITS_BLOCK,
        `      <p class="section-lede"><a href="{{page.root}}jobs.html">All ${all.length} catalogued jobs</a> ·
          <a href="{{page.root}}jobs.json"><span class="mono">/jobs.json</span></a> ·
          <a href="{{page.root}}evidence.html">the claims ledger</a></p>`,
        '    </section>',
        '  </div>',
      ].join('\n'),
    });
  }

  // ----------------------------------------------------------- one page per job
  for (const entry of hubSections) {
    const name = sectionTitle(entry.section);
    for (const job of entry.jobs) {
      if (!owned.has(job.id)) continue;
      const siblings = entry.jobs.filter((other) => other.id !== job.id).slice(0, 8);
      pages.push({
        path: `jobs/${job.id.toLowerCase()}.html`,
        title: truncate(job.title, 70),
        description: truncate(boundaryFirst(job, name), 300),
        jsonLd: [
          breadcrumbs(origin, [
            ['Home', '/'], ['CRM jobs', '/jobs.html'], [name, `/jobs/${entry.slug}.html`],
            [job.title, `/jobs/${job.id.toLowerCase()}.html`],
          ]),
        ],
        body: [
          hero(
            `${escapeHtml(job.id)} · ${escapeHtml(name)}`,
            escapeHtml(job.title),
            `<p class="lede"><strong>${escapeHtml(job.status)}.</strong>
              ${escapeHtml(STATUS_MEANING[job.status] ?? '')}</p>`,
          ),
          '  <div class="shell">',
          '    <section>',
          '      <h2>What the catalogue records</h2>',
          `      <p>${escapeHtml(stripMarkdown(job.summary))}</p>`,
          evidenceBlock(job),
          `      <h2 id="limits">What this status does not mean</h2>
      <p>A status here describes <em>this repository at this commit</em>, nothing more. It is not a
      statement about what a CRM should do, and it is not a roadmap commitment. The whole framework
      ships no authentication, so no status on this
      page implies you can deploy it. The boundaries are listed in full on
      <a href="{{page.root}}evidence.html">the claims ledger</a>.</p>`,
          siblings.length ? [
            `      <h2>Other jobs in ${escapeHtml(name)}</h2>`,
            '      <ul class="plain">',
            ...siblings.map((other) => {
              const href = owned.has(other.id)
                ? `{{page.root}}jobs/${other.id.toLowerCase()}.html`
                : `{{page.root}}jobs/${entry.slug}.html#${escapeHtml(other.id)}`;
              return `        <li><a href="${href}">${escapeHtml(other.title)}</a> — ${escapeHtml(other.status)}</li>`;
            }),
            '      </ul>',
          ].join('\n') : '',
          `      <p class="section-lede"><a href="{{page.root}}jobs/${entry.slug}.html">All ${entry.jobs.length} jobs in ${escapeHtml(name)}</a> ·
            <a href="{{page.root}}jobs.html">the whole catalogue</a></p>`,
          '    </section>',
          '  </div>',
        ].join('\n'),
      });
    }
  }

  return pages;
}

/** @param {any[]} jobs @param {string} status */
function count(jobs, status) {
  return jobs.filter((job) => job.status === status).length;
}

/** @param {any[]} jobs */
function statusSentence(jobs) {
  const parts = Object.keys(STATUS_MEANING)
    .map((status) => [status, count(jobs, status)])
    .filter(([, total]) => Number(total) > 0)
    .map(([status, total]) => `${total} ${status}`);
  return `${parts.join(', ')}.`;
}

/** @param {any[]} jobs */
function statusBar(jobs) {
  return Object.keys(STATUS_MEANING)
    .map((status) => [status, count(jobs, status)])
    .filter(([, total]) => Number(total) > 0)
    .map(([status, total]) => `<span class="pill ${statusClass(String(status))}">${total} ${escapeHtml(String(status))}</span>`)
    .join(' ');
}

/** @param {string} status */
function statusClass(status) {
  if (status === 'validated end to end') return 'ok';
  if (status === 'not supported') return 'no';
  return 'part';
}

function statusLegend() {
  return [
    '      <div class="legend">',
    ...Object.entries(STATUS_MEANING).map(([status, meaning]) => (
      `        <p><span class="pill ${statusClass(status)}">${escapeHtml(status)}</span> ${escapeHtml(meaning)}</p>`
    )),
    '      </div>',
  ].join('\n');
}

/** @param {any} job @param {boolean} hasPage */
function jobCard(job, hasPage) {
  const heading = hasPage
    ? `<a href="{{page.root}}jobs/${job.id.toLowerCase()}.html">${escapeHtml(job.title)}</a>`
    : escapeHtml(job.title);
  return [
    `      <div class="limit-card" id="${escapeHtml(job.id)}">`,
    `        <h3><span class="mono muted">${escapeHtml(job.id)}</span> · ${heading}</h3>`,
    `        <p><span class="pill ${statusClass(job.status)}">${escapeHtml(job.status)}</span></p>`,
    // A job with its own URL gets a lead-in here and the full paragraph there, so the same text is
    // not the substance of two indexable pages. A job with no page of its own is printed in full,
    // because this is the only place it is readable.
    job.summary
      ? `        <p>${escapeHtml(hasPage ? truncate(stripMarkdown(job.summary), 180) : stripMarkdown(job.summary))}</p>`
      : '',
    `        <div class="evidence">${chips(job)}</div>`,
    '      </div>',
  ].filter(Boolean).join('\n');
}

/** @param {any} job */
function evidenceBlock(job) {
  const tests = job.tests ?? [];
  const docs = job.docs ?? [];
  if (tests.length === 0 && docs.length === 0) {
    // Two very different situations share this branch, and conflating them produced pages that
    // contradicted themselves inside one screen.
    const proved = job.status === 'validated end to end' || job.status === 'partially supported';
    return `      <h2>Evidence</h2>
      <p>${proved
        ? 'This row carries no test path of its own in the structured index. The matrix records the '
          + 'evidence for it in a block shared with neighbouring rows, which <span class="mono">jobs.json</span> '
          + 'does not split per row — so read <span class="mono">docs/benchmarks/CRM_JTBD_MATRIX.md</span> '
          + 'for it. The status above was set from that evidence, not from its absence.'
        : 'This row names no test and no document of its own, and its status does not claim one. '
          + 'Treat it as unbuilt: nothing here proves it, and nothing here says otherwise.'}</p>`;
  }
  return [
    '      <h2>Evidence</h2>',
    tests.length ? `      <p>Proved by ${tests.length === 1 ? 'this test' : 'these tests'}, which run on every push:</p>` : '',
    tests.length ? `      <div class="evidence">${tests.map((path) => `<code>${escapeHtml(path)}</code>`).join('')}</div>` : '',
    docs.length ? '      <p>Described in:</p>' : '',
    docs.length ? `      <div class="evidence">${docs.map((path) => `<code>${escapeHtml(path)}</code>`).join('')}</div>` : '',
  ].filter(Boolean).join('\n');
}

/** @param {any} job */
function chips(job) {
  return [...(job.tests ?? []), ...(job.docs ?? [])]
    .map((path) => `<code>${escapeHtml(path)}</code>`)
    .join('');
}

/** @param {string} eyebrow @param {string} heading @param {string} lede */
function hero(eyebrow, heading, lede) {
  return [
    '  <div class="shell">',
    '    <header class="hero">',
    `      <p class="eyebrow">${eyebrow}</p>`,
    `      <h1>${heading}</h1>`,
    lede,
    '    </header>',
    '  </div>',
  ].join('\n');
}

/** @param {string} origin @param {[string, string][]} trail */
function breadcrumbs(origin, trail) {
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

/**
 * The matrix is Markdown, and its emphasis markers travel into jobs.json. They read as noise in a
 * meta description and as literal asterisks in a search result.
 * @param {string} value
 */
export function stripMarkdown(value) {
  return String(value ?? '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/\*([^*]*)\*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** @param {string} value @param {number} limit */
export function truncate(value, limit) {
  const text = String(value ?? '').trim();
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit - 1);
  const boundary = cut.lastIndexOf(' ');
  return `${(boundary > limit * 0.6 ? cut.slice(0, boundary) : cut).trimEnd()}…`;
}

/** @param {string} value */
function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * The answer pages, and the page that lists what this project refuses to answer.
 *
 * The shape is deliberate. A question and a two-line stance are written by a human in
 * `site/answers.json`; **the substance is the ledger, rendered verbatim**. An answer page that
 * paraphrased its own evidence would be a fourth place for a claim to drift, and the whole point of
 * the ledger is that there is one.
 *
 * The refused list is published rather than kept internal. A project that answers every question an
 * answer engine might ask is a project that is making some of them up, and the fifteen questions
 * here — production readiness, a benchmark that has not been run, competitor comparisons, adoption
 * numbers, compliance — are exactly the ones where the pressure to invent is highest.
 *
 * @param {{answers: any, ledger: any, brand: any, origin: string}} input
 */
export function buildAnswerPages({ answers, ledger, brand, origin }) {
  const claims = new Map(ledger.claims.map((/** @type {any} */ claim) => [claim.id, claim]));
  const limitations = new Map(ledger.limitations.map((/** @type {any} */ item) => [item.id, item]));
  const pages = [];

  pages.push({
    path: 'answers.html',
    title: truncate(`Straight answers about ${brand.name.value}`, 70),
    description: truncate(
      `${answers.questions.length} questions answered from the claims ledger, each naming the evidence that holds it — `
      + `and ${answers.refused.length} this project will not answer yet, with the reason for each.`,
      300,
    ),
    jsonLd: [breadcrumbs(origin, [['Home', '/'], ['Answers', '/answers.html']])],
    body: [
      hero(
        'Answers',
        'Straight answers, and the questions we refuse.',
        `<p class="lede">Every answer below is assembled from <a href="{{page.root}}evidence.html">the claims ledger</a>:
         the sentences are the ledger's own, and each one carries the limitation that travels with it. The lede on each
         page summarises; the claim below it is quoted. Below them are ${answers.refused.length} questions this project
         <strong>will not answer yet</strong> — a benchmark that has not been run, comparisons nobody measured,
         adoption numbers that do not exist — with the reason in each case.</p>`,
      ),
      '  <div class="shell">',
      '    <section>',
      '      <h2>Answered</h2>',
      '      <ul class="plain">',
      ...answers.questions.map((entry) => (
        `        <li><a href="{{page.root}}answers/${escapeHtml(entry.slug)}.html">${escapeHtml(entry.question)}</a></li>`
      )),
      '      </ul>',
      '      <h2 id="limits">Refused, and why</h2>',
      `      <p class="section-lede">These have no honest answer in the ledger today. When one exists — when a
        benchmark runs, when the production spine lands — the question moves up the page. Until then this list is the
        answer.</p>`,
      ...answers.refused.map((entry) => [
        '      <div class="limit-card">',
        // Marked so the overclaim gate can skip the quotation without skipping the page. It only
        // ever holds a question published in site/answers.json's refused list, and site-check.js
        // proves that — so the exemption cannot carry a sentence this project is actually making.
        `        <h3 class="refused-question">${escapeHtml(entry.question)}</h3>`,
        `        <p>${escapeHtml(entry.why)}</p>`,
        '      </div>',
      ].join('\n')),
      '    </section>',
      '  </div>',
    ].join('\n'),
  });

  for (const entry of answers.questions) {
    const cited = [
      ...entry.claims.map((/** @type {string} */ id) => claims.get(id)).filter(Boolean),
      ...entry.limitations.map((/** @type {string} */ id) => limitations.get(id)).filter(Boolean),
    ];
    pages.push({
      path: `answers/${entry.slug}.html`,
      title: truncate(entry.question, 70),
      description: entry.snippet ?? truncate(stripMarkdown(entry.answer), 300),
      jsonLd: [
        breadcrumbs(origin, [['Home', '/'], ['Answers', '/answers.html'], [entry.question, `/answers/${entry.slug}.html`]]),
        {
          '@context': 'https://schema.org',
          '@type': 'FAQPage',
          mainEntity: [{
            '@type': 'Question',
            name: entry.question,
            acceptedAnswer: { '@type': 'Answer', text: stripMarkdown(entry.answer) },
          }],
        },
      ],
      body: [
        hero('Answer', escapeHtml(entry.question), `<p class="lede">${escapeHtml(entry.answer)}</p>`),
        '  <div class="shell">',
        '    <section>',
        '      <h2>What the ledger says, word for word</h2>',
        `      <p class="section-lede">Each entry below is copied from <span class="mono">site/claims.json</span>,
        where it is bound to the evidence that holds it — a test file, a document, or a named repository fact — and to
        the limitation that travels with it. The answer above summarises these; these are the claim.</p>`,
        ...cited.map((item) => [
          '      <div class="limit-card">',
          `        <h3><span class="mono muted">${escapeHtml(item.id)}</span>${item.headline ? ` · ${escapeHtml(item.headline)}` : ''}</h3>`,
          `        <p>${escapeHtml(item.text)}</p>`,
          item.limitation ? `        <p class="limit"><b>Limit</b>${escapeHtml(item.limitation)}</p>` : '',
          `        <div class="evidence">${evidenceChipsOf(item)}</div>`,
          '      </div>',
        ].filter(Boolean).join('\n')),
        `      <h2 id="limits">Where this stops</h2>
      <p>Nothing on this page implies deployment readiness. The framework ships no authentication
      verifier; authorization is framework-enforced; tenant isolation is one tenant per application
      instance, not shared-database row tenancy. Read the exact repository posture before deployment.
      <a href="{{page.root}}evidence.html">Every claim and every limitation</a> is on one page, and
      <a href="{{page.root}}answers.html#limits">the questions this project refuses to answer</a> are
      published beside them.</p>`,
        '    </section>',
        '  </div>',
      ].join('\n'),
    });
  }

  return pages;
}

/** @param {any} item */
function evidenceChipsOf(item) {
  const evidence = item.evidence ?? {};
  const chipList = [...(evidence.tests ?? []), ...(evidence.docs ?? []), ...(evidence.repoFacts ?? [])];
  if (evidence.jtbd) chipList.unshift(evidence.jtbd);
  return chipList.map((chip) => `<code>${escapeHtml(chip)}</code>`).join('');
}

/**
 * The meta description for a job page, boundary first.
 *
 * A description is the one surface always read alone — in a result list, in a social card, in a
 * retrieval snippet — and truncating a capability-first sentence at 300 characters reliably cut the
 * limitation off, publishing the half of the sentence this project exists not to publish. So the
 * status leads, and where the matrix wrote an explicit exclusion, that leads the rest.
 *
 * @param {any} job @param {string} sectionName
 */
export function boundaryFirst(job, sectionName) {
  const summary = stripMarkdown(job.summary ?? '');
  const excluded = /\bNOT included:\s*(.+)$/i.exec(summary) ?? /\bNOT\b[^.]*:\s*(.+)$/.exec(summary);
  const head = `${job.title} — ${job.status} in ${sectionName}.`;
  if (excluded) return `${head} Not included: ${excluded[1]}`;
  return `${head} ${summary}`;
}
