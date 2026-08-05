# Admin manual browser smoke checklist

Automated tests cover the Admin at the DOM/integration level (real server + real fetch + a fake document) and run in CI. They do **not** drive a real browser in CI. During the Milestone 4 adversarial review this exact flow was additionally validated once in real Chromium (16 automated checks, all passing, including the XSS-as-text and malformed-hash cases). Re-run this checklist in a real browser before releasing changes that touch `apps/admin/public/`.

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

Report any step that fails; do not mark the actions UI browser-validated unless all pass.
