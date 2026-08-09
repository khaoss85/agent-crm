# First GTM article

## Goal and user-visible outcome

Publish the first evidence-backed article on the Accordo site. It should answer a
high-intent question coding-agent users ask when considering a custom CRM: what
must the agent be structurally unable to decide? The finished page is canonical,
indexable, and suitable for adapted syndication to DEV Community and Indie
Hackers without presenting the pre-launch repository as an installable product.

## Current repository context

- `docs/strategy/MASTER_PLAN.md`, `CATEGORY.md`, `AGENT_DISCOVERY.md` and
  `ORGANIC_GROWTH.md` separate task-time retrieval from global recommendation.
- `docs/marketing/CONTENT_PILLARS.md` selects the refusal surface as the first
  article and binds it to the approval tests.
- `site/blog/README.md` requires title, date, ledger claims, a transcript and a
  named human editor of record.
- Claims C-04, C-16 and C-21 in `site/claims.json` carry the approval, audit and
  discounted-quote evidence and their limitations.
- The repository is pre-launch. `npm create accordo` is an empty reservation,
  there is no auth, tenancy or RBAC, and the benchmark has not been run.

## Milestones

1. Record the focused test command and its complete result in a durable
   transcript.
2. Add one canonical article that teaches the refusal-surface idea, maps the
   relevant CRM intent to Accordo, and states the current fit boundary.
3. Build and gate every public surface, then run the repository verification.
4. Adapt the canonical piece for DEV Community and Indie Hackers once their
   authenticated publishing sessions are available.

## Validation

- `node --no-warnings --test --test-name-pattern='approval workflow rejects an agent pretending to make the human decision' tests/workflow.test.js`
  passes one test with zero failures.
- `npm run gtm:check` accepts the article and regenerated site.
- `npm run verify` passes.
- The emitted sitemap contains the article URL and the generated page contains
  the claim limitations.

## Progress log

- 2026-08-09: read the strategy, status, positioning, distribution, evidence
  handoff, editorial gate and live `llms.txt`.
- 2026-08-09: re-ran the named approval-refusal test: 1 passed, 0 failed.
- 2026-08-09: publishing sessions checked; both external sites currently require
  fresh interactive authentication.
- 2026-08-09: transcript, canonical article and Indie Hackers adaptation added.
- 2026-08-09: `npm run gtm:check` passed. The generated site contains 108 pages
  and both `llms.txt` variants match their sources.
- 2026-08-09: `npm run verify` reached 741 tests: 740 passed and one unrelated
  existing test failed because macOS BSD `find` rejects GNU-style
  `-newermt @0` in `tests/project-doctor.test.js`.
- 2026-08-09: published the adapted discussion to Indie Hackers and the full
  article to DEV Community. Anonymous HTTP checks return 200 for both and both
  contain links to the live answer page, evidence ledger and `llms.txt`.
- 2026-08-09: live re-verification confirmed both external URLs return 200. The
  DEV article is id `4354255`, published at `2026-08-09T15:25:09Z`, with zero
  comments and zero reactions at the first receipt. The Accordo canonical URL
  still returned 404 because this source change had not yet been merged or
  deployed; the repository's three stale "zero posts" statements were updated
  in the same change rather than left contradicting the new artifact.
- 2026-08-09: the full local verification proved the article introduced no
  regression: 741/742 tests passed, with the sole failure still the GNU-only
  project-doctor mutation assertion on macOS. The gate itself was then made
  portable with a Node filesystem inventory that also detects modification,
  not merely create/move/remove; this is the same focused correction already
  adversarially validated on PR #43, carried here without its bootstrap changes
  so the canonical content release can satisfy its own gate independently.
- 2026-08-09: final verification green: `npm run verify` checked 248
  JavaScript files and passed **742/742** tests. The focused site + doctor run
  passed 40/40, `npm run gtm:check` passed, the built site contains 108 pages,
  and the canonical article is present in the blog index, sitemap, `llms.txt`
  and `llms-full.txt`.
- 2026-08-09: adversarial rendering review found the populated blog index still
  rendered the old empty-state H1 and the article exposed no `BlogPosting`
  structured data. It also found that the LLM index had introduced a second
  front-matter parser. The index heading now branches on real post count, each
  article emits bounded `BlogPosting` JSON-LD, and `generate-llms.js` reuses
  `readBlogPosts` so there is one editorial contract. The discovery regression
  asserts all three corrections.
- 2026-08-09: submitted the technical article to Hacker News as a normal link,
  not as a Show HN launch. Item `49232416` is live; the future product launch
  remains a separate artifact.
- 2026-08-09: the public-claims CI failure was a shallow-checkout defect rather
  than a claims failure: `site-check` could not resolve historical measurement
  commit `9958ed9`. The job now fetches full history before verifying the ledger.
- 2026-08-09: adversarial browser smoke covered the generated article at desktop
  width and the populated Writing index at a real 390 px emulated viewport. The
  mobile document's viewport and scroll widths both measured 390 px; the status
  banner, navigation, heading, article card and limitation block rendered without
  clipping or horizontal overflow.
- 2026-08-09: re-verification at head `38d5a97` passed 742/742 tests, the seven
  focused SEO tests and the complete `gtm:check` gate. Both GitHub
  `public-claims` jobs passed after the full-history checkout correction.

## Decision log

- Use a category/engineering article, not a launch announcement. The former is
  an unblocked compounding asset; the latter would spend a first impression while
  the public npm command still installs nothing.
- Lead with the user intent and general engineering lesson, then name Accordo as
  a concrete implementation. This makes the piece useful even to readers who do
  not adopt the project and makes the recommendation boundary retrievable.
- Name Daniele Pelleri as editor of record, but do not treat the article as
  externally published until he has reviewed the rendered draft.

## Outcome and follow-up

The first canonical article and its adapted external versions are ready and the
public-content gates pass. The two external versions are live:

- `https://dev.to/dpelleri/if-a-coding-agent-builds-your-crm-what-should-it-refuse-to-do-5cke`
- `https://www.indiehackers.com/post/what-should-a-coding-agent-be-structurally-unable-to-do-in-a-crm-484d2d2862`
- `https://news.ycombinator.com/item?id=49232416`

The initial repository-wide verification was not green because the
project-doctor immutability test invoked a GNU-only `find` date literal on
macOS. That test is now platform-independent and the final verification receipt
below is the authority for deployment. The external posts were published before
that correction and therefore link only to already-live evidence surfaces.
The technical Hacker News submission is live. A distinct Show HN product launch
remains deliberately unspent until the install path is real.

The DEV copy currently declares its own DEV URL as canonical because the
Accordo page did not exist when it was published. After the Accordo page is live,
update DEV's canonical URL to the Accordo article; until that second receipt
exists, the syndication order is a known SEO gap rather than a completed loop.

Final source evidence for this change: 742 tests passing, 0 failing; seven SEO
tests passing, including the human-and-agent discovery regression; 23 public
claims and nine standing limitations accepted by `site-check`; 108 emitted
pages. These are repository receipts, not live-deployment receipts. The live
canonical page must still return 200 after merge before the task can be checked
off in `TASKS.md`.
