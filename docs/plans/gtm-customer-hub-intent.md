# GTM — the Customer Hub intent page (ExecPlan)

## The question the page exists to answer

> **Somebody typed "customer hub" or "single customer view" into a coding agent.
> How much of what they meant already exists here, and what exactly is missing?**

`docs/strategy/RECOMMENDATION_MAP.md` §2 records that intent as **"Yes, with
framing"** and §3c lists the page as *Now — not started*. The same document
records the neighbouring intent, *"crm + marketing + sales + delivery + billing
+ ERP"*, as **"Split"**: sales through service yes, marketing design-only,
billing non-existent, ERP out of scope. Those two rows are the whole brief, and
the word doing the work in both of them is **framing**.

This is therefore an **intent** page, not a capability page. It does not
announce a domain. It takes a phrase people type, splits it into the pillars it
implies, and gives each pillar its honest status with a job row, a test or a
document a reader can open.

---

## Three ways to express this on the site, compared

### Option 1 — a seventh entry in `site/capabilities.json`

**Rejected, and this is the option that would have done the damage.**

The capabilities pillar page announces itself as *"The commercial domains that
are merged, and where each one stops."* Every one of its six entries is a
merged domain with a package, a test suite and a ledger claim. A customer hub is
none of those: it is a phrase, and the honest answer to it is *four pillars
merged, one design-only, one absent*.

Putting it there would have required rewriting the pillar's own heading and lede
— changing what the six existing pages mean, in order to accommodate one new
page that does not fit. A cluster whose contract has to be loosened for a new
entry is a cluster whose contract has stopped meaning anything, and the next
entry loosens it again.

### Option 2 — a fifth generated cluster, `intent/`

Extend `CLUSTERS` in `scripts/site-clusters.js`, add `site/intent.json`, add a
nav entry, amend `SITE_ARCHITECTURE.md` §2.

**Rejected for now, on the architecture's own terms.** The hub-and-spoke rule
(§Internal linking rules, 2) is that *every pillar links down to all its
spokes*. A pillar page over one spoke is a redirect with furniture on it. The
generator is not the obstacle — extending it is about forty lines — but a
cluster is a promise that there is a *set* of pages of that kind, and there is
one.

Recorded as the right move the moment a second intent page exists. The two
obvious candidates already have their rows in `RECOMMENDATION_MAP.md` §2: the
integrated-ecosystem intent, and "revenue platform". At two or three spokes this
option wins and this plan should be re-read.

### Option 3 — a sixth entry in `site/concepts.json` **(chosen)**

The concepts pillar already says exactly what an intent page needs it to say:

> These pages argue rather than describe, and every paragraph still resolves to
> a file in this repository. **None of these pages states a capability the
> capability pages do not already carry with its limitation attached.**

That last sentence is the guarantee. This page composes capability sentences
that already exist, with the limitations already attached to them, and adds
none of its own. It also lands beside the two pages it must not contradict:

- `concepts/customer-and-revenue-os.html` — *"Why CRM is the narrowest true
  label"*, which already contains the sentence **"'Customer hub' is only ours in
  the build-one reading."** This page is that reading, written out.
- `compare/vs-a-customer-data-platform.html` — the published refusal. See below.

No generator change. No nav change. No architecture amendment. The content
contract in `SITE_ARCHITECTURE.md` §3 already carries everything the page needs,
including the mandatory `boundaries` array that `scripts/site-clusters.js`
refuses to build without.

### Option 4, considered and dismissed early — an `answers.json` entry

`buildAnswerPages()` renders a question, a stance, the cited ledger entries and
a closing limits paragraph. It has **no `boundaries` field at all** — the
above-the-fold boundary block is a cluster-page feature. A page whose whole
argument is *"here is what does not exist"* cannot be published on a template
that has no slot for it.

---

## The conflict this page had to survive: the CDP refusal

`site/compare.json` already ships `cmp-customer-data-platform`, whose summary is
published in the site's own voice:

> This is a CRM framework, not a customer data platform. Nothing ingests events
> or records from other systems, nothing resolves identities into a single
> profile, and nothing builds, freezes or syncs a segment.

A page with a *single customer view* section is one careless sentence away from
reading as a soft retraction of that. Three rules were applied, and they are
visible in the shipped entry:

1. **The definition is restricted in its first clause, not in a trailing
   qualifier.** The sentence is *"the records this framework's own actions
   already wrote about one customer, in one local SQLite database, each carrying
   the id of the record it came from"* — and the paragraph that follows opens
   *"It is a chain this system wrote, not a profile it assembled."* A skimming
   reader gets the distinction from the first eight words of each paragraph;
   they do not have to reach a qualifier to be safe.

