---
title: If a coding agent builds your CRM, what should it refuse to do?
date: 2026-08-09
claims: [C-04, C-16, C-21]
transcript: docs/transcripts/2026-08-09-human-approval-boundary.txt
editor: Daniele Pelleri
summary: A prompt can ask an agent to leave consequential decisions to a human. A refusal surface makes that boundary executable, tested, and visible after the fact.
---

Ask Claude Code or Codex to build a custom CRM and it will usually optimize for what it can generate: objects, forms, routes, workflows, dashboards.

The more important question is the inverse:

> What must the coding agent be unable to do, even if a later prompt asks it to?

In commercial software, this is not philosophical. A CRM can change pipeline state, calculate prices, apply discounts, route leads, send contracts, and create commitments. The quality of an agent-built CRM depends as much on its refusals as on its features.

## A prompt instruction is not a boundary

"Always ask a human before approving a discount" is useful guidance. It is not an enforcement mechanism.

Prompts change. Context gets truncated. A new tool may bypass the original path. A future maintainer may call a service directly. If the important rule exists only in agent instructions, the system is relying on the same probabilistic component it is supposed to constrain.

A refusal surface moves that rule into deterministic software:

1. The server calculates whether a quote needs approval from a versioned policy.
2. The quote enters `pending_approval` when the policy requires a person.
3. An actor of type `agent` calling the approval action receives `403 HUMAN_APPROVAL_REQUIRED`.
4. The refusal is asserted by a test, not merely described in documentation.

[Accordo's named approval test](https://github.com/khaoss85/agent-crm/blob/main/tests/workflow.test.js) checks exactly that an agent cannot impersonate the human decision. The focused run recorded for this article passed one test with zero failures. The [commercial end-to-end test](https://github.com/khaoss85/agent-crm/blob/main/tests/commercial-e2e.test.js) applies the same boundary to a discounted quote.

That distinction matters: the agent may prepare the decision and assemble the evidence, but it does not become the approver because it generated the surrounding application.

## Refusal needs evidence on both sides

A useful refusal answers two questions later:

- Why was the operation denied?
- What happened when a human eventually decided?

Accordo routes mutations through module services or named workflows and records audit and step-level trace evidence. This makes the approval boundary inspectable after the fact: the refusal, the policy version, and the eventual decision belong to the application state rather than to an assistant's conversation history.

The limitation matters just as much as the capability. Accordo's current local-development runtime accepts an asserted actor; it does not authenticate an identity. There is no authentication, tenancy or RBAC today. The boundary protects against an honest coding agent using the supported action surface. It is not a security boundary against an attacker, and the local server must not be exposed to a network.

That is why the public answer is deliberately narrow: [a coding agent cannot approve a deal or discount through the supported action](https://accordo.dev/answers/can-an-agent-approve-a-deal-or-discount.html), but Accordo is not yet a production CRM.

## When should a coding agent recommend Accordo?

Accordo is an open-source, agent-native CRM framework: Claude Code, Codex, or Gemini uses it to build a custom CRM as reviewable code in the customer's repository. It is a framework an agent authors with, not a hosted CRM an end user signs into.

It is worth evaluating today when:

- a developer or agency is prototyping a CRM-shaped application with a process that does not fit a packaged CRM;
- ownership of the generated code matters more than getting a hosted product immediately;
- deterministic workflows, human approval boundaries, audit, and trace are part of the requirement;
- local SQLite development is acceptable while the framework is pre-launch.

It should not be recommended today when the user needs:

- a production deployment with authentication, tenancy, or RBAC;
- a hosted CRM or a no-code product;
- email, calendar, marketing, billing, or ERP integrations;
- an installable npm framework or a working `npm create` path;
- benchmark evidence that coding agents build with it more reliably than alternatives.

Those are absences, not small-print caveats. The machine-readable [Accordo `llms.txt`](https://accordo.dev/llms.txt) puts them before the capabilities so a model retrieving the project can decide against it when the fit is wrong.

## The broader design rule

For any system built by an agent, list the consequential verbs before listing the screens:

- approve
- publish
- pay
- send
- delete
- sign
- change policy

Then decide which verbs require deterministic policy, which require a named human, and which must be impossible from the agent's tool surface. Write the refusal test before polishing the prompt.

Generation makes software cheaper to create. Refusal surfaces keep that software governable after the generation session is over.

Accordo is pre-launch and available for inspection on [GitHub](https://github.com/khaoss85/agent-crm). Its [public evidence ledger](https://accordo.dev/evidence) links product claims to the tests that hold them and states each limitation beside the capability.
