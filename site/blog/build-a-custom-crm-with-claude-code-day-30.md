---
title: "Build a custom CRM with Claude Code: what day 30 looks like"
date: 2026-08-19
claims: [C-01, C-03, C-04, C-05, C-08, C-16, C-17, C-19, C-21, C-22, C-23]
transcript: docs/transcripts/2026-08-19-tour-and-falsify.txt
editor: Aetha Editorial
summary: Day one of an agent-built CRM goes well, and the weekend tutorials are not wrong about that. This is about the four things that are wrong on day 30, why they are the ones that get deferred, what a framework can carry instead, and when building from scratch is still the right call.
---

Ask Claude Code to build you a CRM and day one goes well.

That is not a setup for a reversal. It is the honest starting point, and a post that argues with it is arguing with something you have already watched work.

CRUD is where correctness is visible on screen. You ask for a Company object with six fields; the agent writes the migration, the model, the route, the form and the list view. Then you open the page. A missing field looks like a missing field. A wrong foreign key looks like an empty dropdown. The distance between "the agent wrote something" and "I know whether it is right" is one page load, and that is exactly the loop a coding agent closes well. The weekend tutorials are describing something real.

The trouble starts where that loop stops closing.

## Four things that are wrong on day 30

None of these is CRUD. All four are what a CRM-shaped codebase reliably accumulates once the screens are done.

**The approval check lives in one of N handlers.** Sprint one has a single path to a discount — the quote page — so the threshold check goes there, and it works. Sprint three adds bulk edit. Sprint five adds an importer. Sprint six adds an endpoint for the support team. Each was written in a session holding the *current* file in context and not the original one. The check is now in one place out of four. Nothing failed. Three paths approve.

**Stage is a string column you can PATCH.** `PATCH /opportunities/42 {"stage":"won"}` is the most natural REST an agent can write, and it is also the sentence "any client may declare any deal won". Which transitions are legal, what must be true first, what else fires when one happens — none of it is represented anywhere. It exists only in the order the sales team happens to click.

**The discount rule is an `if`.** `if (discount > 0.2) requireApproval()`. In March somebody changed `0.2` to `0.25`. In June a customer asks why the January quote cleared at 22 percent. The answer is a `git blame`, a deploy log and a guess about which line was live that day. The rule was real; the *version* of the rule that made each decision was never written down.

**The audit row is written outside the transaction.** `await db.insert(order); await db.insert(auditLog);` — two statements, two chances. When the second fails, or the first rolls back after the second commits, the record and the log disagree. The log was the thing you were going to use to find out what happened.

## Why these four get deferred

Because they never fail loudly.

A missing approval rule does not throw. It renders a correct-looking page that approves. A PATCHable stage column does not error; it returns `200`. A hard-coded threshold gives a correct answer every single time, for a rule nobody can reconstruct afterwards. An audit row outside the transaction passes every test you write, because your tests do not crash between two `await`s.

Work gets deferred in proportion to how quietly it fails — by an agent, and by a competent human under a deadline. Everything in that list fails silently, which is why all four are still there on day 30 while the Kanban board and the dark mode are finished.

## A prompt instruction is not a boundary

The reflex fix is to write it down: *always require human approval for discounts over 20 percent*. That is useful guidance. It is not an enforcement mechanism.

Prompts change. Context gets truncated. The next session opens a different file. A future maintainer calls the service directly. A rule that lives only in agent instructions is being enforced by the same probabilistic component it was written to constrain.

The alternative is not a better prompt. It is putting the rule somewhere a prompt cannot reach.

## What a framework can carry

Each of these has its edge stated in the same breath, because the edge is the part you would otherwise find on day 30.

A module manifest becomes a migration, a service, a REST resource, an SDK method and Admin screens with no page code [C-01] — and generated CRUD is the whole of it: the factory writes no workflow and no approval for a custom object, and those stay handwritten [C-01].

Stage changes are a server-authoritative action rather than a column write: the client asks, the server decides [C-05]. That is proven on the built-in Opportunity module; configurable pipelines for generated custom objects are not claimed [C-05].

The approval threshold is deterministic code rather than a model's judgement — a renewal at or above it stops and waits for a named human [C-03] — proven for the built-in renewal object and its single value threshold, with no general policy engine over arbitrary custom objects [C-03]. The same refusal holds where the money is: an agent actor asking to approve a discounted quote is refused with a 403 [C-21], though that assertion sits inside a composite end-to-end test rather than one named for it, so the citation is a file and a line [C-21]. A test asserts the refusal, which is what makes the boundary a property of the system rather than a promise in a README [C-04] — and the actor is asserted, not authenticated, so this holds against an honest agent and not against an attacker with network access [C-04].

