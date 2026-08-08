# Extraction preparation — the work that must happen before Lead Intelligence moves

**Nothing in this document is implemented, and nothing in it authorizes an
extraction.** It is the analysis DX1 was asked to produce alongside the Project
Doctor: what still blocks the first legacy-domain extraction, what each blocker
would cost, and in what order they should be taken. Two of the four are contract
decisions that belong to a human.

Status of record: `docs/architecture/LEGACY_ALIGNMENT_MATRIX.md` records Lead
Intelligence as the **working hypothesis** for the first extraction. That has not
changed. What has changed is that the blockers are now measured rather than
suspected.

## Where the path stands

```text
crm app inspect        the composition before                     AX1   shipped
crm solution check     a plan bound to that composition           AX2   shipped
crm project doctor     is the source coherent before I start?     DX1   shipped
crm package scaffold   an empty conforming target to move into    DX3   shipped
  move code            registries, actions, records               by hand
crm package test       does the result conform?                   DX4   shipped
  characterization     does it still DECIDE identically?          LA0   shipped
```

All seven rungs now exist. The last one to arrive, LA0, is the only one that
can answer the acceptance criterion, which has been the same since ADR-018:
**behaviour preservation, proved from the outside.**

---

## LA0 — Legacy Characterization Harness (merged, `360b0f6`)

### Why it is a gate and not a nice-to-have

`crm package test` proves a package satisfies the *framework contract*. It says
so itself, under `DOMAIN_CORRECTNESS_NOT_PROVEN`: it executes no action,
evaluates no policy and drives no state transition. An extraction that passes
DX4 has proved the new package is well-formed. It has proved nothing about
whether the extracted domain still *decides* the way it did.

Without LA0 the only available proof is "the existing tests still pass" — which
is precisely the proof this repository has twice written down as insufficient,
because it is the proof that misses a boundary violation.

### What it would do

Freeze the externally observable behaviour of a domain **before** the move, then
prove equivalence **after** it. Not a diff of source; a diff of decisions.

```text
record   drive the domain through a corpus of inputs against the pre-move build,
         capturing every externally observable output as evidence
replay   drive the identical corpus against the post-move build
compare  every captured value must be identical, or the extraction has failed
```

### Coverage the harness would need

| Surface | What must reproduce identically |
|---|---|
| HTTP routes | status, headers that carry meaning, body shape and every value |
| SDK | every method's return value and every error type and message |
| `/api/schema` | the published schema block, field for field |
| Admin-visible behaviour | what a reader of the Admin would see for the same data |
| actions and workflows | the same action names on the same records, same results |
| audit, events, trace | the same rows, same count, same order, same span shape |
| migrations and data | the same tables, the same rows, no silent rewrite |
| restart | the same answers after a process restart from the same database |
| exact reads | **>500** individual value assertions, not summary comparisons |
| hostile input | prototype-shaped keys, oversized strings, markup, control characters |
| AX1 / AX2 | the same `app inspect` shape, and plans that bound before still bind |

### Additional coverage specific to Lead Intelligence

Because it is the candidate, and because its evidence records are the domain:

- enrichment snapshots — the same provider output stored the same way;
- behavioural signals — the same signals from the same inputs;
- scoring: the same score, the same **model version**, the same declared-definition
  **fingerprint** (ADR-015);
- routing: the same target chosen, the same capacity arithmetic, the same
  fallback reason when a policy declines every eligible target;
- assignments: the same assignee, the same record shape;
- lifecycle gating: the same transitions allowed and refused;
- provider fingerprints and target-set evidence — the values that make a past
  decision explainable must reproduce byte-for-byte.

A scoring model that returns the same number under a different fingerprint has
**failed** this harness. The number is not the decision; the explainable,
versioned decision is.

### Sequencing

LA0 is built **before** any extraction and against the *current* code, because a
characterization harness written after the move characterizes the move.

### Status: built and measured

Implemented in `tests/characterization/` with `legacyCharacterizationContract: 1`
and a checked-in baseline of **151 observations / 822 asserted values**. Design
and rationale: `docs/plans/la0-legacy-characterization.md`.

Two things it established that this document previously only assumed:

- **A score is not a number.** The suite fails when a model returns the same
  total under a different declared-definition fingerprint. That was the stated
  acceptance criterion and it is now mechanical.
