# Factory × Accordo — Integration Roadmap

**Status:** strategy and architecture planning only.  
**Target repository:** `agent-crm/docs/strategy/FACTORY_ACCORDO_INTEGRATION_ROADMAP.md`  
**Principle:** finish and freeze Factory Core v1 first; integrate it into Accordo through one narrow, versioned seam; do not build a second orchestrator.

---

## 1. Decision

Northstar Factory remains an independent, local-first, open-source governed execution loop.

Accordo does not absorb or reimplement Factory.

Accordo becomes a first-class consumer of Factory after Factory Core v1 is proven and frozen.

The initial integration is deliberately narrow:

```text
Accordo business goal / SolutionPlan
        ↓
bounded CLI + JSON
        ↓
Factory Project Pack
        ↓
Factory selector / checkpoint / ledger
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

Later, the same seam may support operational business initiatives such as marketing, content, SEO, customer success or service. Those are downstream proofs, not requirements for Factory Core v1.

---

## 2. Invariants

### 2.1 Factory stays local-first

Factory execution continues to use installed coding-agent CLIs and their native authenticated sessions.

No mandatory model API.
No automatic fallback to token-billed APIs.
No provider-specific business semantics in the kernel.

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

Factory must not become a CRM database, campaign system, secret store or provider integration layer.

### 2.3 Factory owns loop truth

Factory owns:

- signals admitted to the loop;
- deterministic work selection;
- checkpoint and stop semantics;
- executor session lifecycle;
- evidence plans;
- Factory lifecycle receipts;
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

Factory consumes bounded, machine-readable Accordo views.

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

**Risk:** turning Factory immediately into a universal `Goal → Action → Outcome` engine would abstract before a second real domain proves the abstraction.

**Decision:** do not redesign the kernel for Accordo.

Use the current Factory model and add only the minimum adapter / Project Pack required by the pilot.

**Rule of two:** a primitive moves toward generic Factory core only after it is independently required by:

1. the existing engineering/reliability use case; and
2. a real Accordo use case.

No abstraction based only on anticipated reuse.

---

### Finding B — two orchestrators

Accordo already has durable jobs, operations, policies and managed-runtime work. Factory already has selector, supervisor, checkpoint and ledger semantics.

If both systems select work, retry work and declare completion, integration becomes ambiguous.

**Decision: one owner per responsibility.**

| Responsibility | Owner |
|---|---|
| Business goal and metric | Accordo |
| Customer / revenue data | Accordo |
| Approval and policy | Accordo |
| External side effect | Accordo |
| When infrastructure wakes a worker | Accordo / deployment |
| What Factory should work on next | Factory |
| Coding-agent executor session | Factory |
| Factory lifecycle / receipt | Factory |
| Technical verifier | Factory |
| Business result / business metric | Accordo source, referenced by Factory |

A scheduler may wake Factory. It must not replace Factory's selector.

---

### Finding C — local CLI versus managed SaaS

A fully managed cloud agent and a local subscription CLI are different products.

Trying to hide this would either break the local-first promise or force Accordo to become a model reseller.

**Decision:** first integration uses a user-owned runner.

Conceptually:

```text
Accordo / repository
      ↓
work available
      ↓
Factory Runner
(user machine or user-owned always-on host)
      ↓
