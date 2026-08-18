---
title: The sixteen ways we try to break a milestone before it merges
date: 2026-08-18
claims: [C-11, C-16, C-20]
transcript: docs/transcripts/2026-08-18-adversarial-categories-run.txt
editor: Daniele Pelleri
summary: Every milestone in this repository is attacked against a standing checklist of adversarial categories before a human merges it. Here is the list, what three of the attacks look like in a real run, and what the list deliberately does not prove.
---

A milestone whose happy path works is not finished. Our own quality-gates document says so in almost exactly those words, and then it does something more useful than saying so: it writes down the attacks.

[`docs/QUALITY_GATES.md` §2](https://github.com/khaoss85/agent-crm/blob/main/docs/QUALITY_GATES.md) is a standing table of adversarial review categories, run against every milestone before it merges. The table has fifteen named rows. The sixteenth way to break a milestone sits in the sentence above the table: a category that does not apply must be stated as not applicable — never silently skipped. A review that cannot show its skips is the first thing the review process breaks, because a silent skip is indistinguishable from a pass.

The categories are not a style guide. Each one names a concrete way agent-written commercial software fails quietly: public-boundary bypass, state-machine algebra, transaction and fault injection, idempotency, two-connection concurrency, exact queries beyond page bounds, immutable boundaries, provider timeouts and late settlement, replay and reconciliation, hostile input, schema compatibility, backward compatibility, audit and trace exactness, browser behavior, documentation truthfulness. The executable form lives in the repository too, as [the adversarial-review skill](https://github.com/khaoss85/agent-crm/blob/main/.claude/skills/adversarial-review/SKILL.md) an agent runs before a merge. Its ground rules are the interesting part: confirm a suspicion with a runnable probe before fixing anything, attack the invariant rather than the happy path, and prefer the failure that permanently destroys evidence over the one that merely errors.

What follows is three of the categories as they look in a real run — not a description of what a review would do, but the transcript of the delivery-handover end-to-end suite, run on 2026-08-18 at commit `000aae8` and saved unedited at `docs/transcripts/2026-08-18-adversarial-categories-run.txt`.

## Transaction and fault injection, idempotency, and two connections

The category's wording is blunt: inject a failure after *every* significant write; everything rolls back, no orphan rows, no fake success audit, and the retry produces exactly one complete result. Idempotency has its own row — a repeat behind the same key is refused or resolves identically, and a semantic mismatch behind that key fails closed rather than being adopted. Concurrency has a third: two connections on one database, one winner, no lost update.

The handover from an activated contract to a delivery project is where these three meet, because a handover creates a project, work packages, milestones and an optional partner engagement across a package boundary in one atomic operation ([`tests/delivery-handover-e2e.test.js`](https://github.com/khaoss85/agent-crm/blob/main/tests/delivery-handover-e2e.test.js)). The transcript's slowest subtest is the one named for the attack:

```text
# Subtest: the handover is atomic, idempotent and concurrency-safe
ok 4 - the handover is atomic, idempotent and concurrency-safe
```

It is slow because it does the unglamorous thing the category demands — failing the operation partway through after each write in turn, retrying, and racing a second connection — rather than asserting once that the happy path commits.

## Hostile input

The hostile-input row lists its ammunition explicitly: `__proto__`, `constructor`, `prototype`, markup, quotes, backticks, template syntax, newlines, Unicode separators, null bytes, oversized strings — across every provider, payload, field and route. The point of writing the list down is that "we sanitize input" is a sentence, while a checked-in list is a contract a reviewer can hold a milestone to.

The delivery boundary gets its own version of the attack, because a handover copies data from one package's records into another's:

```text
# Subtest: hostile input stays inert data across the package boundary
ok 8 - hostile input stays inert data across the package boundary
```

Inert is the operative word. The assertion is not that hostile input is rejected — much of it is legal text — but that it crosses the boundary as data and comes back out as data, polluting no prototype and confusing no route.

## Audit, event and trace exactness — and the honest wrinkle in this transcript

This category's rule is the one most reviews get wrong: assert *counts*, not presence. A replay creates none. And a post-commit dispatch failure stays a business success and is visible separately, rather than failing the operation retroactively or vanishing.

The transcript holds both halves. The counting half is a named subtest:

```text
# Subtest: audit, events and trace are exact, and reads stay exact past the list bound
ok 7 - audit, events and trace are exact, and reads stay exact past the list bound
```

The visible-separately half arrived uninvited. Partway through the run, this line appears on the console:

```text
# [accordo] commercial-contract.create-delivery-handover run f257aa51-bc0d-41c1-aff2-66a6ef19a5ad: failed to persist trace: database is locked
```

A trace write lost a lock race against the test's own concurrent connections. The run did not hide it, and it did not convert it into a business failure either — the surrounding subtests passed, and the diagnostic stayed on the console with the run id attached. That is the category's rule doing its job in front of a witness, and it stays in this article for the same reason it stays in the transcript: a review discipline that quietly trims its own output is not one you should believe about anything else.

## What the list does not prove

The categories measure discipline, not correctness, and the repository says so where it counts. The verification gate that runs the suite on every push states its own boundary: a test count measures effort, and real-browser tests are currently run manually rather than in CI — which makes browser behavior the weakest row in the table today, reviewed by a person at a keyboard instead of a robot on every push.

Documentation truthfulness, the last row, is also the one no script fully covers. The quality-gates document is explicit that its mechanical checks compare strings and match patterns; nothing infers whether a sentence is true. That category remains a person. The same document records the failure that keeps everyone honest about green checkmarks: a merge conflict resolved inside a measured record once ran the public ledger a whole wave behind the suite with every check green, which is why an integrator pass over shared-truth files is a gate and not a courtesy.

Every mutation in the framework goes through a module service or a named workflow and leaves audit and trace evidence behind it, which is what makes categories like exactness attackable at all — you cannot count what was never recorded. But the honest summary of the sixteen ways is narrower than it sounds: they are the ways we currently know this kind of software fails, written down so that skipping one is a visible act. The list grows when a review finds a way that is not on it. The transcript of this run, commit and command included, is in the repository — the quickest way to disagree with any of this is to re-run it.