- **Two defect candidates exist and must not be carried through the move.**
  `record-signal`'s `value` accepts unbounded text (5,000 characters stored;
  `MAX_TEXT` is 2,000 and `MAX_REASON` is 300 elsewhere here) and stores control
  characters verbatim (`partner-scorecard`, the teaching example, refuses them).
  Reproduced and documented, deliberately **not** frozen as contract. Each is a
  recommendation for a separate pre-extraction fix.
  **Both were fixed in `1e40d1e`**, which bounded `value` to the module's own
  `MAX_TEXT` of 500 and refused control characters and line breaks. The finding
  above is the record of what LA0 measured at the time, not a live defect.

---

## Blocker 1 — the neutral helpers (**done**)

> **Status: moved.** `computeDefinitionFingerprint`, its canonicalizer and
> `validateDeclaredConfig` are now in `packages/core/src/definition-fingerprint.js`;
> `withTimeout` is in `packages/core/src/timeout.js`. No module outside Lead
> Intelligence imports an Intelligence file to reach a neutral helper any more.
> The assessment below is left as written — it is the reasoning the move was
> made on, and the recommendation it ends with is what was carried out. The
> outcome is recorded at the end of the section.

`computeDefinitionFingerprint` lives in `packages/core/src/intelligence-registry.js`
and `withTimeout` in `packages/core/src/intelligence-actions.js`. Both are read
from outside Lead Intelligence:

| Reader | Imports | Why it matters |
|---|---|---|
| `packages/core/index.js` | `computeDefinitionFingerprint` | it is **public kernel API**, re-exported for every package |
| `packages/core/src/catalog-sync.js` | both | Commercial Operations depends on Intelligence's *files*, and Commercial is itself `needs_extraction` |

### Are they genuinely domain-neutral?

**Yes, both — assessed against what they actually do, not where they live.**

- `computeDefinitionFingerprint` hashes a declared definition's canonical form.
  It knows nothing about enrichment, scoring or routing. ADR-015 describes it as
  the *declared-definition* mechanism, and Commercial Operations (ADR-016) and
  Signature (ADR-017) already use it for discount policies and providers. It is
  horizontal machinery that happens to sit in an Intelligence file because
  Intelligence is where it was first needed.
- `withTimeout` bounds an async call. It is a utility with no domain content
  whatsoever.

Nothing about either is Lead Intelligence. They are in those files for
historical reasons only.

### Now pinned by behaviour, not by argument

LA0 freezes `computeDefinitionFingerprint` over thirteen shapes — empty object,
empty array, null, scalars, key-order-swapped, nested, array-order, unicode,
deep — plus the two properties every consumer depends on (key order irrelevant,
array order significant), and `withTimeout`'s three outcomes (resolved,
rejected, timed out) including the exact message a caller sees.

"Mechanical, zero behaviour change" was a claim. It is now checkable: if the
move changes a single fingerprint or a single timeout outcome, the baseline goes
red. That is the evidence that makes the helper-move PR safe to review quickly.

### Recommendation

**A separate, tiny, mechanical PR before any extraction**, moving both into
neutral kernel modules — `computeDefinitionFingerprint` beside the other declared
definition machinery, `withTimeout` into a general async utility module — with:

- **zero behaviour change**: same function, same signature, same output;
- the public re-export from `packages/core/index.js` preserved exactly, so no
  package sees a difference;
- the old module paths re-exporting from the new location for one release if any
  in-repo importer would otherwise churn, and deleted in the same PR if not;
- `npm run verify` and `crm project doctor` green before and after.

It is small, independently useful, and unblocks the discussion rather than
prejudging it. **Not done in DX1**: the Project Doctor does not need it, and a
diagnostic PR is the wrong place to move kernel exports.

### Outcome

Carried out as recommended, with three things worth recording because they were
decided during the move rather than before it.

**`validateDeclaredConfig` moved too.** The recommendation named two helpers.
`validateDeclaredConfig` is the same canonicalizer seen from the other side —
one hashes what canonicalizes, the other refuses what does not — and they share
a single private `canonicalize`. Moving the fingerprint alone would have left
the canonical form defined in the neutral module and enforced from an
Intelligence file, or duplicated it. Two of the three modules that import
`validateDeclaredConfig` (`package-registry.js`, `signature-registry.js`) had no
other reason to touch Intelligence at all.

**No compatibility re-exports.** Every in-repo importer was updated in the same
change, so the old paths export nothing and there is no second way to reach the
helpers. The re-export from `packages/core/index.js` is unchanged in name and
behaviour — packages see no difference — but it now points at the neutral
module.

**Module names, not a `utils.js`.** `definition-fingerprint.js` and
`timeout.js`. A neutral module still has to say what it is; `utils` would have
been a different kind of wrong location.