installed provider CLI
```

The execution host may evolve later, but the contract does not change.

A future managed runner is a deployment option, not a new Factory architecture, and only exists where the selected provider runtime and terms permit it.

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

Factory should fill that missing execution role.

Do not build an Accordo-specific autonomous-loop engine.

---

### Finding F — provider agnosticism has to remain mechanical

Provider neutrality is not achieved by adding provider names everywhere.

Factory keeps one `CodingAgentAdapter` contract.

Current executor support may evolve, but every new provider must pass the same adapter/conformance tests.

Adding Muse, Gemini or another provider is an adapter change only if the provider can satisfy the existing execution contract. It does not justify a kernel branch.

---

## 4. Factory closure gate

The correct integration gate is **Factory Core v1**, not completion of every future Factory product phase.

Current roadmap shape:

```text
Phase 1  Capability Map + Engineering Memory             CLOSED
Phase 2  Product-Aware Advisor V1                        CLOSED
Phase 3  Owner Decision Loop V1                          CLOSED
Phase 4  Capability Success + Benefit Verification       CLOSED
Phase 5  Owner Decision → Governed Work Bridge           CLOSED
Phase 6  End-to-End Product Outcome Pilot                NEXT / gating
Phase 7  Opportunity Discovery / Advisor Perspectives    post-v1 evolution
Phase 8  Operational Living Map / Live Work Inbox        post-v1 evolution
Phase 9  Policy Learning / Gold Rules                    post-v1 evolution
```

### Factory Core v1 is integration-ready when

1. **Phase 6 closes on a real product**, not the demo.
2. The product-success metric is distinct from technical verification.
3. The loop crosses:
   `evidence → recommendation → owner decision → governed work → implementation → live → technical verification → post-release measurement → honest benefit verdict`.
4. The Project Pack contract used by the pilot is versioned and frozen.
5. CLI/JSON outputs consumed by external integrations have explicit stable versions or a documented compatibility rule.
6. Independent verification remains impossible for the executor to self-certify.
7. The local subscription-CLI execution model remains the default.
8. Any kernel-hardening item proven load-bearing by the Phase-6 pilot is closed.
9. No Phase-7/8/9 feature is pulled forward merely to make the integration look complete.

### Important roadmap refinement

Closing Phase 6 should create a named milestone:

> **Factory Core v1 — Integration Freeze**

That milestone freezes the seam Accordo is allowed to depend on.

Phases 7–9 continue afterward, but they do not block the first Accordo integration.

---

## 5. Integration sequence

### FA0 — Factory Core v1 closure

**Repository:** `agentic-factory`

Goal: close the existing Factory roadmap gate before Accordo depends on it.

No Accordo feature work belongs here.

Deliverables:

- real Phase-6 product pilot;
- stable Project Pack / CLI seam;
- conformance fixtures for the integration surface;
- provider-adapter contract confirmed;
- explicit compatibility / versioning policy.

Exit criterion:

> A second repository can consume Factory without importing Factory internals or depending on undocumented output.

---

### FA1 — Accordo Builder Pack

**Repositories:** `agent-crm` + a thin Factory pack/adapter.

This is the first integration because it reuses what both projects already prove.

The Accordo side already exposes deterministic inspection and plan contracts. Factory supplies the missing execution loop.

Target flow:

```text
business goal
→ Accordo app inspection
→ checked SolutionPlan
→ owner approval where required
→ Factory intake
→ Factory selects governed implementation work
→ local coding-agent CLI changes source
→ Accordo checks / tests / JTBD evidence
→ merge / deploy where allowed
→ Factory independent verification
→ receipt
```

Constraints:

- no new Accordo orchestrator;
- no Factory kernel fork;
- no direct database access added for Factory;
- no provider-specific branch in Accordo;
- no business-operation runtime yet.

Acceptance:

- one real Accordo change can travel end-to-end;
- resume works after coding-agent session interruption;
- switching between at least two conforming executor adapters does not change durable semantics;
- Accordo's deterministic checks are authoritative for Accordo-specific validity;
- Factory remains authoritative for its own work lifecycle.

---

### FA2 — Supervised Business Initiative Pilot

Only after FA1 is stable.

Goal: prove Factory can drive one non-engineering business loop without changing its kernel.

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
→ bounded Pack sources
→ Factory work selection
→ local coding-agent CLI
→ proposal / asset / checked source
→ Accordo approval
→ Accordo managed action
→ Accordo measurement
→ Factory receipt / next checkpoint
```

Exit criterion:

> The same Factory kernel completes one operational loop whose business truth lives in Accordo.

Only now is there evidence for any generic business-loop abstraction.

---

### FA3 — Operational initiative packs

After the supervised pilot, expand through Accordo domain packages, not Factory kernel changes.

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

Factory continues to see the same small contracts.

---

### FA4 — Optional Accordo Cloud control plane

Cloud monetization sits around the integration, not inside Factory core.

Accordo Cloud may add:

- workspace / tenant management;
- remote queue visibility;
- managed business credentials;
- approvals;
- centralized projections of Factory status;
- integrations;
- retention;
- team access;
- billing;
- an optional runner deployment later.

The first version does **not** need to host the model.

A local/user-owned Factory runner can remain the execution worker.

