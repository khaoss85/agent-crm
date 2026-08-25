# The Flow v3 — brand device and a concrete product demonstration

## Goal and user-visible outcome

Evolve the public site's art direction from "a very good developer-product landing page" into a
visual language a visitor could recognise without the wordmark, and answer the question the
previous direction left open: *what does my coding agent actually build?*

Two outcomes, deliberately separate:

- **Emotional memorability.** A brand device derived from the product's own mechanics, recurring
  at several scales across the site.
- **Product tangibility.** One section that shows business intent becoming policy source becoming
  the CRM screen a team uses, with the causal link between them drawn rather than asserted.

Everything the accepted information architecture already carries — claim/evidence contracts,
generated Markdown peers, canonical URLs, structured data, the product/repository-truth
separation — is preserved unchanged.

## Current repository context

- Continues `docs/plans/public-site-art-direction.md`, which established the Flow palette, the
  animated approval demonstration and the marquee. That plan's milestones 1–4 are merged; this
  is the next art-direction iteration on top of them, not a replacement.
- `site/assets/styles.css` owns the whole visual system. The production CSP in `vercel.json` is
  `default-src 'none'` with **no `script-src` at all**, so motion stays CSS-and-semantic-HTML.
- That same CSP is `font-src 'self'` and `style-src 'self' 'unsafe-inline'`. A font CDN is not a
  slower option here, it is a blocked one — the face would silently never arrive.
- `tests/site-art-direction.test.js` pinned the previous direction's implementation details. Two
  of its assertions describe markup this plan replaces and are rewritten here; the rest are kept
  and extended.
- The design source is a Claude Design handoff bundle (desktop `Accordo — The Flow v3` plus a
  390px companion). It is a prototype: pixel intent is authoritative, its internal structure is
  not, and two of its details were wrong for this repository (below).

## Approaches considered

1. **Keep the hero demo as a card and restyle it.** Cheapest, and it preserves every existing
   selector. Rejected: the whole complaint the iteration answers is that the product story reads
   as a dashboard widget inside a card inside a grid of cards. Restyling the card does not move it.
2. **Introduce an illustration system — mascot, scene, spot drawings.** Memorable, and completely
   disconnected from what the software does. It would also be the one surface on this site whose
   content no test can bind to a fact. Rejected.
3. **Derive the brand device from the product's own semantics, and let the page be built from the
   device.** The four authorities in every governed decision — agent, policy, human, evidence —
   drawn as four arcs closing into one ring, and the process drawn as a line that a gate stops.
   Chosen: it is ownable, it is *about* the product, and it degrades to semantic HTML.

## Decisions worth recording

