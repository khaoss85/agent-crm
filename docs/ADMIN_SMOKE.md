# Admin manual browser smoke checklist

Automated tests cover the Admin at the DOM/integration level (real server + real fetch + a fake document) and run in CI. They do **not** drive a real browser in CI. During the Milestone 4 adversarial review this exact flow was additionally validated once in real Chromium (re-run at each milestone; 37 automated checks at Milestone 14a, all passing, including the XSS-as-text, malformed-hash, composite-pricing, signature/order, contract-activation, delivery-handover and delivery-execution cases). Re-run this checklist in a real browser before releasing changes that touch `apps/admin/public/`.

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
