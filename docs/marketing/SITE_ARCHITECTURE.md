# Site architecture

The information architecture of the public site, and the contract every generated
cluster follows. This is the decision document; `scripts/site-clusters.js` is its
implementation and `scripts/site-check.js` is its enforcement.

---

## 1. Why the site is a hub-and-spoke, and not a landing page with a blog

A coding agent and a search engine want the same thing and neither of them wants a
homepage: a page that answers **one** question completely, links to the neighbouring
questions, and states its own boundary. That is the hub-and-spoke model — a pillar
page for a topic, ten to twenty spokes each owning one sub-question, every spoke
linking back to its pillar with descriptive anchor text.

We already had two clusters and did not call them that: `jobs.html` over 68 job pages,
and `answers.html` over 15 answer pages. Both are generated from a structured source
with evidence attached to every row. **That is the pattern; the rest of the site is
built the same way, or it is not built.**

The reason is not tidiness. `scripts/site-check.js` scans every emitted page for
overclaims and refuses to ship a capability sentence that no test holds. A hand-written
marketing page cannot pass that gate reliably, and a page that has to be argued past a
gate is a page that will eventually be argued past it wrongly. So content lives in JSON
with evidence paths, and pages are a rendering of it.

## 2. The five clusters

| Cluster | Pillar | Spokes | Answers the question |
|---|---|---|---|
| **Capabilities** | `capabilities.html` | 6 | "can it do *my* commercial process?" |
| **Agent tools** | `tools.html` | 8 | "what can my coding agent actually do here?" |
| **Concepts** | `concepts.html` | 8 | "why is it built this way?" |
| **Compare** | `compare.html` | 4 | "why this and not that?" |
| **Jobs** *(exists)* | `jobs.html` | 68 | "is this specific job supported?" |
| **Answers** *(exists)* | `answers.html` | 15 | a direct question, directly answered |

**Capabilities is the commercial entry point and Jobs is its evidence.** A visitor
searching "quote approval workflow" lands on a capability page; the JTBD rows that prove
it are one link away and say `not supported` where that is true. Neither page could do
both jobs: the capability page would drown in 68 rows, and the job page has no room to
explain what the domain is for.

### Internal linking rules

1. Every spoke links **up** to its pillar, in a breadcrumb, on every page.
2. Every pillar links **down** to all its spokes.
3. Capability spokes link **across** to the job pages that prove them, and to the
   answers that address them. Tool spokes link across to the capability they serve.
4. Anchor text is the target's own name. No "click here", no "learn more".
5. A cross-link is only written when the target page exists. The generator resolves
   every internal href against the emitted set and fails the build on a dead one —
   an internal 404 is a defect, not a cosmetic issue.

### URL shape

`<cluster>/<slug>.html`, lowercase, hyphenated, no dates, no IDs. `cleanUrls` stays
`false`: the existing 79 pages already link with the extension, and the screenshot
harness loads the site over `file://` where extensionless paths do not resolve.

## 3. The content contract

Four new sources, all in `site/`, all with the same shape. Every one is read by
`scripts/site-clusters.js` and validated before a page is written.

```jsonc
{
  "<name>Contract": 1,
  "entries": [
    {
      "id": "quote-to-cash",              // stable, never reused
      "slug": "quote-to-cash-cpq",        // the URL
      "title": "…",                       // the <h1> and <title>
      "plainName": "…",                   // the second, plain-English name
      "intent": "…",                      // the phrase a person actually types
      "summary": "…",                     // ≥150 chars, boundary-first
      "sections": [                       // the body, in order
        { "heading": "…", "body": ["paragraph", …] }
      ],
      "recordChain": {                    // optional; only when record order is the argument
        "title": "…",
        "caption": "…",
        "nodes": [
          { "label": "…", "detail": "…", "state": "working | partial" }
        ]
      },
      "refusalProof": {                   // optional; only when a tested refusal is the argument
        "title": "…",
        "caption": "…",
        "request": "POST …",
        "actor": "{ type: … }",
        "result": "403 …"
      },
      "responsibilityMap": {              // optional; only when two layers divide one job
        "title": "…",
        "caption": "…",
        "bridge": "…",                   // says whether the connection actually exists
        "layers": [                       // exactly two
          {
            "label": "Profile layer",
            "name": "…",
            "owns": ["…", "…", "…"],   // exactly three bounded responsibilities
            "doesNotOwn": "…"
          }
        ]
      },
      "boundaries": ["…"],                // REQUIRED, non-empty — what it does not do
      "claims": ["C-06"],                 // ledger ids, must exist in claims.json
      "limitations": ["L-04"],            // ledger ids, must exist in claims.json
      "jobs": ["JTBD-CO-01"],             // ids that must exist in jobs.json
      "docs": ["docs/COMMERCIAL_OPERATIONS.md"],  // must exist on disk
      "tests": ["tests/commercial-e2e.test.js"],  // must exist on disk
      "related": ["signature-to-order"]   // slugs in any cluster
    }
  ]
}
```

