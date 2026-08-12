# Admin manual browser smoke checklist

Automated tests cover the Admin at the DOM/integration level (real server + real fetch + a fake document) and run in CI. **They do not drive a real browser, and neither does CI: no workflow in `.github/workflows/` launches one.** `npm run smoke` is an in-process application smoke, not a browser smoke. Every "validated in real Chromium" block below was driven **outside CI**, by hand or by a throwaway script, and is only as current as its stated commit. During the Milestone 4 adversarial review this exact flow was additionally validated once in real Chromium, and re-run at each milestone: 37 automated checks at Milestone 14a, all passing, covering the XSS-as-text, malformed-hash, composite-pricing, signature/order, contract-activation, delivery-handover and delivery-execution cases; 22 **further** checks for the Milestone 14b2 Delivery Change & Acceptance section, all passing; 24 **further** checks for the Milestone 15 Service operations section, all passing; and 30 **further** checks for the Work v1 section (ADR-030), all passing. Each block is additive and scoped to its own section — the 30 do not re-run or replace the 24, the 24 do not re-run the 22, and none re-runs the 37, which were last exercised on the Milestone 14a branch. Re-run the block for any section you touch before releasing changes to `apps/admin/public/`.

## Setup

```bash
npm run crm -- module create examples/modules/partner.module.json --apply
# a second module to prove the generic behavior:
printf '{"manifestVersion":1,"name":"supplier","fields":[{"name":"name","type":"string","required":true},{"name":"code","type":"string","required":true,"unique":true},{"name":"active","type":"boolean"}]}' > examples/modules/supplier.module.json
npm run crm -- module create examples/modules/supplier.module.json --apply
npm run dev   # http://localhost:4000
```

## Checklist

1. Dashboard loads at `#/`; "Generated modules" nav shows **Partner** and **Supplier** (sorted).
2. Click **Partner** → collection view with columns derived from fields; empty state reads "No records yet."
3. **Create** → form shows: Name (text, required *), Tier (select: silver/gold/platinum), Territory (text), Active (checkbox).
4. Submit empty → "Name is required" shown against the field; no record created.
5. Fill Name + Tier + Active, submit → navigates to the record; toast confirms.
6. Detail view shows immutable id/createdAt/updatedAt read-only; edit Tier → Save → value persists.
7. Edit to an invalid state (e.g. clear a required field) → error shown, previous values preserved.
8. Direct-navigate to `#/modules/partner`, refresh the page → view restores. Back/forward between Partner and Supplier works; no data bleed.
9. Navigate to `#/modules/partner/does-not-exist` → "Record not found," no crash.
10. Double-click Submit → only one record created (button disables).
11. Create a Supplier with a duplicate `code` → conflict error shown; no record created.
12. Keyboard: Tab through form controls, labels announce, focus is visible, checkbox toggles with Space.
13. Narrow the window to phone width → layout stays usable; table scrolls, no horizontal page scroll.
14. In the Supplier collection, a record value containing `<b>x</b>` renders as literal text (paste it into Name) — no bold, no script.
15. Restart `npm run dev` → both modules and their records are still present.

Delivery handover (Milestone 13, the delivery domain package — requires the delivery package registered and its five manifests applied; the section is absent without it):

36. Under an activated contract, a **Delivery handover** section offers a policy selector and **Plan delivery handover**, stating that planning is read-only. The plan lists every pending delivery obligation with who delivers it *and the reason*, plus the proposed milestone plan.
37. An obligation whose delivery mode the policy could not decide is highlighted as blocking, with a mode selector and a required reason; no planning window, no partner input and no handover control appear while anything is undecided. Applying a decision without a reason is refused before any request leaves the browser.
38. Once nothing is undecided, the planning window asks for target start and end as calendar dates and states that these are **post-sale planning data, not a customer commitment**, that both are supplied together or not at all, and that nothing schedules them. A partner reference and name are requested **only** when some work package is partner-delivered, alongside the statement that a partner engagement **grants no access of any kind**.
39. Creating the handover once re-renders to evidence: project facts (status `pending_kickoff`, planning window and its source, policy version and fingerprint), work packages with each mode's reason and any human decision next to what the policy said, the milestone plan with the note that it is not a contractual or billing milestone, and the partner engagement with its no-access limitation. The handover control does not accept a second click.
40. On a handed-over contract the whole **handover** section exposes no input, button or selector, and no control exists to staff, cost, bill or accept anything.