2. **The refusal is inherited, not restated and not re-litigated.** A named
   paragraph points at *Not a customer data platform*, repeats its three-job
   definition of the category, and says none of the three exists here in any
   form. `related` links to it directly, with the target's own title as anchor
   text.

3. **No CDP product is named**, matching that page's stated ground: the only
   competitor source this site may cite carries no CDP research at all. No
   comparison is introduced that `COMPETITOR_MAP.md` does not cover — in fact
   this page makes no competitor comparison of any kind, so it carries no
   `verifiedOn` date and needs none.

**Conclusion: the page is writable without weakening the refusal**, because the
two sentences are about different objects. The CDP page refuses a *profile
assembled from other systems*. This page names a *chain this system wrote*. The
distinguishing fact is not a qualifier — it is that **nothing enters this
database except through an action this framework ran**, so there is no ingestion
to resolve and therefore nothing to resolve.

---

## The pillars, and the evidence each sentence rests on

Every status below is the job catalogue's, not this page's. `docs/benchmarks/jobs.json`
is generated from `docs/benchmarks/CRM_JTBD_MATRIX.md` and held to it by
`tests/jobs-json.test.js`.

| Pillar | Honest status | Evidence the page cites |
|---|---|---|
| **CRM core + lead intelligence** | merged, partly validated | 8 of 17 core rows validated end to end (JTBD-04, JTBD-05, JTBD-05b, JTBD-03); 4 of 9 lead rows validated (JTBD-LI-01/02/04/07), 4 partial, JTBD-LI-06 not supported. C-06, C-05, C-16. `tests/lead-conversion-e2e.test.js` |
| **Commercial: quote, discount, signature, order** | merged, partly validated | JTBD-CO-01, JTBD-CO-03, JTBD-CO-07 validated; JTBD-CO-02/04/05/06 partial. C-08, C-09, C-21. `tests/commercial-e2e.test.js`, `tests/signature-order-e2e.test.js` |
| **Contract and subscription** | merged, partial | JTBD-CS-01 and JTBD-CS-02 partial; the other **eight** rows in that section not supported. C-10. `tests/contracts-activation-e2e.test.js` |
| **Delivery** | merged, partial | JTBD-DS-01, JTBD-DS-06, JTBD-DS-08 validated; DS-02/03/05/07/09 partial; DS-04 and DS-10 not supported. C-11, C-12. `tests/delivery-handover-e2e.test.js` |
| **Service and support** | merged, partial | JTBD-DS-11 and JTBD-DS-12 both partially supported. `tests/service-operations-e2e.test.js`, `docs/SERVICE_OPERATIONS.md` |
| **Marketing** | **design only — no code** | all **43** JTBD-MK rows not supported; `docs/strategy/MARKETING_GROWTH_OPERATIONS.md` opens *"Status: product strategy and roadmap only. Nothing in this document is implemented."*; roadmap track MK0–MK7. New ledger row **L-11** |
| **Billing** | **does not exist in any form** | JTBD-DS-10 and JTBD-CS-05 not supported; `EXECUTION_ROADMAP.md` lists invoicing, billing, payment, usage rating, proration, tax and FX as explicitly deferred; `packages/contracts/modules/subscription.module.json` calls itself *"a commercial activation record, not a billing engine"*. New ledger row **L-10** |
| **ERP** | out of scope by decision | `RECOMMENDATION_MAP.md` §2: *"Not a goal; say so plainly."* |

## Ledger changes, and the one this plan refuses to make

`SITE_ARCHITECTURE.md` §3 is explicit: *"If a capability has nothing in the
ledger to cite, the honest page says what the code does and cites `docs` and
`tests` — it does not invent a claim, and it does not get a claim added to the
ledger to justify a marketing sentence."*

So **no claim is added.** The linkage sentence — that each record carries the id
of the record it came from — is stated in a section body and cited to the
module manifests and the four end-to-end suites that assert it, which is the
route the architecture prescribes. Every capability sentence on the page is an
existing claim, printed from the ledger by the generator.

**Two limitations are added**, because a limitation is the opposite of a
marketing sentence and neither of these facts has a row anywhere:

- **L-10 — Nothing bills.** No invoice, payment, dunning, tax, usage rating,
  proration or revenue recognition exists, and MRR, ARR and TCV are not derived
  from contract data.
- **L-11 — Marketing is a design document, not a package.**

Both are written **terse on purpose**, and this is not a style choice.
`scripts/generate-llms.js` holds `llms-full.txt` under a hard 40,000-character
budget and, when it overflows, drops a whole inlined section rather than
truncating one — the last candidate in its priority list being *the claims
ledger's evidence for every entry*. At `0c8a29d` the headroom was **913
characters**. The first draft of these two rows was ~1,100 characters and
silently pushed the ledger evidence out of the file, replacing it with a line
telling an agent to fetch `site/claims.json` itself. The rows were cut to fit
instead: the canonical sentence lives in the ledger, and the long-form statement
of the same fact lives in this page's `boundaries`, which is where it belongs.

