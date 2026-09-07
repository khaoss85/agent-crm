---
title: Run a B2B quote approval workflow: from client brief to audit receipt
date: 2026-09-07
claims: [C-04, C-08, C-16]
transcript: site/assets/recipes/quote-approval-transcript.txt
editor: Aetha Editorial
summary: Run a synthetic 30-seat proposal through pricing, a 25% discount request, an agent refusal and a simulated user approval. Keep the local project and inspect the receipt.
---

A customer asks for 25% off. Your CRM needs to calculate the proposal, hold it for approval and retain the decision. This worked example takes a short client brief through that process using Accordo's existing commercial package.

[Download the client brief](../recipes/quote-approval-brief.md), then run the example below. It creates a local project you can inspect. The [recorded execution](../recipes/quote-approval-transcript.txt) includes the result and the setup mistake corrected during development.

## The customer request

Northwind Studio is a synthetic customer buying 30 seats of the fixture Enterprise Plan. Its catalog has a EUR 5,000 setup charge, a EUR 2,000 monthly platform charge and EUR 40 per seat per month at this quantity. The requested 25% discount applies to each component.

The existing policy auto-approves discounts through 10%, requests a user decision above 10% through 50%, and rejects larger discounts. These are the example's rules and prices, not Accordo subscription pricing. Both are defined in the [starter catalog and policy](https://github.com/khaoss85/agent-crm/blob/main/examples/starters/b2b-lead-qualification/commercial.js).

## Run the exact workflow

Use Git, Node.js 22.16 or newer and npm. Start in an empty working directory with internet access for the checkout and dependency installation:

```sh
git clone https://github.com/khaoss85/agent-crm.git framework-source
cd framework-source
git rev-parse HEAD
node --no-warnings examples/recipes/quote-approval/run.mjs ../my-quote-crm
```

The [recipe source](https://github.com/khaoss85/agent-crm/blob/main/examples/recipes/quote-approval/run.mjs) uses the scaffolder in that checkout, installs the generated project's dependencies, composes the commercial modules and starts a temporary HTTP server on localhost. It drives the public SDK and closes the server when finished. It does not use the npm scaffolder release.

The receipt records the checkout commit and recipe hash. Keep that commit to reproduce a saved run. Choose a new target directory for another replay: the scaffolder refuses an occupied project.

## What the execution checks

The server calculates EUR 3,750 once and EUR 2,400 per month after discount. It keeps those periods separate. Submission freezes the commercial snapshot under policy version 1 and places the quote in `pending_approval`.

The simulated agent then tries to approve:

```text
Agent approval refused: 403 HUMAN_APPROVAL_REQUIRED. Quote and approval remain pending; no business audit added.
```

The recipe asserts that refusal and unchanged business state, then calls the same action as a simulated user. It checks an approved decision, exactly one user decision audit, and an unchanged submitted snapshot. It also reads the failed agent trace and the completed user trace. These assertions extend the worked example around the already tested [commercial approval behavior](https://github.com/khaoss85/agent-crm/blob/main/tests/commercial-e2e.test.js).

Both actors are scripted local identities. Nobody authenticates or clicks Approve during this replay. A production deployment must supply a verified identity and authorization configuration; the example's `sales-manager` approval key is a label, not a login role.

## Inspect what remains

```sh
cd ../my-quote-crm
cat data/quote-approval-receipt.json
npm run verify
npm run crm -- app inspect --json
```

The local SQLite database and JSON receipt remain in `data/`. The receipt connects the quote, frozen version, policy fingerprint, approval, decision audit and traces. Project verification checks technical health; the recipe's assertions check this particular business journey. The audit records what the process did under the asserted actor; it is not an externally attestable compliance log.

## The mistake the first run caught

The first implementation generated commercial modules alphabetically. A reference to the quote table failed because the quote module had not been installed yet. Using the dependency order from the existing commercial test corrected the setup, and the recorded execution then passed. The generated project also initially retained a starter test expecting no domain packages; the recipe now changes that assertion to require the commercial package. Both findings stay in the transcript's development history.

This is a deterministic replay of existing primitives. It does not measure Claude Code or Codex building a CRM from a prompt, and it establishes no build success rate. The catalog is a fixture; no email, signature, billing or customer notification is sent. The [evidence ledger](https://accordo.dev/evidence.html) gives the wider product boundaries.

## Try your own brief next

Use the [downloadable brief](../recipes/quote-approval-brief.md) as a starting point. Replace the sample customer process, then ask your coding agent to inspect the project and propose the smallest reviewed change. Keep the price checks, refusal and audit checks as acceptance criteria. That adaptation is a separate build to evaluate; this example does not claim it has already succeeded.
