# Admin visual alignment — phase 1: tokens, type, state semantics

## Goal and user-visible outcome

`apps/admin/public/` — the Admin every generated project ships — stops looking
like a different product from accordo.dev. After this change the Admin renders
in the site's vendored faces on every machine, on the site's warm paper, and
colours record state by **which authority holds it** (agent, policy, human,
evidence, accord) rather than by a generic warning/danger scale.

Derived from `design/pattern-library/` (sheets 01–03). Sheet-04/05 layout
ideas — de-carding the dashboard, editorial rows — are **phase 2** and not
here; this phase changes no markup structure and no behaviour except one
badge-text line.

## Current repository context

- `apps/admin/public/styles.css` (175 lines) carries three defects the pattern
  library documented: `font-family: Inter` with no font file anywhere under
  `apps/`; `--surface-soft` used three times and never declared; four `var()`
  fallbacks naming a colour that is not their own token.
- `.badge.failed, .badge.rejected` is one rule — a crashed run and a human
  refusal look identical. `.badge.proposal, .badge.completed, .badge.approved`
  is one rule — an agent's proposal and a settled accord look identical.
- `text-transform: capitalize` plus `stage.replace('_', ' ')` in `app.js:109`
  renders "Approval Pending", a string that exists nowhere in the API, audit
  or trace, so a user cannot search for what they read.
- `apps/server/src/http-server.js` `mimeType()` has no `.woff2` entry.
- The 14 admin test files assert behaviour against a fake DOM; grep confirms
  none binds a colour, a font or the capitalised badge text.
- `npm create accordo` vendors `apps/` wholesale, so generated projects pick
  this up with no further work.

## What changes

1. **Vendor the faces.** Copy `bricolage-grotesque-latin-var.woff2`,
   `spline-sans-mono-latin-var.woff2` and `OFL.txt` from `site/assets/fonts/`
   to `apps/admin/public/fonts/`; declare both `@font-face`; the stacks end in
   system fallbacks. No font CDN — generated projects run offline
   (`NO_NETWORK_ACCESS` is a stated property of the scaffold).
2. **`.woff2` MIME** in `http-server.js`.
3. **Retoken `styles.css`** to the site palette (paper `#f7f3e9`, ink
   `#171912`, muted `#62655b`, line `#d9d5c8`, surface `#fffdf7`, accent
   `#176b2a` + soft), plus the authority tokens (`--agent/--pending/--human/
   --data`, each with `-soft` and `-ink`, and `--accord`). Declare
   `--surface-soft`. Drop every `var()` fallback — the tokens are always
   declared, and a fallback that can drift is how two of the defects happened.
4. **State semantics.** Badges become 11px mono, weight 700, `6px 10px`,
   radius 6px, lowercase, no capitalize — the site's `.practice-chip`
   geometry. Rules split per authority: `approval_pending`/`approval_required`
   → policy; `rejected` → human; `failed` keeps danger; `proposal`/`draft` →
   agent; `approved`/`completed`/`auto_approve` → accord. Trace `.dot` →
   evidence (`.span.failed .dot` keeps danger); `.immutable` → evidence ink.
5. **One JS line:** `app.js:109` stops spacing the stage string; the badge
   shows the machine's own state token, searchable as read.
6. **Controls to site geometry:** buttons radius 12px / `13px 20px` / weight
   750, primary = accent on paper text; inputs radius 9px; focus
   `2px solid var(--accent)` at 3px offset everywhere.

## Validation

- `npm run verify` (the full suite; the admin tests are behavioural and must
  stay green untouched).
- Visual receipt: `accordo serve` against a demo-seeded SQLite, headless
  Chrome screenshots of the dashboard, committed nowhere but checked by eye —
  browser E2E stays deliberately out of CI (`docs/ADMIN.md`).
- `npm run repo:truth -- --check` — no bound claim names Admin colours, but
  the check is cheap and the rule is to run it when touching product surface.

## Residual limitations

- No dark theme in the Admin; the site has one. Phase 2 decision.
- The dashboard keeps its card layout; de-carding is phase 2 with real
  markup work and its own screenshots.
- `.pipeline-column.type-won/.type-lost` tints and the quote-builder blocks
  are retinted into the new palette but keep their structure.
