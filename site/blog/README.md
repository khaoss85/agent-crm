# site/blog

**There are zero posts in this directory, and that is the current state, not an oversight.**

`docs/marketing/SITE_ARCHITECTURE.md` §5 records the decision: the blog *engine* ships and the
blog ships empty. A post that has not been written is not content, and an editorial calendar
rendered as if it were published is exactly the roadmap-ware the content rules forbid. The engine
exists so that publishing the first piece is a one-file commit rather than a project.

`scripts/site-clusters.js` reads every `*.md` in this directory (this README is skipped), renders it
through `site/shell.html`, and lists it on `/blog.html`. With no posts, that index says there are
zero posts rather than showing placeholders.

---

## The front-matter contract

A post opens with a `---` delimited block. Five fields are **required**, and the build fails —
loudly, naming the file and the field — if any of them is missing or empty. The gate is mechanical
because an editorial gate that can be waived on a deadline is not a gate; these five fields are the
six gates in `docs/strategy/ORGANIC_GROWTH.md` §11 made into build failures.

| Field | Type | What it means |
|---|---|---|
| `title` | string | The `<h1>` and the `<title>`. |
| `date` | `YYYY-MM-DD` | Publication date. Any other shape fails the build. |
| `claims` | list of ledger ids | Every claim id from `site/claims.json` the piece uses. An id that is not in the ledger fails the build. **A piece that cites no claim does not build** — if it needs a claim the ledger does not carry, the ledger is the thing to fix, and it is fixed with evidence, not with a sentence. |
| `transcript` | string | The repository path of the transcript, log or command output the piece is grounded in. A post is a write-up of something that happened, and this names it. |
| `editor` | string | The named human editor of record. Not a team, not a role — a person who read it. |

`summary` is optional; without it the index card uses the first paragraph.

```markdown
---
title: What the conformance report refuses to say
date: 2026-08-14
claims: [C-11, C-12]
transcript: docs/transcripts/2026-08-12-package-conformance.md
editor: Daniele Pelleri
---

Body starts here.
```

The list may also be written as a block:

```yaml
claims:
  - C-11
  - C-12
```

## What the renderer supports

A deliberately small Markdown subset, because the alternative is this repository's first runtime
dependency: `##`–`####` headings, paragraphs, `-`/`*` and numbered lists, fenced code blocks,
blockquotes, and inline `` `code` ``, `**bold**`, `*italic*` and `[links](href)`. Everything is
HTML-escaped before any markup is added — raw HTML in a post is printed, not executed. The site
serves `default-src 'none'` with no `script-src` at all, and post markup should not be the first
thing to test that.

`#` is not rendered as a heading: the `<h1>` is the `title` field, and a second one would give the
page two.

## What a post may not say

Everything on this site is held to the same standard, and a post is not an exception:

- The vocabulary in `scripts/site-check.js` is rejected here too, at build time, naming the file and
  the phrase. `scripts/site-clusters.js` checks the title and the body against the same list.
- **No future tense about capability.** If it is not merged, it does not appear, in any tense.
- **Every factual sentence traces to a file in this repository, and cites it.** A sentence with no
  evidence is deleted rather than softened.
- The standing limitations from `site/claims.json` are rendered on every post page automatically:
  there is no authentication, tenancy or RBAC (L-01), persistence is local SQLite (L-02), there is
  no scheduler (L-04), no adapter sends anything to anyone (L-05), the build benchmark has not been
  run (L-03), and nothing is installable — the two published package names are empty reservations
  (L-08). A post cannot opt out of them.

## Adding one

Write `site/blog/<slug>.md`, then run `npm run site:build && node scripts/site-check.js`. The file
name is the URL: `site/blog/<slug>.md` becomes `/blog/<slug>.html`. The sitemap picks it up from the
emitted page set, so there is no index to update by hand.