**Headroom after this change is 159 characters.** That is a real constraint the
next person to add a ledger row inherits, and it should be a deliberate decision
rather than a surprise: either the row is small, or something is traded out of
`llms-full.txt` on purpose.

Both rows carry `evidence.docs` that resolve on disk and a `jtbd` id, and both are
declared for the `site` surface only — `site/templates/evidence.html` renders
the whole ledger via `{{ledger:limitations}}`, so the surface-coverage check in
`scripts/site-check.js` is satisfied by construction, and neither needs a README
sentence written to justify it.

## The ledger measurement block — measured three times, then corrected

`site/claims.json` records `sha: "9958ed9", tests: 701`. Main is `0c8a29d`, and
the block's own note says *"A claims file measured against a stale SHA is a
claims file that lies."* Correcting it was in scope, conditional on measuring it
rather than copying a number from somewhere.

It was measured, twice, with `npm run verify` in this worktree — once at
`0c8a29d` before any edit and once after the page landed. Both runs report
**741 tests**, and both report **739 passing and 2 failing**. Neither pair of
failures is the same pair, and every one of them passes when its file is run on
its own:

| Run | Failing | Why |
|---|---|---|
| 1 | `tests/package-test-command.test.js` | a leftover `/tmp/accordo-package-test-*` scratch directory it did not create; passes with `/tmp` cleaned |
| 1, 2 | `tests/delivery-change-acceptance-evidence.test.js` | `ECONNRESET` against its own loopback server under load; the named case passes alone in 11.9s |
| 2 | `tests/contracts-activation-e2e.test.js` | `MODULE_NOT_FOUND` for a file its own `cpSync` had just written into `/tmp`; passes alone |

The cause is not this repository. `ps` shows two other agent sessions —
`/home/user/agent-crm-worktrees/audit-dx5` and
`/home/user/agent-crm-worktrees/bootstrap` — running full suites on the same
four cores and, more to the point, in the same `/tmp`: one of them was executing
`tests/package-test-command.test.js` and holding a `/tmp/accordo-package-test-*`
directory while this worktree's copy of that test asserted no such directory
survives. A serial re-run (`--test-concurrency=1`) was started to get a clean
number and did not survive the contention either.

The block was therefore **not** going to be corrected: `tests: 741` was measured
and `failures: 0` was not, and the entire point of the block is that it never
carries a number nobody ran.

Then the sibling sessions finished, and a third run on a quiet machine — at
`fe92a0e`, with a clean worktree — reported **741 tests, 741 passing, 0 failing,
exit 0, in 225 seconds**. That is the measurement, so the block now records it:

```
sha: fe92a0e   tests: 741   failures: 0   date: 2026-08-09
```

`fe92a0e` is the commit whose tree was tested, not a commit chosen for
convenience. **If this branch is squashed rather than merged, that SHA stops
existing and `site-check` fails with "measuredAgainst.sha … is not a commit in
this repository" — which is the gate behaving correctly, because a squashed
branch is a different tree that nobody measured.** Merge it, or re-measure.

The count is corrected on every surface that states it in the present tense, not
only the two `site-check` sweeps: `site/claims.json` (the block, C-20's text and
C-20's repoFact), `README.md`, `site/answers.json`, `site/concepts.json`,
`docs/marketing/OBJECTIONS.md`, `docs/marketing/LAUNCH_PACKET.md`, and
`docs/strategy/RECOMMENDATION_MAP.md` §1, which said **555**. Documents that
quote a count *as of a stated date* — `GO_TO_MARKET.md`, `AGENT_RECOMMENDATION.md`,
`RENAME_SURFACE.md`, `FOUNDER_CHECKLIST.md`, `PENDING_HUMAN_SUBMISSION.md` and
the milestone plans — are records of a moment and are left alone.

## The other stale number, found on the way

`site/concepts.json` publishes *"68 modules, 4 packages, 32 resources, 52
actions, 7 policies and 10 providers"* on `concepts/customer-and-revenue-os.html`.
The tour-verified claim C-22 says **70, 6, 41, 56, 7, 5**. `tests/tour-claim.test.js`
sweeps five surfaces for those counts and `site/concepts.json` is not one of
them, so the drift shipped silently — exactly the failure that test file's own
header describes.

Corrected to C-22's numbers, and `site/concepts.json` added to `QUOTING_SURFACES`
so it cannot drift again. Separate commit.

## Verification

`npm run site:build` · `npm run site:check` · `npm run gtm:check` ·
`npm run surface:check` · `npm run verify`. The site gates are strict by design:
if one refuses a sentence, the sentence changes and the gate does not.