The evidence is the LA0 baseline. Regenerating it after the move changed exactly
one observation, `architecture.intelligence-internal-importers`, which is
`pre_extraction_evidence` and asserted by nobody: the list of files reaching
into an Intelligence internal went from ten to four. Every asserted
observation — all 822 values across 142 observations — is byte-identical, which
was confirmed by running the *pre-move* observations against the post-move tree
through the harness's own comparison rather than through a diff script. The two
new modules were added to `BEHAVIOUR_BEARING_SOURCE`, so a future edit to either
stales the baseline, and both were mutation-checked in place: unsorting the
canonicalizer's keys moves every declared fingerprint, and altering the timeout
message moves `helpers.withTimeout.outcomes`.

What remains open is unchanged: the `app.intelligence` field (Blocker 2) and the
fixed definition-registry slot (Blocker 3).

---

## Blocker 2 — `app.intelligence` (decision analysis, no implementation)

`app.intelligence` is a field on the application object. It is published in
`/api/schema` (`apps/server/src/http-server.js`) and injected into **every**
action's context (`packages/core/src/action-runtime.js`). A package can declare
a capability; it cannot contribute an ambient key that every action receives.

### Measured: who actually consumes it

LA0 records the consumers rather than remembering them
(`architecture.app-intelligence-consumers`):

| What | Measured |
|---|---|
| files reading `app.intelligence` outside the app itself | **one** — `apps/server/src/http-server.js`, which publishes the `intelligence` block on `/api/schema` |
| the ambient **context key** | injected by `packages/core/src/action-runtime.js` into every action's context |
| actions that read that key | only Lead Intelligence's own four |

**This makes the migration much smaller than it looked.** The field's only
non-Intelligence consumer is the schema publisher, and the context key — while
handed to every action — is read by nobody outside the domain that would move.
Option B's cost was estimated as "a real behaviour change for every existing
action that touches scoring or routing". Measured, that set is empty: the
actions that read it are the ones moving into the package anyway, where they
would open the capability they now receive ambiently.

What remains is one deliberate change: `/api/schema` publishing `intelligence`
as the package's own schema contribution instead of an ambient block. LA0 freezes
that block's shape (`architecture.schema-intelligence-block-present`,
`architecture.definition-kinds-published`) so the migration is provable rather
than hoped for.

### Option A — keep the ambient field

Intelligence moves to a package, and the application keeps handing
`app.intelligence` to every action as it does today.

*For*: zero migration; every existing action keeps working unchanged; the
ergonomics inside an action stay exactly as they are.
*Against*: it is a permanent exception to ADR-018. The package's interface is
reachable without declaring it, so `requires` stops being the whole truth about
who depends on whom — which is the one property the package seam exists to give.
A custom package could never obtain the same privilege, so first-party and
customer packages stop being equal, which `docs/PACKAGE_AUTHORING.md` §14
explicitly promises they are.

### Option B — a declared capability

Intelligence offers `intelligence@1`; every consumer declares it in `requires`
and opens it with `domains.capability(...)`.

*For*: it is the seam that already exists, already tested, already understood.
The dependency becomes visible in `app inspect`, bindable in a Solution Plan and
checkable by `package test`. Custom packages get exactly the same access as
first-party ones. A project without Intelligence composed simply has no consumer
declaring it, and the registry says so at startup instead of at runtime.
*Against*: it is a real behaviour change for every existing action that touches
scoring or routing — each must declare the requirement and open the capability
rather than reading an ambient field. That is a migration, and it is visible in
every touched action.

### Option C — a generic named runtime-service registry

A new seam: packages register named services, and the runtime resolves them into
the action context by name.

*For*: it would preserve today's ergonomics while making the contribution
explicit.
*Against*: it is a **new generic seam with one consumer**, which is exactly what
this repository's own rule refuses — a seam is added when two real consumers need
the same domain-neutral bounded behaviour. It also re-creates ambient access
under a new name: an action would still reach a package it never declared, so the
property Option B buys is not actually bought.

### Recommendation — **Option B, with a staged migration** (unchanged, confidence raised)

The evidence above does not disprove the working hypothesis; it makes it
cheaper. Confidence moves from *recommended* to *recommended with a measured
cost*: one schema-publication change and four actions that move anyway.

The whole argument for ADR-018 is that a dependency you cannot see is a
dependency you cannot reason about, and Option A keeps one permanently
invisible. Option C costs a new seam and does not fix the visibility problem.

Migration strategy, in order, none of it started:

