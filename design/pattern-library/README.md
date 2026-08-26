# Admin pattern library — source

Design guidelines for the frontend the framework generates (`apps/admin/public/`),
derived from the public site's Flow v3 language. Five artboards:

| File | What it settles |
|---|---|
| `Main.dc.html` | Ground, ink, type ramp, rules-not-cards, and the three inherited CSS defects |
| `Authorities.dc.html` | The four-authority colour semantics and the rule-by-rule remap of `apps/admin/public/styles.css` |
| `Controls.dc.html` | Buttons, fields, state chips, empty and toast — all at the site's own geometry |
| `ScreenModule.dc.html` | A generated module list, using only fields `opportunity` actually declares |
| `ScreenApproval.dc.html` | One approval, with the real `standardSalesDiscountV1` source |

`canvas.json` lays them out. These six files are the source of truth; edit them,
never the seeded page.

## The rule this library exists to enforce

Colour is not a severity scale here. It names **which authority holds the record**:
agent, policy, human, evidence — and green for the accord the four produce when
they agree. Values come from `site/assets/styles.css`; anything proposed rather
than existing is labelled as such on the sheet.

## Re-seeding after an edit

The published canvas is assembled by the `design` skill's helper from these
files. From this directory, with `<skill>` the skill's base directory:

```bash
node "<skill>/seed-canvas.mjs" \
  --template "<skill>/payload.template.html" \
  --out accordo-admin-pattern-library.html \
  --title "Accordo Admin Pattern Library" \
  --artboard Main.dc.html --artboard Authorities.dc.html --artboard Controls.dc.html \
  --artboard ScreenModule.dc.html --artboard ScreenApproval.dc.html \
  --canvas canvas.json
```

`accordo-admin-pattern-library.html` is a ~2.5 MB build artifact and is
gitignored. Publish it to the existing artifact URL rather than a new one, or
the link people have stops being the current one.

## Two honest caveats, kept here so they are not lost

- **The sheets load both faces from Google Fonts.** The shipped site refuses to,
  because `vercel.json` sets `font-src 'self'` — it vendors them under
  `site/assets/fonts`. The canvas admits no other font host, so the drawing of
  the rule cannot obey the rule. It still applies to the product.
- **Company and person names are invented** (Acme S.p.A., Sarah Rossi), matching
  the site's own demonstration. Every identifier, threshold, field name, state
  string and policy value is real and was read out of the source.

## What is not in scope

This is guidance, not an implementation. Nothing here changes
`apps/admin/public/`. Applying it is a separate change, and the first three
items are defects rather than design work: the missing Inter font file, the
undeclared `--surface-soft`, and four `var()` fallbacks that name a colour other
than their own token.
