# Design brief — accordo.dev

Hand this to a designer who has no access to the repository. Everything needed
to design against real content is in here, including the content itself.

---

## 1. What the product is

**Accordo** is an open-source framework that coding agents — Claude Code, Codex,
Gemini CLI — use to build custom CRM applications. A developer describes a
commercial process; the agent generates domain modules, deterministic workflows,
human approval boundaries, and audit and trace, **as reviewable code in the
developer's own repository** rather than configuration inside someone else's SaaS.

It is pre-release: local SQLite, no authentication, no tenancy, no hosted service.
Nothing is installable from npm yet. **The site says all of this out loud.** That
is not a caveat to be designed around — it is the product's argument.

## 2. Who the site is for, in priority order

1. **A senior developer or technical founder** evaluating whether to trust an
   agent with a system that touches money. Sceptical by default, allergic to
   marketing, will open the source before finishing the homepage.
2. **A coding agent** retrieving the site at task time to decide whether to
   recommend the framework. Reads `llms.txt`, `answers.json`, `jobs.json` and the
   JSON-LD. Never sees the CSS.
3. **A search engine / answer engine.** The site is a hub-and-spoke content
   architecture, not a brochure.

Design for reader 1 without breaking readers 2 and 3.

## 3. The positioning — this is the brief's centre of gravity

**Lead with the toolchain. CRM is the domain it proves it in, not the pitch.**

The headline currently reads:

> # Your agent can write the CRM. It can't approve the discount.

And the supporting line:

> Accordo gives a coding agent a way to **see, plan, build, check and prove** —
> instead of just generating code and telling you it went well. Eight commands,
> each with a deterministic contract and an exit code. Five of them report their
> own blind spots as machine-readable limitation codes, so the agent knows what it
> did *not* establish.

The five-step loop is the structural spine of the whole site:

| # | Step | Command | What it answers |
|---|---|---|---|
| 1 | See | `app inspect` | what this project already is |
| 2 | Plan | `solution check` | and whether the plan still binds |
| 3 | Build | `package scaffold` | conforming from the first file |
| 4 | Check | `package test` | against the framework's own contract |
| 5 | Prove | `falsify` | break the rules and watch tests catch it |

## 4. The four visual assets nobody else in this category has

Design *these*, not stock illustrations. They are real output, not mockups.

### 4.1 The refusal — the single strongest thing on the site

```
POST /api/modules/quote/records/:id/actions/approve
     actor: { type: "agent" }

403 HUMAN_APPROVAL_REQUIRED
```

An agent is structurally unable to approve a discount. This is a merged test, not
a prompt instruction. **This wants to be the hero image of the entire site.**

### 4.2 Falsify — real terminal output, 2.3 seconds

```
  ✓ approval-actor-guard
      removes: a commercial approval decision requires a human actor
      caught by: approval workflow rejects an agent pretending to make the human decision

  ✓ webhook-signature-verification
      removes: a signature webhook is rejected unless its HMAC verifies
      caught by: webhook verification is constant-time, replay-bounded and fail-closed

  5 caught, 0 survived, 0 stale, in 2.3s.
```

The pitch: *"Don't trust our tests. Break them yourself, in one command."*

### 4.3 The composition, measured

```
modules       71        resources     66        policies       7
packages       9        actions       59        providers      1
```

Composed and inspected in seconds, from manifests, by one command — these
values are `npm run tour`'s own output at the commit this brief was last
regenerated from, never typed from memory; re-run the tour before quoting them.

### 4.4 The blind spots, published as data

The inspector emits its own limitations as machine-readable codes. These want to
be a visual element — chips, a grid, a marquee of honesty:

`DATABASE_NOT_INSPECTED` · `PROVIDER_HEALTH_UNKNOWN` · `PRODUCTION_SPINE_ABSENT` ·
`RUNTIME_STATE_UNKNOWN` · `SECRETS_NOT_INSPECTED` · `DOMAIN_CORRECTNESS_NOT_PROVEN` ·
`EVIDENCE_NOT_AGGREGATED` · `CI_EVIDENCE_NOT_INFERRED` · `ADMIN_EXTENSIONS_UNSUPPORTED` ·
`DATA_QUALITY_UNKNOWN` · `PACKAGE_SOURCE_TRUSTED` · `PROCESS_ISOLATION_BOUNDED`

**Nobody else publishes their own blind spots.** That is the brand.

## 5. Page inventory — 140 pages, seven clusters

Hub-and-spoke: each pillar page links down to its spokes, each spoke links back up.

| Cluster | Pillar | Spokes | What a spoke looks like |
|---|---|---|---|
| **Agent tools** | `tools.html` | 8 | one command: what it answers, what it refuses to claim, what it costs to run |
| **Capabilities** | `capabilities.html` | 6 | one business domain: what it models, what the framework refuses, what proves it |
| **Concepts** | `concepts.html` | 8 | why it is built this way — the vision layer |
| **Compare** | `compare.html` | 4 | opens by naming where the *alternative* wins |
| **Jobs** | `jobs.html` | 63 | one CRM job, its support status, its evidence |
| **Answers** | `answers.html` | 15 | one blunt question, answered, plus 15 published refusals |

Plus: `index.html`, `evidence.html` (the full claims ledger as a table), `blog.html`
(the first evidence-backed post now ships; the honest zero-post state remains a renderer requirement),
`privacy.html` (the hosted Docs MCP data boundary), and `404.html`.

**Only five content templates are needed:** homepage · pillar · spoke ·
table-page (evidence/jobs) · privacy/data-boundary. Everything else is generated.

### The eight tools, with their plain-English names