Factory's local ledger remains authoritative for Factory lifecycle unless a future explicit protocol changes that rule. Cloud projections must not silently become a second ledger.

---

## 6. How this integrates with existing Accordo roadmaps

### Objective-Driven Agent Experience

Keep:

```text
GOAL → DISCOVER → ASSESS → DESIGN → PLAN → APPROVE
```

Factory begins where durable execution starts.

Refined model:

```text
Accordo:
GOAL → DISCOVER → ASSESS → DESIGN → PLAN → APPROVE
                                         ↓
Factory:
                                  SELECT → EXECUTE
                                         ↓
Accordo + Factory:
                                  VERIFY → OBSERVE
                                         ↓
Accordo:
                                    RECOMMEND
                                         ↓
Factory:
                                      ITERATE
```

No second planner is introduced.

### Agentic Workforce Roadmap

Keep `role-agent packs` as Accordo domain compositions.

Do not turn Factory into the role-pack model.

A role pack declares business capabilities and limits.
Factory runs the governed work loop.
Accordo executes governed business actions.

This preserves:

- business-domain modularity in Accordo;
- provider-neutral agent execution in Factory;
- one source of policy truth;
- one source of loop truth.

### Marketing & Growth Operations

Do not rewrite MK0–MK7 around Factory.

Factory becomes the execution mechanism available to the workstream when needed.

For example:

```text
MK1 Funnel Insight + Campaign Proposal
    → may produce governed work for Factory

MK3 Content + Landing + Tracking
    → Factory may build checked assets
    → Accordo still owns publish approval and provider action

MK4+ durable journeys
    → Accordo jobs/outbox remain the durable business runtime
    → Factory does not become the journey scheduler
```

### Accordo Cloud

Cloud stays the managed business/control-plane layer.

Factory stays the agent execution loop.

A cloud worker and a Factory executor are not the same responsibility.

---

## 7. Provider strategy

Factory currently follows the correct pattern: subscription-CLI execution behind adapters.

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

### Accordo → Factory

Bounded CLI/JSON answers for:

- current goal / approved plan identity;
- relevant business facts;
- current metric measurement;
- approved action boundaries;
- authoritative verification commands.

### Factory → Accordo

References / receipts for:

- selected work identity;
- execution state;
- requested human boundary;
- completed checked change;
- evidence refs;
- verification outcome.

### Accordo actions

All business mutations remain existing or future Accordo managed actions.

No new “Factory can execute arbitrary CRM command” endpoint.

---

## 9. What must not be built yet

Until a real integration proves the need:

- universal `Initiative` database model;
- universal business-agent ontology;
- generic tool registry in Factory;
- duplicate Accordo scheduler;
- duplicate Accordo approval engine;
- duplicate business audit log;
- Factory-side credential vault;
- Factory-side customer data store;
- hosted model billing;
- universal MCP gateway;
- autonomous policy learning;
- cross-domain memory engine;
- a special Factory branch for each agent provider.

---

## 10. Recommended immediate order

```text
NOW
│
├─ 1. Close Factory Phase 6 on a real product
│
├─ 2. Declare "Factory Core v1 — Integration Freeze"
│
├─ 3. Freeze/version only the external seams Accordo needs
│
├─ 4. Build FA1 Accordo Builder Pack
│      goal / SolutionPlan → local Factory loop → verified code change
│
├─ 5. Dogfood until the seam is boring
│
└─ 6. Select ONE supervised business initiative for FA2
       only then test non-engineering generality
```

Do not start Cloud-specific execution work before step 4 proves the seam.

Do not wait for Factory Phases 7–9 before step 4.

---

## 11. Strategic outcome

The product architecture becomes:

```text
                    FACTORY
             open-source execution kernel
       local-first / provider-neutral coding CLI
                         │
             stable Project Pack seam
                         │
                         ▼
                     ACCORDO
         customer & revenue business system
       data / policy / approvals / operations
                         │
                         ▼
                  ACCORDO CLOUD
       managed business control plane / SaaS
```

This gives each product one clear job:

**Factory**
> Govern autonomous coding-agent work and prove what happened.

**Accordo**
> Define what the business is, what it wants, what agents may do, and whether the result mattered.

**Accordo Cloud**
> Operate that business system as a managed product.

The architecture remains open, local-first, provider-agnostic and scalable without turning either repository into a universal agent platform.
