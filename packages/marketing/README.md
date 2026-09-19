# Marketing — Funnel Insight + Campaign Proposal (MK1)

An agent observes a bounded funnel insight and prepares a **complete**
CampaignProposal in Admin. Nothing is sent, published or spent.

## What it owns

- **Records** (all read-only publicly, written only through the trusted managed
  path): `funnel-definition`, `funnel-run`, `funnel-drop-insight`,
  `campaign-proposal`, `campaign-version`. Manifests in `modules/`.
- **Actions** on `campaign-proposal`: `propose` (plan — complete becomes
  `proposed`, incomplete becomes `refused` with its missing sections) and
  `approve` (human decision — requires a user actor, creates the immutable
  campaign version).
- **Declared definitions**: proposal policies (`proposal-policy` kind),
  versioned and fingerprinted per ADR-015. The policy names the required
  sections and the allowed channels and modes.
- **Capability**: `marketing-proposals@1` — read-only proposal and version
  evidence for future consumers (MK2 sends; nothing consumes yet).

## The boundary that makes it safe

This package declares **no provider**, holds **no credential**, opens **no
socket** and reaches **no table** outside its own five resources. The provider
rationale a proposal states is prose a human reads, never a handle the runtime
resolves. "No provider is contacted by any path" therefore holds
structurally, and `tests/marketing-no-external-effect.test.js` pins it: no
network import, no dynamic import, no eval, no provider registry, no
credential field in any manifest.

## Plan-then-approve

An agent may prepare the draft and run the review; it may not commit the
campaign. `approve` refuses every non-user actor with
`HUMAN_APPROVAL_REQUIRED` (403), recomputes completeness from the stored
record inside the transaction, refuses a policy drift since the review with
`PROPOSAL_POLICY_CHANGED` (409), and answers the immutable version snapshot:
what the approver saw is what is stored. A change is a new version, never an
edit.

## Composition

One static import in `packages/domains/generated/index.js`:

```js
import { createMarketingDomain } from '../../marketing/src/index.js';

export const generatedDomains = [createMarketingDomain({
  proposalPolicies: [standardProposalPolicyV1],
})];
```

A project that does not want marketing removes the line and keeps working.
The Admin review screen (`apps/admin/public/admin-marketing.js`) renders only
while `/api/schema` publishes `domains.marketing`, and disappears with the
package rather than degrading into a broken control.

## What is deliberately not here

Audiences and snapshots, consent and suppression, sending of any kind,
content assets and landing pages, journeys, experiments, paid media,
attribution (MK2–MK7). Each is its own package, each its own approval.
