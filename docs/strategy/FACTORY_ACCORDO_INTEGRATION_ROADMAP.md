# Orchestro × Accordo — Integration Roadmap

**Status:** strategy and architecture planning only.  
**Engine decision (Dan, 2026-11-12, ADR-046):** agent teams in Accordo run on the Orchestro loop. Accordo owns interface, data and approvals; Orchestro executes. Earlier revisions of this document named Northstar Factory as the engine and gated integration on a "Factory Core v1 — Integration Freeze" with "FA1 Builder Pack" first: that premise is superseded and dropped. There is no freeze gate and no FA-first sequence.  
**File name:** kept as `FACTORY_ACCORDO_INTEGRATION_ROADMAP.md` so existing references stay valid.  
**Principle:** run agent teams on the Orchestro loop through one narrow, versioned seam; do not build a second orchestrator.

---

## 1. Decision

Orchestro is the governed execution loop for Accordo agent teams.

Accordo does not absorb or reimplement the loop.
Orchestro does not absorb Accordo's business truth.

The initial integration is deliberately narrow:

```text
Accordo business goal / SolutionPlan
        ↓
bounded CLI + JSON
        ↓
Orchestro governed loop
        ↓
Orchestro work selection / checkpoint
        ↓
local coding-agent CLI
        ↓
Claude Code / Codex / Grok / future conforming adapter
        ↓
checked source / governed change
        ↓
independent verification
        ↓
receipt / measured outcome
```

Later, the same seam may support operational business initiatives such as marketing, content, SEO, customer success or service. Those are downstream proofs, not requirements for the first integration.

---

## 2. Invariants

### 2.1 Orchestro executes through installed coding-agent CLIs

Orchestro execution continues to use installed coding-agent CLIs and their native authenticated sessions.

No mandatory model API.
No automatic fallback to token-billed APIs.
No provider-specific business semantics in the loop.

The executor is an adapter behind one contract. Provider differences stay inside adapters.

### 2.2 Accordo owns business truth

Accordo owns:

- customer and commercial records;
- business goals and primary metrics;
- policies and approval boundaries;
- tenant identity and authorization;
- provider integrations and credentials;
- external business actions;
- business audit and operational evidence.

Orchestro must not become a CRM database, campaign system, secret store or provider integration layer.

### 2.3 Orchestro owns loop truth

Orchestro owns:

- signals admitted to the loop;
- deterministic work selection;
- checkpoint and stop semantics;
- executor session lifecycle;
- evidence plans;
- Orchestro lifecycle receipts;
- independent technical verification;
- recurrence / durable loop state where applicable.

Accordo must not reproduce these mechanisms.

### 2.4 External actions remain governed by Accordo

A coding-agent CLI may reason, inspect, generate, edit, test and prepare.

A side effect such as:

- send;
- publish;
- spend;
- enroll;
- change a live audience;
- use a production credential;
- mutate governed CRM state;

must cross an Accordo managed action / operation boundary.

Native CLI or MCP access is never a shortcut around Accordo policy, approval, identity, idempotency or audit.

### 2.5 Bounded context only

Orchestro consumes bounded, machine-readable Accordo views.

No full CRM database dump into an agent context.
No arbitrary SQL seam.
No universal query endpoint created only for the agent.

Prefer:

```text
command
→ bounded JSON
→ explicit contract version
→ stable identity / fingerprint
```

This is the same architectural shape already used by both projects.

---

## 3. Adversarial review of the previous proposal

### Finding A — premature generalization

**Risk:** turning the loop immediately into a universal `Goal → Action → Outcome` engine would abstract before a second real domain proves the abstraction.

**Decision:** do not design a new generic engine for Accordo.

Use the Orchestro loop and add only the minimum adapter needed by the pilot.

**Rule of two:** a primitive moves toward generic loop core only after it is independently required by:

1. the existing engineering/reliability use case; and
2. a real Accordo use case.