1. Intelligence offers `intelligence@1` as a capability **while** `app.intelligence`
   still exists. Both work. No consumer changes yet.
2. Convert consumers one at a time — each declares the requirement, opens the
   capability, and keeps its tests green. Reviewable in isolation.
3. When no consumer reads the ambient field, remove it from the action context
   and from `/api/schema`'s ambient block, publishing it as the package's own
   schema contribution instead.
4. `crm app inspect` then shows the edge, and `crm package test` enforces it.

Step 1 is additive and independently safe. Steps 3 and 4 are the breaking part
and should not begin until the extraction is otherwise ready.

**This is a contract decision. It belongs to a human, and this document does not
take it.**

---

## Blocker 3 — the project-owned definition registry (decision analysis, no implementation)

`packages/intelligence/generated/index.js` is a checked-in, project-owned file
where a project declares enrichment providers, scoring models, routing policies
and routing targets. AX1 reads it as one of a fixed set of composition slots. If
Intelligence becomes a package, the file is a *project* file describing a
*package's* definition kinds, and there is no generic seam for that.

### Measured: who depends on the fixed slot

LA0 records it (`architecture.definition-registry-slot`): four files, and only
two of them are runtime — `packages/app/src/create-app.js`, which constructs the
registries, and `packages/cli/src/app-inspect.js`, where `intelligence` is one
of AX1's fixed composition slots. The other two are documentation.

And the four definition kinds, measured from `/api/schema`: enrichment
providers, scoring models, routing policies, routing targets. Three of the four
already have a contract that fits — providers, and `policies` for the two
versioned fingerprinted kinds. **Routing targets remain the open question**, and
they are closer to project configuration than to a definition.

### Option A — keep it as a fixed project-owned registry

The file stays exactly where it is, and the extracted package reads it.

*For*: nothing changes for any project; AX1 keeps its fixed slot; no new seam.
*Against*: the framework keeps a hard-coded file path for a domain that is
supposed to be optional. A project that removes the Intelligence package still
has an `intelligence/generated` slot, and a second package wanting the same shape
has nowhere to go.

### Option B — a package-contributed bounded registry seam

Packages declare definition kinds; projects declare instances in a generic
location; the registry resolves them.

*For*: general, and it is the shape a marketplace of domain packages would
eventually want.
*Against*: **one consumer**. It needs its own versioning, its own validation,
its own answer to "what if two packages claim one kind", and its own AX1
representation. Building it now would violate the two-real-consumers rule the
same way Option C above does, and it is a large seam to design around a single
case.

### Option C — express the definitions using contracts that already exist

Scoring models, routing policies and discount policies are all *versioned,
fingerprinted declared definitions*. The package contract already has
`policies`, and the provider contract already covers enrichment providers.
Routing targets are the one that does not obviously fit — they are closer to
configuration data than to a definition.

*For*: no new seam at all. It reuses `policies`, `capabilities`, providers and
`metadata()`, all of which are versioned, fingerprinted and already inspected by
AX1 and enforced by DX4. Commercial Operations already proves the pattern for
discount policies.
*Against*: routing targets need a home, and answering that honestly may mean
they stay project configuration rather than becoming a package definition kind —
which is a smaller decision than a new seam.

### Recommendation — **Option C, reuse existing contracts** (unchanged, now evidenced)

The measurement supports it: two runtime dependants, three of four kinds already
expressible, one open question about a single kind. That is not the shape of a
problem that needs a new generic seam with one consumer.

Do not add a generic definition-registry seam. Three of the four Intelligence
definition kinds already have a contract that fits, and the fourth is a
question about one kind rather than a reason to build a mechanism. If, after
Intelligence is extracted, a **second** package needs a project-owned registry
that the existing contracts cannot express, that is the evidence Option B
requires — and it will be a better seam for having a real second case.

**Also a contract decision, and also a human's.**

---

## What the signal-hardening PR established about the workflow

The intentional-change loop is no longer theoretical; it ran:

```text
apply the fix          -> LA0 reports the baseline STALE *and* the behaviour changed,
                          as two separate failures
regenerate explicitly  -> npm run characterize:intelligence
review the diff        -> exactly 5 observations moved, all in one family
```

Two of the five were the declared `defect_candidate`s. The other three —
`newline`, `carriage-return` and `unicode-separator` — were classified
`contractual` by LA0 because it observed them individually and they happened to
be accepted. The fix treats them as the same class, which is a **deliberate
widening of public behaviour**, recorded here rather than absorbed silently.
That is precisely what a reviewed regeneration is for.