Delivery execution (Milestone 14a — the same package, at revision 2 of the three record manifests; these run in the generic module views, not in the contract section):

41. Open the generated **delivery-project** collection and its record detail. The managed-field summary shows `status: pending_kickoff` read-only — there is no editable status input anywhere, because every field is workflow-managed.
42. The actions panel lists the project's transitions. **Start delivery project** succeeds and re-renders with `status: in_progress` and a `startedAt` stamp; the optional note is stored as text. **Complete delivery project** is refused with a `409` naming the work packages and milestones still open. *(Known limitation: the generated Admin lists every action a module declares and does not filter by the record's current state, so both buttons appear from the start. The refusal is the server's, and it names the allowed moves.)*
43. On a **delivery-work-package** record, **Block work package** reveals a required *reason* input; submitting it empty is refused before any request leaves the browser. With a reason, the record re-renders with `status: blocked`, the reason, who blocked it and when. **Resume work package** clears those three fields and returns it to `in_progress`.
44. Paste `<img src=x onerror=alert(1)>` into a note or reason: it is stored and rendered as literal text — no image, no script, no bold. A 600-character note is refused with a validation message naming the 500-character limit.
45. Complete every work package and every milestone, then **Complete delivery project** succeeds and stamps `completedAt`. Afterwards no delivery action on any of that project's records succeeds — each is refused with a `409` — and nowhere in the section is there a control to record time, cost, a change request, a deliverable, an invoice or a customer acceptance.
46. Restart `npm run dev` → every execution state, stamp and block reason is still exactly as left.

Report any step that fails; do not mark the Admin browser-validated unless all pass.

## Service operations (Milestone 15)

**Service-specific, manual, and outside CI.** These 24 checks cover the
Milestone 15 Service operations section only. They were driven in real Chromium
against a seeded project and are reproducible from the steps below; nothing here
runs in CI, and nothing here re-runs or replaces the 37 Milestone 14a checks or
the 22 Milestone 14b2 checks above. **24 checks, all passing.**

The section is **package-scoped, not package-owned**: the framework has no seam
for a package to contribute an Admin extension — AX1 publishes that limitation as
`ADMIN_EXTENSIONS_UNSUPPORTED` — so `apps/admin/public/admin-service.js` lives in
the Admin app and renders only while `/api/schema` publishes `domains.service`.

**The run found one defect the fake-DOM tests could not.** The Admin's `withBusy`
re-renders the *whole* quote detail whenever a write succeeds, which builds a
brand new section. The open case was held in that section's closure, so every
successful action destroyed it: recording a case, or a note on the case being
read, threw the operator back to a queue with nothing open. Selection now lives
outside the render closure, keyed by contract, and
`tests/admin-service.test.js` reproduces the parent's rebuild so the same class
of mistake fails in CI rather than in a browser.

Setup: compose a project with the contracts **and** service packages, apply the
seven service manifests, drive a quote through signature to an activated contract
carrying a pending service obligation, then open `#/quotes/<quoteId>` where the
service section renders under the contract.

1. The **Service operations** section renders on the contract's quote route.
2. It states, verbatim: *"ServiceCoverage is operational evidence. It is not a signed contract and does not amend the Commercial Contract."*
3. Planning is offered and says it records nothing.
4. Planning wrote nothing — zero coverage, entitlement and activation-run rows.
5. A policy that cannot decide the obligation **blocks**: no activation control and no coverage form exist while anything is undecided.
6. A decision without a reason is refused **before any request leaves the browser**.
7. A decidable plan lists every entitlement, its reason, and the policy fingerprint.
8. An activation refused for a missing field is **visible**, and the typed input survives it.
9. That refusal wrote nothing.
10. Activating once re-renders to coverage evidence, and offers no second activation path.
11. Entitlements render read-only, with every bound stated and **no control at all** on the card.
12. The case queue states, verbatim: *"A listed channel does not mean a provider is connected."*
13. A case in a category the entitlement does not cover is refused, and the refusal is visible on screen.
14. A covered case is recorded and appears in the queue.
15. The case detail offers **exactly** the transitions the server declares for that state — `closed` is not among them from `new`.
16. The first response is recorded once, and its control then disappears.
17. The SLA **preview** is a separate block from **recorded** evidence, and previewing records nothing.
18. A recorded evaluation renders its instant and the inputs it used.
19. No contractual-breach wording appears anywhere; the elapsed-time-only statement is present.
20. An escalation is recorded and the section states, verbatim: *"No notification was sent automatically."*
21. Hostile record text renders as text and creates no element.
22. No amend / invoice / bill / payment / renew / authenticate control exists anywhere in the section.
23. A direct route plus refresh restores the section and its state.
24. No failed resource, no unexpected API response, and no uncaught JavaScript error during the run.