No abstraction based only on anticipated reuse.

---

### Finding B — two orchestrators

Accordo already has durable jobs, operations, policies and managed-runtime work. Orchestro already has work selection, checkpoint and receipt semantics.

If both systems select work, retry work and declare completion, integration becomes ambiguous.

**Decision: one owner per responsibility.**

| Responsibility | Owner |
|---|---|
| Business goal and metric | Accordo |
| Customer / revenue data | Accordo |
| Approval and policy | Accordo |
| External side effect | Accordo |
| When infrastructure wakes a worker | Accordo / deployment |
| What the loop should work on next | Orchestro |
| Coding-agent executor session | Orchestro |
| Orchestro lifecycle / receipt | Orchestro |
| Technical verifier | Orchestro |
| Business result / business metric | Accordo source, referenced by Orchestro |

A scheduler may wake Orchestro. It must not replace Orchestro's selection.

---

### Finding C — local CLI versus managed SaaS

A fully managed cloud agent and a local subscription CLI are different products.

Trying to hide this would either break the installed-CLI execution model or force Accordo to become a model reseller.

**Decision:** first integration uses a user-owned runner.

Conceptually:

```text
Accordo / repository
      ↓
work available
      ↓
Orchestro runner
(user machine or user-owned always-on host)
      ↓
installed provider CLI
```

The execution host may evolve later, but the contract does not change.

A future managed runner is a deployment option, not a new loop architecture, and only exists where the selected provider runtime and terms permit it.

---

### Finding D — business-agent scope is too large for the first integration

Campaigns + website + SEO + editorial plan + customer success are not one pilot.

They have different sources, actions, approval boundaries and success metrics.

**Decision:** first prove one loop.

Do not create a universal `Initiative` runtime before one real use case needs it.

`Initiative` may remain a UX/product concept until durable product evidence requires a new canonical record.

---

### Finding E — Accordo already has the missing seam

Accordo deliberately exposes deterministic CLI/JSON surfaces and currently does not ship a generic orchestrator or plan executor.

Orchestro fills that execution role.

Do not build an Accordo-specific autonomous-loop engine.

---

### Finding F — provider agnosticism has to remain mechanical

Provider neutrality is not achieved by adding provider names everywhere.

Orchestro keeps one `CodingAgentAdapter` contract.

Current executor support may evolve, but every new provider must pass the same adapter/conformance tests. Adding a provider is an adapter change only if the provider can satisfy the existing execution contract. It does not justify a loop branch.

---

## 4. Engine readiness — no freeze gate

The earlier gate ("Factory Core v1 — Integration Freeze" after closing roadmap phases on a real product) is superseded by the 2026-11-12 decision and dropped. Integration does not wait for any freeze.

Orchestro is the execution loop now. An integration is ready when its own seam is ready:

1. The bounded CLI/JSON inputs the loop consumes have explicit stable versions or a documented compatibility rule.
2. The checked plans, policies and approval boundaries the loop must respect are explicit.
3. The authoritative verification commands for the loop's output are explicit.
4. Independent verification remains impossible for the executor to self-certify.
5. No managed business side effect bypasses an Accordo managed action / operation boundary.

No future loop phase may be pulled forward merely to make an integration look complete.

---

## 5. Integration sequence

### S1 — Builder execution on the Orchestro loop

This is the first integration because it reuses what both projects already prove.

The Accordo side already exposes deterministic inspection and plan contracts. Orchestro supplies the missing execution loop.

Target flow:

```text
business goal
→ Accordo app inspection
→ checked SolutionPlan
→ owner approval where required
→ Orchestro intake
→ Orchestro selects governed implementation work
→ local coding-agent CLI changes source
→ Accordo checks / tests / JTBD evidence
→ merge / deploy where allowed
→ Orchestro independent verification
→ receipt
```

Constraints:

- no new Accordo orchestrator;
- no Orchestro loop fork;
- no direct database access added for the loop;
- no provider-specific branch in Accordo;
- no business-operation runtime yet.

