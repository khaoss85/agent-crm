# Design-to-CRM

**Status: design only. The generated Admin exists; none of the design pipeline
below does.**

The North Star has always been three inputs, not two:

```text
business brief
+ business process
+ design reference (Figma / screenshot / prototype)
      ↓
CRM navigation · layouts · forms · boards · dashboards · design tokens
      ↓
a tested, responsive Admin the customer owns
```

Eleven milestones delivered the first two inputs thoroughly and the third not at
all. The Admin is generated from module metadata and looks the same in every
project. That is a legitimate v1 — and it is also the part of the promise most
likely to be quietly dropped, because it is the part with no milestone. This
document restores it as a first-class track.

## What exists today

- A generated Admin over one resource contract: collection, detail, forms, action controls, all derived from module metadata (M3/M4, ADR-008/009).
- An **override seam** (ADR-009) already used twice for focused views: the pipeline board (M8) and the quote/signature view (M10/M11).
- Strict rendering discipline: every value is text, never HTML; controls disable in flight; stale renders are discarded; list bounds are disclosed.
- One CSS file and no theming layer.

So the framework can already render a custom view — it simply has no way to be
*told* what a custom view should look like.

## Future primitives

| Primitive | Purpose |
|---|---|
| **Design tokens** | color, type scale, spacing, radius, elevation — declared data, not CSS edits |
| **Theme** | a named token set plus light/dark handling, applied to the whole Admin |
| **Navigation schema** | which modules appear, grouped how, labelled what, in which order |
| **Page / layout schema** | which fields, in which sections, in which order, at which breakpoints |
| **Component override** | a declared swap of one rendering slot, inside the existing seam, without forking the Admin |
| **View contract** | the boundary a custom view must honor: text rendering, disabled-in-flight, stale-render token, disclosed bounds, keyboard reachability |
| **Visual fixture** | a deterministic dataset that renders a page identically every run |
| **Accessibility checks** | contrast, focus order, labels, target size — automated, not aspirational |
| **Visual regression** | screenshot comparison per fixture, in CI |

## Phases

**1. Branding tokens.** A declared token set applied to the existing Admin. No layout change. Immediate, visible customer value and the smallest possible surface.

**2. Navigation and layout mapping.** Declared navigation and per-module layout schemas: sections, field order, breakpoints. Still generated, now shaped.

**3. Safe component overrides.** Formalize the ADR-009 seam into a declared override registry with a stated view contract, so a project can replace a slot without forking — and so a plugin can ship one.

**4. Design-reference interpretation.** The agent reads a Figma file, a screenshot or a prototype and **proposes** tokens, navigation and layout schemas. The output is reviewable declarative data, not generated CSS. A human approves before it is applied.

**5. Visual-regression benchmark.** Deterministic fixtures + screenshots in CI, and a benchmark scenario that scores "brief + design reference → working, on-brand CRM".

Phase 5 depends on browser E2E in CI, which does not exist yet
(`docs/QUALITY_GATES.md` §4).

## Future JTBDs

| ID | Job | Status |
|---|---|---|
| DC-01 | Apply a brand's colors and typography to the Admin | **not supported** |
| DC-02 | Choose which modules appear in navigation, and how they are grouped | **not supported** |
| DC-03 | Control field order, sections and responsive layout per module | **not supported** |
| DC-04 | Replace one component with a custom implementation without forking | **partially supported** — the ADR-009 override seam exists and is used by the pipeline board and the quote view, but it is an internal seam with no declared contract, registry or plugin path |
| DC-05 | Generate a CRM UI from a Figma file or screenshot | **not supported** |
| DC-06 | Prove the UI still matches its design after a change | **not supported** — no visual regression, and browser tests are not in CI |
| DC-07 | Meet a stated accessibility bar | **not supported** — no automated checks; the current Admin is text-first and keyboard-operable by construction, which is not the same as verified |

## Explicitly not claimed

Pixel-perfect generation from a design file is **not** the goal and will not be
claimed. The realistic target is: correct information architecture, on-brand
tokens, sane responsive layout, and a human-reviewable diff — with the design
reference as **input to a proposal**, never as a specification the agent
silently implements.

## The Marketing track depends on this, and does not duplicate it

MK3 (`EXECUTION_ROADMAP.md`) generates email content, landing pages, forms, CTAs and thank-you pages as **checked-in, customer-owned source**, with design tokens and branding owned by the code exactly as this document requires. It composes what is defined here; it does not implement a second design pipeline, and it makes **no claim that visual or Figma ingestion exists**. See `CAMPAIGNS_JOURNEYS.md` §6.