- **Two greens, not one.** `--accent` was a vivid fill green used both for rails and for every
  link, kicker and evidence tick; as 15px text on warm paper that is 3.4:1. The token now splits:
  `--accord` is the fill (rail, marquee ground, the seal's centre), `--accent` is the readable
  green words are set in. One edit fixed about twenty inherited rules.
- **`--dim` darkened from the prototype's `#8f8a78` to `#6f6a5a`.** 3.12:1 → 4.88:1. It is the
  colour of stop labels and field labels — 10px mono a customer has to read.
- **Display tracking is set by the typeface.** Bricolage Grotesque draws `f` with a crossbar that
  reaches well past the stem; below about -.024em the two crossbars in "different" merge into the
  `i` beside them and the word renders as though struck through — on the one headline the site is
  built around. -.022em is the tightest setting that stays legible.
- **Both faces are vendored** under `site/assets/fonts` as latin-subset variable woff2 (113 kB
  total) with `OFL.txt`, because of the CSP above. `scripts/site-check.js` exempts that directory
  from the hardcoded-brand scan: an upstream licence is not ours to route through `brand.json`.
- **Includes are now recursive** (depth-capped at 8) so the mark can be drawn once in
  `site/partials/seal.html` and pulled into the nav, the footer and eleven templates.
- **The implementation boundary moved out of the banner above the wordmark** into the colophon and
  the proof section. It is still on every page and still unhedged; a visitor now meets the durable
  product truth before the current state of the implementation. A test holds that condition.
- **Two details of the prototype were wrong for this repository and were corrected**: its policy
  snippet was illustrative pseudo-API (the real shape is
  `examples/starters/b2b-lead-qualification/commercial.js`, with discounts in basis points), and
  its gate label said 15% where the section's own sentence says 20%.

## Milestones

### 1. The Accord Seal

- Four arcs — violet agent, yellow policy, coral human, cyan evidence — closing around a green
  centre: four streams that only form a valid business state when they accord.
- Drawn once in `site/partials/seal.html` from `brand.json` `flowColors`; the mark, the social
  preview, the nav, the footer and the stylesheet cannot drift apart.
- Recurs as the logo, a slow-turning hero object, the thing the choreography **mints** the moment
  audit is recorded, the seal on the "one system" strip, and the seal on the proof receipt.

### 2. The signature scene

- A full-bleed rail carrying the eight lifecycle stops; at Approval a gate closes on the agent's
  discount request, a human arrives from a different layer and stamps it, the gate opens and the
  flow leaves an audit trace behind.
- The whole scene is generated from an ordered list that reads correctly with no CSS at all.
- Reduced motion renders the *finished* story — approved, gate open, audit recorded — rather than
  an empty rail.
- Below 760px the scene is rotated, not stacked: the same line, gate and order, read downwards.

### 3. In practice — intent → source → running CRM

- The business sentence, the CLI plan, the real policy source and a plausible generated admin
  screen, in one row.
- Cause and effect is literal: a coloured mark on a line of policy and the same coloured mark on
  the behaviour it governs, pulsing together on a 12s cycle.
- A full-width strip states the one-system point: UI, model, services, workflows, policy, audit.

### 4. The spine, and de-carding the rest

- Below the hero the rail turns vertical and becomes the page's left margin; every section is a
  stop on it with a node in its actor's colour.
- Card grids become rules, numbers and type. Solution and resource cards become editorial rows.
- The shared shell (nav, footer, tokens) carries the direction to all 160 built pages; the
  fourteen hand-written templates additionally get spine nodes and, where they are product pages
  rather than retrieval pages, the mark.

### 5. Validate

- `npm run gtm:check`, `npm run repo:truth -- --check`, the site/SEO/art-direction tests and the
  full suite.
- Browser receipts for desktop, 390px mobile and reduced motion.

## Validation

- `npm run gtm:check` succeeds — site generation, HTML/Markdown correspondence, discovery,
  distribution and surface contracts all intact.
- `tests/site-art-direction.test.js` extended: reduced-motion resolves the scene to its ending;
  the bleed cannot overshoot the viewport; the spine carries an actor colour per section; both
  faces are same-origin and every family ends in a system stack; the seal draws from shared
  tokens only; the boundary sentence is on every page. The WCAG test now reads the tokens out of
  the stylesheet instead of repeating them, so a colour edited in one place cannot pass a test
  that is checking the colour it used to be.
- Browser receipts regenerated with `npm run site:shots`.

## Adversarial review (pre-merge, AGENTS.md §10)

Reviewed at `a9c4c52` against `origin/main` `bc03409` — merge-base equal to the base, one commit,
no conflicts, `project doctor` valid with no problems, nothing tracked that must not be.

Four defects confirmed and fixed in place. Three of them were invisible to every receipt taken
during the build, which is the finding behind the finding:

1. **High — 7.5px of horizontal overflow on every page.** `.flow-scene` used `width: 100vw` with
   `margin-inline: calc(50% - 50vw)`. `100vw` includes the scrollbar; the 50% resolves against a
   parent that excludes it; they stop cancelling the moment a scrollbar appears. Measured in
   Chromium at 1280x700: 8px on the branch, 0px on main. **`npm run site:shots` passes
   `--hide-scrollbars`, so no screenshot in this repository can ever show this class of defect.**
   Fixed by dropping the viewport unit entirely — the scene is a direct child of `<main>`, so
   `width: 100%` is already exactly full-bleed.
2. **High — the test asserted the defect.** `site-art-direction.test.js` claimed the `100vw`
   pattern "cannot overshoot". It was rewritten to assert the measured invariant, and a second
   test now covers the grid failure below. A test that encodes a defect is part of the defect.
3. **Medium — 49px of overflow at 390px** in the new *In practice* section. The desktop tracks
   were `minmax(0, …)` but the narrow override was a bare `1fr`, and a grid *item*'s automatic
   minimum size is its own min-content regardless of the track: a 303px track held 366px items.
   Fixed with `minmax(0, 1fr)` plus `min-width: 0` on the items.
4. **Medium — two silent losses inside the code pane.** Making `.code` a dark terminal ground in
   both themes left two rules written for the light pane behind: `.code .bad` at 3.32:1 and
   `.code.refusal`, whose mark was a `border-color` on a rule this direction had set to
   `border: 0` — on the page the brief calls the most differentiated on the site. Both restated
   in the pane's own palette; a test now measures every pane foreground against the pane.

Also corrected: `.colophon-boundary` was introduced with no rule at all — the one paragraph whose
prominence justifies moving the boundary out of the banner; and §10 of `DESIGN_BRIEF.md` still
forbade "animation beyond a focus ring", which the site outgrew two passes ago. The prohibition
is replaced by the rule it was reaching for, which is testable: motion may only reveal a
relationship the HTML already states.

Pre-existing defects the redesign amplified, and improved on the way past: inline `<code>` holding
file paths had no break opportunity (Spline Sans Mono sets wider than the system mono it
replaced), and generated tables emitted without a `.table-wrap` inherited a `min-width: 620px`
with nothing to scroll in. `evidence.html` went from 32px of overflow at 390px to 0; `jobs.html`
from 259px to 23px, and to 0 at 768px and above.

Not applicable to this milestone, and stated rather than skipped: public-boundary bypass,
state-machine algebra, transaction and fault injection, idempotency, two-connection concurrency,
exact query beyond page bounds, immutable boundaries, provider timeout, replay and reconciliation,
audit/event/trace exactness, schema compatibility. No runtime, domain or persistence code is in
the diff.

## Residual limitations

- The generated CRM screen is a demonstration with invented data (Acme S.p.A., Sarah Rossi). It
  is not a customer deployment and no page says or implies that it is.
- Bricolage Grotesque draws `Q` with a long horizontal tail that passes under the following
  letters. On "Quote & approval" — a solution-card title — it reads a little like a link
  underline. It is a characteristic of the face, not a defect, and no stylistic set changes it.
- The 12s pairing cycle and the 16s scene cycle are independent; they are not meant to line up.
- `jobs.html` still overflows by 23px at 390px and 93px at 320px. It renders a four-column
  generated table with no `.table-wrap`, which is a shape in `scripts/site-pages.js` rather than
  in this stylesheet; fixing it properly is its own change. It is better than it was.
- `npm run site:shots` captures with `--hide-scrollbars`. Every image it produces is taken in a
  world where the scrollbar has no width, so it cannot show a scrollbar-induced layout defect.
  The overflow probe used in this review is a page that reports `documentElement.scrollWidth -
  clientWidth` and names the widest unclipped element; it is worth folding into the receipts.