Acceptance:

- one real Accordo change can travel end-to-end;
- resume works after coding-agent session interruption;
- switching between at least two conforming executor adapters does not change durable semantics;
- Accordo's deterministic checks are authoritative for Accordo-specific validity;
- Orchestro remains authoritative for its own work lifecycle.

---

### S2 — Supervised business initiative pilot

Only after the builder seam is stable.

Goal: prove Orchestro can drive one non-engineering business loop without changing its core.

Choose **one** bounded initiative.

Good candidate properties:

- one primary business metric;
- one small set of guardrails;
- one bounded data source;
- one bounded managed action;
- one human approval boundary;
- measurable before/after evidence;
- no requirement for a universal marketing runtime.

Do not start with “run all marketing”.

Candidate examples should be selected from capabilities Accordo has actually implemented at that time.

The integration should look like:

```text
Accordo goal + metric + constraints
→ bounded loop inputs
→ Orchestro work selection
→ local coding-agent CLI
→ proposal / asset / checked source
→ Accordo approval
→ Accordo managed action
→ Accordo measurement
→ Orchestro receipt / next checkpoint
```

Exit criterion:

> The same Orchestro loop completes one operational loop whose business truth lives in Accordo.

Only now is there evidence for any generic business-loop abstraction.

---

### S3 — Operational initiative packs

After the supervised pilot, expand through Accordo domain packages, not loop-core changes.

Possible future packs:

- Marketing / campaign;
- Content / landing / website;
- SEO;
- Prospecting / SDR;
- Customer success;
- Service.

Each pack owns its domain-specific:

- source commands;
- metrics;
- managed actions;
- policies;
- approval boundaries;
- evidence.

Orchestro continues to see the same small contracts.

---

### S4 — Optional Accordo Cloud control plane

Cloud monetization sits around the integration, not inside the loop core.

Accordo Cloud may add:

- workspace / tenant management;
- remote queue visibility;
- managed business credentials;
- approvals;
- centralized projections of Orchestro status;
- integrations;
- retention;
- team access;
- billing;
- an optional runner deployment later.

The first version does **not** need to host the model.

A local/user-owned Orchestro runner can remain the execution worker.

Orchestro's local lifecycle record remains authoritative for loop lifecycle unless a future explicit protocol changes that rule. Cloud projections must not silently become a second ledger.

---

## 6. How this integrates with existing Accordo roadmaps

### Objective-Driven Agent Experience

Keep:

```text
GOAL → DISCOVER → ASSESS → DESIGN → PLAN → APPROVE
```

Orchestro begins where durable execution starts.

Refined model:

```text
Accordo:
GOAL → DISCOVER → ASSESS → DESIGN → PLAN → APPROVE
                                         ↓
Orchestro:
                                  SELECT → EXECUTE
                                         ↓
Accordo + Orchestro:
                                  VERIFY → OBSERVE
                                         ↓
Accordo:
                                    RECOMMEND
                                         ↓
Orchestro:
                                      ITERATE
```

No second planner is introduced.

### Agentic Workforce Roadmap

Keep `role-agent packs` as Accordo domain compositions.

Do not turn Orchestro into the role-pack model.

A role pack declares business capabilities and limits.
Orchestro runs the governed work loop.
Accordo executes governed business actions.

This preserves:

- business-domain modularity in Accordo;
- provider-neutral agent execution in Orchestro;
- one source of policy truth;
- one source of loop truth.

### Marketing & Growth Operations

Do not rewrite MK0–MK7 around Orchestro.

Orchestro becomes the execution mechanism available to the workstream when needed.

For example:

```text
MK1 Funnel Insight + Campaign Proposal
    → may produce governed work for Orchestro

MK3 Content + Landing + Tracking
    → Orchestro may build checked assets
    → Accordo still owns publish approval and provider action

MK4+ durable journeys
    → Accordo jobs/outbox remain the durable business runtime
    → Orchestro does not become the journey scheduler
```