| Command | Plain name |
|---|---|
| `app inspect` | See what exists |
| `solution check` | Decide what to build |
| `project doctor` | Find what's broken |
| `package scaffold` | Create the right starting point |
| `package test` | Check it follows the rules |
| Quality Gates | Prove it works |
| `falsify` | Try to break it yourself |
| Skills & MCP | Plug it into your agent |

### The six capabilities

Lead scoring and routing · CPQ and discount approval · E-signature to immutable
order · Contract and subscription activation · Delivery projects and economics ·
Support entitlements and SLA

## 6. The one structural rule the design must honour

**Every page has a `boundary-block`: what this does *not* do.** It sits **above**
the body content, not in a footnote, and it must be visually prominent.

Sample, from the CPQ page:

> - Nothing bills. There is no invoice, no payment and no dunning.
> - Every signature provider is an offline fixture; no envelope has ever been sent.
> - There is no scheduler, so a renewal date passes without anything firing.

A competitor puts this in 11px grey at the bottom. **We put it in the light.**
If the design makes this feel like a disclaimer, the design has failed.

## 7. Hard technical constraints — non-negotiable

- **Zero JavaScript.** The site ships none, and says so. Menus, disclosure and
  tabs must work with `<details>`/`<summary>`, `:target` or CSS alone.
- **Zero external requests.** No CDN, no Google Fonts, no analytics, no remote
  images. System font stack only (Inter if present locally, else system UI).
- **Static HTML from a generator.** No framework, no bundler, no build step
  beyond the existing Node script. One stylesheet.
- **Light and dark, both first-class**, via `prefers-color-scheme`. No toggle.
- **Loads over `file://`** — all internal links are relative with depth prefixes.
- **Accessible:** 4.5:1 contrast in both themes, visible focus rings, one `<h1>`
  per page, no horizontal scroll at 360px.

## 8. Brand tokens — use these, do not invent

**Light**

| Token | Value | Use |
|---|---|---|
| `ink` | `#18211c` | body text |
| `muted` | `#647067` | secondary text |
| `line` | `#dce1da` | borders, rules |
| `surface` | `#ffffff` | cards |
| `paper` | `#f3f5f1` | page background |
| `accent` | `#1f6f50` | links, commands, emphasis |
| `accentSoft` | `#e4f2eb` | accent backgrounds |
| `warning` | `#9b5c0a` | the boundary block, the 403 |
| `warningSoft` | `#fff0d8` | boundary background |
| `danger` | `#a23636` | failure states |

**Dark**

`ink #e8ede9` · `muted #97a49b` · `line #2a332d` · `surface #161b18` ·
`paper #0f1311` · `accent #6cc79b` · `accentSoft #1a2f26` · `warning #e0a856`

Type: `Inter` / system sans, and `ui-monospace, SFMono-Regular, Menlo, Consolas`
for every command, code, status and limitation code. **Monospace carries a lot of
the identity here** — it is the voice of the machine reporting on itself.

## 9. Existing class names — keep these working

The generator emits these; renaming one breaks 113 pages.

`breadcrumbs` · `cluster-hero` · `cluster-grid` · `cluster-card` · `card-plain` ·
`spoke-hero` · `plain-name` · `boundary-block` · `boundary-list` · `evidence-rail` ·
`evidence-group` · `related-rail` · `section-block` · `intent-line` · `loop` ·
`loop-step` · `loop-note` · `code` · `hero` · `lede` · `eyebrow` · `cta` ·
`button` · `cards` · `card` · `shell` · `nav` · `status-banner` · `footer-grid` ·
`mono` · `limits-grid` · `limit-card` · `table-wrap`

New classes are welcome. Renamed ones are not.

## 10. Tone, and the words that are forbidden

Quiet, dense, documentation-shaped. Closer to a well-made technical reference than
to a SaaS landing page. No gradients as decoration, no drop shadows for depth, no
animation beyond a focus ring, no stock illustration, no 3D shapes, no hero video.

A build gate **fails the deploy** if any of these words appear anywhere on the site:

> production-ready · enterprise-grade · SOC 2 · ISO 27001 · HIPAA · GDPR-compliant ·
> bank-grade · fastest · best · leading · world-class · revolutionary · game-changing ·
> guarantee · any "N% success rate" · fully autonomous · replaces Salesforce ·
> zero-config · trusted by

Also absent by decision, so do not design slots for them: pricing, newsletter
capture, testimonials, customer logos, case studies, "used by" counts. There are no
customers, and inventing the furniture for them is the one thing this site cannot do.

## 11. Reference points

**medusajs.com** for density, monospace confidence and the dark technical register —
but do not copy it. Medusa sells commerce modules to human developers. This sells
*an agent's reliability*, and the assets in §4 are things Medusa has no equivalent of.

Others worth a look for the shape rather than the skin: **Stripe docs** (information
density), **Linear** (restraint), **Sentry's older marketing** (showing real output).

## 12. What to deliver

In priority order:

1. **Homepage** — hero, the five-step loop, the 403, falsify output, the blind-spot
   chips, the six-cluster grid, the limits section.
2. **Spoke template** — breadcrumbs, h1 + plain name, boundary block, body
   sections, evidence rail, related rail. This is 102 of the 113 pages.
3. **Pillar template** — hero plus a card grid.
4. **Table template** — evidence ledger and jobs catalogue, dense and scannable.
5. **Blog index and article page**, retaining the tested empty state for a build with no posts.
6. **Privacy/data-boundary page**, using the same above-the-fold boundary block.
7. **Nav and footer** at desktop and 360px.

Light and dark for each.
