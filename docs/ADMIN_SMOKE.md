# Admin manual browser smoke checklist

Automated tests cover the Admin at the DOM/integration level (real server + real fetch + a fake document). They do **not** drive a real browser. Run this checklist in a real browser before releasing changes that touch `apps/admin/public/`.

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