### Accordo Cloud

Cloud stays the managed business/control-plane layer.

Orchestro stays the agent execution loop.

A cloud worker and an Orchestro executor are not the same responsibility.

---

## 7. Provider strategy

Orchestro execution follows the installed-CLI pattern: provider CLIs run behind adapters.

The durable rule is:

> Provider capability changes adapters, never lifecycle semantics.

Required for every executor adapter:

- installed/available detection where supported;
- start;
- resume;
- structured termination diagnosis;
- working-directory isolation;
- execution-session marker;
- quota/auth failure semantics;
- no automatic token-API fallback.

A provider that cannot satisfy the contract is not a supported executor yet.

Do not weaken the contract to make a provider fit.

Muse or any future CLI should enter only through the same conformance gate.

---

## 8. Minimal integration contract

Do not design a large SDK first.

Prefer a small seam:

### Accordo → Orchestro

Bounded CLI/JSON answers for:

- current goal / approved plan identity;
- relevant business facts;
- current metric measurement;
- approved action boundaries;
- authoritative verification commands.

### Orchestro → Accordo

References / receipts for:

- selected work identity;
- execution state;
- requested human boundary;
- completed checked change;
- evidence refs;
- verification outcome.

### Accordo actions

All business mutations remain existing or future Accordo managed actions.

No new “Orchestro can execute arbitrary CRM command” endpoint.

---

## 9. What must not be built yet

Until a real integration proves the need:

- universal `Initiative` database model;
- universal business-agent ontology;
- generic tool registry in the loop;
- duplicate Accordo scheduler;
- duplicate Accordo approval engine;
- duplicate business audit log;
- loop-side credential vault;
- loop-side customer data store;
- hosted model billing;
- universal MCP gateway;
- autonomous policy learning;
- cross-domain memory engine;
- a special loop branch for each agent provider.

---

## 10. Recommended immediate order

```text
NOW
│
├─ 1. Run builder execution on the Orchestro loop
│      goal / SolutionPlan → Orchestro loop → verified code change
│
├─ 2. Freeze/version only the external seams the loop needs
│
├─ 3. Dogfood until the seam is boring
│
└─ 4. Select ONE supervised business initiative
       only then test non-engineering generality
```

Do not start Cloud-specific execution work before step 1 proves the seam.

---

## 11. Strategic outcome

The product architecture becomes:

```text
                   ORCHESTRO
              governed execution loop
       installed coding-agent CLIs behind adapters
                         │
              stable bounded seam
                         │
                         ▼
                     ACCORDO
         customer & revenue business system
       interface / data / policy / approvals
                         │
                         ▼
                  ACCORDO CLOUD
       managed business control plane / SaaS
```

This gives each product one clear job:

**Orchestro**
> Run governed agent-team work and prove what happened.

**Accordo**
> Define what the business is, what it wants, what agents may do, and whether the result mattered.

**Accordo Cloud**
> Operate that business system as a managed product.

The architecture remains provider-neutral and scalable without turning either repository into a universal agent platform.

---

## 12. Roadmap simplification consequences

Now that the seam above is defined, Accordo roadmaps simplify by rule, not by
taste. The question for any planned Accordo work is: *does Orchestro already own
the generic mechanism?* If yes, Accordo keeps the business outcome and takes a
dependency — it does not build the mechanism twice.

Business retry is not coding-agent retry. The business scheduler is not the
Orchestro selector. The CRM audit is not the Orchestro lifecycle receipt. The pairs
share nouns, not ownership.

### KEEP IN ACCORDO

Business goals and metrics; CRM/customer/revenue data; SolutionPlan and domain
contracts; business policies; approvals; tenant/auth/business identity;
provider credentials; managed business actions; jobs/outbox/business
scheduler; business-side retries/idempotency/reconciliation; CRM/business audit
and trace; domain-specific verification commands (AX1/AX2, DX5 Project
Verify, DX6 Scenario Runner, DX10 Implementation Evidence — Orchestro may invoke
and sequence them, never duplicate their domain logic); business outcomes and
measurement.

