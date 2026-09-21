# B2B quote approval: client brief

Synthetic example for evaluating Accordo. No real customer information.

Northwind Studio needs a proposal for 30 seats of the fixture Enterprise Plan.
The catalog charges EUR 5,000 once for setup, EUR 2,000 monthly for the platform,
and EUR 40 monthly per seat at this quantity. The rep requests 25% off every
component. Keep one-time and monthly amounts separate.

Use the existing standard-sales-discount policy version 1: discounts up to 10%
auto-approve, above 10% through 50% require a user decision, above 50% reject.
The agent may prepare and submit the quote. It cannot approve a quote that
requires a user. Record the policy version, the frozen commercial terms and
who made the decision.

## Acceptance checks

- Server pricing returns EUR 3,750 once and EUR 2,400 per month after discount.
- Submission enters pending_approval under policy version 1.
- An agent approval call returns 403 HUMAN_APPROVAL_REQUIRED and leaves the
  quote and approval pending, with no added business audit record.
- A simulated user approval succeeds and records one user decision audit.
- The submitted commercial snapshot stays unchanged; there is one quote
  version and one approval record, with a failed agent trace and successful
  user trace linked to the decision.

## Evaluation boundary

The recipe uses a fixture catalog, SQLite and an HTTP server bound to localhost.
Both actors are simulated and asserted by the SDK: no person authenticates or
clicks Approve during this replay. It sends no proposal, signature or invoice.
A production deployment must supply and verify authentication and authorization
configuration before handling real customer information.

## Adaptation prompt (not an executed agent session)

Read this brief and the installed project guidance. Inspect what the project
contains, then propose the smallest change to implement our own pricing process.
Keep the acceptance checks and explicit human approval boundary. State which
requirements are already supported and which require additional implementation.
Do not send messages, deploy or connect external providers as part of this exercise.