A later comment-only edit to the same file proved the other half: the source
digest moved, the baseline went stale, and **zero** observations changed. Source
staleness and behaviour change are genuinely distinct signals.

### Two follow-ups the signal fix deliberately did not take

Recorded so neither is rediscovered as a surprise, and neither was smuggled into
a change scoped to two defect candidates:

- **Provider snapshot fields carry no control-character rule.** `companyName`,
  `industry`, `country`, `employeeRange`, `revenueRange`, `companyDomain`,
  `language` and `sourceRef` share the same `MAX_TEXT` bound as `value` but are
  only length- and shape-checked. They are a different trust boundary — provider
  output, refused as a 502 rather than a 400 — and holding them to the caller
  rule would be a second behaviour migration with its own LA0 diff.
- **Bidirectional overrides and zero-width characters are accepted.** U+202E,
  zero-width joiners and homoglyphs pass. That is consistent with where the line
  was drawn: the rule protects the record's *structural* integrity, and display
  safety is the renderer's job. If a rendering surface ever displays signal
  values, the fix belongs in that renderer, not in a write-time sanitizer.

## Updated extraction gate

| Precondition | State |
|---|---|
| DX3 package scaffold merged | **yes** — `05fafbd` |
| DX4 package conformance merged | **yes** — `5da5205` |
| DX1 project doctor merged | **yes** — `845cd3d` |
| LA0 characterization harness | **yes** — `360b0f6` |
| LA0 defect candidates resolved | **yes** — `1e40d1e`. `record-signal`'s `value` is now bounded to the domain's own `MAX_TEXT` (500) and refused when it contains control characters or line breaks. Reviewed regeneration moved exactly five observations, all `hostile-input.record-signal.*` |
| Neutral helpers moved out of Intelligence files | **done, open for review** — moved to `definition-fingerprint.js` and `timeout.js`; the LA0 importer list went from ten files to four with every asserted value byte-identical |
| `app.intelligence` decision taken | **no** — Option B recommended, cost now measured (one schema-publication change; zero external action consumers). Human decision |
| Definition-registry decision taken | **no** — Option C recommended, dependants now measured. Human decision |
| Package-contributed HTTP route seam needed | **not for Intelligence.** DX4 established that route contribution is not required for generic conformance. It remains a precondition for **Commercial** and **Signature** specifically, each of which owns a route in `apps/server` |

**Lead Intelligence is still not extractable today** — but the remaining
blockers are now small, measured and mostly decisions rather than unknowns.

### Recommended next PR sequence

1. **LA0 review and merge** — it is open and unmerged; the extraction cannot be
   proved without it.
2. **Resolve the two defect candidates** — done in an open PR. `value` is
   bounded to this domain's own `MAX_TEXT` (500) and refused when it carries a
   control character or a line break. The reviewed regeneration moved **exactly
   five observations**, all `hostile-input.record-signal.*`, and one source
   digest; nothing in scoring, routing, assignment, lifecycle, schema, helpers
   or scale moved at all. Doing it after the extraction would have meant
   changing behaviour in the same PR that claims to change none.
3. **Neutral-helper move** — mechanical, zero behaviour change, now provable:
   LA0 fails if a single fingerprint or timeout outcome moves.
4. **Architecture ADR(s)** — `app.intelligence` and the definition registry,
   decided by a human and written down before any code moves.
5. **Lead Intelligence extraction implementation** — one domain, one PR, with
   `wireIntelligence` as the only characterization file it edits.
6. **Extraction review** — LA0 green plus `crm package test` plus
   `crm project doctor`.
7. **DX2 Skill mirror sync** — real (six skills live under `.claude/` only, and
   `crm project doctor` reports it as a warning) but nothing depends on it.
8. **M16 Analytics Studio** — last, because it is the item most likely to consume
   whatever the extraction learns about reading across packages.

Step 2 is the one worth arguing with, because it delays the extraction for two
small fixes. It sits there because a characterization baseline regenerated
*during* an extraction is a baseline nobody can trust: the diff would mix
"behaviour I meant to change" with "behaviour that moved by accident", which is
the exact distinction the harness exists to preserve.

---

## Related

`docs/architecture/LEGACY_ALIGNMENT_MATRIX.md` (status of record) ·
`docs/CODER_TOOLING_ROADMAP.md` · `docs/plans/dx1-project-doctor.md` ·
`docs/plans/dx3-package-scaffold.md` · `docs/plans/dx4-package-conformance-kit.md` ·
`DECISIONS.md` (ADR-015, ADR-016, ADR-018 and its addenda, ADR-019, ADR-020)