### OWNED BY ORCHESTRO

Generic work selection; selector/checkpoint/stop semantics; coding-agent
execution lifecycle; coding-agent resume/retry; coding-agent provider
adapters; Claude Code / Codex / Muse / future CLI differences; engineering
execution context; Orchestro lifecycle ledger; evidence orchestration;
independent technical verification; recurrence of the governed implementation
loop.

### CONSUMED THROUGH THE SEAM

Accordo authorities that Orchestro invokes (inspection, checked plans,
verification commands, JTBD evidence); bounded pack inputs (DX9-style
context, when built); projections of Orchestro status in Cloud; role-agent
packs as business capability compositions executed through the loop.

### NOT REQUIRED FIRST

Project MCP parity (DX13 — CLI/JSON suffices); skill portability beyond
Accordo's own source hygiene (DX2 — adapters own execution
differences); hosted model or mandatory model API; duplicate loop queue or
ledger; Cloud-side selector or supervisor; universal `Initiative` runtime.

The following must NOT become new Accordo primitives for the Orchestro
integration: generic agent orchestrator, generic plan executor, coding-agent
supervisor, coding-agent checkpoint/resume engine, generic coding-model
router, generic engineering-memory runtime, universal Initiative
runtime/model, duplicate scheduler, duplicate execution ledger, universal
agent SDK, universal MCP gateway, mandatory hosted model/API,
provider-specific execution branches.

---

## 13. Roadmap impact summary

| AREA | CURRENT ACCORDO ROADMAP | WITH ORCHESTRO | ACTION |
|---|---|---|---|
| JTBD | 600 assigned jobs incl. 8 with generic execution mechanisms | 8 keep outcome, take Orchestro implementation dependency; catalogue unchanged | DEPENDENCY |
| Objective-driven AX | GOAL → … → APPROVE, execution unspecified | APPROVE → Orchestro SELECT → EXECUTE; VERIFY/OBSERVE shared | NARROW |
| Coder DX | Authorities + context/MCP/skill portability | Authorities stay; DX9 reusable seam input; DX13/DX2 not first-integration gates | KEEP |
| Role-agent packs | Domain compositions incl. orchestration vocabulary | Same slices AW0–AW4; packs compose, Orchestro loops | KEEP |
| Marketing | MK0–MK7 with own scheduler/runtime | Unchanged; Orchestro available as execution mechanism | KEEP |
| Cloud | Managed control plane + Agent Operations surface | Explicit infra-operation surface; no model/queue/ledger/selector | NARROW |
| MCP/tool surface | CLI-first, MCP mirrors | Unchanged; mirrors follow CLI, never lead | KEEP |
| Context/memory | DX9 context pack; memory in agent-eng JTBDs | DX9 bounded seam input; generic memory is Orchestro-owned | DEPENDENCY |
| Model/provider routing | AGENT-ENG-014, provider rows in DX | Outcome stays; routing owned by Orchestro adapters | DEPENDENCY |
| Retries/checkpoints | Business retries + agent retry JTBDs | Business side Accordo; coding-agent side Orchestro | NARROW |
| Schedulers | Spine jobs/outbox + journey scheduler | Unchanged; never the Orchestro selector | KEEP |
| Ledgers/evidence | CRM audit + Orchestro lifecycle receipts | Separate by rule; Cloud shows projections only | KEEP |
| Generic orchestrator/supervisor/SDK | Refused in three docs | Refused a fourth time here; REMOVE DUPLICATION if proposed | REMOVE DUPLICATION |

No Accordo roadmap is renumbered by this table. DEFER applies to operational
packs (marketing/content/SEO/prospecting/success/service), which expand only
after the builder seam proves itself.