## Record actions (Milestone 6)

Validated once in real Chromium during Milestone 6 (13 checks, all passing, including the invalid-input and XSS-as-text cases). Re-run when changing the actions panel in `apps/admin/public/admin-modules.js`.

### Setup

```bash
npm run crm -- module create examples/starters/b2b-lead-qualification/lead.module.json --apply
npm run crm -- module create examples/starters/b2b-lead-qualification/task.module.json --apply
# register the starter's actions in packages/actions/generated/index.js (see the starter README)
npm run dev
```

### Checklist

1. Create a Lead; open its detail. An **Actions** panel appears below the edit form with **Qualify lead** and **Disqualify lead**.
2. The panel shows `Status: new` read-only; the edit form has **no** Status control (managed fields are not editable).
3. Click **Qualify lead** → its `dueAt` input form is revealed.
4. Submit it blank → "Due At is required" against the field; no task created.
5. Enter `not-a-date` → server rejects it with an ISO-8601 message; still no task.
6. Enter `2026-08-12T09:00:00Z` → succeeds; the detail re-renders showing `Status: qualified`.
7. Exactly one Task now exists, with `sourceKey` = `qualify:<leadId>` (check the Task module list).
8. No action buttons remain; the panel reads "No actions available for this record."
9. Reload the page → still `qualified` (the state is persisted, not client-side optimism).
10. On a second new Lead, run **Disqualify lead** with a reason → status becomes `disqualified` and **no** Task is created.
11. Submit Disqualify with a blank reason → refused; no state change.
12. Create a Lead whose first name is `<b>x</b><img src=x onerror=alert(1)>` → it renders as literal text on the detail; no bold, no image, no dialog.
13. Throughout, the browser console shows no uncaught JavaScript errors.

### Conversion (Milestone 7)

Validated in the same real-Chromium run (steps continue from the qualify flow; the captured Lead needs a `companyName`):