**`boundaries` is required and the page renders it above the fold, not in a footnote.**
A capability page whose boundary list is empty is a page that claims completeness, and
completeness is the one thing four ledger limitations contradict.

**`claims` and `limitations` are ledger ids, never prose.** The page prints the ledger's
own sentence. If a capability has nothing in the ledger to cite, the honest page says
what the code does and cites `docs` and `tests` — it does not invent a claim, and it
does not get a claim added to the ledger to justify a marketing sentence.

**`recordChain` is optional and semantic.** It is reserved for a page whose subject is an
ordered chain of records the framework owns; the renderer emits an `<ol>`, not an image.
It must contain two to eight nodes, and every node states whether that slice is a validated
path or a partial domain. A decorative process diagram, or a chain whose order carries no
meaning, does not clear this contract.

**`refusalProof` is optional and semantic.** It is reserved for a page whose argument is a
tested server refusal. The shape is deliberately closed: request, asserted actor and
machine-readable result, plus a title and a caption that name the proof's scope. The
renderer escapes every authored field and places the receipt after the mandatory boundary
but before the essay. Every field is non-blank, single-line and bounded (`title` 140,
`caption` 300, `request` 500, `actor` 300, `result` 160 characters); unknown fields fail
the build. A sample response that no test asserts, or a generic code panel used only for
visual emphasis, does not clear this contract.

**`responsibilityMap` is optional and semantic.** It is reserved for a page whose argument is
that exactly two systems or layers answer different questions. The shape is deliberately fixed:
two layers, three owned responsibilities per layer, one explicit non-responsibility per layer and
one bridge sentence. Every string is non-blank, single-line, bounded and escaped; unknown fields
fail the build. The bridge sentence must say whether the connection exists — a connector line that
silently implies an integration does not clear this contract. The CDP + CRM page uses the map to
separate profile ownership from process ownership while stating that Accordo ships no connector.

## 4. What may not be written

The overclaim scan in `scripts/site-check.js` is the floor, not the ceiling. It rejects:

> production-ready · enterprise-grade · SOC 2 / ISO 27001 / HIPAA / GDPR-compliant ·
> bank-grade · fastest / best / leading / world-class / revolutionary / game-changing ·
> guarantee · any *N*% success or build rate · fully autonomous · replaces Salesforce ·
> zero-config · trusted by

Above the floor, three rules that no regex enforces:

1. **No future tense about capability.** "will support" is roadmap-ware. If it is not
   merged, the page does not mention it, in any tense.
2. **No competitor claim without a citation and a `verifiedOn` date.** Competitors ship;
   an uncited comparison is wrong within a quarter and reads as dishonest rather than
   stale. Comparison content comes from `docs/strategy/COMPETITOR_MAP.md` and inherits
   its citations, or it is not published.
3. **No number that is not measured.** The test count, the job counts and the tour
   counts come from the ledger and the generated indexes, never from a sentence.

## 5. The blog

The blog **engine** originally shipped empty. The first post now ships from
`site/blog/if-a-coding-agent-builds-your-crm-what-should-it-refuse-to-do.md`.

`site/blog/*.md` renders through the same shell, with front-matter that must declare
the claim ids the piece uses, the transcript it is grounded in, and the named human
editor of record — the six gates in `docs/strategy/ORGANIC_GROWTH.md` §11, made
mechanical. `scripts/site-clusters.js` fails the build on a post missing any of them.

The renderer still has an honest zero-post state rather than showing
placeholders. This repository has crossed that state once: the first post names
its claims, transcript and editor, and the build refuses it if any of those
artifacts disappears. An editorial calendar is still not published content.

## 6. What is deliberately absent

- **No newsletter capture, no pricing page, no testimonials.** There is nothing to
  charge for, nobody to quote, and a form that collects an address we have no policy for
  is a decision nobody has taken (`PENDING_HUMAN_SUBMISSION.md` §4).
- **No case studies.** They require builds that have happened.
- **No "customers" or "used by".** There are none.

## Related

`CONTENT_PILLARS.md` (what to write) · `CONTENT_PRODUCTION.md` (per-channel cadence) ·
`docs/strategy/ORGANIC_GROWTH.md` (the six gates) ·
`docs/strategy/GTM_TECHNICAL_EVIDENCE_HANDOFF.md` (**the authority on what may be said**) ·
`docs/strategy/RECOMMENDATION_MAP.md` (which intents should reach us at all)