A discount that goes for approval freezes the quote into an immutable version, priced on the server from a catalog [C-08]. Catalog sync runs against a fixture provider — no Stripe, Zuora or ERP is connected — and money is integer cents with no FX [C-08].

Every mutation goes through a module service or a named workflow and leaves an audit event and a step-level trace behind it [C-16]. Audit records what the process did under an asserted actor: it is not tamper-evident, not externally attestable, and not a compliance control [C-16].

Modules evolve through explicit revisions, a checked-in state file and append-only named migrations [C-19] — a source-only view, so what a particular database has actually applied is not knowable from it [C-19].

Composed, that is what `npm run tour` builds and then inspects: 76 modules, 9 packages, 71 resources, 64 actions, 7 policies and 1 provider, driven end to end, followed by the eleven things the inspector says it cannot see [C-22]. It composes the starter's application, not yours; it runs locally against SQLite with no authentication, a different composition gives different numbers, and wall-clock time varies by machine and is deliberately not claimed [C-22].

And the rules can be removed on purpose. `npm run falsify` deletes five named invariants one at a time and reports which test caught each: in the run saved at `docs/transcripts/2026-08-19-tour-and-falsify.txt`, 5 caught, 0 survived, 0 stale, in 2.3 seconds — a sixth rule is slow and runs only with `--all` [C-23]. It falsifies six named rules, not the claims in our ledger, and proves only that a test holds each one; a rule that is wrong but faithfully defended passes every mutation [C-23].

The stack underneath is Node 22 and a checkout — no third-party runtime dependencies, no build step, no bundler [C-17]. That is a property of the framework, not of whatever you add on top of it [C-17].

## Exactly where this stops

Read this section first.

There is no authentication, tenancy or RBAC; the server is local-development-only and an actor header is an assertion, not an identity [L-01]. Persistence is SQLite [L-02]. There is no scheduler, so nothing fires on a timer [L-04], and no adapter sends email or touches a calendar [L-05]. There is no import, export, dedupe, merge, bulk edit, saved views or global search [L-06] — table stakes in every commercial CRM, recorded deliberately rather than left for you to find. Which means the honest consequence: you cannot put real customer data in this yet, because with no export and no erasure path a data-subject request cannot be serviced [L-09]. Nothing bills [L-10]. It is not a product you sign up for; the output is an application in your repository [L-07].

And the install is narrower than it sounds. `npm create accordo` works, and what it installs is a **scaffolder, not a framework library**: the framework source is vendored into your project, so you own the result outright, there is no versioned framework dependency, and upgrading means merging changes into your copy rather than bumping a number [L-08].

## When building from scratch is the right answer

Genuinely, and more often than a framework post usually admits.

**Your application has few consequential verbs.** List them before you list screens: approve, publish, pay, send, delete, sign, change policy. If you have two and neither touches money, everything above is overhead you will maintain for nothing.

**Your first sprint is auth.** Accordo does not have it [L-01]. A Next.js starter does. If week one is login, tenancy and invites, adopting this adds its absences to your own backlog.

**You already have a house architecture.** A team with an opinionated service layer, its own migration discipline and a review culture already has the constraint. A second one fights the first, and the one you wrote is the one your reviewers enforce.

**It is a feature, not an application.** A pipeline view inside a product you already ship is a feature. Frameworks earn their keep across many consequential verbs, not one.

**And if you are buying, buy.** If a sales team needs to log in this quarter with import, search, saved views, reporting and someone to call, that is a CRM product [L-06], not a repository [L-07].

## Practices worth stealing in any stack

Close this tab and go back to Prisma, but take these:

1. Write the consequential verbs down before the screens, then decide for each: deterministic policy, a named human, or impossible from the agent's tool surface.
2. Make state changes actions, not column writes. One server-side path, or every client is a state machine.
3. Version the policy, not just the number — persist *which version* decided, so a January answer is still explainable in June.
4. Write the audit inside the transaction that made the change.
5. Delete a rule on purpose and see whether a test notices. If nothing fails, the rule is documentation.

## What has not been measured

No speed claim appears here, in either direction. No success rate, no build rate, no comparison. The build benchmark for this project is designed and published and **has not been run**, so no such number exists, and any figure you see quoted for it is not ours [L-03].

Nothing above says a CRM gets built faster with this framework than without it, because nobody has measured that. What is measured is narrower and duller: the composition a starter actually applies, and five rules that fail loudly when they are removed.

The four failures are real, the boundary is a test, and the rest is your judgement.