14. Once qualified, **Qualify**/**Disqualify** disappear and **Convert lead** appears.
15. Convert reveals its form; **Value Cents** renders as a number control (integer input).
16. Enter a non-numeric value → "must be a whole number" client-side; no POST.
17. Enter a name and `5000000` → the detail re-renders with `Status: converted`; `Converted Company Id` / `Converted Contact Id` / `Converted Opportunity Id` show read-only; exactly one Opportunity exists with `valueCents` 5000000; **no** action buttons remain.

### Pipeline board (Milestone 8)

Validated in the same real-Chromium run (requires the starter's pipeline and `move-stage` registered):

18. `#/pipelines/b2b-sales` renders the board; the converted Opportunity sits in **Discovery** (count 1).
19. `Won ✓` / `Lost ✕` badges are visible text; the Discovery column shows a per-currency `EUR …` total.
20. Select **Demo** in the card's "Move to" control and press **Move** → Demo count becomes 1, Discovery 0, and the server's opportunity record reads `pipelineStage: demo`.

### Lead Intelligence (Milestone 9)

Validated in the same real-Chromium run (requires the intelligence manifests, definitions and framework actions registered — see `docs/LEAD_INTELLIGENCE.md`); note step 17's "no action buttons remain" becomes "no **lifecycle** action buttons remain" — the state-independent Enrich/Record signal/Score/Route controls stay visible:

21. After enrich → score → route on a fresh lead (fixture provider), the lead detail shows the **Enrich**, **Score** and **Route** action controls, the assigned target (`enterprise-italy`) as read-only text, and no editable input for any managed intelligence field.
22. A `score-contribution` record's detail renders the rule key (e.g. `enterprise-company`) read-only — the immutable record modules are browsable but never editable in the generic Admin.

### Quote builder (Milestone 10)

Validated in the same real-Chromium run (requires the commercial manifests, the fixture catalog provider and the quote actions registered — see `docs/COMMERCIAL_OPERATIONS.md`):

23. After a catalog sync, `#/quotes/<id>` on a draft quote shows the **offer** selector (each option naming the offer and its component count), quantity and basis-point discount inputs (with the "1000 = 10.00%" hint and the "flat fees are charged once" note) and the **Totals by commercial period** panel under the documented 1/100 contract. The quote-ineligible `Metered Bandwidth` offer never appears in the selector.
24. Adding **one** line for the composite `Enterprise Plan` (20 seats at 500 bps) re-renders from server state: a **One-time** row at `EUR 4,750.00` and a separate **Recurring every 1 month(s)** row at `EUR 2,850.00` — never summed into one figure, and with no ARR/MRR/TCV anywhere on the page. The line lists all three components with their recurrence and pricing model, and the volume-tiered seat component shows exactly one band, `1–20 · 20 × EUR 50.00` (the whole quantity priced at the reached tier). No client-computed amount is ever posted.
25. Submitting a 20% discount parks the quote in `pending_approval`, shows the policy decision and states that role enforcement waits for the Production Spine; approving as the Admin user actor flips it to `approved`, removes every editing control, and shows no signature or order UI.
26. The resulting quote version snapshots the commercial decision: `#/modules/quote-version-component` lists one immutable row per component (with its complete tier schedule and calculated band breakdown) and `#/modules/quote-version-total` one row per commercial period — all read-only, with no create control and no editable field.

Signature and Order (Milestone 11, ADR-017 — requires the signature manifests, the fixture signature provider and the request-signature action registered):

27. An **approved** quote shows a **Signature** section with exactly one write control (Request signature), a provider selector, signer name/email/role inputs, the statement that sending requires a human user actor and that this is **not** Sales or Legal role enforcement, and the note that all signers are required and signer identity assurance is not claimed. No payment, invoice, billing or delivery control appears anywhere.
28. Sending as the Admin user actor re-renders to the envelope state: status `sent`, provider identity, provider envelope id, document hash and format, and the signer row. The Request-signature control is gone — a second envelope for the same quote version is impossible by construction.
29. After a verified provider completion event, the page shows **Signed artifact evidence** (provider artifact id, document and artifact hashes, type, reference, completion time), the disclosure that the bytes stay with the provider and that this is not a legally qualified signature, and an **Order** with its own one-time and per-period totals plus the note that they are never recalculated from the current catalog. No ARR/MRR/TCV appears, and neither the envelope, the artifact nor the order exposes any input or button.
30. On a `failed` envelope the page states which phase failed, that the provider may still hold the envelope, and offers **Reconcile with provider** — never a second signature request.

Contract activation (Milestone 12, ADR-018 addendum — requires the contracts domain package registered and its eight manifests applied; the section is absent without it):

31. Under an order, a **Contract activation** section offers a policy selector and **Plan activation**, stating that planning is read-only. Planning lists every order component with **both** classification axes — whether it is a recurring right, and what it obliges beyond the money — *and the reason for them*, and creates no record.
32. A component the policy could not classify is highlighted as blocking, with **one editor per undecided axis**, each with its own required reason; no term form and no activation control appear while anything is ambiguous. Applying a decision without a reason is refused before any request leaves the browser.
33. Once nothing is ambiguous, the term form asks for effective date, term start, term end and **the source of the term**, states that these values were recorded after signature and are **not part of the signed agreement**, that the end date is inclusive, that auto-renew and notice days are recorded only, that a future-dated term is recorded as scheduled and nothing transitions it, and that activating requires a signed-in user actor and is **not** Finance or Legal role enforcement.
34. Activating once re-renders to evidence: contract facts (status — `active`, or `scheduled` with its caveat — term, day count, term source and reason, deciding policy version and fingerprint, signed document hash), contract lines showing both axes with their reasons and any human override next to what the policy said, the subscription with its per-period line amounts (including a recurring component that also carries an obligation), and pending delivery/service obligations with the statement that nothing executes them. The activation control does not accept a second click.
35. On an activated order the whole section exposes no input, button or selector, no ARR/MRR/TCV figure is derived, and the omissions (billing, invoicing, renewal, cancellation, delivery execution…) are listed rather than implied.

Report any step that fails; do not mark the actions UI browser-validated unless all pass.

## Delivery change & acceptance (Milestone 14b2)

Validated in real Chromium — most recently as the **pre-merge gate**, after the
independent review added the `resolve-commercial-change` control: **22 checks,
all passing**, scoped to this section. The 37 Milestone 14a checks above were
**not re-run in that pass**; nothing here supersedes them. Automated browser
testing is still **not in CI**; this run was driven manually against a seeded
project and is reproducible from the steps below.

**That rerun found two defects the fake-DOM tests could not.** The first was
serious: every refusal in this section was *invisible*. The section caught its
own failure and did not re-throw, so the parent `withBusy` treated the call as a
success and re-rendered the whole quote detail — destroying both the error
message the section had just written and the operator's typed input. Clicking
"Record follow-up outcome" with an empty reason returned `400` and left the
screen looking exactly as if nothing had happened. Every handler now re-throws,
and the DOM test stub models the real `withBusy` — re-render on success, error on
rejection — so a swallowed failure fails in CI instead of in a browser.

The second: a change request kept saying *"commercial follow-up required"* after
its candidate had been resolved or withdrawn, and its hook reused
`data-commercial-change`, an attribute that already identified the candidate
card. The sentence now follows the candidate's status and the hook is
`data-candidate-ref`.

The run found one real defect the DOM-level tests had missed: the section called
`client.module().action()`, an SDK API the Admin's own request client does not
have. The stub in `tests/admin-delivery-change.test.js` now mirrors the Admin's
real `request(path, options)` shape, so the same class of mistake fails in CI
rather than in a browser.

Setup: compose a project with the delivery package, activate a contract, hand it
over, start the project and its work packages, then open the quote detail route
(`#/quotes/<quoteId>`) where the delivery sections render.

1. A pending commercial follow-up blocks acceptance server-side before the browser opens.
2. The quote route loads and the **Delivery change & acceptance** section renders.
3. The pending candidate is shown as **commercial follow-up required**.
4. It states **"No Quote, Order or Contract has been amended"**.
5. The **Record follow-up outcome** control is visible on a pending candidate.
6. Its own copy says recording an outcome amends nothing.
7. `resolved_externally` and `withdrawn` are the only offered outcomes.
8. An **empty reason is refused**, the message names the field, and it is visible on screen.
9. That refusal wrote nothing: the candidate is still pending.
10. No amend / invoice / bill / payment / charge / renew control exists anywhere.
11. A hostile deliverable label renders as **text**.
12. No element is created from record data.
13. `resolved_externally` is recorded and rendered read-only.
14. A resolved candidate offers no second outcome control.
15. The screen states that recording the outcome amended nothing.
16. Acceptance becomes available only once the follow-up outcome is recorded.
17. **No commercial row moved** across the whole browser session.
18. The `withdrawn` path validates and renders its own outcome.
19. A direct route plus refresh restores the section.
20. The frozen scope renders from storage and says it is never rebuilt.
21. No failed resource or unexpected API response during the run.
22. No uncaught JavaScript error during the run.

## Work — tasks and activity evidence (Work v1, ADR-030)

**Work-specific, scripted, and outside CI. 30 checks, all passing** — driven in real Chromium (**Chrome/141.0.7390.37**) at `184e543` on Node **22.16.0**, serially, twice, on an idle machine (load average 0.15–0.82 on 4 cores), with identical results both runs.

**Browser automation is still manual.** The run was scripted rather than hand-driven — a zero-dependency Chrome DevTools Protocol driver over Node's built-in `WebSocket` — but **that script is not checked in and no CI job launches a browser**, so this remains a gate a human must re-run by hand. Landing the driver under `tests/browser/` and wiring it to a job with a preinstalled Chromium is the only thing that would change that sentence. (Playwright happens to be installed globally on the current build machine but is not a dependency of this repository, and the previous milestones' drivers imported it by absolute path — which is why their browser evidence stopped being reproducible the moment the machine changed.) Nothing here re-runs or replaces the 37 / 22 / 24 checks above.

The section is **package-scoped, not package-owned**: the framework has no seam for a package to contribute an Admin extension — AX1 publishes that as `ADMIN_EXTENSIONS_UNSUPPORTED` — so `apps/admin/public/admin-work.js` lives in the Admin app and renders only while `/api/schema` publishes `domains.work`.

**The first pass of this matrix, at `c3c39c5`, found one defect the fake-DOM tests could not, and it is fixed here.** `renderTask` read `GET /api/modules/work-activity/records?limit=100` — the newest 100 activity rows across **every** subject — and filtered by subject **in the browser**. Once about a hundred activities existed anywhere, an older subject's entries were absent from a page they were never selected into, and the timeline rendered **"Nothing recorded yet."** for a task that demonstrably had a `task_created` entry, with **"Showing at most 100 entries. A display bound of this screen, never a bound on what exists."** printed directly beneath it. Both statements were false at once, and the second was the dangerous kind of false because it read as a disclosure. The fix is **ADR-008 addendum 2**, a new shared surface — `GET /api/modules/:module/records?filter.<field>=<value>`, equality on a single scalar, index-backed fields only (`filterableFields` = indexed and unique fields plus `id`), ≤200 characters, unrepeated, ≤4 combined, still bounded 1–500, every violation a 400, and a module generated before the addendum **refused rather than answered unfiltered**. `listWhere` stays in-process and unrouted. The client-side predicate is retained as defence in depth, so a server that ignored the filter still could not draw another subject's rows. The empty state now reads "Nothing recorded yet **on this subject**", and the truncation notice names the subject, the direction and the missing end.

Setup: compose a project with the `work` package, apply `work-task.module.json` and `work-activity.module.json`, seed tasks in `open`, `completed` and `cancelled` states plus one legacy-migrated row and one row carrying hostile text, then open `#/work`. Checks 26–30 additionally need a project whose activity table exceeds 100 rows, with a subject whose entries are older than that page.

1. The **Work** nav link and the `#/work` queue appear only while `/api/schema` publishes `domains.work`.
2. With the package **not** composed, there is no nav link, no panel, and the screen reads "This application does not have the work package."
3. The queue renders live data: every server record is a row, and the open/closed counts match the server.
4. The detail view shows the immutable source and subject evidence, with the label marked as a snapshot.
5. **`#/work/<id>` is refresh-safe** — a deep link and a reload restore the same view; the hash survives.
6. **Complete** moves an open task and re-renders to completion evidence and a `task_completed` entry.
7. **Cancel** requires a reason, moves the task, and records the reason as the closing note.
8. A **terminal** task offers **zero** controls, and says the server would refuse one.
9. A manual note is recorded, with both the "reaches nobody" and "two notes are two notes" disclosures.
10. A note on a **terminal** task is accepted — allowed by design — and changes no status.
11. A **legacy migrated** row renders: `done` maps to `completed` with an honest `Completed: — at —` rather than invented evidence; a migrated `open` row stays open and is movable.
12. Hostile text renders character-for-character: `<script>`, `<b>`, `${7*7}` and backtick templates are all literal, in the queue and the detail.
13. That text injects **no** node — no `script`, `img`, `b` or `iframe`, no `onerror` — and raises **no dialog**.
14. A due date is a plain instant under an "evidence only" header; an **overdue** task stays open and gets no urgency wording, class or ARIA role.
15. **No assignment, reminder, calendar or notification control exists anywhere**, and the absence is stated, with all 23 `notModeled` items enumerated on screen.
16. A refusal is **visible**, and the user's typed input survives it — including a neighbouring input — and nothing is written.
17. Double-submit is prevented: the control disables in flight, and three clicks produce one state change.
18. Under real network latency, a superseded render is discarded rather than drawn over a newer one.
19. The queue's display bound is **disclosed** when it bites: 141 tasks exist, 100 render, the screen says so.
20. Every control has an accessible name and takes keyboard focus, and every text input carries a durable `aria-label` — **not** a placeholder, which vanishes the moment the user types.
21. No failed resource, no 5xx, no uncaught JavaScript error, no console error and no dialog across the run — including from the new filter query string.
22. Six malformed `#/work` hashes each render "That module route is not valid."; a trailing slash canonicalises to the queue, exactly as `#/quotes/` and `#/modules/<name>/` do; an absent id is an explained failure, not a crash.
23. The timeline is subject-scoped, oldest-first, and states that it is not the audit log and that nothing on it was sent.
24. The package's own limitation text and every `notModeled` item render verbatim on both views.
25. A failed load is explained on screen and its **Retry** actually recovers the queue.
26. **The regression guard.** A task's timeline renders its own entries with far more than 100 activities in the table — the case that previously read "Nothing recorded yet."
27. The narrowing happens **on the server**: the wire response is already scoped to the subject, not filtered afterwards in the browser.
28. A filter on a **non-filterable** field is refused with a `400` that names the field and says a filter must be index-backed — **never answered with unfiltered rows**. Empty, repeated, over-length, over-combined and unknown-field filters are all refused the same way.
29. A module generated **before** the addendum is refused with a `400` naming the cause, never answered unfiltered; an unfiltered read of that same module still works, so the refusal is scoped to the filter.
30. A subject genuinely **past** the bound renders 100 entries and discloses that the subject has more than 100, that these are the most recent, that the list is drawn oldest-first and therefore starts in the middle, and that earlier entries exist and are not shown.

Report any step that fails; do not mark the Work section browser-validated unless all 30 pass.
