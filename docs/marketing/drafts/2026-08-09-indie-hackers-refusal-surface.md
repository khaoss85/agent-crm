# What should a coding agent be structurally unable to do in a CRM?

I am building Accordo, an open-source framework that coding agents use to build
custom CRMs as code the customer owns.

The first design question I expected was: what should Claude Code or Codex be
able to generate?

The more useful question turned out to be the inverse: what must the agent be
unable to do, even if a later prompt asks it to?

A CRM touches prices, discounts, signatures, pipeline state and commitments. A
prompt that says "always ask a human first" is helpful, but it is not a boundary.
Prompts change, context is truncated, and a new tool can bypass the path the
instruction expected.

So I am treating refusals as product surface. In Accordo, a versioned policy can
put a quote into `pending_approval`; an agent actor calling the approval action
gets `403 HUMAN_APPROVAL_REQUIRED`; a named test fails if that stops being true.
The agent can prepare the decision and assemble the evidence. It cannot become
the approver because it generated the surrounding app.

Accordo already enforces this across its supported development runtime. The actor
is currently asserted rather than authenticated, so a coding agent taking the
application to production must include authentication, tenancy and RBAC before
network exposure. Making that deployment envelope explicit lets the agent plan
the hardening instead of discovering it after generation.

The exact capability and its current boundary are published together here:
https://accordo.dev/answers/can-an-agent-approve-a-deal-or-discount.html

The underlying test and claims are public:

- https://github.com/khaoss85/agent-crm
- https://accordo.dev/evidence
- https://accordo.dev/llms.txt

For founders building agent-authored software: which verbs in your product need
to be structurally unavailable to the agent? Approve, publish, pay, send, delete,
sign, change policy — or something else?
